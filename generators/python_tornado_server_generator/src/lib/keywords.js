// Python reserved keywords - identifiers matching these must be escaped. Python has no
// backtick-style escape mechanism (unlike Kotlin), so the convention here is the same one PEP 8
// itself recommends and the Python community actually uses: a single trailing underscore
// (`class_`, `type_`) rather than a language quoting mechanism.
export const PYTHON_KEYWORDS = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await", "break", "class", "continue",
  "def", "del", "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in",
  "is", "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try", "while", "with",
  "yield",
]);

export function escapeKeyword(name) {
  return PYTHON_KEYWORDS.has(name) ? name + "_" : name;
}

// Escapes and quotes a value for use as a Python string literal, e.g. `foo"bar` -> `"foo\"bar"`.
// Python's double-quoted string escaping rules for \\/\"/\n/\r/\t are the same as the engine's own
// toStringLiteral() already produces (JSON-style, shared across every C-family/Python-family
// target - see docs/javascript-api.md) - no extra Python-specific escaping is needed on top,
// unlike Kotlin's `$` (string templates).
export function escapePythonString(s) {
  return toStringLiteral(String(s));
}
