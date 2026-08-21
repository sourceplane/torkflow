import type {
  Expression,
  ObjectProperty,
  Pattern,
  Program,
  Statement,
} from "./ast.js";
import { tokenize, type Token } from "./lexer.js";

export class ParseError extends Error {
  readonly position: number;
  constructor(message: string, position: number) {
    super(`${message} (at offset ${position})`);
    this.name = "ParseError";
    this.position = position;
  }
}

/** Binary operator precedence, higher binds tighter. */
const BINARY_PRECEDENCE: Record<string, number> = {
  "??": 1,
  "||": 2,
  "&&": 3,
  "|": 4,
  "^": 5,
  "&": 6,
  "==": 7, "!=": 7, "===": 7, "!==": 7,
  "<": 8, ">": 8, "<=": 8, ">=": 8, "instanceof": 8, "in": 8,
  "<<": 9, ">>": 9, ">>>": 9,
  "+": 10, "-": 10,
  "*": 11, "/": 11, "%": 11,
  "**": 12,
};

const ASSIGNMENT_OPERATORS = new Set([
  "=", "+=", "-=", "*=", "/=", "%=", "**=", "<<=", ">>=", ">>>=", "&=", "|=", "^=",
  "&&=", "||=", "??=",
]);

class Parser {
  private readonly tokens: Token[];
  private index = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  // ---- token helpers -------------------------------------------------------

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.index + offset, this.tokens.length - 1)]!;
  }

  private next(): Token {
    const token = this.peek();
    if (this.index < this.tokens.length - 1) this.index++;
    return token;
  }

  private at(value: string): boolean {
    const token = this.peek();
    return (token.type === "punct" || token.type === "keyword") && token.value === value;
  }

  private eat(value: string): boolean {
    if (this.at(value)) {
      this.next();
      return true;
    }
    return false;
  }

  private expect(value: string): Token {
    if (!this.at(value)) {
      const token = this.peek();
      throw new ParseError(
        `expected ${JSON.stringify(value)} but found ${JSON.stringify(token.value || token.type)}`,
        token.start,
      );
    }
    return this.next();
  }

  private atEof(): boolean {
    return this.peek().type === "eof";
  }

  /** Automatic semicolon insertion, in the shape the subset needs. */
  private consumeSemicolon(): void {
    if (this.eat(";")) return;
    const token = this.peek();
    if (token.type === "eof" || this.at("}") || token.newlineBefore) return;
    throw new ParseError(
      `expected ";" but found ${JSON.stringify(token.value || token.type)}`,
      token.start,
    );
  }

  // ---- program -------------------------------------------------------------

  parseProgram(): Program {
    const body: Statement[] = [];
    while (!this.atEof()) body.push(this.parseStatement());
    return { body };
  }

  /**
   * Parses a single expression and requires the whole input to be consumed.
   * This is the `{{ }}` and `core.if` entry point.
   */
  parseExpressionOnly(): Expression {
    const expression = this.parseExpression();
    if (!this.atEof()) {
      const token = this.peek();
      throw new ParseError(
        `unexpected ${JSON.stringify(token.value || token.type)} after expression`,
        token.start,
      );
    }
    return expression;
  }

  // ---- statements ----------------------------------------------------------

  private parseStatement(): Statement {
    const token = this.peek();

    if (token.type === "punct" && token.value === "{") return { kind: "Block", body: this.parseBlock() };
    if (token.type === "punct" && token.value === ";") {
      this.next();
      return { kind: "Empty" };
    }

    if (token.type === "keyword") {
      switch (token.value) {
        case "var":
        case "let":
        case "const": {
          const declaration = this.parseVariableDeclaration();
          this.consumeSemicolon();
          return declaration;
        }
        case "function":
          return this.parseFunctionDeclaration();
        case "return": {
          this.next();
          let argument: Expression | null = null;
          if (!this.at(";") && !this.at("}") && !this.atEof() && !this.peek().newlineBefore) {
            argument = this.parseExpression();
          }
          this.consumeSemicolon();
          return { kind: "Return", argument };
        }
        case "if":
          return this.parseIf();
        case "for":
          return this.parseFor();
        case "while": {
          this.next();
          this.expect("(");
          const test = this.parseExpression();
          this.expect(")");
          return { kind: "While", test, body: this.parseStatement() };
        }
        case "do": {
          this.next();
          const body = this.parseStatement();
          this.expect("while");
          this.expect("(");
          const test = this.parseExpression();
          this.expect(")");
          this.eat(";");
          return { kind: "DoWhile", test, body };
        }
        case "break":
          this.next();
          this.consumeSemicolon();
          return { kind: "Break" };
        case "continue":
          this.next();
          this.consumeSemicolon();
          return { kind: "Continue" };
        case "throw": {
          this.next();
          const argument = this.parseExpression();
          this.consumeSemicolon();
          return { kind: "Throw", argument };
        }
        case "try":
          return this.parseTry();
      }
    }

    const expression = this.parseExpression();
    this.consumeSemicolon();
    return { kind: "ExpressionStatement", expression };
  }

  private parseBlock(): Statement[] {
    this.expect("{");
    const body: Statement[] = [];
    while (!this.at("}") && !this.atEof()) body.push(this.parseStatement());
    this.expect("}");
    return body;
  }

  private parseVariableDeclaration(): Statement {
    const declarationKind = this.next().value;
    const declarations: { id: Pattern; init: Expression | null }[] = [];
    do {
      const id = this.parseBindingPattern();
      let init: Expression | null = null;
      if (this.eat("=")) init = this.parseAssignment();
      declarations.push({ id, init });
    } while (this.eat(","));
    return { kind: "VariableDeclaration", declarations, declarationKind };
  }

  private parseFunctionDeclaration(): Statement {
    this.expect("function");
    const nameToken = this.next();
    if (nameToken.type !== "name") {
      throw new ParseError("expected a function name", nameToken.start);
    }
    const params = this.parseParams();
    const body = this.parseBlock();
    return { kind: "FunctionDeclaration", name: nameToken.value, params, body };
  }

  private parseIf(): Statement {
    this.expect("if");
    this.expect("(");
    const test = this.parseExpression();
    this.expect(")");
    const consequent = this.parseStatement();
    let alternate: Statement | null = null;
    if (this.eat("else")) alternate = this.parseStatement();
    return { kind: "If", test, consequent, alternate };
  }

  private parseFor(): Statement {
    this.expect("for");
    this.expect("(");

    // `for (const x of xs)` / `for (const k in o)`
    if (this.at("var") || this.at("let") || this.at("const")) {
      const declarationKind = this.peek().value;
      const checkpoint = this.index;
      this.next();
      const left = this.parseBindingPattern();
      if (this.at("of") || this.at("in")) {
        const isOf = this.next().value === "of";
        const right = this.parseAssignment();
        this.expect(")");
        const body = this.parseStatement();
        return isOf
          ? { kind: "ForOf", left, declarationKind, right, body }
          : { kind: "ForIn", left, declarationKind, right, body };
      }
      this.index = checkpoint;
    }

    let init: Statement | Expression | null = null;
    if (!this.at(";")) {
      init = this.at("var") || this.at("let") || this.at("const")
        ? this.parseVariableDeclaration()
        : this.parseExpression();
    }
    this.expect(";");
    const test = this.at(";") ? null : this.parseExpression();
    this.expect(";");
    const update = this.at(")") ? null : this.parseExpression();
    this.expect(")");
    return { kind: "For", init, test, update, body: this.parseStatement() };
  }

  private parseTry(): Statement {
    this.expect("try");
    const block = this.parseBlock();
    let param: Pattern | null = null;
    let handler: Statement[] | null = null;
    let finalizer: Statement[] | null = null;

    if (this.eat("catch")) {
      if (this.eat("(")) {
        param = this.parseBindingPattern();
        this.expect(")");
      }
      handler = this.parseBlock();
    }
    if (this.eat("finally")) finalizer = this.parseBlock();

    if (!handler && !finalizer) {
      throw new ParseError("try requires a catch or finally clause", this.peek().start);
    }
    return { kind: "Try", block, param, handler, finalizer };
  }

  // ---- patterns ------------------------------------------------------------

  private parseBindingPattern(): Pattern {
    if (this.at("[")) return this.parseArrayPattern();
    if (this.at("{")) return this.parseObjectPattern();

    const token = this.next();
    if (token.type !== "name" && !(token.type === "keyword" && token.value === "undefined")) {
      throw new ParseError(
        `expected a binding name but found ${JSON.stringify(token.value || token.type)}`,
        token.start,
      );
    }
    return { kind: "IdentifierPattern", name: token.value };
  }

  private parseArrayPattern(): Pattern {
    this.expect("[");
    const elements: (Pattern | null)[] = [];
    let rest: string | undefined;
    while (!this.at("]")) {
      if (this.eat(",")) {
        elements.push(null);
        continue;
      }
      if (this.eat("...")) {
        rest = this.next().value;
        break;
      }
      const element = this.parseBindingPattern();
      if (this.eat("=")) {
        elements.push({ ...element, default: this.parseAssignment() } as Pattern);
      } else {
        elements.push(element);
      }
      if (!this.at("]")) this.expect(",");
    }
    this.expect("]");
    return { kind: "ArrayPattern", elements, rest };
  }

  private parseObjectPattern(): Pattern {
    this.expect("{");
    const properties: { key: string; value: Pattern }[] = [];
    let rest: string | undefined;
    while (!this.at("}")) {
      if (this.eat("...")) {
        rest = this.next().value;
        break;
      }
      const keyToken = this.next();
      const key = keyToken.type === "string" ? keyToken.value : keyToken.value;
      let value: Pattern = { kind: "IdentifierPattern", name: key };
      if (this.eat(":")) value = this.parseBindingPattern();
      if (this.eat("=")) value = { ...value, default: this.parseAssignment() } as Pattern;
      properties.push({ key, value });
      if (!this.at("}")) this.expect(",");
    }
    this.expect("}");
    return { kind: "ObjectPattern", properties, rest };
  }

  private parseParams(): Pattern[] {
    this.expect("(");
    const params: Pattern[] = [];
    while (!this.at(")")) {
      if (this.eat("...")) {
        params.push({ kind: "IdentifierPattern", name: `...${this.next().value}` });
      } else {
        let param = this.parseBindingPattern();
        if (this.eat("=")) param = { ...param, default: this.parseAssignment() } as Pattern;
        params.push(param);
      }
      if (!this.at(")")) this.expect(",");
    }
    this.expect(")");
    return params;
  }

  // ---- expressions ---------------------------------------------------------

  private parseExpression(): Expression {
    const first = this.parseAssignment();
    if (!this.at(",")) return first;
    const expressions = [first];
    while (this.eat(",")) expressions.push(this.parseAssignment());
    return { kind: "Sequence", expressions };
  }

  private parseAssignment(): Expression {
    const arrow = this.tryParseArrowFunction();
    if (arrow) return arrow;

    const left = this.parseConditional();
    const token = this.peek();
    if (token.type === "punct" && ASSIGNMENT_OPERATORS.has(token.value)) {
      this.next();
      return { kind: "Assignment", operator: token.value, target: left, value: this.parseAssignment() };
    }
    return left;
  }

  /**
   * Arrow functions need lookahead: `(a, b) => …` is only distinguishable from
   * a parenthesised expression at the `=>`. Speculatively parse, and rewind on
   * failure.
   */
  private tryParseArrowFunction(): Expression | null {
    const token = this.peek();

    // `x => …`
    if (token.type === "name" && this.peek(1).type === "punct" && this.peek(1).value === "=>") {
      this.next();
      this.next();
      return this.finishArrowBody([{ kind: "IdentifierPattern", name: token.value }]);
    }

    if (!(token.type === "punct" && token.value === "(")) return null;

    const checkpoint = this.index;
    try {
      const params = this.parseParams();
      if (!this.at("=>")) {
        this.index = checkpoint;
        return null;
      }
      this.next();
      return this.finishArrowBody(params);
    } catch {
      this.index = checkpoint;
      return null;
    }
  }

  private finishArrowBody(params: Pattern[]): Expression {
    if (this.at("{")) {
      return { kind: "Function", params, body: this.parseBlock(), arrow: true };
    }
    return { kind: "Function", params, body: this.parseAssignment(), arrow: true };
  }

  private parseConditional(): Expression {
    const test = this.parseBinary(0);
    if (!this.at("?")) return test;
    this.next();
    const consequent = this.parseAssignment();
    this.expect(":");
    const alternate = this.parseAssignment();
    return { kind: "Conditional", test, consequent, alternate };
  }

  private parseBinary(minPrecedence: number): Expression {
    let left = this.parseUnary();

    for (;;) {
      const token = this.peek();
      const operator = token.value;
      if (token.type !== "punct" && !(token.type === "keyword" && (operator === "instanceof" || operator === "in"))) {
        break;
      }
      const precedence = BINARY_PRECEDENCE[operator];
      if (precedence === undefined || precedence < minPrecedence) break;
      this.next();

      // `**` is right-associative; everything else here is left-associative.
      const right = this.parseBinary(operator === "**" ? precedence : precedence + 1);
      left =
        operator === "&&" || operator === "||" || operator === "??"
          ? { kind: "Logical", operator, left, right }
          : { kind: "Binary", operator, left, right };
    }
    return left;
  }

  private parseUnary(): Expression {
    const token = this.peek();
    if (
      (token.type === "punct" && ["!", "-", "+", "~"].includes(token.value)) ||
      (token.type === "keyword" && ["typeof", "void", "delete"].includes(token.value))
    ) {
      this.next();
      return { kind: "Unary", operator: token.value, argument: this.parseUnary() };
    }
    if (token.type === "punct" && (token.value === "++" || token.value === "--")) {
      this.next();
      return { kind: "Update", operator: token.value, argument: this.parseUnary(), prefix: true };
    }

    let expression = this.parseCallOrMember();

    const after = this.peek();
    if (
      after.type === "punct" &&
      (after.value === "++" || after.value === "--") &&
      !after.newlineBefore
    ) {
      this.next();
      expression = { kind: "Update", operator: after.value, argument: expression, prefix: false };
    }
    return expression;
  }

  private parseCallOrMember(): Expression {
    let expression = this.parsePrimary();

    for (;;) {
      if (this.eat(".")) {
        const property = this.next();
        expression = {
          kind: "Member",
          object: expression,
          property: { kind: "Literal", value: property.value },
          computed: false,
          optional: false,
        };
        continue;
      }
      if (this.at("?.")) {
        this.next();
        if (this.at("(")) {
          const { args, spreads } = this.parseArguments();
          expression = { kind: "Call", callee: expression, args, spreads, optional: true };
          continue;
        }
        if (this.at("[")) {
          this.next();
          const property = this.parseExpression();
          this.expect("]");
          expression = { kind: "Member", object: expression, property, computed: true, optional: true };
          continue;
        }
        const property = this.next();
        expression = {
          kind: "Member",
          object: expression,
          property: { kind: "Literal", value: property.value },
          computed: false,
          optional: true,
        };
        continue;
      }
      if (this.at("[")) {
        this.next();
        const property = this.parseExpression();
        this.expect("]");
        expression = { kind: "Member", object: expression, property, computed: true, optional: false };
        continue;
      }
      if (this.at("(")) {
        const { args, spreads } = this.parseArguments();
        expression = { kind: "Call", callee: expression, args, spreads, optional: false };
        continue;
      }
      break;
    }
    return expression;
  }

  private parseArguments(): { args: Expression[]; spreads: boolean[] } {
    this.expect("(");
    const args: Expression[] = [];
    const spreads: boolean[] = [];
    while (!this.at(")")) {
      const spread = this.eat("...");
      args.push(this.parseAssignment());
      spreads.push(spread);
      if (!this.at(")")) this.expect(",");
    }
    this.expect(")");
    return { args, spreads };
  }

  private parsePrimary(): Expression {
    const token = this.peek();

    switch (token.type) {
      case "number":
        this.next();
        return { kind: "Literal", value: Number(token.value.replace(/_/g, "")) };
      case "string":
        this.next();
        return { kind: "Literal", value: token.value };
      case "regex":
        this.next();
        return { kind: "RegexLiteral", pattern: token.pattern ?? "", flags: token.flags ?? "" };
      case "template": {
        this.next();
        const quasis: string[] = [];
        const expressions: Expression[] = [];
        for (const part of token.parts ?? []) {
          quasis.push(part.cooked);
          if (part.expression !== undefined) {
            expressions.push(new Parser(part.expression).parseExpressionOnly());
          }
        }
        return { kind: "Template", quasis, expressions };
      }
      case "name":
        this.next();
        return { kind: "Identifier", name: token.value };
      case "keyword":
        switch (token.value) {
          case "true":
            this.next();
            return { kind: "Literal", value: true };
          case "false":
            this.next();
            return { kind: "Literal", value: false };
          case "null":
            this.next();
            return { kind: "Literal", value: null };
          case "undefined":
            this.next();
            return { kind: "Literal", value: undefined };
          case "function": {
            this.next();
            const nameToken = this.peek().type === "name" ? this.next() : null;
            const params = this.parseParams();
            const body = this.parseBlock();
            return {
              kind: "Function",
              params,
              body,
              arrow: false,
              ...(nameToken ? { name: nameToken.value } : {}),
            };
          }
          case "new": {
            // `new X(...)` is supported only for the whitelisted constructors
            // the interpreter exposes (Error and friends).
            this.next();
            const callee = this.parseCallOrMember();
            if (callee.kind === "Call") {
              return { kind: "Call", callee: callee.callee, args: callee.args, spreads: callee.spreads, optional: false };
            }
            return { kind: "Call", callee, args: [], spreads: [], optional: false };
          }
        }
        break;
      case "punct":
        if (token.value === "(") {
          this.next();
          const expression = this.parseExpression();
          this.expect(")");
          return expression;
        }
        if (token.value === "[") return this.parseArrayLiteral();
        if (token.value === "{") return this.parseObjectLiteral();
        break;
    }

    throw new ParseError(
      `unexpected ${JSON.stringify(token.value || token.type)}`,
      token.start,
    );
  }

  private parseArrayLiteral(): Expression {
    this.expect("[");
    const elements: (Expression | null)[] = [];
    const spreads: boolean[] = [];
    while (!this.at("]")) {
      if (this.at(",")) {
        this.next();
        elements.push(null);
        spreads.push(false);
        continue;
      }
      const spread = this.eat("...");
      elements.push(this.parseAssignment());
      spreads.push(spread);
      if (!this.at("]")) this.expect(",");
    }
    this.expect("]");
    return { kind: "Array", elements, spreads };
  }

  private parseObjectLiteral(): Expression {
    this.expect("{");
    const properties: ObjectProperty[] = [];
    while (!this.at("}")) {
      if (this.eat("...")) {
        properties.push({
          key: { kind: "Literal", value: null },
          value: this.parseAssignment(),
          computed: false,
          spread: true,
        });
        if (!this.at("}")) this.expect(",");
        continue;
      }

      let key: Expression;
      let computed = false;
      if (this.at("[")) {
        this.next();
        key = this.parseAssignment();
        this.expect("]");
        computed = true;
      } else {
        const keyToken = this.next();
        key =
          keyToken.type === "number"
            ? { kind: "Literal", value: String(Number(keyToken.value)) }
            : { kind: "Literal", value: keyToken.value };
      }

      if (this.at("(")) {
        // Method shorthand: `{ fn() { … } }`.
        const params = this.parseParams();
        const body = this.parseBlock();
        properties.push({ key, value: { kind: "Function", params, body, arrow: false }, computed, spread: false });
      } else if (this.eat(":")) {
        properties.push({ key, value: this.parseAssignment(), computed, spread: false });
      } else {
        // Shorthand: `{ x }`.
        const name = (key as { kind: "Literal"; value: unknown }).value;
        properties.push({
          key,
          value: { kind: "Identifier", name: String(name) },
          computed,
          spread: false,
        });
      }

      if (!this.at("}")) this.expect(",");
    }
    this.expect("}");
    return { kind: "Object", properties };
  }
}

/** Parses a single expression — the `{{ }}` and `core.if` entry point. */
export function parseExpression(source: string): Expression {
  return new Parser(source).parseExpressionOnly();
}

/** Parses a full script — the `core.js` entry point. */
export function parseProgram(source: string): Program {
  return new Parser(source).parseProgram();
}
