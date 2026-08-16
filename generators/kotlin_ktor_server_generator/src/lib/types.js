// Maps OpenAPI schemas to Kotlin types and builds a registry of named models to render.
//
// Supported: object/array/primitives (with format mapping), $ref, enum, allOf (flattened merge),
// oneOf/anyOf with a discriminator and $ref-only variants (sealed interface + one @Serializable
// subtype per variant), and *undiscriminated* oneOf/anyOf (kind "union": a sealed interface with
// one value-wrapping variant per branch, deserialized via a generated hand-rolled KSerializer that
// dispatches on the JSON value's shape - see the engine's resolveUnionDispatch()
// (docs/javascript-api.md), registerUnion below, and templates/model_union.kt.j2).
//
// A union's variants must be pairwise distinguishable from the raw JSON alone: at most one
// variant per non-object JSON shape (string/number/boolean/array), and for multiple object-shaped
// variants, each one needs a `required` property that no other object variant also requires. If a
// oneOf/anyOf can't be dispatched this way, that's a hard error (not a silent guess) -
// resolveUnionDispatch() throws with details.
//
// External types are always referenced fully-qualified (kotlinx.datetime.Instant,
// kotlinx.serialization.json.JsonElement/JsonObject) so callers never need per-file import
// bookkeeping - every model lives in the same package, so referencing another generated model by
// its class name needs no import either.
//
// `schema` (global) has no `$ref` anywhere - every reference is already the actual target object
// (see README's "Global values"). `nameOf(x)` recovers the components.schemas name a schema was
// reached through (null for an inline/anonymous one) - this is what used to be a `$ref` string
// check. `kindOf`/`constraintsOf` classify a schema's shape/validation keywords instead of the
// hand-rolled `Array.isArray(s.enum)`-style checks this file used to do. All three only work while
// still in this main-script phase, before a schema is passed into renderTemplate (see
// lib/operations.js's note on the same thing).

import { className, fieldName, enumConstantName } from "./naming.js";
import { escapeKotlinString } from "./keywords.js";
import { withResilience } from "./strict.js";

// Builds calls into the shared Validation.kt runtime helpers (DRY: constraint-checking logic
// lives once there, both model validate() extensions and route parameter validation call it).
export function buildValidationCalls(varExpr, fieldLabel, type, constraints) {
  const calls = [];
  const isNumeric = type === "Int" || type === "Long" || type === "Float" || type === "Double";
  if (isNumeric) {
    if (typeof constraints.maximum === "number") calls.push(`requireMax(${varExpr}, ${constraints.maximum}.0, "${fieldLabel}")`);
    if (typeof constraints.minimum === "number") calls.push(`requireMin(${varExpr}, ${constraints.minimum}.0, "${fieldLabel}")`);
  }
  if (type === "String") {
    if (typeof constraints.maxLength === "number")
      calls.push(`requireMaxLength(${varExpr}, ${constraints.maxLength}, "${fieldLabel}")`);
    if (typeof constraints.minLength === "number")
      calls.push(`requireMinLength(${varExpr}, ${constraints.minLength}, "${fieldLabel}")`);
    if (typeof constraints.pattern === "string")
      calls.push(`requirePattern(${varExpr}, ${escapeKotlinString(constraints.pattern)}, "${fieldLabel}")`);
  }
  return calls;
}

// Extends buildValidationCalls with recursion into a nested object/array property: a property
// whose own schema is itself an object (or allOf-merged object) gets its generated .validate()
// called; an array property gets each element either .validate()'d (object items) or
// constraint-checked (primitive items with maxLength/pattern/etc, same as a scalar property).
// Both model_data_class.kt.j2's validate() and this file share the resulting call list.
//
// A nested `.validate()` call is only valid if its target type actually has one - a $ref'd schema
// that failed its own registration (permissive mode - see withResilience in buildModelRegistry)
// falls back to a plain `typealias X = JsonElement`, which has no generated validate() extension
// at all. But Pass 2 (see buildModelRegistry) registers schemas in declaration order, so at THIS
// property's registration time, its target schema may not have had its own turn yet - its
// eventual kind ("object" vs. permissive-fallback "typealias") genuinely isn't knowable here.
// Every call below is therefore returned tagged with `requiresType` (the type name it depends on,
// or null for a plain constraint check with no dependency) instead of emitted unconditionally;
// buildModelRegistry's pass 3, run only after every schema has been fully registered one way or
// the other, drops any call whose `requiresType` didn't end up as a genuine "object" kind. Each
// entry's `text` is the plain Kotlin snippet - what a caller conceptually building this list
// straightforwardly, but pass 3 needs the untagged text back out for the templates.
function buildNestedValidationCalls(varExpr, fieldLabel, propSchema, propType, nullable) {
  const calls = [];
  const kind = kindOf(propSchema);
  const accessor = nullable ? "?." : ".";
  if (kind === "Object" || kind === "AllOf") {
    calls.push({ text: `${varExpr}${accessor}validate()`, requiresType: propType });
  } else if (kind === "Array") {
    const itemSchema = propSchema.items || {};
    const itemKind = kindOf(itemSchema);
    if (itemKind === "Object" || itemKind === "AllOf") {
      const itemType = (/^(?:List|Set)<(.+)>$/.exec(propType) || [])[1] || null;
      const itemAccessor = itemSchema.nullable === true ? "?." : ".";
      calls.push({ text: `${varExpr}${accessor}forEach { it${itemAccessor}validate() }`, requiresType: itemType });
    } else {
      const itemPrim = primitiveKtType(itemSchema);
      const itemType = itemPrim && (typeof itemPrim === "string" ? itemPrim : itemPrim.type);
      if (itemType) {
        const itemCalls = buildValidationCalls("it", `${fieldLabel}[]`, itemType, constraintsOf(itemSchema));
        if (itemCalls.length > 0) calls.push({ text: `${varExpr}${accessor}forEach { ${itemCalls.join("; ")} }`, requiresType: null });
      }
    }
  }
  return calls;
}

function newRegistry(reservedNames) {
  return { models: new Map(), order: [], reservedNames };
}

// Disambiguates a hint-derived synthetic type name (an inline oneOf/anyOf/allOf/object with no
// $ref of its own) that collides with a REAL top-level schema's own generated name - a real
// pattern in Stripe's spec: an "expandable" property (e.g. "ownership" on schema
// "financial_connections.account") whose inline `anyOf: [string, $ref X]` hints to
// "FinancialConnectionsAccountOwnership", which is also the literal generated name of the schema
// "financial_connections.account_ownership" (X) it's $ref'ing to alongside the plain string ID -
// the single-variant shortcut in ktType avoids this for a 1-variant oneOf/anyOf, but a 2+-variant
// one still needs its own wrapper name. Uses the engine's disambiguateName() (docs/javascript-api.md)
// against `reservedNames` (every real top-level schema's generated name, computed once upfront) -
// not `registry.models` - so reprocessing the exact same hint name for the exact same inline
// schema still correctly reuses the earlier registration via registerObject/registerUnion/
// registerMerged's own idempotent guard, instead of spuriously "colliding with itself" on every
// repeat visit.
function disambiguateHintName(registry, candidate) {
  return disambiguateName(candidate, registry.reservedNames);
}

function addModel(registry, name, entry) {
  registry.models.set(name, entry);
  registry.order.push(name);
}

function registerObject(registry, name, schema, variantOpts) {
  if (registry.models.has(name)) return;
  const skipProperty = variantOpts && variantOpts.skipProperty;
  const required = new Set(schema.required || []);
  const props = [];
  for (const [propName, propSchema] of Object.entries(schema.properties || {})) {
    if (skipProperty && propName === skipProperty) continue;
    const { kotlinName, needsSerialName } = fieldName(propName);
    const t = ktType(registry, propSchema, name + className(propName));
    const isRequired = required.has(propName);
    const nullable = !isRequired || propSchema.nullable === true;
    const constraints = constraintsOf(propSchema);
    props.push({
      ktName: kotlinName,
      wireName: propName,
      needsSerialName,
      type: t.type,
      serializerAnnotation: t.serializerAnnotation || null,
      nullable,
      description: propSchema.description || null,
      constraints,
      // Untagged (plain-string) pass-1 constraint calls have no cross-type dependency; tag them
      // uniformly with buildNestedValidationCalls's {text, requiresType} shape so pass 3 (see
      // buildModelRegistry) can filter this whole list the same way regardless of source.
      validationCalls: [
        ...buildValidationCalls(kotlinName, propName, t.type, constraints).map((text) => ({ text, requiresType: null })),
        ...buildNestedValidationCalls(kotlinName, propName, propSchema, t.type, nullable),
      ],
    });
  }
  addModel(registry, name, {
    name,
    kind: "object",
    description: schema.description || null,
    properties: props,
    implements: (variantOpts && variantOpts.implements) || null,
    serialName: (variantOpts && variantOpts.serialName) || null,
  });
}

function registerEnum(registry, name, schema) {
  if (registry.models.has(name)) return;
  const baseType = schema.type === "integer" ? "Int" : "String";
  // A literal `null` entry (some real-world specs write `enum: [foo, bar, null]` alongside
  // `nullable: true`, e.g. GitHub's) isn't a real enum constant - the property's Kotlin type
  // already becomes nullable via `nullable`, so a JSON null there deserializes to Kotlin `null`
  // rather than needing an enum member of its own.
  const entries = schema.enum.filter((v) => v !== null).map((v) => ({ ktName: enumConstantName(v), wireValue: String(v) }));
  addModel(registry, name, { name, kind: "enum", baseType, entries, description: schema.description || null });
}

// Uses the engine's flattenAllOf() (see docs/javascript-api.md), which recursively merges nested
// allOf branches - a real improvement over this generator's previous one-level-only merge, which
// silently dropped properties from a branch that itself used allOf.
function registerMerged(registry, name, schema, variantOpts) {
  if (registry.models.has(name)) return;
  const flat = flattenAllOf(schema);
  const merged = { type: "object", properties: flat.properties, required: flat.required, description: schema.description || null };
  registerObject(registry, name, merged, variantOpts);
}

// Turns a variant's {dispatchKind, dispatchField} (see the engine's resolveUnionDispatch(),
// docs/javascript-api.md) into a ready Kotlin boolean expression testing the decoded `element:
// JsonElement`, for model_union.kt.j2's generated deserializer - collapses what used to be a
// hand-written per-kind {% if/else if %} chain in the template itself down to a single `{{
// v.dispatchCondition }} -> ...` line per variant. Returns null for dispatchKind "any": that
// variant isn't tested at all, it's the deserializer's trailing `else` branch instead (see
// registerUnion's catchAllVariant, below).
function buildDispatchCondition(dispatchKind, dispatchField) {
  if (dispatchKind === "object") {
    return dispatchField
      ? `element is JsonObject && ${toStringLiteral(dispatchField)} in element`
      : "element is JsonObject";
  }
  if (dispatchKind === "array") return "element is JsonArray";
  if (dispatchKind === "string") return "element is JsonPrimitive && element.isString";
  if (dispatchKind === "boolean")
    return 'element is JsonPrimitive && !element.isString && (element.content == "true" || element.content == "false")';
  if (dispatchKind === "number")
    return "element is JsonPrimitive && !element.isString && element.content.toDoubleOrNull() != null";
  return null;
}

// Registers an undiscriminated oneOf/anyOf as a "union" model: a sealed interface with one
// value-wrapping data class per variant, plus a hand-rolled KSerializer that dispatches on the
// JSON value's shape - classification/validation is the engine's resolveUnionDispatch()
// (docs/javascript-api.md), which throws a descriptive error if the variants can't be
// unambiguously told apart. At most one variant may be an unconstrained catch-all ("any"/`{}`) -
// it becomes the deserializer's trailing `else` branch instead of a shape-predicate branch (see
// model_union.kt.j2).
function registerUnion(registry, name, schema, variantOpts) {
  if (registry.models.has(name)) return;
  const variants = schema.oneOf || schema.anyOf || [];
  const dispatch = resolveUnionDispatch(schema);

  const variantModels = variants.map((variant, index) => {
    const { dispatchKind, dispatchField } = dispatch.variants[index];
    const variantRawName = nameOf(variant);
    const suffix = variantRawName ? className(variantRawName) : `Variant${index + 1}`;
    const wrapperName = name + suffix;
    // Hint name for the variant's OWN type is wrapperName + "Value", not wrapperName itself - an
    // inline (non-$ref) variant with no distinguishing name of its own (e.g. an anonymous
    // "range_query_specs"-style object) would otherwise register its synthesized type under the
    // exact same name as the wrapper data class about to wrap it (`data class
    // {wrapperName}(val value: {wrapperName})`), a direct self-collision - two different classes,
    // same name, same file. A $ref'd variant is unaffected: ktType resolves its name via nameOf()
    // before ever looking at this hint.
    const t = ktType(registry, variant, wrapperName + "Value");
    return {
      wrapperName,
      valueType: t.type,
      dispatchKind,
      dispatchField,
      dispatchCondition: buildDispatchCondition(dispatchKind, dispatchField),
    };
  });

  // Stable sort: moves the one field-less object variant (if any, resolveUnionDispatch guarantees
  // at most one) after every other object variant, without disturbing relative order otherwise -
  // a common real-world shape (e.g. Stripe's "application" vs. "deleted_application": the deleted
  // variant is the non-deleted one's own properties plus a unique "deleted" flag, so the
  // non-deleted variant - a strict subset - can never have a property absent from the other).
  // That variant's unconditional `element is JsonObject -> ...` branch (see model_union.kt.j2) is
  // only ever reached once every more specific field-presence check above it has already failed
  // to match.
  variantModels.sort((a, b) => {
    const aFallback = a.dispatchKind === "object" && !a.dispatchField ? 1 : 0;
    const bFallback = b.dispatchKind === "object" && !b.dispatchField ? 1 : 0;
    return aFallback - bFallback;
  });

  addModel(registry, name, {
    name,
    kind: "union",
    description: schema.description || null,
    variants: variantModels,
    catchAllVariant: variantModels.find((v) => v.dispatchKind === "any") || null,
    implements: (variantOpts && variantOpts.implements) || null,
  });
}

// The Kotlin type generated for `format: date-time`, configurable via the `dateTimeType` generator
// variable (see main.js's configureDateTimeType call) since kotlinx-datetime has already changed
// what its own `Instant` is once (0.7.0 moved it to be kotlin.time.Instant) and callers pinned to
// either side of that need a way to get compiling code without a spec change. `date` isn't
// affected - kotlinx-datetime's LocalDate hasn't moved - so it stays hardcoded below.
const DATE_TIME_TYPES = {
  "kotlinx.datetime.Instant": { type: "kotlinx.datetime.Instant", serializerAnnotation: null },
  "kotlin.time.Instant": {
    type: "kotlin.time.Instant",
    // kotlin.time.Instant is a stdlib class with no kotlinx.serialization support of its own -
    // kotlinx.datetime.Instant gets that for free because kotlinx-datetime marks that *typealias*
    // itself @Serializable(with = ...), which doesn't carry over to referencing kotlin.time.Instant
    // directly.
    serializerAnnotation: "@Serializable(with = kotlinx.datetime.serializers.InstantIso8601Serializer::class)",
  },
  String: { type: "String", serializerAnnotation: null },
};
let dateTimeType = DATE_TIME_TYPES["kotlinx.datetime.Instant"];

export function configureDateTimeType(value) {
  const resolved = DATE_TIME_TYPES[value];
  if (!resolved) {
    throw Error(`<f3a1c9d2> Unsupported dateTimeType "${value}"; expected one of ${Object.keys(DATE_TIME_TYPES).join(", ")}`);
  }
  dateTimeType = resolved;
}

// Maps a schema's `type`/`format` to a Kotlin primitive, or null if it isn't a plain scalar
// (object/array/etc). Shared by ktType (property/param positions) and registerTopLevel (named
// top-level schemas that are themselves just a scalar, e.g. `AnnouncementMessage: {type: string}`).
// Every branch but date-time returns a plain string; date-time returns the configured
// {type, serializerAnnotation} object instead - see the call sites for how each shape is handled.
function primitiveKtType(s) {
  const type = s.type;
  if (type === "string") {
    if (s.format === "date") return "kotlinx.datetime.LocalDate";
    if (s.format === "date-time") return dateTimeType;
    return "String";
  }
  if (type === "integer") return s.format === "int64" ? "Long" : "Int";
  if (type === "number") return s.format === "float" ? "Float" : "Double";
  if (type === "boolean") return "Boolean";
  return null;
}

// Maps a schema appearing in a property/parameter/array-item position to a Kotlin type string,
// registering any newly-discovered named model along the way. `hintName` is only used if an
// inline (non-named) schema needs to be turned into its own named model.
export function ktType(registry, schema, hintName) {
  const s = schema || {};

  const name = nameOf(s);
  if (name) return { type: className(name) };

  const kind = kindOf(s);
  if (kind === "Enum") {
    const n = disambiguateHintName(registry, hintName);
    registerEnum(registry, n, s);
    return { type: n };
  }
  if (kind === "OneOf" || kind === "AnyOf") {
    // A single-variant oneOf/anyOf is trivially just that one variant's schema - a common
    // real-world idiom (e.g. Stripe's `anyOf: [$ref X]` + `nullable: true`, used because OAS 3.0
    // doesn't allow a bare `nullable` next to a `$ref`) that shouldn't need its own wrapper
    // union; recursing avoids both an unnecessary synthetic type and a type-name collision when
    // the synthesized wrapper's hint name happens to match an actual schema name (as it did for
    // Stripe's "business_profile" property vs. its "account_business_profile" schema). A 2+-variant
    // oneOf/anyOf can hit the same collision (see disambiguateHintName) but still needs a wrapper.
    const variants = s.oneOf || s.anyOf || [];
    if (variants.length === 1) return ktType(registry, variants[0], hintName);
    const n = disambiguateHintName(registry, hintName);
    registerUnion(registry, n, s);
    return { type: n };
  }
  if (kind === "AllOf") {
    // A single-branch allOf is trivially just that one branch's schema, whatever kind it is - a
    // common real-world idiom (e.g. .NET/Swashbuckle-generated specs use `allOf: [$ref X]` to
    // attach a sibling description/etc. next to a $ref) that registerMerged can't handle
    // correctly, since it unconditionally treats allOf as an object merge - fine for the common
    // multi-branch object case, but wrong (and silently produces an empty object type) when the
    // one branch is actually an enum/primitive/array, as it is for a wrapped enum parameter.
    if (s.allOf.length === 1) return ktType(registry, s.allOf[0], hintName);
    const n = disambiguateHintName(registry, hintName);
    registerMerged(registry, n, s);
    return { type: n };
  }
  if (kind === "Array") {
    const itemType = ktType(registry, s.items || {}, hintName + "Item");
    const container = s.uniqueItems ? "Set" : "List";
    return { type: `${container}<${itemType.type}>` };
  }
  if (kind === "Object") {
    const n = disambiguateHintName(registry, hintName);
    registerObject(registry, n, s);
    return { type: n };
  }
  if (kind === "Map") {
    if (s.additionalProperties && typeof s.additionalProperties === "object") {
      const valueType = ktType(registry, s.additionalProperties, hintName + "Value");
      return { type: `Map<String, ${valueType.type}>` };
    }
    return { type: "kotlinx.serialization.json.JsonObject" };
  }
  const prim = primitiveKtType(s);
  if (prim) return typeof prim === "string" ? { type: prim } : { type: prim.type, serializerAnnotation: prim.serializerAnnotation };
  return { type: "kotlinx.serialization.json.JsonElement" };
}

function registerTopLevel(registry, name, schema, variantOpts) {
  const s = schema;
  const kind = kindOf(s);
  if (kind === "Enum") {
    registerEnum(registry, name, s);
    return;
  }
  if (kind === "AllOf") {
    registerMerged(registry, name, s, variantOpts);
    return;
  }
  if (kind === "OneOf" || kind === "AnyOf") {
    registerUnion(registry, name, s, variantOpts);
    return;
  }
  if (kind === "Array") {
    const itemType = ktType(registry, s.items || {}, name + "Item");
    const container = s.uniqueItems ? "Set" : "List";
    addModel(registry, name, {
      name,
      kind: "typealias",
      targetType: `${container}<${itemType.type}>`,
      description: s.description || null,
    });
    return;
  }
  if (s.properties) {
    registerObject(registry, name, s, variantOpts);
    return;
  }
  // A named schema that's a plain scalar (e.g. `AnnouncementMessage: {type: string}`) or a
  // property-less object (free-form/map) - none of these can be a `data class` (Kotlin requires
  // at least one constructor parameter), so they become a typealias instead.
  if (kind === "Map") {
    if (s.additionalProperties && typeof s.additionalProperties === "object") {
      const valueType = ktType(registry, s.additionalProperties, name + "Value");
      addModel(registry, name, {
        name,
        kind: "typealias",
        targetType: `Map<String, ${valueType.type}>`,
        description: s.description || null,
      });
      return;
    }
    addModel(registry, name, {
      name,
      kind: "typealias",
      targetType: "kotlinx.serialization.json.JsonObject",
      description: s.description || null,
    });
    return;
  }
  const prim = primitiveKtType(s);
  if (prim) {
    const targetType = typeof prim === "string" ? prim : prim.type;
    addModel(registry, name, { name, kind: "typealias", targetType, description: s.description || null });
    return;
  }
  registerObject(registry, name, s, variantOpts);
}

// Walks schema.components.schemas and builds the full model registry: sealed interfaces for
// discriminated oneOf/anyOf plus their variants, enums, merged allOf objects, array typealiases,
// and plain data classes - including any inline types discovered transitively along the way.
export function buildModelRegistry(root) {
  const schemas = (root.components && root.components.schemas) || {};
  const registry = newRegistry(Object.keys(schemas).map(className));

  // Pass 1: find discriminated sealed parents via the engine's resolveDiscriminator() (see
  // docs/javascript-api.md - it already resolves each variant's component name and discriminator
  // literal, including the mapping-less "falls back to the component name itself" default),
  // register their markers, and record which variants need to implement them (must happen before
  // pass 2 registers the variants). Anything else shaped like oneOf/anyOf - no discriminator, or
  // variants that aren't a reference to a named schema - is left for pass 2 to pick up as a
  // "union" model instead (see registerUnion).
  const variantInfo = new Map();
  for (const [rawName, schema] of Object.entries(schemas)) {
    const disc = resolveDiscriminator(schema);
    if (!disc) continue;

    const name = className(rawName);
    addModel(registry, name, {
      name,
      kind: "sealed",
      discriminatorProperty: disc.property,
      description: schema.description || null,
    });
    for (const variant of disc.variants) {
      const variantName = className(variant.name);
      variantInfo.set(variantName, { implements: name, serialName: variant.literal, skipProperty: disc.property });
    }
  }

  // Pass 2: register everything else (data classes, enums, merged objects, array typealiases).
  for (const rawName of Object.keys(schemas)) {
    const name = className(rawName);
    const existing = registry.models.get(name);
    if (existing) {
      if (existing.kind === "sealed") continue; // marker already registered in pass 1
      throw Error(`<071c49a0> Schema name collision after Kotlin identifier conversion: "${rawName}" -> "${name}"`);
    }
    withResilience(
      `schema "${rawName}"`,
      () => registerTopLevel(registry, name, schemas[rawName], variantInfo.get(name)),
      () =>
        addModel(registry, name, {
          name,
          kind: "typealias",
          targetType: "kotlinx.serialization.json.JsonElement",
          description: null,
        })
    );
  }

  return registry;
}

// Must run after EVERY model is registered - not just buildModelRegistry's own schema-driven
// pass 1/2, but also whatever collectOperationsByTag (lib/operations.js) registers afterward for
// inline operation params/bodies/responses (main.js calls this in between the two) - only then is
// every schema's final registration state (real "object" model, or a permissive-mode "typealias"
// fallback) actually settled, which is what a nested `.validate()` call's target (see
// buildNestedValidationCalls) needs to be reliably checked against. Drops any nested-validate call
// that doesn't resolve to a genuine "object" kind, and flattens every property's validationCalls
// from {text, requiresType} back down to the plain strings the templates expect.
export function finalizeValidationCalls(registry) {
  for (const model of registry.models.values()) {
    if (model.kind !== "object") continue;
    for (const prop of model.properties) {
      prop.validationCalls = prop.validationCalls
        .filter((c) => c.requiresType === null || (registry.models.get(c.requiresType) || {}).kind === "object")
        .map((c) => c.text);
    }
  }
}
