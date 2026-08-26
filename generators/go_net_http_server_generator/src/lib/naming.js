// Naming helpers built on top of the generator core's built-in toCamelCase/toPascalCase/
// sanitizeIdentifier globals, plus Go keyword escaping.

import { escapeKeyword } from "./keywords.js";

// Exported (PascalCase) Go identifier for a type name - struct/enum/interface names always need to
// be exported since models are read across package boundaries (client/server import models).
export function typeName(name) {
  const n = toPascalCase(String(name));
  return sanitizeIdentifier(n.length ? n : "Model");
}

// Returns { goName, wireName, needsTag } for a struct field derived from a wire property name.
// goName is always exported (PascalCase) - encoding/json can only marshal exported fields.
export function fieldName(name) {
  const pascal = toPascalCase(String(name));
  const sanitized = sanitizeIdentifier(pascal.length ? pascal : "Value");
  const goName = escapeKeyword(sanitized);
  return { goName, wireName: String(name), needsTag: goName !== String(name) };
}

// Identifiers a generated function signature/body always introduces on its own - the client
// method receiver/context/body parameter and the error variable every call site reuses ("c",
// "ctx", "body", "err"), and the server route wrapper's fixed closure parameters/registration
// arguments ("w", "r", "mux", "handler", "onError"). A wire parameter/field name that happens to
// sanitize to one of these would otherwise collide with it (e.g. a query parameter literally
// named "body" - this has shown up in a real-world spec).
const RESERVED_LOCAL_NAMES = new Set(["ctx", "body", "c", "err", "w", "r", "mux", "handler", "onError"]);

// Unexported (camelCase) Go identifier for a local variable/function parameter name.
export function paramName(name) {
  const camel = toCamelCase(String(name));
  const sanitized = sanitizeIdentifier(camel.length ? camel : "value");
  const escaped = escapeKeyword(sanitized);
  return RESERVED_LOCAL_NAMES.has(escaped) ? escaped + "Param" : escaped;
}

// Go has no per-type-scoped enum constants (unlike Kotlin's `EnumClass.CONSTANT`) - every constant
// lives in the package's flat scope, so it's prefixed with its enum type's own name to avoid
// collisions between two different enums that happen to share a member name (e.g. two enums each
// with an "Active" value).
export function enumConstantName(modelTypeName, value) {
  const pascal = toPascalCase(String(value));
  const sanitized = sanitizeIdentifier(pascal.length ? pascal : "Value");
  return escapeKeyword(modelTypeName + sanitized);
}

// Exported (PascalCase) Go identifier for a client method / handler interface method name.
export function operationName(method, pathStr, operationId) {
  let camel;
  if (operationId) {
    camel = toPascalCase(operationId);
  } else {
    const segments = pathStr
      .split("/")
      .filter((s) => s.length > 0)
      .map((s) => s.replace(/[{}]/g, ""));
    camel = toPascalCase(method + "_" + segments.join("_"));
  }
  return escapeKeyword(sanitizeIdentifier(camel.length ? camel : toPascalCase(method)));
}
