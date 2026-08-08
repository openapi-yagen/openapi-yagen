// Scans one or more TS type strings (e.g. "Pet[]", "Record<string, Tag>", "Circle | Square") for
// references to other registered models, so a generated file (a model referencing another model,
// or an api_client.ts.j2 referencing the models it uses) knows what to import. A plain
// word-boundary regex is sufficient - every registered model name is a PascalCase identifier
// (letters/digits only, see lib/naming.js's typeName), so no other token in a generated type
// string can accidentally match one.
export function collectReferencedModelNames(typeStrings, registry, excludeName) {
  const found = new Set();
  for (const name of registry.order) {
    if (name === excludeName) continue;
    const re = new RegExp(`\\b${name}\\b`);
    if (typeStrings.some((t) => re.test(t))) found.add(name);
  }
  return Array.from(found).sort();
}
