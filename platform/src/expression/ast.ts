/** AST for the supported JavaScript subset. */

export type Node = Expression | Statement;

export type Expression =
  | { kind: "Literal"; value: unknown }
  | { kind: "RegexLiteral"; pattern: string; flags: string }
  | { kind: "Identifier"; name: string }
  | { kind: "Template"; quasis: string[]; expressions: Expression[] }
  | { kind: "Array"; elements: (Expression | null)[]; spreads: boolean[] }
  | { kind: "Object"; properties: ObjectProperty[] }
  | { kind: "Member"; object: Expression; property: Expression; computed: boolean; optional: boolean }
  | { kind: "Call"; callee: Expression; args: Expression[]; spreads: boolean[]; optional: boolean }
  | { kind: "Unary"; operator: string; argument: Expression }
  | { kind: "Update"; operator: string; argument: Expression; prefix: boolean }
  | { kind: "Binary"; operator: string; left: Expression; right: Expression }
  | { kind: "Logical"; operator: "&&" | "||" | "??"; left: Expression; right: Expression }
  | { kind: "Conditional"; test: Expression; consequent: Expression; alternate: Expression }
  | { kind: "Assignment"; operator: string; target: Expression; value: Expression }
  | { kind: "Sequence"; expressions: Expression[] }
  | { kind: "Function"; params: Pattern[]; body: Statement[] | Expression; arrow: boolean; name?: string };

export interface ObjectProperty {
  key: Expression;
  value: Expression;
  computed: boolean;
  spread: boolean;
}

export type Pattern =
  | { kind: "IdentifierPattern"; name: string; default?: Expression }
  | { kind: "ObjectPattern"; properties: { key: string; value: Pattern }[]; rest?: string }
  | { kind: "ArrayPattern"; elements: (Pattern | null)[]; rest?: string };

export type Statement =
  | { kind: "ExpressionStatement"; expression: Expression }
  | { kind: "VariableDeclaration"; declarations: { id: Pattern; init: Expression | null }[]; declarationKind: string }
  | { kind: "FunctionDeclaration"; name: string; params: Pattern[]; body: Statement[] }
  | { kind: "Return"; argument: Expression | null }
  | { kind: "If"; test: Expression; consequent: Statement; alternate: Statement | null }
  | { kind: "Block"; body: Statement[] }
  | { kind: "For"; init: Statement | Expression | null; test: Expression | null; update: Expression | null; body: Statement }
  | { kind: "ForOf"; left: Pattern; declarationKind: string; right: Expression; body: Statement }
  | { kind: "ForIn"; left: Pattern; declarationKind: string; right: Expression; body: Statement }
  | { kind: "While"; test: Expression; body: Statement }
  | { kind: "DoWhile"; test: Expression; body: Statement }
  | { kind: "Break" }
  | { kind: "Continue" }
  | { kind: "Throw"; argument: Expression }
  | { kind: "Try"; block: Statement[]; param: Pattern | null; handler: Statement[] | null; finalizer: Statement[] | null }
  | { kind: "Empty" };

export interface Program {
  body: Statement[];
}
