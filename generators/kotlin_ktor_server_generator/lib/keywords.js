// Kotlin hard keywords - identifiers matching these must be backtick-escaped.
export const KOTLIN_KEYWORDS = new Set([
  "as", "break", "class", "continue", "do", "else", "false", "for", "fun", "if", "in",
  "interface", "is", "null", "object", "package", "return", "super", "this", "throw", "true",
  "try", "typealias", "typeof", "val", "var", "when", "while",
  "by", "catch", "constructor", "delegate", "dynamic", "field", "file", "finally", "get", "import",
  "init", "param", "property", "receiver", "set", "setparam", "where", "actual", "abstract",
  "annotation", "companion", "const", "crossinline", "data", "enum", "expect", "external", "final",
  "infix", "inline", "inner", "internal", "lateinit", "noinline", "open", "operator", "out",
  "override", "private", "protected", "public", "reified", "sealed", "suspend", "tailrec", "vararg",
]);

export function isValidIdentifier(name) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

// Sanitizes an arbitrary string into a syntactically valid Kotlin identifier (not case-converted -
// callers apply toCamelCase/toPascalCase/toScreamingSnakeCase before or after this as needed).
export function sanitizeIdentifier(name) {
  let n = String(name).replace(/[^A-Za-z0-9_]/g, "_");
  if (n.length === 0 || /^[0-9]/.test(n)) {
    n = "_" + n;
  }
  return n;
}

// Wraps a keyword in backticks so it can still be used as an identifier.
export function escapeKeyword(name) {
  return KOTLIN_KEYWORDS.has(name) ? "`" + name + "`" : name;
}

// Escapes the content of a Kotlin string template literal (no surrounding quotes).
export function escapeKotlinStringContent(s) {
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$");
}

// Escapes and quotes a value for use as a Kotlin string literal, e.g. `foo"bar` -> `"foo\"bar"`.
export function escapeKotlinString(s) {
  return '"' + escapeKotlinStringContent(s) + '"';
}
