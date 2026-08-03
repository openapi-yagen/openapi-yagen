// Naming helpers built on top of the generator core's built-in toCamelCase/toPascalCase/
// toScreamingSnakeCase/sanitizeIdentifier globals (see lib/generator/functions.cpp in the core)
// plus Kotlin keyword escaping.

import { escapeKeyword } from "./keywords.js";

export function className(name) {
  const n = toPascalCase(String(name));
  return sanitizeIdentifier(n.length ? n : "Model");
}

// Returns { kotlinName, needsSerialName } for a wire property/parameter name.
export function fieldName(name) {
  const camel = toCamelCase(String(name));
  const sanitized = sanitizeIdentifier(camel.length ? camel : "value");
  const kotlinName = escapeKeyword(sanitized);
  return { kotlinName, needsSerialName: sanitized !== String(name) };
}

export function enumConstantName(value) {
  const s = String(value);
  const screaming = toScreamingSnakeCase(s);
  return sanitizeIdentifier(screaming.length ? screaming : "VALUE");
}

export function packageNameToPath(pkg) {
  return String(pkg).split(".").join("/");
}

export function operationName(method, pathStr, operationId) {
  let camel;
  if (operationId) {
    camel = toCamelCase(operationId);
  } else {
    const segments = pathStr
      .split("/")
      .filter((s) => s.length > 0)
      .map((s) => s.replace(/[{}]/g, ""));
    camel = toCamelCase(method + "_" + segments.join("_"));
  }
  return escapeKeyword(sanitizeIdentifier(camel.length ? camel : method));
}
