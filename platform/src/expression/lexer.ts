/**
 * Tokenizer for the JavaScript subset used by torkflow expressions.
 *
 * torkflow expressions are JavaScript: `{{ }}` templates, `core.if` conditions
 * and `core.js` scripts all run as JS in the CLI (goja). Workers forbid `eval`,
 * so the platform parses and interprets the language itself. That keeps
 * evaluation deterministic and replay-safe, and it means an expression cannot
 * reach anything the interpreter does not hand it.
 */

export type TokenType =
  | "number"
  | "string"
  | "template"
  | "regex"
  | "name"
  | "keyword"
  | "punct"
  | "eof";

export interface TemplatePart {
  /** Literal text preceding the expression, already unescaped. */
  cooked: string;
  /** Source of the `${...}` expression following the text, if any. */
  expression?: string;
}

export interface Token {
  type: TokenType;
  value: string;
  start: number;
  end: number;
  /** Set for template literals: alternating literal text and expressions. */
  parts?: TemplatePart[];
  /** Set for regex literals. */
  pattern?: string;
  flags?: string;
  /** True when a line terminator precedes this token (for ASI). */
  newlineBefore: boolean;
}

const KEYWORDS = new Set([
  "var", "let", "const", "function", "return", "if", "else", "for", "of", "in",
  "while", "do", "break", "continue", "try", "catch", "finally", "throw", "new",
  "typeof", "void", "delete", "instanceof", "true", "false", "null", "undefined",
  "switch", "case", "default",
]);

// Longest-first so `===` wins over `==` over `=`.
const PUNCTUATORS = [
  ">>>=",
  "...", "===", "!==", "**=", "<<=", ">>=", ">>>", "&&=", "||=", "??=",
  "=>", "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "++", "--",
  "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "**", "<<", ">>",
  "{", "}", "(", ")", "[", "]", ";", ",", "<", ">", "+", "-", "*", "/",
  "%", "&", "|", "^", "!", "~", "?", ":", "=", ".",
];

export class LexError extends Error {
  readonly position: number;
  constructor(message: string, position: number) {
    super(`${message} (at offset ${position})`);
    this.name = "LexError";
    this.position = position;
  }
}

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let newlineBefore = false;

  const push = (token: Omit<Token, "newlineBefore">) => {
    tokens.push({ ...token, newlineBefore });
    newlineBefore = false;
  };

  while (i < source.length) {
    const ch = source[i]!;

    // Whitespace and comments.
    if (ch === "\n") {
      newlineBefore = true;
      i++;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\f" || ch === "\v" || ch === " ") {
      i++;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end === -1) throw new LexError("unterminated block comment", i);
      if (source.slice(i, end).includes("\n")) newlineBefore = true;
      i = end + 2;
      continue;
    }

    const start = i;

    // Numbers, including hex/binary/octal and exponents.
    if (isDigit(ch) || (ch === "." && isDigit(source[i + 1] ?? ""))) {
      i = readNumber(source, i);
      push({ type: "number", value: source.slice(start, i), start, end: i });
      continue;
    }

    // Strings.
    if (ch === '"' || ch === "'") {
      const { value, next } = readString(source, i, ch);
      i = next;
      push({ type: "string", value, start, end: i });
      continue;
    }

    // Template literals.
    if (ch === "`") {
      const { parts, next } = readTemplate(source, i);
      i = next;
      push({ type: "template", value: source.slice(start, i), parts, start, end: i });
      continue;
    }

    // Identifiers and keywords.
    if (isIdentStart(ch)) {
      i++;
      while (i < source.length && isIdentPart(source[i]!)) i++;
      const value = source.slice(start, i);
      push({ type: KEYWORDS.has(value) ? "keyword" : "name", value, start, end: i });
      continue;
    }

    // A `/` is a regex literal rather than division when the previous token
    // cannot end an expression — the standard JS disambiguation.
    if (ch === "/" && regexAllowed(tokens)) {
      const { pattern, flags, next } = readRegex(source, i);
      i = next;
      push({ type: "regex", value: source.slice(start, i), pattern, flags, start, end: i });
      continue;
    }

    const punct = PUNCTUATORS.find((p) => source.startsWith(p, i));
    if (punct) {
      i += punct.length;
      push({ type: "punct", value: punct, start, end: i });
      continue;
    }

    throw new LexError(`unexpected character ${JSON.stringify(ch)}`, i);
  }

  tokens.push({ type: "eof", value: "", start: i, end: i, newlineBefore });
  return tokens;
}

function regexAllowed(tokens: Token[]): boolean {
  const previous = tokens[tokens.length - 1];
  if (!previous) return true;
  if (previous.type === "number" || previous.type === "string" || previous.type === "template") {
    return false;
  }
  if (previous.type === "regex") return false;
  if (previous.type === "name") return false;
  if (previous.type === "keyword") {
    // `return /re/` is a regex; `true / 2` is division.
    return !["true", "false", "null", "undefined", "this"].includes(previous.value);
  }
  if (previous.type === "punct") {
    return ![")", "]", "}", "++", "--"].includes(previous.value);
  }
  return true;
}

function readNumber(source: string, start: number): number {
  let i = start;
  if (source[i] === "0" && /[xXbBoO]/.test(source[i + 1] ?? "")) {
    i += 2;
    while (i < source.length && /[0-9a-fA-F_]/.test(source[i]!)) i++;
    return i;
  }
  while (i < source.length && /[0-9_]/.test(source[i]!)) i++;
  if (source[i] === ".") {
    i++;
    while (i < source.length && /[0-9_]/.test(source[i]!)) i++;
  }
  if (source[i] === "e" || source[i] === "E") {
    i++;
    if (source[i] === "+" || source[i] === "-") i++;
    while (i < source.length && isDigit(source[i]!)) i++;
  }
  return i;
}

function readString(source: string, start: number, quote: string): { value: string; next: number } {
  let i = start + 1;
  let out = "";
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === "\\") {
      const { text, next } = readEscape(source, i);
      out += text;
      i = next;
      continue;
    }
    if (ch === quote) return { value: out, next: i + 1 };
    if (ch === "\n") throw new LexError("unterminated string literal", start);
    out += ch;
    i++;
  }
  throw new LexError("unterminated string literal", start);
}

function readTemplate(source: string, start: number): { parts: TemplatePart[]; next: number } {
  const parts: TemplatePart[] = [];
  let i = start + 1;
  let cooked = "";

  while (i < source.length) {
    const ch = source[i]!;
    if (ch === "\\") {
      const { text, next } = readEscape(source, i);
      cooked += text;
      i = next;
      continue;
    }
    if (ch === "`") {
      parts.push({ cooked });
      return { parts, next: i + 1 };
    }
    if (ch === "$" && source[i + 1] === "{") {
      // Scan to the matching brace, respecting nested braces and strings.
      let depth = 1;
      let j = i + 2;
      while (j < source.length && depth > 0) {
        const c = source[j]!;
        if (c === "{") depth++;
        else if (c === "}") depth--;
        else if (c === '"' || c === "'") {
          const { next } = readString(source, j, c);
          j = next;
          continue;
        } else if (c === "`") {
          const { next } = readTemplate(source, j);
          j = next;
          continue;
        }
        j++;
      }
      if (depth !== 0) throw new LexError("unterminated template expression", i);
      parts.push({ cooked, expression: source.slice(i + 2, j - 1) });
      cooked = "";
      i = j;
      continue;
    }
    cooked += ch;
    i++;
  }
  throw new LexError("unterminated template literal", start);
}

function readEscape(source: string, at: number): { text: string; next: number } {
  const ch = source[at + 1];
  switch (ch) {
    case "n": return { text: "\n", next: at + 2 };
    case "t": return { text: "\t", next: at + 2 };
    case "r": return { text: "\r", next: at + 2 };
    case "b": return { text: "\b", next: at + 2 };
    case "f": return { text: "\f", next: at + 2 };
    case "v": return { text: "\v", next: at + 2 };
    case "0": return { text: "\0", next: at + 2 };
    case "\n": return { text: "", next: at + 2 };
    case "x": {
      const hex = source.slice(at + 2, at + 4);
      return { text: String.fromCharCode(parseInt(hex, 16)), next: at + 4 };
    }
    case "u": {
      if (source[at + 2] === "{") {
        const end = source.indexOf("}", at + 3);
        if (end === -1) throw new LexError("unterminated unicode escape", at);
        return {
          text: String.fromCodePoint(parseInt(source.slice(at + 3, end), 16)),
          next: end + 1,
        };
      }
      const hex = source.slice(at + 2, at + 6);
      return { text: String.fromCharCode(parseInt(hex, 16)), next: at + 6 };
    }
    default:
      return { text: ch ?? "", next: at + 2 };
  }
}

function readRegex(source: string, start: number): { pattern: string; flags: string; next: number } {
  let i = start + 1;
  let inClass = false;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
    else if (ch === "/" && !inClass) break;
    else if (ch === "\n") throw new LexError("unterminated regular expression", start);
    i++;
  }
  if (source[i] !== "/") throw new LexError("unterminated regular expression", start);
  const pattern = source.slice(start + 1, i);
  i++;
  const flagStart = i;
  while (i < source.length && isIdentPart(source[i]!)) i++;
  return { pattern, flags: source.slice(flagStart, i), next: i };
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function isIdentStart(ch: string): boolean {
  return /[A-Za-z_$]/.test(ch) || ch.charCodeAt(0) > 127;
}

function isIdentPart(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch) || ch.charCodeAt(0) > 127;
}
