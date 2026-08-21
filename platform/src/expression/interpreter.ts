import type { Expression, ObjectProperty, Pattern, Program, Statement } from "./ast.js";
import { parseExpression, parseProgram } from "./parser.js";

/**
 * Interpreter for the supported JavaScript subset.
 *
 * Three properties matter more than completeness:
 *
 *  - **No `eval`.** Workers forbid it, and the interpreter never reaches for a
 *    host compiler.
 *  - **No prototype access.** `constructor`, `__proto__` and `prototype` are
 *    refused, which closes the standard `x.constructor.constructor(...)` escape
 *    that any naive property-walking evaluator opens.
 *  - **Bounded.** Every evaluation carries an operation budget, so a runaway
 *    loop terminates. The Go engine's goja VM sets no `vm.Interrupt`, so
 *    `{{ while(true){} }}` hangs it indefinitely; here it throws.
 */

export class ExpressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExpressionError";
  }
}

export class BudgetExceededError extends ExpressionError {
  constructor(limit: number) {
    super(`expression exceeded its evaluation budget of ${limit} operations`);
    this.name = "BudgetExceededError";
  }
}

/** A value thrown by interpreted `throw`, carried through native frames. */
class ThrownValue extends Error {
  readonly value: unknown;
  constructor(value: unknown) {
    super(typeof value === "object" && value !== null && "message" in value
      ? String((value as { message: unknown }).message)
      : String(value));
    this.name = "ThrownValue";
    this.value = value;
  }
}

const BLOCKED_PROPERTIES = new Set(["__proto__", "constructor", "prototype"]);

const DEFAULT_BUDGET = 200_000;

interface Completion {
  type: "normal" | "return" | "break" | "continue";
  value?: unknown;
}

const NORMAL: Completion = { type: "normal" };

class Scope {
  private readonly values = new Map<string, unknown>();
  private readonly constants = new Set<string>();
  readonly parent: Scope | null;

  constructor(parent: Scope | null = null) {
    this.parent = parent;
  }

  declare(name: string, value: unknown, constant = false): void {
    this.values.set(name, value);
    if (constant) this.constants.add(name);
  }

  has(name: string): boolean {
    return this.values.has(name) || (this.parent?.has(name) ?? false);
  }

  get(name: string): unknown {
    if (this.values.has(name)) return this.values.get(name);
    if (this.parent) return this.parent.get(name);
    throw new ExpressionError(`${name} is not defined`);
  }

  set(name: string, value: unknown): void {
    if (this.values.has(name)) {
      if (this.constants.has(name)) {
        throw new ExpressionError(`assignment to constant variable ${name}`);
      }
      this.values.set(name, value);
      return;
    }
    if (this.parent) {
      this.parent.set(name, value);
      return;
    }
    // Implicit global, matching sloppy-mode JS.
    this.values.set(name, value);
  }
}

/** A function defined inside interpreted source. */
class Closure {
  constructor(
    readonly params: Pattern[],
    readonly body: Statement[] | Expression,
    readonly scope: Scope,
    readonly interpreter: Interpreter,
    readonly name?: string,
  ) {}

  call(args: unknown[]): unknown {
    return this.interpreter.invoke(this, args);
  }
}

export interface EvaluateOptions {
  /** Maximum interpreter operations before evaluation is aborted. */
  budget?: number;
}

class Interpreter {
  private operations = 0;
  private readonly budget: number;

  constructor(budget: number) {
    this.budget = budget;
  }

  private tick(): void {
    if (++this.operations > this.budget) throw new BudgetExceededError(this.budget);
  }

  // ---- entry points --------------------------------------------------------

  runProgram(program: Program, scope: Scope): unknown {
    this.hoist(program.body, scope);
    let last: unknown;
    for (const statement of program.body) {
      const completion = this.execute(statement, scope);
      if (completion.type === "return") return completion.value;
      if (statement.kind === "ExpressionStatement") last = completion.value;
    }
    return last;
  }

  evaluate(expression: Expression, scope: Scope): unknown {
    this.tick();

    switch (expression.kind) {
      case "Literal":
        return expression.value;

      case "RegexLiteral":
        return new RegExp(expression.pattern, expression.flags);

      case "Identifier":
        return scope.get(expression.name);

      case "Template": {
        let out = expression.quasis[0] ?? "";
        for (let i = 0; i < expression.expressions.length; i++) {
          out += stringify(this.evaluate(expression.expressions[i]!, scope));
          out += expression.quasis[i + 1] ?? "";
        }
        return out;
      }

      case "Array": {
        const out: unknown[] = [];
        expression.elements.forEach((element, index) => {
          if (element === null) {
            out.length += 1;
            return;
          }
          const value = this.evaluate(element, scope);
          if (expression.spreads[index]) {
            for (const item of toIterable(value)) out.push(item);
          } else {
            out.push(value);
          }
        });
        return out;
      }

      case "Object": {
        const out: Record<string, unknown> = {};
        for (const property of expression.properties) {
          this.assignProperty(out, property, scope);
        }
        return out;
      }

      case "Member": {
        const object = this.evaluate(expression.object, scope);
        if (expression.optional && (object === null || object === undefined)) return undefined;
        const key = expression.computed
          ? this.evaluate(expression.property, scope)
          : (expression.property as { value: unknown }).value;
        return getMember(object, key);
      }

      case "Call":
        return this.evaluateCall(expression, scope);

      case "Unary": {
        if (expression.operator === "typeof") {
          // `typeof undeclared` must not throw.
          if (expression.argument.kind === "Identifier" && !scope.has(expression.argument.name)) {
            return "undefined";
          }
          return typeOf(this.evaluate(expression.argument, scope));
        }
        const value = this.evaluate(expression.argument, scope);
        switch (expression.operator) {
          case "!": return !truthy(value);
          case "-": return -(value as number);
          case "+": return +(value as number);
          case "~": return ~(value as number);
          case "void": return undefined;
          case "delete": return true;
        }
        throw new ExpressionError(`unsupported unary operator ${expression.operator}`);
      }

      case "Update": {
        const current = Number(this.evaluate(expression.argument, scope));
        const updated = expression.operator === "++" ? current + 1 : current - 1;
        this.assign(expression.argument, updated, scope);
        return expression.prefix ? updated : current;
      }

      case "Binary":
        return binary(
          expression.operator,
          this.evaluate(expression.left, scope),
          this.evaluate(expression.right, scope),
        );

      case "Logical": {
        const left = this.evaluate(expression.left, scope);
        switch (expression.operator) {
          case "&&": return truthy(left) ? this.evaluate(expression.right, scope) : left;
          case "||": return truthy(left) ? left : this.evaluate(expression.right, scope);
          case "??":
            return left === null || left === undefined
              ? this.evaluate(expression.right, scope)
              : left;
        }
      }

      case "Conditional":
        return truthy(this.evaluate(expression.test, scope))
          ? this.evaluate(expression.consequent, scope)
          : this.evaluate(expression.alternate, scope);

      case "Assignment": {
        if (expression.operator === "=") {
          const value = this.evaluate(expression.value, scope);
          this.assign(expression.target, value, scope);
          return value;
        }
        if (expression.operator === "&&=" || expression.operator === "||=" || expression.operator === "??=") {
          const current = this.evaluate(expression.target, scope);
          const shouldAssign =
            expression.operator === "&&=" ? truthy(current)
            : expression.operator === "||=" ? !truthy(current)
            : current === null || current === undefined;
          if (!shouldAssign) return current;
          const value = this.evaluate(expression.value, scope);
          this.assign(expression.target, value, scope);
          return value;
        }
        const current = this.evaluate(expression.target, scope);
        const operand = this.evaluate(expression.value, scope);
        const value = binary(expression.operator.slice(0, -1), current, operand);
        this.assign(expression.target, value, scope);
        return value;
      }

      case "Sequence": {
        let last: unknown;
        for (const item of expression.expressions) last = this.evaluate(item, scope);
        return last;
      }

      case "Function":
        return new Closure(
          expression.params,
          expression.body,
          scope,
          this,
          expression.name,
        );
    }

    throw new ExpressionError(`unsupported expression`);
  }

  private assignProperty(
    target: Record<string, unknown>,
    property: ObjectProperty,
    scope: Scope,
  ): void {
    if (property.spread) {
      const source = this.evaluate(property.value, scope);
      if (source && typeof source === "object") {
        for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
          if (BLOCKED_PROPERTIES.has(key)) continue;
          target[key] = value;
        }
      }
      return;
    }
    const key = property.computed
      ? String(this.evaluate(property.key, scope))
      : String((property.key as { value: unknown }).value);
    if (BLOCKED_PROPERTIES.has(key)) {
      throw new ExpressionError(`assignment to ${key} is not allowed`);
    }
    target[key] = this.evaluate(property.value, scope);
  }

  private evaluateCall(expression: Extract<Expression, { kind: "Call" }>, scope: Scope): unknown {
    const args: unknown[] = [];
    expression.args.forEach((arg, index) => {
      const value = this.evaluate(arg, scope);
      if (expression.spreads[index]) {
        for (const item of toIterable(value)) args.push(item);
      } else {
        args.push(value);
      }
    });

    // A method call keeps its receiver.
    if (expression.callee.kind === "Member") {
      const member = expression.callee;
      const receiver = this.evaluate(member.object, scope);
      if (member.optional && (receiver === null || receiver === undefined)) return undefined;
      const key = member.computed
        ? this.evaluate(member.property, scope)
        : (member.property as { value: unknown }).value;
      const fn = getMember(receiver, key);
      if (expression.optional && (fn === null || fn === undefined)) return undefined;
      return this.applyCallable(fn, receiver, args, String(key));
    }

    const callee = this.evaluate(expression.callee, scope);
    if (expression.optional && (callee === null || callee === undefined)) return undefined;
    const name = expression.callee.kind === "Identifier" ? expression.callee.name : "expression";
    return this.applyCallable(callee, undefined, args, name);
  }

  private applyCallable(fn: unknown, receiver: unknown, args: unknown[], name: string): unknown {
    this.tick();
    if (fn instanceof Closure) return fn.call(args);
    if (typeof fn === "function") {
      // Callback arguments are interpreted closures; hand natives a wrapper.
      const nativeArgs = args.map((arg) => (arg instanceof Closure ? this.toNative(arg) : arg));
      return (fn as (...a: unknown[]) => unknown).apply(receiver, nativeArgs);
    }
    throw new ExpressionError(`${name} is not a function`);
  }

  /** Wraps an interpreted closure so native methods like `map` can call it. */
  private toNative(closure: Closure): (...args: unknown[]) => unknown {
    return (...args: unknown[]) => closure.call(args);
  }

  invoke(closure: Closure, args: unknown[]): unknown {
    this.tick();
    const scope = new Scope(closure.scope);

    closure.params.forEach((param, index) => {
      if (param.kind === "IdentifierPattern" && param.name.startsWith("...")) {
        scope.declare(param.name.slice(3), args.slice(index));
        return;
      }
      this.bind(param, args[index], scope, "let");
    });

    if (!Array.isArray(closure.body)) {
      return this.evaluate(closure.body, scope);
    }

    this.hoist(closure.body, scope);
    for (const statement of closure.body) {
      const completion = this.execute(statement, scope);
      if (completion.type === "return") return completion.value;
    }
    return undefined;
  }

  /** Function declarations are visible before their definition. */
  private hoist(body: Statement[], scope: Scope): void {
    for (const statement of body) {
      if (statement.kind === "FunctionDeclaration") {
        scope.declare(
          statement.name,
          new Closure(statement.params, statement.body, scope, this, statement.name),
        );
      }
    }
  }

  execute(statement: Statement, scope: Scope): Completion {
    this.tick();

    switch (statement.kind) {
      case "ExpressionStatement":
        return { type: "normal", value: this.evaluate(statement.expression, scope) };

      case "VariableDeclaration": {
        for (const declaration of statement.declarations) {
          const value = declaration.init === null ? undefined : this.evaluate(declaration.init, scope);
          this.bind(declaration.id, value, scope, statement.declarationKind);
        }
        return NORMAL;
      }

      case "FunctionDeclaration":
        // Already hoisted; redeclare so a nested block sees the current scope.
        scope.declare(
          statement.name,
          new Closure(statement.params, statement.body, scope, this, statement.name),
        );
        return NORMAL;

      case "Return":
        return {
          type: "return",
          value: statement.argument === null ? undefined : this.evaluate(statement.argument, scope),
        };

      case "If":
        if (truthy(this.evaluate(statement.test, scope))) {
          return this.execute(statement.consequent, scope);
        }
        return statement.alternate ? this.execute(statement.alternate, scope) : NORMAL;

      case "Block": {
        const inner = new Scope(scope);
        this.hoist(statement.body, inner);
        for (const child of statement.body) {
          const completion = this.execute(child, inner);
          if (completion.type !== "normal") return completion;
        }
        return NORMAL;
      }

      case "For": {
        const outer = new Scope(scope);
        if (statement.init) {
          if ("kind" in statement.init && isStatement(statement.init)) {
            this.execute(statement.init as Statement, outer);
          } else {
            this.evaluate(statement.init as Expression, outer);
          }
        }
        for (;;) {
          this.tick();
          if (statement.test && !truthy(this.evaluate(statement.test, outer))) break;
          const completion = this.execute(statement.body, new Scope(outer));
          if (completion.type === "break") break;
          if (completion.type === "return") return completion;
          if (statement.update) this.evaluate(statement.update, outer);
        }
        return NORMAL;
      }

      case "ForOf": {
        const iterable = toIterable(this.evaluate(statement.right, scope));
        for (const item of iterable) {
          this.tick();
          const inner = new Scope(scope);
          this.bind(statement.left, item, inner, statement.declarationKind);
          const completion = this.execute(statement.body, inner);
          if (completion.type === "break") break;
          if (completion.type === "return") return completion;
        }
        return NORMAL;
      }

      case "ForIn": {
        const target = this.evaluate(statement.right, scope);
        const keys =
          target && typeof target === "object"
            ? Array.isArray(target)
              ? target.map((_, i) => String(i))
              : Object.keys(target as Record<string, unknown>)
            : [];
        for (const key of keys) {
          this.tick();
          const inner = new Scope(scope);
          this.bind(statement.left, key, inner, statement.declarationKind);
          const completion = this.execute(statement.body, inner);
          if (completion.type === "break") break;
          if (completion.type === "return") return completion;
        }
        return NORMAL;
      }

      case "While":
        for (;;) {
          this.tick();
          if (!truthy(this.evaluate(statement.test, scope))) break;
          const completion = this.execute(statement.body, new Scope(scope));
          if (completion.type === "break") break;
          if (completion.type === "return") return completion;
        }
        return NORMAL;

      case "DoWhile":
        for (;;) {
          this.tick();
          const completion = this.execute(statement.body, new Scope(scope));
          if (completion.type === "break") break;
          if (completion.type === "return") return completion;
          if (!truthy(this.evaluate(statement.test, scope))) break;
        }
        return NORMAL;

      case "Break":
        return { type: "break" };

      case "Continue":
        return { type: "continue" };

      case "Throw":
        throw new ThrownValue(this.evaluate(statement.argument, scope));

      case "Try": {
        try {
          const inner = new Scope(scope);
          this.hoist(statement.block, inner);
          for (const child of statement.block) {
            const completion = this.execute(child, inner);
            if (completion.type !== "normal") return completion;
          }
        } catch (error) {
          // A budget overrun is not catchable — otherwise `try {} catch {}`
          // around an infinite loop would swallow the abort.
          if (error instanceof BudgetExceededError) throw error;
          if (!statement.handler) throw error;
          const inner = new Scope(scope);
          if (statement.param) {
            this.bind(statement.param, unwrapThrown(error), inner, "let");
          }
          this.hoist(statement.handler, inner);
          for (const child of statement.handler) {
            const completion = this.execute(child, inner);
            if (completion.type !== "normal") return completion;
          }
        } finally {
          if (statement.finalizer) {
            const inner = new Scope(scope);
            this.hoist(statement.finalizer, inner);
            for (const child of statement.finalizer) this.execute(child, inner);
          }
        }
        return NORMAL;
      }

      case "Empty":
        return NORMAL;
    }

    throw new ExpressionError("unsupported statement");
  }

  private bind(pattern: Pattern, value: unknown, scope: Scope, declarationKind: string): void {
    const constant = declarationKind === "const";

    switch (pattern.kind) {
      case "IdentifierPattern": {
        const resolved =
          value === undefined && pattern.default ? this.evaluate(pattern.default, scope) : value;
        scope.declare(pattern.name, resolved, constant);
        return;
      }
      case "ObjectPattern": {
        const source = (value ?? {}) as Record<string, unknown>;
        const taken = new Set<string>();
        for (const property of pattern.properties) {
          taken.add(property.key);
          this.bind(property.value, getMember(source, property.key), scope, declarationKind);
        }
        if (pattern.rest) {
          const rest: Record<string, unknown> = {};
          for (const [key, item] of Object.entries(source)) {
            if (!taken.has(key)) rest[key] = item;
          }
          scope.declare(pattern.rest, rest, constant);
        }
        return;
      }
      case "ArrayPattern": {
        const source = [...toIterable(value)];
        pattern.elements.forEach((element, index) => {
          if (element) this.bind(element, source[index], scope, declarationKind);
        });
        if (pattern.rest) {
          scope.declare(pattern.rest, source.slice(pattern.elements.length), constant);
        }
        return;
      }
    }
  }

  private assign(target: Expression, value: unknown, scope: Scope): void {
    if (target.kind === "Identifier") {
      scope.set(target.name, value);
      return;
    }
    if (target.kind === "Member") {
      const object = this.evaluate(target.object, scope);
      const key = String(
        target.computed
          ? this.evaluate(target.property, scope)
          : (target.property as { value: unknown }).value,
      );
      if (BLOCKED_PROPERTIES.has(key)) {
        throw new ExpressionError(`assignment to ${key} is not allowed`);
      }
      if (object === null || object === undefined) {
        throw new ExpressionError(`cannot set ${key} of ${String(object)}`);
      }
      (object as Record<string, unknown>)[key] = value;
      return;
    }
    throw new ExpressionError("invalid assignment target");
  }
}

function isStatement(node: unknown): boolean {
  const kind = (node as { kind?: string }).kind;
  return kind === "VariableDeclaration" || kind === "ExpressionStatement";
}

function unwrapThrown(error: unknown): unknown {
  if (error instanceof ThrownValue) return error.value;
  if (error instanceof Error) return { name: error.name, message: error.message };
  return error;
}

// ---- value operations ------------------------------------------------------

function truthy(value: unknown): boolean {
  return Boolean(value);
}

function typeOf(value: unknown): string {
  if (value instanceof Closure) return "function";
  return typeof value;
}

function stringify(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function toIterable(value: unknown): unknown[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return [...value];
  if (value instanceof Set || value instanceof Map) return [...value];
  if (typeof value === "object") return Object.values(value as Record<string, unknown>);
  return [];
}

function binary(operator: string, left: unknown, right: unknown): unknown {
  switch (operator) {
    case "+": return (left as number) + (right as number);
    case "-": return (left as number) - (right as number);
    case "*": return (left as number) * (right as number);
    case "/": return (left as number) / (right as number);
    case "%": return (left as number) % (right as number);
    case "**": return (left as number) ** (right as number);
    case "==": return left == right; // eslint-disable-line eqeqeq
    case "!=": return left != right; // eslint-disable-line eqeqeq
    case "===": return left === right;
    case "!==": return left !== right;
    case "<": return (left as number) < (right as number);
    case "<=": return (left as number) <= (right as number);
    case ">": return (left as number) > (right as number);
    case ">=": return (left as number) >= (right as number);
    case "&": return (left as number) & (right as number);
    case "|": return (left as number) | (right as number);
    case "^": return (left as number) ^ (right as number);
    case "<<": return (left as number) << (right as number);
    case ">>": return (left as number) >> (right as number);
    case ">>>": return (left as number) >>> (right as number);
    case "in":
      return right !== null && typeof right === "object" &&
        Object.prototype.hasOwnProperty.call(right, String(left));
    case "instanceof":
      return false;
  }
  throw new ExpressionError(`unsupported operator ${operator}`);
}

const STRING_METHODS = new Set([
  "at", "charAt", "charCodeAt", "codePointAt", "concat", "endsWith", "includes",
  "indexOf", "lastIndexOf", "localeCompare", "match", "matchAll", "normalize",
  "padEnd", "padStart", "repeat", "replace", "replaceAll", "search", "slice",
  "split", "startsWith", "substring", "toLowerCase", "toUpperCase", "trim",
  "trimEnd", "trimStart", "toString",
]);

const ARRAY_METHODS = new Set([
  "at", "concat", "entries", "every", "fill", "filter", "find", "findIndex",
  "findLast", "findLastIndex", "flat", "flatMap", "forEach", "includes",
  "indexOf", "join", "keys", "lastIndexOf", "map", "pop", "push", "reduce",
  "reduceRight", "reverse", "shift", "slice", "some", "sort", "splice",
  "toString", "unshift", "values",
]);

const NUMBER_METHODS = new Set([
  "toExponential", "toFixed", "toPrecision", "toString",
]);

const REGEXP_METHODS = new Set(["exec", "test", "toString"]);

const DATE_METHODS = new Set([
  "getTime", "getFullYear", "getMonth", "getDate", "getHours", "getMinutes",
  "getSeconds", "getMilliseconds", "getUTCFullYear", "getUTCMonth", "getUTCDate",
  "getUTCHours", "getUTCMinutes", "getUTCSeconds", "getDay", "getUTCDay",
  "toISOString", "toJSON", "toString", "valueOf",
]);

/**
 * Property read. This is the interpreter's security boundary: prototype
 * plumbing is refused, and built-in methods are reachable only through
 * per-type allow lists.
 */
function getMember(object: unknown, key: unknown): unknown {
  const name = String(key);

  if (object === null || object === undefined) {
    throw new ExpressionError(`cannot read ${JSON.stringify(name)} of ${String(object)}`);
  }
  if (BLOCKED_PROPERTIES.has(name)) {
    throw new ExpressionError(`access to ${name} is not allowed`);
  }

  if (typeof object === "string") {
    if (name === "length") return object.length;
    if (/^\d+$/.test(name)) return object[Number(name)];
    if (STRING_METHODS.has(name)) return (object as unknown as Record<string, unknown>)[name];
    return undefined;
  }

  if (Array.isArray(object)) {
    if (name === "length") return object.length;
    if (/^-?\d+$/.test(name)) return object[Number(name)];
    if (ARRAY_METHODS.has(name)) return (object as unknown as Record<string, unknown>)[name];
    return undefined;
  }

  if (typeof object === "number") {
    return NUMBER_METHODS.has(name) ? (object as unknown as Record<string, unknown>)[name] : undefined;
  }

  if (object instanceof RegExp) {
    if (name === "source") return object.source;
    if (name === "flags") return object.flags;
    if (name === "lastIndex") return object.lastIndex;
    return REGEXP_METHODS.has(name) ? (object as unknown as Record<string, unknown>)[name] : undefined;
  }

  if (object instanceof Date) {
    return DATE_METHODS.has(name) ? (object as unknown as Record<string, unknown>)[name] : undefined;
  }

  if (object instanceof Closure) {
    if (name === "name") return object.name ?? "";
    if (name === "length") return object.params.length;
    return undefined;
  }

  if (typeof object === "function") {
    // Namespace objects in the sandboxed globals (`Array.isArray`,
    // `Number.isInteger`) are functions carrying own properties. Inherited
    // members — `call`, `apply`, `bind` — stay unreachable.
    return Object.prototype.hasOwnProperty.call(object, name)
      ? (object as unknown as Record<string, unknown>)[name]
      : undefined;
  }

  if (typeof object === "object") {
    // Own properties only — no walking up a prototype chain.
    return Object.prototype.hasOwnProperty.call(object, name)
      ? (object as Record<string, unknown>)[name]
      : undefined;
  }

  if (typeof object === "boolean") return undefined;

  return undefined;
}

// ---- the sandboxed global environment --------------------------------------

/**
 * The globals an expression can see. Everything with ambient authority — the
 * network, storage, timers, the host's `globalThis` — is simply absent.
 */
function createGlobals(): Record<string, unknown> {
  const MathSafe: Record<string, unknown> = {
    abs: Math.abs, ceil: Math.ceil, floor: Math.floor, round: Math.round,
    trunc: Math.trunc, sign: Math.sign, min: Math.min, max: Math.max,
    pow: Math.pow, sqrt: Math.sqrt, cbrt: Math.cbrt, log: Math.log,
    log2: Math.log2, log10: Math.log10, exp: Math.exp, hypot: Math.hypot,
    PI: Math.PI, E: Math.E,
  };

  const ObjectSafe: Record<string, unknown> = {
    keys: (o: object) => Object.keys(o ?? {}),
    values: (o: object) => Object.values(o ?? {}),
    entries: (o: object) => Object.entries(o ?? {}),
    assign: (...args: object[]) => Object.assign({}, ...args),
    fromEntries: (entries: Iterable<readonly [PropertyKey, unknown]>) => Object.fromEntries(entries),
    freeze: <T>(o: T) => o,
    hasOwn: (o: object, k: PropertyKey) => Object.prototype.hasOwnProperty.call(o ?? {}, k),
  };

  const ArraySafe = Object.assign(
    (...args: unknown[]) => (args.length === 1 && typeof args[0] === "number" ? new Array(args[0]) : args),
    {
      isArray: Array.isArray,
      from: (value: unknown, mapper?: (item: unknown, index: number) => unknown) => {
        const items = toIterable(value);
        return mapper ? items.map(mapper) : items;
      },
      of: (...items: unknown[]) => items,
    },
  );

  const JSONSafe: Record<string, unknown> = {
    stringify: (value: unknown, replacer?: unknown, space?: unknown) =>
      JSON.stringify(value, replacer as never, space as never),
    parse: (text: string) => JSON.parse(text),
  };

  const makeError = (name: string) =>
    (message?: unknown) => ({ name, message: message === undefined ? "" : String(message) });

  return {
    JSON: JSONSafe,
    Math: MathSafe,
    Object: ObjectSafe,
    Array: ArraySafe,
    String: Object.assign((v: unknown) => stringify(v), {
      fromCharCode: String.fromCharCode,
    }),
    Number: Object.assign((v: unknown) => Number(v), {
      isInteger: Number.isInteger,
      isFinite: Number.isFinite,
      isNaN: Number.isNaN,
      parseFloat: Number.parseFloat,
      parseInt: Number.parseInt,
      MAX_SAFE_INTEGER: Number.MAX_SAFE_INTEGER,
      MIN_SAFE_INTEGER: Number.MIN_SAFE_INTEGER,
      EPSILON: Number.EPSILON,
    }),
    Boolean: (v: unknown) => Boolean(v),
    parseInt: (v: unknown, radix?: number) => parseInt(String(v), radix),
    parseFloat: (v: unknown) => parseFloat(String(v)),
    isNaN: (v: unknown) => Number.isNaN(Number(v)),
    isFinite: (v: unknown) => Number.isFinite(Number(v)),
    encodeURIComponent,
    decodeURIComponent,
    encodeURI,
    decodeURI,
    btoa: (v: string) => btoa(v),
    atob: (v: string) => atob(v),
    RegExp: (pattern: unknown, flags?: unknown) =>
      new RegExp(String(pattern), flags === undefined ? undefined : String(flags)),
    Error: makeError("Error"),
    TypeError: makeError("TypeError"),
    RangeError: makeError("RangeError"),
    NaN: Number.NaN,
    Infinity: Number.POSITIVE_INFINITY,
    undefined: undefined,
  };
}

function buildScope(context: Record<string, unknown>): Scope {
  const scope = new Scope(null);
  for (const [name, value] of Object.entries(createGlobals())) {
    scope.declare(name, value, true);
  }
  // torkflow's context bindings, matching the CLI's goja setup:
  // `$` is the whole context, plus `Steps` and `Trigger` at the top level.
  scope.declare("$", context, true);
  for (const [name, value] of Object.entries(context)) {
    scope.declare(name, value, true);
  }
  return scope;
}

/** Evaluates a single expression against a run context. */
export function evaluateExpression(
  source: string,
  context: Record<string, unknown>,
  options: EvaluateOptions = {},
): unknown {
  const interpreter = new Interpreter(options.budget ?? DEFAULT_BUDGET);
  try {
    return interpreter.evaluate(parseExpression(source), buildScope(context));
  } catch (error) {
    throw rethrow(error, source);
  }
}

/**
 * Runs a full script against a run context — the `core.js` entry point.
 *
 * Matches the CLI's two-shot behaviour: a bare expression body (`({a: 1})`)
 * yields that value, and a statement body yields its `return`.
 */
export function runScript(
  source: string,
  context: Record<string, unknown>,
  options: EvaluateOptions = {},
): unknown {
  const interpreter = new Interpreter(options.budget ?? DEFAULT_BUDGET);
  try {
    return interpreter.runProgram(parseProgram(source), buildScope(context));
  } catch (error) {
    if (error instanceof BudgetExceededError) throw error;
    // A bare object literal (`{ a: 1 }`) parses as a block; retry it wrapped,
    // exactly as the Go engine's EvalScript fallback does.
    try {
      const retry = new Interpreter(options.budget ?? DEFAULT_BUDGET);
      return retry.runProgram(
        parseProgram(`(function(){\n${source}\n})()`),
        buildScope(context),
      );
    } catch {
      throw rethrow(error, source);
    }
  }
}

function rethrow(error: unknown, source: string): Error {
  if (error instanceof ThrownValue) {
    const value = error.value;
    const message =
      value && typeof value === "object" && "message" in value
        ? String((value as { message: unknown }).message)
        : stringify(value);
    return new ExpressionError(message);
  }
  if (error instanceof ExpressionError) return error;
  const preview = source.length > 120 ? `${source.slice(0, 117)}...` : source;
  return new ExpressionError(`${(error as Error).message} — while evaluating: ${preview}`);
}
