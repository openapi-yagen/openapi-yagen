// JS/TS identifier escaping. Narrower scope than a language like Kotlin needs: object/interface
// property names and method names accept ANY string in JS/TS ({ "class": 1 } and
// `interface X { class: string }` are both legal), so escaping is only needed for bare identifier
// bindings - type declaration names (interface/enum/type alias) and camelCased parameter names.
// There is no backtick-style escape syntax in JS/TS (unlike Kotlin) - a colliding name is instead
// renamed with a trailing "_".

// ECMAScript reserved words (keywords + strict-mode-reserved + contextual keywords with real
// syntactic weight) - collisions here are only possible for parameter names, since type names are
// PascalCase-first and every one of these is lowercase-only.
export const JS_RESERVED_WORDS = new Set([
  "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do",
  "else", "enum", "export", "extends", "false", "finally", "for", "function", "if", "import", "in",
  "instanceof", "new", "null", "return", "super", "switch", "this", "throw", "true", "try",
  "typeof", "var", "void", "while", "with", "implements", "interface", "let", "package", "private",
  "protected", "public", "static", "yield", "await",
]);

// TS/JS global "lib" type names - not reserved words, but a type declaration named e.g. "Array" or
// "Promise" would shadow the global inside its own generated file (and any file importing it under
// that name). Soft/cosmetic-safety measure, applied only to type-declaration names.
export const TS_LIB_GLOBAL_NAMES = new Set([
  "Array", "Object", "String", "Number", "Boolean", "Function", "Promise", "Date", "Error", "Map",
  "Set", "RegExp", "Symbol", "JSON", "Record", "Partial", "Required", "Readonly", "Pick", "Omit",
]);

export function escapeReservedIdentifier(name) {
  return JS_RESERVED_WORDS.has(name) ? name + "_" : name;
}

export function escapeShadowingTypeName(name) {
  return TS_LIB_GLOBAL_NAMES.has(name) ? name + "_" : name;
}
