// Go reserved words - identifiers matching these must be renamed (Go has no escape syntax for a
// keyword-as-identifier).
export const GO_KEYWORDS = new Set([
  "break", "case", "chan", "const", "continue", "default", "defer", "else", "fallthrough", "for",
  "func", "go", "goto", "if", "import", "interface", "map", "package", "range", "return", "select",
  "struct", "switch", "type", "var",
]);

// Appends "_" to a keyword so it can still be used as an identifier - Go has no backtick/bracket
// escape mechanism, so renaming is the only option (unlike Kotlin's escapeKeyword).
export function escapeKeyword(name) {
  return GO_KEYWORDS.has(name) ? name + "_" : name;
}

// Produces a Go double-quoted string literal. Go's interpreted string literals share the same
// backslash escaping rules as JSON (\\, \", \n, \r, \t, ...), so the engine's toStringLiteral()
// (see docs/javascript-api.md) needs no extra wrapping.
export function toGoStringLiteral(s) {
  return toStringLiteral(String(s));
}
