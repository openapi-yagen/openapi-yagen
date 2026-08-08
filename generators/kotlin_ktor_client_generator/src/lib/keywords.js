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

// Escapes the content of a Kotlin string template literal (no surrounding quotes). Builds on the
// engine's toStringLiteral() (see docs/javascript-api.md) for the JSON-style escaping every
// C-like language shares (\\, \", \n, ...), stripping its surrounding quotes since this result is
// meant to be embedded inside an existing Kotlin string template, then adds the one extra rule
// toStringLiteral doesn't know about: Kotlin's `$` needs escaping too, since it introduces string
// template interpolation.
export function escapeKotlinStringContent(s) {
  const jsonEscaped = toStringLiteral(String(s));
  return jsonEscaped.slice(1, -1).replace(/\$/g, "\\$");
}

// Escapes and quotes a value for use as a Kotlin string literal, e.g. `foo"bar` -> `"foo\"bar"`.
export function escapeKotlinString(s) {
  return '"' + escapeKotlinStringContent(s) + '"';
}
