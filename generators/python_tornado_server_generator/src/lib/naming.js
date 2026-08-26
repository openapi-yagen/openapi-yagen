// Naming helpers built on top of the generator core's built-in toPascalCase/toSnakeCase/
// sanitizeIdentifier globals (see lib/generator/functions.cpp in the core) plus Python keyword
// escaping (see ./keywords.js).

import { escapeKeyword } from "./keywords.js";

// Class names (models, handler interfaces, RequestHandler subclasses): PascalCase, Python's own
// convention (PEP 8) for class names.
export function className(name) {
  const n = toPascalCase(String(name));
  return sanitizeIdentifier(n.length ? n : "Model");
}

// Field/property/parameter/method names: snake_case, Python's own convention for everything else.
export function fieldName(name) {
  const snake = toSnakeCase(String(name));
  const sanitized = sanitizeIdentifier(snake.length ? snake : "value");
  return escapeKeyword(sanitized);
}

// Module (file) names: snake_case, matching fieldName - `models/<moduleName>.py`,
// `apis/<moduleName>.py`. Doesn't need keyword escaping (a module named `class.py` is imported as
// `import class` only via `class_`-style aliasing anyway, and none of this generator's own tag/
// schema-derived names collide with a keyword in practice) - sanitizeIdentifier alone is enough to
// guarantee a valid module name.
export function moduleName(name) {
  const snake = toSnakeCase(String(name));
  return sanitizeIdentifier(snake.length ? snake : "value");
}

export function operationName(method, pathStr, operationId) {
  let base;
  if (operationId) {
    base = operationId;
  } else {
    const segments = pathStr
      .split("/")
      .filter((s) => s.length > 0)
      .map((s) => s.replace(/[{}]/g, ""));
    base = method + "_" + segments.join("_");
  }
  const snake = toSnakeCase(base);
  return escapeKeyword(sanitizeIdentifier(snake.length ? snake : method));
}
