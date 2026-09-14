// Ruby identifier escaping. Ruby has no backtick-style escape syntax (unlike Kotlin) and, unlike
// JS/TS object keys, a bare `def initialize(class:)`-style keyword argument name really can't be
// a reserved word - so a colliding generator-invented identifier is renamed with a trailing "_",
// the same convention the TypeScript/Kotlin generators use for their own unescapable cases.

// Ruby reserved words (keywords with real syntactic weight - excludes "defined?", which contains
// a "?" and therefore can never collide with a sanitized identifier in the first place).
export const RUBY_KEYWORDS = new Set([
  "__ENCODING__", "__LINE__", "__FILE__", "BEGIN", "END", "alias", "and", "begin", "break", "case",
  "class", "def", "do", "else", "elsif", "end", "ensure", "false", "for", "if", "in", "module",
  "next", "nil", "not", "or", "redo", "rescue", "retry", "return", "self", "super", "then", "true",
  "undef", "unless", "until", "when", "while", "yield",
]);

// Core Ruby/stdlib constant names - not reserved words, but a generated class/module named e.g.
// "String" or "Object" would shadow the real one inside its own file (and anywhere requiring it).
// Soft/cosmetic-safety measure, applied only to type-declaration (class/module) names.
export const RUBY_CORE_CONSTANTS = new Set([
  "Object", "String", "Array", "Hash", "Integer", "Float", "Numeric", "Symbol", "Kernel", "Class",
  "Module", "Comparable", "Enumerable", "NilClass", "TrueClass", "FalseClass", "Struct", "Time",
  "Range", "Regexp", "Proc", "Method", "Exception", "StandardError", "IO", "File", "Dir", "Math",
  "Data",
]);

export function escapeKeyword(name) {
  return RUBY_KEYWORDS.has(name) ? name + "_" : name;
}

export function escapeShadowingConstant(name) {
  return RUBY_CORE_CONSTANTS.has(name) ? name + "_" : name;
}
