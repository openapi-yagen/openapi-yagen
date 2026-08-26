// Builds Python expression/statement source for converting between a parsed-JSON value (plain
// dict/list/str/int/float/bool/None, as json.loads would return it) and its properly-typed Python
// value, and for validating a value against its schema's OpenAPI-level constraints - mirroring
// ../../ruby_faraday_client_generator/src/lib/serialization.js's buildFromHExpr/buildToWireExpr/
// buildValidateStatements, adapted for this generator's simpler v1 descriptor shape (see
// lib/types.js's header comment: only "ref" descriptors that point at a class ever appear here,
// since Map/Array/primitive-kind schemas resolve to their own structural descriptor directly
// instead of an opaque ref needing runtime dispatch).
//
//   { kind: "primitive", pyType: "str" | "int" | "float" | "bool" }
//   { kind: "unknown" }                    // free-form/any - identity, no wrapping
//   { kind: "ref", refName: <name> }       // a registered dataclass - has its own from_wire/to_wire/validate
//   { kind: "array", item: <descriptor> }
//   { kind: "record", value: <descriptor> | null }   // null = untyped Dict[str, Any], no per-value walk
//
// Per AGENTS.md's "a generator for a dynamically-typed target language must generate its own
// runtime checks" convention (Python is explicitly named there as a future case, alongside Ruby -
// the reference implementation these functions mirror). Validation only ever runs against
// *incoming* values (request parameters/bodies) - like the sibling generators, a handler's
// outgoing return value isn't validated, since it's constructed by trusted server-side code, not
// an untrusted caller.
//
// Multi-statement (array/record) validation blocks are generated as multi-line Python source using
// a 4-space RELATIVE indent per nesting level, starting at column 0 on their own first line -
// templates place them with Inja's indent() filter (see docs/templating.md), which shifts every
// line but the first by the call site's own indentation, preserving this relative structure. This
// is the same "generate structurally, let the template's indent() do the alignment" split every
// other generator in this repo uses for multi-line generated blocks.

import { escapePythonString } from "./keywords.js";

// Prefixes EVERY line of EVERY statement in `statements` with `prefix` and joins them with a plain
// "\n" (the prefix already accounts for the newline-separated join, unlike a naive
// `statements.join("\n" + prefix)`, which would only prefix the first line of any statement that's
// itself already multi-line - e.g. a nested array-of-record validate block - leaving its inner
// lines under-indented relative to the block they're now nested inside).
function indentAll(statements, prefix) {
  return statements
    .map((s) =>
      s
        .split("\n")
        .map((line) => prefix + line)
        .join("\n")
    )
    .join("\n");
}

export function buildFromWireExpr(descriptor, expr, depth = 0) {
  switch (descriptor.kind) {
    case "ref":
      return `${descriptor.refName}.from_wire(${expr})`;
    case "array": {
      const v = `item${depth}`;
      const inner = buildFromWireExpr(descriptor.item, v, depth + 1);
      return `([${inner} for ${v} in ${expr}] if ${expr} is not None else None)`;
    }
    case "record": {
      if (!descriptor.value) return expr;
      const k = `k${depth}`;
      const v = `v${depth}`;
      const inner = buildFromWireExpr(descriptor.value, v, depth + 1);
      return `({${k}: ${inner} for ${k}, ${v} in ${expr}.items()} if ${expr} is not None else None)`;
    }
    case "primitive":
    case "unknown":
    default:
      return expr;
  }
}

export function buildToWireExpr(descriptor, expr, depth = 0) {
  switch (descriptor.kind) {
    case "ref":
      return `${descriptor.refName}.to_wire(${expr})`;
    case "array": {
      const v = `item${depth}`;
      const inner = buildToWireExpr(descriptor.item, v, depth + 1);
      return `([${inner} for ${v} in ${expr}] if ${expr} is not None else None)`;
    }
    case "record": {
      if (!descriptor.value) return expr;
      const k = `k${depth}`;
      const v = `v${depth}`;
      const inner = buildToWireExpr(descriptor.value, v, depth + 1);
      return `({${k}: ${inner} for ${k}, ${v} in ${expr}.items()} if ${expr} is not None else None)`;
    }
    case "primitive":
    case "unknown":
    default:
      return expr;
  }
}

// Builds Python statement(s) validating `expr` against `schema`'s OpenAPI-level constraints (the
// engine's constraintsOf() plus `const`), recursing through "array"/"record" descriptor positions
// the same way buildFromWireExpr/buildToWireExpr do. Used to generate each model's validate() (see
// templates/model_dataclass.py.j2).
export function buildValidateStatements(descriptor, schema, expr, fieldLabel, depth = 0) {
  const statements = [];
  const resolved = unwrapSchema(schema || {});
  const c = constraintsOf(resolved);
  const field = escapePythonString(fieldLabel);

  // A property with NO constraintsOf() keywords at all (a bare `type: integer`) would otherwise
  // get no check at all - Python has no compiler to catch a wrong-shaped value the way the
  // TypeScript/Kotlin generators' static types do, so a basic type check is generated
  // unconditionally for every primitive-kind position, same as the Ruby generator's own
  // require_type/require_boolean.
  if (descriptor.kind === "primitive") {
    if (resolved.type === "string") statements.push(`runtime.require_str(${expr}, ${field})`);
    else if (resolved.type === "integer") statements.push(`runtime.require_int(${expr}, ${field})`);
    else if (resolved.type === "number") statements.push(`runtime.require_float(${expr}, ${field})`);
    else if (resolved.type === "boolean") statements.push(`runtime.require_bool(${expr}, ${field})`);
  }

  if (resolved.const !== undefined) statements.push(`runtime.require_const(${expr}, ${JSON.stringify(resolved.const)}, ${field})`);

  if (c.minLength != null) statements.push(`runtime.require_min_length(${expr}, ${c.minLength}, ${field})`);
  if (c.maxLength != null) statements.push(`runtime.require_max_length(${expr}, ${c.maxLength}, ${field})`);
  if (c.pattern != null) statements.push(`runtime.require_pattern(${expr}, ${escapePythonString(c.pattern)}, ${field})`);
  if (c.minimum != null) statements.push(`runtime.require_min(${expr}, ${c.minimum}, ${field})`);
  if (c.maximum != null) statements.push(`runtime.require_max(${expr}, ${c.maximum}, ${field})`);
  if (c.exclusiveMinimum != null) statements.push(`runtime.require_exclusive_min(${expr}, ${c.exclusiveMinimum}, ${field})`);
  if (c.exclusiveMaximum != null) statements.push(`runtime.require_exclusive_max(${expr}, ${c.exclusiveMaximum}, ${field})`);
  if (c.multipleOf != null) statements.push(`runtime.require_multiple_of(${expr}, ${c.multipleOf}, ${field})`);
  if (c.minItems != null) statements.push(`runtime.require_min_items(${expr}, ${c.minItems}, ${field})`);
  if (c.maxItems != null) statements.push(`runtime.require_max_items(${expr}, ${c.maxItems}, ${field})`);
  if (c.uniqueItems) statements.push(`runtime.require_unique_items(${expr}, ${field})`);
  if (c.minProperties != null) statements.push(`runtime.require_min_properties(${expr}, ${c.minProperties}, ${field})`);
  if (c.maxProperties != null) statements.push(`runtime.require_max_properties(${expr}, ${c.maxProperties}, ${field})`);

  if (descriptor.kind === "ref") {
    // A dataclass/enum "ref" always has its own validate() - but a *union* "ref" can point at a
    // bare primitive value at runtime (e.g. the `str` variant of an undiscriminated oneOf/anyOf),
    // which has none - hasattr() guards against calling .validate() on a value that doesn't define
    // it, without needing a separate descriptor kind just for unions.
    statements.push(`if ${expr} is not None and hasattr(${expr}, "validate"): ${expr}.validate()`);
  } else if (descriptor.kind === "array") {
    const itemVar = `item${depth}`;
    const itemStatements = buildValidateStatements(descriptor.item, (resolved && resolved.items) || {}, itemVar, fieldLabel, depth + 1);
    if (itemStatements.length > 0) {
      statements.push(`if ${expr} is not None:\n    for ${itemVar} in ${expr}:\n${indentAll(itemStatements, "        ")}`);
    }
  } else if (descriptor.kind === "record" && descriptor.value) {
    const valueVar = `v${depth}`;
    const valueSchema = (resolved && typeof resolved.additionalProperties === "object" && resolved.additionalProperties) || {};
    const valueStatements = buildValidateStatements(descriptor.value, valueSchema, valueVar, fieldLabel, depth + 1);
    if (valueStatements.length > 0) {
      statements.push(`if ${expr} is not None:\n    for ${valueVar} in ${expr}.values():\n${indentAll(valueStatements, "        ")}`);
    }
  }

  return statements;
}
