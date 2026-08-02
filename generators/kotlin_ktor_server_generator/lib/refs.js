// Local-only JSON-pointer $ref resolver. The generator core does not resolve $ref itself -
// it hands the raw parsed spec to JS verbatim - so every generator has to do this on its own.

function decodeToken(token) {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

export function resolveRef(root, ref) {
  if (!ref.startsWith("#/")) {
    throw Error(`<a1c9e2f0> Only local refs (#/...) are supported: ${ref}`);
  }
  const parts = ref
    .slice(2)
    .split("/")
    .map(decodeToken);
  let node = root;
  for (const part of parts) {
    if (node == null || typeof node !== "object") {
      throw Error(`<b2dae3f1> Cannot resolve ref, path not found: ${ref}`);
    }
    node = node[part];
  }
  if (node === undefined) {
    throw Error(`<c3ebf4a2> Ref not found: ${ref}`);
  }
  return node;
}

// Resolves a possible {$ref: ...} node down to its target, following chained refs.
export function deref(root, schema) {
  let s = schema;
  let guard = 0;
  while (s && typeof s === "object" && typeof s["$ref"] === "string") {
    s = resolveRef(root, s["$ref"]);
    guard++;
    if (guard > 50) {
      throw Error(`<d4fca5b3> Too many nested $ref, possible cycle`);
    }
  }
  return s;
}

// Trailing path segment of a ref, e.g. "#/components/schemas/Pet" -> "Pet"
export function refName(ref) {
  const parts = ref.split("/");
  return parts[parts.length - 1];
}
