// Naming helpers built on top of the generator core's built-in toCamelCase/toPascalCase/
// sanitizeIdentifier globals plus JS/TS keyword escaping (lib/keywords.js).
//
// Property/method names round-tripped through JSON.parse (object properties, wire query/header
// names) are handled separately by propertyKeyLiteral() below - they are NEVER case-converted
// (see lib/types.js's header comment for why: unlike Kotlin's @SerialName remapping, TS has no
// (de)serialization layer, so a generated property name must be the literal wire key or the type
// is structurally false). The helpers below are only for generator-invented identifiers that never
// round-trip through JSON: type/interface/enum declaration names, enum member names, and
// operation/parameter names on client classes.

import { escapeReservedIdentifier, escapeShadowingTypeName } from "./keywords.js";

export function typeName(name) {
  const n = toPascalCase(String(name));
  const base = sanitizeIdentifier(n.length ? n : "Model");
  return escapeShadowingTypeName(base);
}

// Caller-facing camelCase identifier (parameter/method name) - NOT for wire property/query/header
// names, which stay verbatim (see propertyKeyLiteral).
export function paramName(name) {
  const camel = toCamelCase(String(name));
  const sanitized = sanitizeIdentifier(camel.length ? camel : "value");
  return escapeReservedIdentifier(sanitized);
}

export function enumMemberName(value) {
  const s = String(value);
  const pascal = toPascalCase(s);
  if (pascal.length && /^[A-Za-z_]/.test(pascal)) return escapeReservedIdentifier(pascal);
  return "Value" + sanitizeIdentifier(s.replace(/[^A-Za-z0-9]/g, "_"));
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
  return escapeReservedIdentifier(sanitizeIdentifier(camel.length ? camel : method));
}

// A wire name (object property key, query param name, header name) as a quoted TS string-literal
// key/value - JSON.stringify doubles as a correct, safe TS/JS string-literal producer, so no
// hand-rolled escaping is needed (contrast Kotlin's escapeKotlinString/escapeKotlinStringContent).
export function propertyKeyLiteral(name) {
  return JSON.stringify(String(name));
}
