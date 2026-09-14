// Naming helpers built on top of the generator core's built-in toPascalCase/toSnakeCase/
// toScreamingSnakeCase/sanitizeIdentifier globals (see lib/generator/functions.cpp in the core)
// plus Ruby keyword/constant-shadowing escaping (./keywords.js).
//
// Unlike the TypeScript generator (structural typing, no (de)serialization layer - see that
// generator's lib/naming.js), Ruby property names ARE case-converted (wire "pet_name"/"petName"
// becomes the Ruby-idiomatic snake_case accessor either way) because every model hand-writes its
// own to_h/from_h - same reason the Kotlin generator case-converts via @SerialName remapping.
// fieldName() below returns both names so a template can always emit the wire literal used as the
// JSON hash key.

import { escapeKeyword, escapeShadowingConstant } from "./keywords.js";

// A class/module declaration name (model class, enum module, union dispatch module).
export function className(name) {
  const pascal = toPascalCase(String(name));
  const sanitized = sanitizeIdentifier(pascal.length ? pascal : "Model");
  // Ruby constants must start with an uppercase letter - sanitizeIdentifier's own fallback for a
  // digit-leading/empty result is a leading "_", which isn't valid there (unlike a local variable).
  const capitalized = /^[A-Z]/.test(sanitized) ? sanitized : "Model" + sanitized;
  return escapeShadowingConstant(capitalized);
}

// Returns { rubyName, wireLiteral } for a wire property name. wireLiteral is always the exact
// wire-format string (as a Ruby string literal), used as the to_h/from_h hash key regardless of
// what rubyName became.
export function fieldName(name) {
  const snake = toSnakeCase(String(name));
  const sanitized = sanitizeIdentifier(snake.length ? snake : "value");
  const rubyName = escapeKeyword(sanitized);
  return { rubyName, wireLiteral: toStringLiteral(String(name)) };
}

export function enumConstantName(value) {
  const s = String(value);
  const screaming = toScreamingSnakeCase(s);
  const sanitized = sanitizeIdentifier(screaming.length ? screaming : "VALUE");
  return /^[A-Za-z]/.test(sanitized) ? sanitized : "VALUE_" + sanitized;
}

// Caller-facing snake_case identifier (method/keyword-argument name) - NOT for wire property/
// query/header names, which stay verbatim wire strings (see fieldName's wireLiteral).
export function paramName(name) {
  const snake = toSnakeCase(String(name));
  const sanitized = sanitizeIdentifier(snake.length ? snake : "value");
  return escapeKeyword(sanitized);
}

export function operationName(method, pathStr, operationId) {
  let snake;
  if (operationId) {
    snake = toSnakeCase(operationId);
  } else {
    const segments = pathStr
      .split("/")
      .filter((s) => s.length > 0)
      .map((s) => s.replace(/[{}]/g, ""));
    snake = toSnakeCase(method + "_" + segments.join("_"));
  }
  return escapeKeyword(sanitizeIdentifier(snake.length ? snake : method));
}
