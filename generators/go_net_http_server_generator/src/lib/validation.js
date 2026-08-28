// Builds each object model property's Validate() statements from its already-collected
// constraintsOf() result - kept as plain Go statement strings so model_struct.go.j2 stays a flat
// printer (see lib/types.js's finalizeModels, which calls attachValidationCalls once the whole
// registry - and each property's pointer/omitempty decision - is known).
//
// Scope matches this project's other generators: minimum/maximum and minLength/maxLength/pattern
// only - not the full JSON Schema constraint vocabulary.

import { toGoStringLiteral } from "./keywords.js";

// requireMin/requireMax take *T (T constrained to Go's numeric types, see validation.go) so a
// single generic function covers every numeric Go type this generator emits. A non-pointer
// (required, non-nullable) property has no nil case to skip, but the same *T signature still
// applies - passing its address costs nothing and needs no separate non-pointer overload.
function numExpr(p) {
  return p.pointer ? `v.${p.goName}` : `&v.${p.goName}`;
}

function strExpr(p) {
  return p.pointer ? `v.${p.goName}` : `&v.${p.goName}`;
}

// Every "object"/"union" model kind has its own generated Validate() (see types.js's
// modelHasValidate, duplicated here in one-line form to avoid a validation.js <-> types.js import
// cycle - types.js already imports attachValidationCalls from this file).
function hasValidateMethod(model) {
  return !!model && (model.kind === "object" || model.kind === "union");
}

// A `[]T`/`map[string]T` property's element type (as it strips down to nothing left to strip);
// a plain (non-container) property's own type unwraps to itself, one field per container flavor -
// each drives a differently-shaped generated loop/nil-check in nestedValidateCall below. Resolves
// through a named "alias" model first (e.g. `type TagSet []Tag`, from a top-level array/map schema
// - see types.js's registerTopLevel) - the property's own printed Go type stays the alias name
// either way (TagSet ranges/indexes exactly like []Tag), only the container-shape *decision* needs
// to see through it. Mirrors types.js's isRefType, which resolves the same alias chain for a
// different purpose (pointer/omitempty decisions).
function unwrapContainer(registry, type) {
  if (type.startsWith("[]")) return { container: "slice", elem: type.slice(2) };
  if (type.startsWith("map[string]")) return { container: "map", elem: type.slice("map[string]".length) };
  const model = registry.models.get(type);
  if (model && model.kind === "alias") return unwrapContainer(registry, model.targetType);
  return { container: "scalar", elem: type };
}

// A struct-typed (or oneOf/anyOf-typed) property's own Validate() needs to run wherever this
// property's declared type resolves to a model that has one - directly, or through every element
// of a slice/map. `prefixValidationField` (models/validation.go) rewraps a nested *ValidationError
// so its Field reports the full path from the outermost struct (e.g. "shapes[2].radius") - each
// struct hop the error bubbles through prefixes its own field name once, composing correctly
// across multiple levels of nesting.
function nestedValidateCall(registry, prop) {
  const { container, elem } = unwrapContainer(registry, prop.type);
  if (!hasValidateMethod(registry.models.get(elem))) return null;
  const fieldLit = toGoStringLiteral(prop.wireName);
  if (container === "slice") {
    return (
      `for i := range v.${prop.goName} {\n` +
      `\tif err := v.${prop.goName}[i].Validate(); err != nil {\n` +
      `\t\treturn prefixValidationField(err, fmt.Sprintf("%s[%d]", ${fieldLit}, i))\n` +
      `\t}\n` +
      `}`
    );
  }
  if (container === "map") {
    return (
      `for k, item := range v.${prop.goName} {\n` +
      `\tif err := item.Validate(); err != nil {\n` +
      `\t\treturn prefixValidationField(err, fmt.Sprintf("%s[%q]", ${fieldLit}, k))\n` +
      `\t}\n` +
      `}`
    );
  }
  const call = `if err := v.${prop.goName}.Validate(); err != nil {\n\treturn prefixValidationField(err, ${fieldLit})\n}`;
  if (!prop.pointer) return call;
  return `if v.${prop.goName} != nil {\n\t${call.replace(/\n/g, "\n\t")}\n}`;
}

export function attachValidationCalls(registry, prop) {
  const c = prop.constraints || {};
  const calls = [];
  if (c.minimum !== undefined) {
    calls.push(`if err := requireMin(${numExpr(prop)}, ${c.minimum}, ${toGoStringLiteral(prop.wireName)}); err != nil {\n\treturn err\n}`);
  }
  if (c.maximum !== undefined) {
    calls.push(`if err := requireMax(${numExpr(prop)}, ${c.maximum}, ${toGoStringLiteral(prop.wireName)}); err != nil {\n\treturn err\n}`);
  }
  if (c.minLength !== undefined) {
    calls.push(`if err := requireMinLength(${strExpr(prop)}, ${c.minLength}, ${toGoStringLiteral(prop.wireName)}); err != nil {\n\treturn err\n}`);
  }
  if (c.maxLength !== undefined) {
    calls.push(`if err := requireMaxLength(${strExpr(prop)}, ${c.maxLength}, ${toGoStringLiteral(prop.wireName)}); err != nil {\n\treturn err\n}`);
  }
  if (c.pattern !== undefined) {
    calls.push(`if err := requirePattern(${strExpr(prop)}, ${toGoStringLiteral(c.pattern)}, ${toGoStringLiteral(prop.wireName)}); err != nil {\n\treturn err\n}`);
  }
  if (prop.format === "uuid") {
    calls.push(`if err := requireUUID(${strExpr(prop)}, ${toGoStringLiteral(prop.wireName)}); err != nil {\n\treturn err\n}`);
  }
  if (prop.format === "date") {
    calls.push(`if err := requireDate(${strExpr(prop)}, ${toGoStringLiteral(prop.wireName)}); err != nil {\n\treturn err\n}`);
  }
  const nested = nestedValidateCall(registry, prop);
  if (nested) calls.push(nested);
  prop.validationCalls = calls;
  prop.hasNestedValidate = !!nested;
}
