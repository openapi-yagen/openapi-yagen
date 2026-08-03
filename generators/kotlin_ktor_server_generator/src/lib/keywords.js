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
