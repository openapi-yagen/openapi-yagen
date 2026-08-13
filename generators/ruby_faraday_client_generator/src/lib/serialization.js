// Builds Ruby expression source for converting between a parsed-JSON value (plain Hash/Array/
// String/Numeric/true/false/nil, as JSON.parse would return it) and its properly-typed Ruby value
// (a generated model instance, recursively for nested arrays/hashes/models).
//
// Ruby has no compile-time type system and no annotation-driven (de)serialization framework (the
// way Kotlin leans on kotlinx.serialization) - unlike either sibling generator, this one must
// hand-write the recursive (de)serialization walk itself. It does so by walking the same
// structural "descriptor" tree lib/types.js's rubyType() already builds (deliberately the same
// shape as the TypeScript generator's lib/validation.js descriptor, which solves the analogous
// "walk a structural type description to build a recursive expression" problem):
//
//   { kind: "primitive" }                 // string/integer/number/boolean - identity, no wrapping
//   { kind: "unknown" }                   // free-form/any - identity, no wrapping
//   { kind: "ref", refName: <name> }      // another registered model - has its own from_h/to_wire
//   { kind: "array", item: <descriptor> }
//   { kind: "record", value: <descriptor> | null }   // null = untyped Hash, no per-value walk
//
// Every registered model (plain class, enum module, or union dispatch module - see lib/types.js)
// exposes the same two class/module-level methods, regardless of which kind it is:
//   self.from_h(wire_value)   -> typed Ruby value (nil-safe: nil in, nil out)
//   self.to_wire(ruby_value)  -> wire-shaped value (nil-safe: nil in, nil out)
// which is exactly what makes a "ref" descriptor uniform here no matter what it points to - the
// caller never needs to know whether it's an object class, an enum, or a oneOf/anyOf dispatcher.

export function buildFromHExpr(descriptor, expr, depth = 0) {
  switch (descriptor.kind) {
    case "ref":
      return `${descriptor.refName}.from_h(${expr})`;
    case "array": {
      const v = `item${depth}`;
      return `${expr}&.map { |${v}| ${buildFromHExpr(descriptor.item, v, depth + 1)} }`;
    }
    case "record": {
      if (!descriptor.value) return expr;
      const v = `v${depth}`;
      return `${expr}&.transform_values { |${v}| ${buildFromHExpr(descriptor.value, v, depth + 1)} }`;
    }
    case "primitive":
    case "unknown":
    default:
      return expr;
  }
}

// Builds Ruby statements validating `expr` against `schema`'s OpenAPI-level constraints (the
// engine's constraintsOf() - minLength/maxLength/pattern/minimum/maximum/exclusiveMinimum/
// exclusiveMaximum/multipleOf/minItems/maxItems/uniqueItems), recursing through "array"/"record"
// descriptor positions the same way buildFromHExpr/buildToWireExpr do. Used to generate each
// model's validate! (see templates/model_class.rb.j2) - part of this generator's answer to
// AGENTS.md's "a generator for a dynamically-typed target language must generate its own runtime
// checks" convention (Ruby has no compiler to reject a wrong-shaped/out-of-spec value the way the
// TypeScript/Kotlin generators' static types do).
//
// A "ref" descriptor delegates differently depending on what it points at - there's no uniform
// "validate this" call every registered kind exposes the same way (unlike from_h/to_wire).
// Dispatches on `kindOf(schema)` directly (not a `registry.models.get(...)` lookup, deliberately -
// a $ref'd schema not yet processed by buildModelRegistry's own top-level walk wouldn't be in the
// registry yet when this runs, since a property can easily reference a schema declared *later* in
// components.schemas; kindOf works on the schema itself, already $ref-resolved by the engine, so
// it needs no registration-order guarantee):
//   - kindOf "Object"/"AllOf" (registers as a class): `expr&.validate!` (recurses into that
//     instance's own generated method).
//   - kindOf "Enum": an inline `ALL_VALUES.include?` membership check.
//   - anything else (a union - "OneOf"/"AnyOf" - or a plain alias): not deep-validated here - see
//     this generator's README "Known limitations". A wrong/unmatched value there still surfaces,
//     just one step later, from that union's own strengthened to_wire instead of from validate!.
//
// `unwrapSchema` mirrors what rubyType() itself already unwraps through (a single-branch
// oneOf/anyOf/allOf around the real schema) so constraintsOf/kindOf read from the same effective
// schema position `descriptor` was resolved from - constraints declared directly alongside a
// `$ref` (rather than on the referenced schema itself) aren't picked up, same "handles the common
// case" scope as the rest of this generator.
export function buildValidateStatements(descriptor, schema, expr, fieldLabel, depth = 0) {
  const statements = [];
  const resolved = unwrapSchema(schema || {});
  const c = constraintsOf(resolved);
  const field = toStringLiteral(fieldLabel);

  // A property with NO constraintsOf() keywords at all (a bare `type: integer`, no minimum/
  // maximum/...) would otherwise get an empty validate! - which looks like validation silently
  // does nothing, when what's actually missing is a basic type check TypeScript/Kotlin get for
  // free from their own compiler and this generator needs to generate explicitly instead. Checked
  // first so a wrong-typed value fails with a clear TypeError here rather than a confusing
  // NoMethodError from one of the constraint helpers below (e.g. require_min_length calling
  // .length on an Integer).
  if (descriptor.kind === "primitive") {
    if (resolved.type === "string") statements.push(`OpenapiYagenRuntime.require_type(${expr}, String, ${field})`);
    else if (resolved.type === "integer") statements.push(`OpenapiYagenRuntime.require_type(${expr}, Integer, ${field})`);
    else if (resolved.type === "number") statements.push(`OpenapiYagenRuntime.require_type(${expr}, Numeric, ${field})`);
    else if (resolved.type === "boolean") statements.push(`OpenapiYagenRuntime.require_boolean(${expr}, ${field})`);
  }

  if (c.minLength != null) statements.push(`OpenapiYagenRuntime.require_min_length(${expr}, ${c.minLength}, ${field})`);
  if (c.maxLength != null) statements.push(`OpenapiYagenRuntime.require_max_length(${expr}, ${c.maxLength}, ${field})`);
  if (c.pattern != null) statements.push(`OpenapiYagenRuntime.require_pattern(${expr}, ${toStringLiteral(c.pattern)}, ${field})`);
  if (c.minimum != null) statements.push(`OpenapiYagenRuntime.require_min(${expr}, ${c.minimum}, ${field})`);
  if (c.maximum != null) statements.push(`OpenapiYagenRuntime.require_max(${expr}, ${c.maximum}, ${field})`);
  if (c.exclusiveMinimum != null) statements.push(`OpenapiYagenRuntime.require_exclusive_min(${expr}, ${c.exclusiveMinimum}, ${field})`);
  if (c.exclusiveMaximum != null) statements.push(`OpenapiYagenRuntime.require_exclusive_max(${expr}, ${c.exclusiveMaximum}, ${field})`);
  if (c.multipleOf != null) statements.push(`OpenapiYagenRuntime.require_multiple_of(${expr}, ${c.multipleOf}, ${field})`);
  if (c.minItems != null) statements.push(`OpenapiYagenRuntime.require_min_items(${expr}, ${c.minItems}, ${field})`);
  if (c.maxItems != null) statements.push(`OpenapiYagenRuntime.require_max_items(${expr}, ${c.maxItems}, ${field})`);
  if (c.uniqueItems) statements.push(`OpenapiYagenRuntime.require_unique_items(${expr}, ${field})`);

  if (descriptor.kind === "ref") {
    const kind = kindOf(resolved);
    if (kind === "Object" || kind === "AllOf") {
      statements.push(`${expr}&.validate!`);
    } else if (kind === "Enum") {
      statements.push(`OpenapiYagenRuntime.require_enum(${expr}, ${descriptor.refName}::ALL_VALUES, ${field})`);
    }
  } else if (descriptor.kind === "array") {
    const itemVar = `item${depth}`;
    const itemStatements = buildValidateStatements(descriptor.item, (resolved && resolved.items) || {}, itemVar, fieldLabel, depth + 1);
    if (itemStatements.length > 0) statements.push(`${expr}&.each { |${itemVar}| ${itemStatements.join("; ")} }`);
  } else if (descriptor.kind === "record" && descriptor.value) {
    const valueVar = `v${depth}`;
    const valueSchema = (resolved && typeof resolved.additionalProperties === "object" && resolved.additionalProperties) || {};
    const valueStatements = buildValidateStatements(descriptor.value, valueSchema, valueVar, fieldLabel, depth + 1);
    if (valueStatements.length > 0) statements.push(`${expr}&.each_value { |${valueVar}| ${valueStatements.join("; ")} }`);
  }

  return statements;
}

export function buildToWireExpr(descriptor, expr, depth = 0) {
  switch (descriptor.kind) {
    case "ref":
      return `${descriptor.refName}.to_wire(${expr})`;
    case "array": {
      const v = `item${depth}`;
      return `${expr}&.map { |${v}| ${buildToWireExpr(descriptor.item, v, depth + 1)} }`;
    }
    case "record": {
      if (!descriptor.value) return expr;
      const v = `v${depth}`;
      return `${expr}&.transform_values { |${v}| ${buildToWireExpr(descriptor.value, v, depth + 1)} }`;
    }
    case "primitive":
    case "unknown":
    default:
      return expr;
  }
}
