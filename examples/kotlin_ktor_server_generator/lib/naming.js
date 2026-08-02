// Naming helpers built on top of the generator core's built-in toCamelCase/toPascalCase/
// toScreamingSnakeCase globals (see lib/generator/functions.cpp in the core) plus Kotlin
// identifier sanitization/keyword escaping.

import { sanitizeIdentifier, escapeKeyword } from "./keywords.js";

// Case converters split words on _-. and space plus lower->upper transitions, but don't treat
// other punctuation (e.g. "x-next", "pet/status") as delimiters - normalize those to spaces first.
function normalizeForCase(name) {
  return String(name).replace(/[^A-Za-z0-9_\-. ]/g, " ");
}

export function className(name) {
  const n = toPascalCase(normalizeForCase(name));
  return sanitizeIdentifier(n.length ? n : "Model");
}

// Returns { kotlinName, needsSerialName } for a wire property/parameter name.
export function fieldName(name) {
  const camel = toCamelCase(normalizeForCase(name));
  const sanitized = sanitizeIdentifier(camel.length ? camel : "value");
  const kotlinName = escapeKeyword(sanitized);
  return { kotlinName, needsSerialName: sanitized !== String(name) };
}

export function enumConstantName(value) {
  const s = String(value);
  const screaming = toScreamingSnakeCase(normalizeForCase(s));
  return sanitizeIdentifier(screaming.length ? screaming : "VALUE");
}

export function packageNameToPath(pkg) {
  return String(pkg).split(".").join("/");
}

export function operationName(method, pathStr, operationId) {
  let camel;
  if (operationId) {
    camel = toCamelCase(normalizeForCase(operationId));
  } else {
    const segments = pathStr
      .split("/")
      .filter((s) => s.length > 0)
      .map((s) => s.replace(/[{}]/g, ""));
    camel = toCamelCase(normalizeForCase(method + "_" + segments.join("_")));
  }
  return escapeKeyword(sanitizeIdentifier(camel.length ? camel : method));
}
