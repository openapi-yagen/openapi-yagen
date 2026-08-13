// Maps OpenAPI schemas to a registry of named Ruby models to render (see main.js), mirroring the
// shape of the sibling generators' lib/types.js (compare
// ../../../typescript_fetch_client_generator/src/lib/types.js and
// ../../../kotlin_ktor_client_generator/src/lib/types.js) but for a target with neither TS's
// structural erased typing nor Kotlin's annotation-driven serializer: every model here needs its
// own hand-generated from_h/to_wire (see lib/serialization.js), so rubyType() below returns not
// just a doc-comment-friendly label but the same kind of structural "descriptor" the TypeScript
// generator's optional validateResponses mode uses - except here it's load-bearing, not optional.
//
// A oneOf/anyOf becomes its own registered model no matter what (never inlined into a caller like
// a plain scalar/array would be), because Ruby needs *somewhere* to hang the runtime dispatch
// logic a discriminated/undiscriminated union requires - see registerUnionDiscriminated/
// registerUnionDispatch below and templates/model_union.rb.j2.

import { className, fieldName, enumConstantName } from "./naming.js";
import { buildFromHExpr, buildToWireExpr } from "./serialization.js";
import { withResilience } from "./strict.js";

function newRegistry(reservedNames) {
  return { models: new Map(), order: [], reservedNames };
}

// Disambiguates a hint-derived synthetic model name (an inline oneOf/anyOf/allOf/object with no
// $ref of its own) that collides with a REAL top-level schema's own generated name - see the
// TypeScript generator's lib/types.js (disambiguateHintName) for the real-world Stripe example
// this guards against. Uses the engine's disambiguateName() against `reservedNames` (every real
// top-level schema's generated name, computed once upfront), not `registry.models`, so revisiting
// the same hint name for the same inline schema still correctly reuses the earlier registration.
function disambiguateHintName(registry, candidate) {
  return disambiguateName(candidate, registry.reservedNames);
}

function addModel(registry, name, entry) {
  registry.models.set(name, entry);
  registry.order.push(name);
}

function registerClass(registry, name, schema) {
  if (registry.models.has(name)) return;
  const required = new Set(schema.required || []);
  const props = [];
  for (const [propName, propSchema] of Object.entries(schema.properties || {})) {
    const f = fieldName(propName);
    const t = rubyType(registry, propSchema, name + className(propName));
    props.push({
      rubyName: f.rubyName,
      wireLiteral: f.wireLiteral,
      descriptor: t.descriptor,
      label: t.label,
      required: required.has(propName),
      nullable: propSchema.nullable === true,
      description: propSchema.description || null,
      fromHExpr: buildFromHExpr(t.descriptor, `h[${f.wireLiteral}]`),
      toWireExpr: buildToWireExpr(t.descriptor, `@${f.rubyName}`),
    });
  }
  addModel(registry, name, { name, kind: "class", description: schema.description || null, properties: props });
}

function registerEnum(registry, name, schema) {
  if (registry.models.has(name)) return;
  const isNumeric = schema.type === "integer" || schema.type === "number";
  // A literal `null` entry (some real-world specs write `enum: [foo, bar, null]` alongside
  // `nullable: true`) isn't a real enum member - an optional/nullable property already allows a
  // bare JSON null without needing one of its own (see model_class.rb.j2 - required/nullable are
  // handled at the property level, same as the TypeScript generator's registerEnum).
  const entries = (schema.enum || [])
    .filter((v) => v !== null)
    .map((v) => ({ constantName: enumConstantName(v), valueLiteral: isNumeric ? String(v) : toStringLiteral(String(v)) }));
  addModel(registry, name, { name, kind: "enum", description: schema.description || null, entries });
}

// Flattens allOf branches into a single class (merged properties) - same "merge into one" choice
// as the TypeScript generator's registerMergedAllOf, for the same reason (allOf branches are
// frequently inline, not all named $refs). Uses the engine's flattenAllOf(), which recursively
// merges nested allOf branches.
function registerMergedAllOf(registry, name, schema) {
  if (registry.models.has(name)) return;
  const flat = flattenAllOf(schema);
  const merged = { type: "object", properties: flat.properties, required: flat.required, description: schema.description || null };
  registerClass(registry, name, merged);
}

// Registers a discriminated oneOf/anyOf (see the engine's resolveDiscriminator()) as a dispatch
// module: `<Name>.from_h(h)` reads `h[property]` and delegates to whichever variant class's own
// from_h matches; `<Name>.to_wire(value)` delegates to `value.class.to_wire(value)`, since every
// variant is itself a normal registered class exposing to_wire uniformly. No separate registration
// step is needed for the variants themselves (e.g. "Circle"/"Square") - they're ordinary top-level
// schemas, registered normally by buildModelRegistry's own pass 2 below.
function registerUnionDiscriminated(registry, name, schema, disc) {
  addModel(registry, name, {
    name,
    kind: "union_discriminated",
    description: schema.description || null,
    property: disc.property,
    variants: disc.variants.map((v) => ({ className: className(v.name), literal: v.literal })),
  });
}

// Ruby `case`/`when` class pattern matching a value of the engine-classified `dispatchKind`
// ("object"/"array"/"string"/"number"/"boolean"/"any" - see resolveUnionDispatch in
// docs/javascript-api.md). null means "matches anything" - the trailing `else` branch, never a
// `when` clause of its own.
function dispatchClassPattern(dispatchKind, descriptor) {
  switch (dispatchKind) {
    case "object":
      return descriptor.kind === "ref" ? descriptor.refName : "Hash";
    case "array":
      return "Array";
    case "string":
      return "String";
    case "number":
      return "Numeric";
    case "boolean":
      return "TrueClass, FalseClass";
    case "any":
    default:
      return null;
  }
}

// Registers an undiscriminated oneOf/anyOf (or a discriminated one the engine still couldn't
// resolve a mapping for) as a shape-dispatching module, using the engine's resolveUnionDispatch()
// - see docs/javascript-api.md for exactly what shapes/uniqueness it guarantees. Variants are
// reordered so the dispatch chain checks the most specific case first: object variants with their
// own distinguishing field, then other single-shape variants (array/string/number/boolean), then
// at most one shape-only/field-less fallback last - mirrors the Kotlin client generator's own
// dispatcher ordering (see that generator's model_union.kt.j2), adapted for Ruby's runtime
// `if`/`elsif` chain instead of a compile-time sealed interface.
// Ruby boolean expression testing whether raw (still-JSON-shaped) `value` belongs to a variant
// classified as `dispatchKind`/`dispatchField` - null means "matches anything" (only possible for
// dispatchKind "any", the unconstrained-schema catch-all), rendered as a plain `else` rather than
// an `if`/`elsif` guard.
function buildDispatchGuard(dispatchKind, dispatchField) {
  switch (dispatchKind) {
    case "object":
      return dispatchField ? `value.is_a?(Hash) && value.key?(${toStringLiteral(dispatchField)})` : "value.is_a?(Hash)";
    case "array":
      return "value.is_a?(Array)";
    case "string":
      return "value.is_a?(String)";
    case "number":
      return "value.is_a?(Numeric)";
    case "boolean":
      return "value == true || value == false";
    case "any":
    default:
      return null;
  }
}

function registerUnionDispatch(registry, name, schema) {
  if (registry.models.has(name)) return;
  const variants = schema.oneOf || schema.anyOf || [];
  const dispatch = resolveUnionDispatch(schema);
  const built = variants.map((variant, index) => {
    const variantRawName = nameOf(variant);
    const hint = name + (variantRawName ? className(variantRawName) : `Variant${index + 1}`);
    const t = rubyType(registry, variant, hint);
    const d = dispatch ? dispatch.variants[index] : { dispatchKind: "any", dispatchField: null };
    return {
      descriptor: t.descriptor,
      label: t.label,
      dispatchKind: d.dispatchKind,
      dispatchField: d.dispatchField,
      classPattern: dispatchClassPattern(d.dispatchKind, t.descriptor),
      guardExpr: buildDispatchGuard(d.dispatchKind, d.dispatchField),
      fromHExpr: buildFromHExpr(t.descriptor, "value"),
      toWireExpr: buildToWireExpr(t.descriptor, "value"),
    };
  });
  const withField = built.filter((v) => v.dispatchKind === "object" && v.dispatchField);
  const shapeOnly = built.filter((v) => ["array", "string", "number", "boolean"].includes(v.dispatchKind));
  const fallback = built.filter((v) => (v.dispatchKind === "object" && !v.dispatchField) || v.dispatchKind === "any");
  const orderedVariants = [...withField, ...shapeOnly, ...fallback];
  addModel(registry, name, {
    name,
    kind: "union_dispatch",
    description: schema.description || null,
    variants: orderedVariants,
    // true only when the last variant's guard is unconditional (dispatchKind "any") - see
    // buildDispatchGuard - meaning the generated from_h dispatch chain always terminates in a
    // matching branch and needs no further "no variant matched" safety-net `else`.
    hasUnconditionalFallback: orderedVariants.length > 0 && orderedVariants[orderedVariants.length - 1].guardExpr === null,
  });
}

function primitiveDescriptor(s) {
  const type = s.type;
  if (type === "string" || type === "integer" || type === "number" || type === "boolean") return { kind: "primitive" };
  return null;
}

function primitiveLabel(s) {
  if (s.type === "string") return "String";
  if (s.type === "integer") return "Integer";
  if (s.type === "number") return "Float";
  if (s.type === "boolean") return "Boolean";
  return null;
}

// Maps a schema appearing in a property/parameter/array-item position to a doc-comment label plus
// its structural descriptor (see this file's header comment), registering any newly-discovered
// named model along the way. `hintName` is only used if an inline (non-named) schema needs to
// become its own named model.
export function rubyType(registry, schema, hintName) {
  const s = schema || {};

  const name = nameOf(s);
  if (name) {
    const n = className(name);
    return { label: n, descriptor: { kind: "ref", refName: n } };
  }

  const kind = kindOf(s);
  if (kind === "Enum") {
    const n = disambiguateHintName(registry, hintName);
    registerEnum(registry, n, s);
    return { label: n, descriptor: { kind: "ref", refName: n } };
  }
  if (kind === "OneOf" || kind === "AnyOf") {
    // A single-variant oneOf/anyOf is trivially just that one variant's schema - same real-world
    // idiom the sibling generators special-case (see the TypeScript generator's tsType).
    const variants = s.oneOf || s.anyOf || [];
    if (variants.length === 1) return rubyType(registry, variants[0], hintName);
    const n = disambiguateHintName(registry, hintName);
    registerUnionDispatch(registry, n, s);
    return { label: n, descriptor: { kind: "ref", refName: n } };
  }
  if (kind === "AllOf") {
    if (s.allOf.length === 1) return rubyType(registry, s.allOf[0], hintName);
    const n = disambiguateHintName(registry, hintName);
    registerMergedAllOf(registry, n, s);
    return { label: n, descriptor: { kind: "ref", refName: n } };
  }
  if (kind === "Array") {
    const item = rubyType(registry, s.items || {}, hintName + "Item");
    return { label: `Array<${item.label}>`, descriptor: { kind: "array", item: item.descriptor } };
  }
  if (kind === "Object") {
    const n = disambiguateHintName(registry, hintName);
    registerClass(registry, n, s);
    return { label: n, descriptor: { kind: "ref", refName: n } };
  }
  if (kind === "Map") {
    if (s.additionalProperties && typeof s.additionalProperties === "object") {
      const v = rubyType(registry, s.additionalProperties, hintName + "Value");
      return { label: `Hash<String, ${v.label}>`, descriptor: { kind: "record", value: v.descriptor } };
    }
    return { label: "Hash", descriptor: { kind: "record", value: null } };
  }
  const prim = primitiveDescriptor(s);
  if (prim) return { label: primitiveLabel(s), descriptor: prim };
  return { label: "Object", descriptor: { kind: "unknown" } };
}

// Registers a plain alias module for a top-level schema whose Ruby representation is just
// "whatever `descriptor` already knows how to (de)serialize" - array/map/scalar type aliases, and
// a single-variant top-level oneOf/anyOf (see below) - with no properties/dispatch of its own.
// Still gets a real module (not just inlined at every use site) so it has a stable name other
// models can $ref and call <Name>.from_h/<Name>.to_wire on, same as every other registered kind.
function addAlias(registry, name, description, descriptor, label) {
  addModel(registry, name, {
    name,
    kind: "alias",
    description: description || null,
    descriptor,
    label,
    fromHExpr: buildFromHExpr(descriptor, "value"),
    toWireExpr: buildToWireExpr(descriptor, "value"),
  });
}

function registerTopLevel(registry, name, schema) {
  const kind = kindOf(schema);
  if (kind === "Enum") return registerEnum(registry, name, schema);
  if (kind === "AllOf") return registerMergedAllOf(registry, name, schema);
  if (kind === "OneOf" || kind === "AnyOf") {
    const variants = schema.oneOf || schema.anyOf || [];
    // A single-variant oneOf/anyOf needs no dispatch module at all - same simplification
    // rubyType() applies when the same shape shows up in a property/parameter position (see
    // rubyType's own OneOf/AnyOf branch above) - registerUnionDispatch's runtime `if`/`elsif`
    // chain assumes 2+ variants (see model_union.rb.j2), so this also sidesteps having to handle
    // a one-variant chain with nothing to branch on there.
    if (variants.length === 1) {
      const t = rubyType(registry, variants[0], name);
      addAlias(registry, name, schema.description, t.descriptor, t.label);
      return;
    }
    return registerUnionDispatch(registry, name, schema);
  }
  if (kind === "Array") {
    const item = rubyType(registry, schema.items || {}, name + "Item");
    addAlias(registry, name, schema.description, { kind: "array", item: item.descriptor }, `Array<${item.label}>`);
    return;
  }
  if (kind === "Object") return registerClass(registry, name, schema);
  if (kind === "Map") {
    if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
      const v = rubyType(registry, schema.additionalProperties, name + "Value");
      addAlias(registry, name, schema.description, { kind: "record", value: v.descriptor }, `Hash<String, ${v.label}>`);
    } else {
      addAlias(registry, name, schema.description, { kind: "record", value: null }, "Hash");
    }
    return;
  }
  const prim = primitiveDescriptor(schema);
  if (prim) {
    addAlias(registry, name, schema.description, prim, primitiveLabel(schema));
    return;
  }
  // Fallback: an unrecognized/free-form shape becomes an (empty-ish) class, mirroring the most
  // permissive reasonable guess rather than erroring outright.
  registerClass(registry, name, schema);
}

// Walks schema.components.schemas and builds the full model registry: dispatch modules for
// oneOf/anyOf (discriminated or not), enum modules, flattened-allOf/plain classes, and array/map/
// scalar alias modules - including any inline types discovered transitively along the way (via
// rubyType, called both here and from lib/operations.js while building operation body/response
// descriptors).
export function buildModelRegistry(root) {
  const schemas = (root.components && root.components.schemas) || {};
  const registry = newRegistry(Object.keys(schemas).map(className));

  // Pass 1: discriminated unions first (see registerUnionDiscriminated) - registered under the
  // union's own name immediately; each variant (e.g. "Circle") is left for pass 2, which registers
  // it exactly like any other top-level schema (no discriminator-literal forcing needed here,
  // unlike the TypeScript/Kotlin generators - Ruby has no static type to narrow, so the
  // discriminator property is just an ordinary wire field like any other).
  const discriminatedNames = new Set();
  for (const [rawName, schema] of Object.entries(schemas)) {
    const disc = resolveDiscriminator(schema);
    if (!disc) continue;
    const name = className(rawName);
    registerUnionDiscriminated(registry, name, schema, disc);
    discriminatedNames.add(name);
  }

  // Pass 2: everything else.
  for (const rawName of Object.keys(schemas)) {
    const name = className(rawName);
    const existing = registry.models.get(name);
    if (existing) {
      if (discriminatedNames.has(name)) continue; // already registered in pass 1
      throw Error(`<8f2c9a41> Schema name collision after Ruby identifier conversion: "${rawName}" -> "${name}"`);
    }
    withResilience(
      `schema "${rawName}"`,
      () => registerTopLevel(registry, name, schemas[rawName]),
      () => addModel(registry, name, { name, kind: "alias", description: null, descriptor: { kind: "unknown" }, label: "Object" })
    );
  }

  return registry;
}
