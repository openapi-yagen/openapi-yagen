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

export function attachValidationCalls(prop) {
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
  prop.validationCalls = calls;
}
