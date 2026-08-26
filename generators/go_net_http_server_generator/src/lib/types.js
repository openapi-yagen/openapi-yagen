// Maps OpenAPI schemas to Go types and builds a registry of named models to render.
//
// This generator declares openApiVersion "3.1" (see generator.yml), so nullability is read from
// the JSON Schema 2020-12 dialect OAS 3.1 uses: a schema is nullable when its `type` is an array
// containing "null" (there is no `nullable` boolean key in this dialect - see isNullable below).
//
// Supported: object/array/primitives (with format mapping), $ref, enum, allOf (flattened merge),
// oneOf/anyOf with a discriminator (one concrete variant struct per branch, resolved via the
// engine's resolveDiscriminator()), and undiscriminated oneOf/anyOf (a wrapper struct with one
// value-holding accessor per branch, deserialized by dispatching on the raw JSON's shape via the
// engine's resolveUnionDispatch()). Both discriminated and undiscriminated cases are represented
// as the same "union" model kind (see registerDiscriminatedUnion/registerUnion below and
// templates/model_union.go.j2) - Go has no algebraic/sealed-interface type to lean on the way
// Kotlin's sealed interface does, so every oneOf/anyOf becomes a concrete wrapper struct with
// hand-rolled MarshalJSON/UnmarshalJSON instead.
//
// A union's undiscriminated variants must be pairwise distinguishable from the raw JSON alone: at
// most one variant per non-object JSON shape (string/number/boolean/array), and for multiple
// object-shaped variants, each one needs a `required` property that no other object variant also
// requires. If a oneOf/anyOf can't be dispatched this way, that's a hard error (not a silent
// guess) - resolveUnionDispatch() throws with details.
//
// `schema` (global) has no `$ref` anywhere - every reference is already the actual target object.
// `nameOf(x)` recovers the components.schemas name a schema was reached through (null for an
// inline/anonymous one). `kindOf`/`constraintsOf` classify a schema's shape/validation keywords.
// All three only work while still in this main-script phase, before a schema is passed into
// renderTemplate (see lib/operations.js's note on the same thing).
//
// Pointer/omitempty decisions (which properties become *T, which get `,omitempty`) are NOT made
// here - a property's Go type name alone doesn't reveal whether its underlying representation is
// already nil-able (a slice/map) until every model in the registry has been walked at least once
// (a $ref may point at a schema not yet visited). See finalizeModels() below, run once after the
// whole registry is built, right before rendering.

import { typeName, fieldName, paramName, enumConstantName } from "./naming.js";
import { withResilience } from "./strict.js";
import { attachValidationCalls } from "./validation.js";

function newRegistry(reservedNames) {
  return { models: new Map(), order: [], reservedNames };
}

// Disambiguates a hint-derived synthetic type name (an inline oneOf/anyOf/allOf/object with no
// $ref of its own) that collides with a REAL top-level schema's own generated name. Uses the
// engine's disambiguateName() against `reservedNames` (every real top-level schema's generated
// name, computed once upfront) - not `registry.models` - so reprocessing the exact same hint name
// for the exact same inline schema still correctly reuses the earlier registration via
// registerStruct/registerUnion/registerMerged's own idempotent guard, instead of spuriously
// "colliding with itself" on every repeat visit.
function disambiguateHintName(registry, candidate) {
  return disambiguateName(candidate, registry.reservedNames);
}

function addModel(registry, name, entry) {
  registry.models.set(name, entry);
  registry.order.push(name);
}

// A schema is nullable in the OAS 3.1 dialect when its `type` is an array containing "null" -
// there is no `nullable` boolean key in this dialect (that's 3.0-only).
function isNullable(schema) {
  return Array.isArray(schema.type) && schema.type.includes("null");
}

// The schema's own scalar type keyword, ignoring "null" - `type` may be a plain string or (OAS
// 3.1) an array like ["string", "null"].
function baseType(schema) {
  if (Array.isArray(schema.type)) return schema.type.find((t) => t !== "null") || null;
  return schema.type || null;
}

function registerStruct(registry, name, schema, variantOpts) {
  if (registry.models.has(name)) return;
  const skipProperty = variantOpts && variantOpts.skipProperty;
  const required = new Set(schema.required || []);
  const props = [];
  for (const [propName, propSchema] of Object.entries(schema.properties || {})) {
    if (skipProperty && propName === skipProperty) continue;
    const { goName, wireName, needsTag } = fieldName(propName);
    const t = goType(registry, propSchema, name + typeName(propName));
    props.push({
      goName,
      wireName,
      needsTag,
      type: t.type,
      required: required.has(propName),
      nullable: isNullable(propSchema),
      description: propSchema.description || null,
      constraints: constraintsOf(propSchema),
    });
  }
  addModel(registry, name, {
    name,
    kind: "object",
    description: schema.description || null,
    properties: props,
  });
}

function registerEnum(registry, name, schema) {
  if (registry.models.has(name)) return;
  const isInt = baseType(schema) === "integer";
  // A literal `null` entry (some real-world specs write `enum: [foo, bar, null]` alongside a
  // nullable type) isn't a real enum constant - the property's Go type already becomes a pointer
  // via the nullable/required table, so a JSON null there is represented as a nil pointer rather
  // than needing an enum member of its own.
  const entries = schema.enum
    .filter((v) => v !== null)
    .map((v) => ({ goName: enumConstantName(name, v), wireValue: isInt ? Number(v) : String(v) }));
  addModel(registry, name, { name, kind: "enum", isInt, entries, description: schema.description || null });
}

// Uses the engine's flattenAllOf(), which recursively merges nested allOf branches.
function registerMerged(registry, name, schema, variantOpts) {
  if (registry.models.has(name)) return;
  const flat = flattenAllOf(schema);
  const merged = { type: "object", properties: flat.properties, required: flat.required, description: schema.description || null };
  registerStruct(registry, name, merged, variantOpts);
}

// Registers an undiscriminated oneOf/anyOf as a "union" model: a wrapper struct with one
// unexported *Variant field and AsX()/FromX() accessor pair per branch, plus hand-rolled
// MarshalJSON/UnmarshalJSON that dispatch on the raw JSON's shape - classification/validation is
// the engine's resolveUnionDispatch(), which throws a descriptive error if the variants can't be
// unambiguously told apart. At most one variant may be an unconstrained catch-all ("any"/`{}`) -
// it becomes the deserializer's trailing default case instead of a shape-checked one (see
// templates/model_union.go.j2).
function registerUnion(registry, name, schema, variantOpts) {
  if (registry.models.has(name)) return;
  const variants = schema.oneOf || schema.anyOf || [];
  const dispatch = resolveUnionDispatch(schema);

  const variantModels = variants.map((variant, index) => {
    const { dispatchKind, dispatchField } = dispatch.variants[index];
    const variantRawName = nameOf(variant);
    const suffix = variantRawName ? typeName(variantRawName) : `Variant${index + 1}`;
    // The registry hint name is globally prefixed (name + suffix) to avoid colliding with an
    // unrelated top-level schema of the same suffix; the Go-facing accessor/field name below is
    // scoped to this wrapper struct's own methods/fields, so it only needs to be unique here.
    const t = goType(registry, variant, name + suffix + "Value");
    return {
      accessorName: suffix,
      fieldName: paramName(suffix),
      valueType: t.type,
      literal: null,
      dispatchKind,
      dispatchField,
    };
  });

  // Stable sort: moves the one field-less object variant (if any, resolveUnionDispatch guarantees
  // at most one) after every other object variant, without disturbing relative order otherwise -
  // its unconditional "is this a JSON object" branch is only reached once every more specific
  // field-presence check above it has already failed to match.
  variantModels.sort((a, b) => {
    const aFallback = a.dispatchKind === "object" && !a.dispatchField ? 1 : 0;
    const bFallback = b.dispatchKind === "object" && !b.dispatchField ? 1 : 0;
    return aFallback - bFallback;
  });

  addModel(registry, name, {
    name,
    kind: "union",
    description: schema.description || null,
    discriminant: null,
    variants: variantModels,
    catchAllVariant: variantModels.find((v) => v.dispatchKind === "any") || null,
  });
}

// Registers a discriminated oneOf/anyOf (resolveDiscriminator() already guarantees every variant
// is a $ref to a named schema) as a "union" model whose variants dispatch on the discriminator
// property's decoded value instead of the JSON's shape - see registerUnion above for the
// undiscriminated case this mirrors, and buildModelRegistry's pass 1 for how this gets called
// before the variant schemas themselves are registered.
function registerDiscriminatedUnion(registry, name, schema, disc) {
  if (registry.models.has(name)) return;
  const variantModels = disc.variants.map((v) => {
    const vName = typeName(v.name);
    return {
      accessorName: vName,
      fieldName: paramName(vName),
      valueType: vName,
      literal: v.literal,
      dispatchKind: null,
      dispatchField: null,
    };
  });
  addModel(registry, name, {
    name,
    kind: "union",
    description: schema.description || null,
    discriminant: disc.property,
    variants: variantModels,
    catchAllVariant: null,
  });
}

// Maps a schema's `type`/`format` to a Go primitive, or null if it isn't a plain scalar
// (object/array/etc). Shared by goType (property/param positions) and registerTopLevel (named
// top-level schemas that are themselves just a scalar, e.g. `AnnouncementMessage: {type: string}`).
function primitiveGoType(s) {
  const type = baseType(s);
  if (type === "string") {
    if (s.format === "date-time") return "time.Time";
    return "string";
  }
  if (type === "integer") {
    if (s.format === "int32") return "int32";
    if (s.format === "int64") return "int64";
    return "int";
  }
  if (type === "number") return s.format === "float" ? "float32" : "float64";
  if (type === "boolean") return "bool";
  return null;
}

// Maps a schema appearing in a property/parameter/array-item position to a Go type name,
// registering any newly-discovered named model along the way. `hintName` is only used if an
// inline (non-named) schema needs to be turned into its own named model.
export function goType(registry, schema, hintName) {
  const s = schema || {};

  const name = nameOf(s);
  if (name) return { type: typeName(name) };

  const kind = kindOf(s);
  if (kind === "Enum") {
    const n = disambiguateHintName(registry, hintName);
    registerEnum(registry, n, s);
    return { type: n };
  }
  if (kind === "OneOf" || kind === "AnyOf") {
    // A single-variant oneOf/anyOf is trivially just that one variant's schema - a common
    // real-world idiom (e.g. `anyOf: [$ref X]` + a nullable wrapper, used because OAS 3.0 doesn't
    // allow a bare `nullable` next to a `$ref`) that shouldn't need its own wrapper union;
    // recursing avoids both an unnecessary synthetic type and a type-name collision when the
    // synthesized wrapper's hint name happens to match an actual schema name.
    const variants = s.oneOf || s.anyOf || [];
    if (variants.length === 1) return goType(registry, variants[0], hintName);
    const n = disambiguateHintName(registry, hintName);
    registerUnion(registry, n, s);
    return { type: n };
  }
  if (kind === "AllOf") {
    // A single-branch allOf is trivially just that one branch's schema, whatever kind it is - a
    // common real-world idiom (e.g. `allOf: [$ref X]` to attach a sibling description next to a
    // $ref) that registerMerged can't handle correctly, since it unconditionally treats allOf as
    // an object merge.
    if (s.allOf.length === 1) return goType(registry, s.allOf[0], hintName);
    const n = disambiguateHintName(registry, hintName);
    registerMerged(registry, n, s);
    return { type: n };
  }
  if (kind === "Array") {
    const itemType = goType(registry, s.items || {}, hintName + "Item");
    return { type: `[]${itemType.type}` };
  }
  if (kind === "Object") {
    const n = disambiguateHintName(registry, hintName);
    registerStruct(registry, n, s);
    return { type: n };
  }
  if (kind === "Map") {
    if (s.additionalProperties && typeof s.additionalProperties === "object") {
      const valueType = goType(registry, s.additionalProperties, hintName + "Value");
      return { type: `map[string]${valueType.type}` };
    }
    return { type: "map[string]any" };
  }
  const prim = primitiveGoType(s);
  if (prim) return { type: prim };
  return { type: "any" };
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
    const itemType = goType(registry, s.items || {}, name + "Item");
    addModel(registry, name, { name, kind: "alias", targetType: `[]${itemType.type}`, description: s.description || null });
    return;
  }
  if (s.properties) {
    registerStruct(registry, name, s, variantOpts);
    return;
  }
  // A named schema that's a plain scalar (e.g. `AnnouncementMessage: {type: string}`) or a
  // property-less object (free-form/map) becomes a defined type instead of a struct.
  if (kind === "Map") {
    if (s.additionalProperties && typeof s.additionalProperties === "object") {
      const valueType = goType(registry, s.additionalProperties, name + "Value");
      addModel(registry, name, { name, kind: "alias", targetType: `map[string]${valueType.type}`, description: s.description || null });
      return;
    }
    addModel(registry, name, { name, kind: "alias", targetType: "map[string]any", description: s.description || null });
    return;
  }
  const prim = primitiveGoType(s);
  if (prim) {
    addModel(registry, name, { name, kind: "alias", targetType: prim, description: s.description || null });
    return;
  }
  registerStruct(registry, name, s, variantOpts);
}

// A Go type name's underlying representation is already nil-able (slice/map) when it's a builtin
// container syntax, or a registered "alias" model whose own target is one - in either case an
// optional property of that type must NOT be wrapped in an extra pointer (see finalizeModels).
function isRefType(registry, typeStr) {
  if (typeStr.startsWith("[]") || typeStr.startsWith("map[")) return true;
  const model = registry.models.get(typeStr);
  return !!model && model.kind === "alias" && isRefType(registry, model.targetType);
}

// Resolves each object model's per-property pointer/omitempty decision, deferred until the whole
// registry is built since a property's referenced type may not have been visited yet at the point
// it was registered (a forward $ref). Scalar/enum/struct/union-typed properties become *T when
// optional or nullable (Go can't otherwise represent "absent"/"null" distinctly from the zero
// value); slice/map-typed properties never do, since a nil slice/map already serves that role.
//
// Exported and called separately from buildModelRegistry (main.js calls it explicitly, after
// collectOperationsByTag) rather than at the end of buildModelRegistry itself - an operation's
// inline (non-$ref) parameter/body/response schema can register a brand new model via goType()
// during collectOperationsByTag, which runs after buildModelRegistry returns; calling this only
// once, too early, would leave such a model's properties without .pointer/.omitempty/
// .validationCalls and the model itself without .needsTime, which model_struct/alias/union.go.j2
// all read unconditionally.
export function finalizeModels(registry) {
  for (const model of registry.models.values()) {
    if (model.kind === "object") {
      model.needsTime = false;
      for (const p of model.properties) {
        const ref = isRefType(registry, p.type);
        p.isRef = ref;
        p.pointer = !ref && (p.nullable || !p.required);
        p.omitempty = !p.required;
        attachValidationCalls(p);
        if (p.type.includes("time.Time")) model.needsTime = true;
      }
    } else if (model.kind === "alias") {
      model.needsTime = model.targetType.includes("time.Time");
    } else if (model.kind === "union") {
      model.needsTime = model.variants.some((v) => v.valueType.includes("time.Time"));
    }
  }
}

// Walks schema.components.schemas and builds the full model registry: union wrapper structs for
// discriminated and undiscriminated oneOf/anyOf, enums, merged allOf objects, array/map/scalar
// defined types, and plain structs - including any inline types discovered transitively along the
// way.
export function buildModelRegistry(root) {
  const schemas = (root.components && root.components.schemas) || {};
  const registry = newRegistry(Object.keys(schemas).map(typeName));

  // Pass 1: find discriminated unions via the engine's resolveDiscriminator(), register their
  // wrapper model, and record which variants need their discriminator property skipped when
  // pass 2 registers them as ordinary structs. Anything else shaped like oneOf/anyOf - no
  // discriminator, or variants that aren't a reference to a named schema - is left for pass 2 to
  // pick up as an undiscriminated union instead (see registerUnion).
  const variantInfo = new Map();
  for (const [rawName, schema] of Object.entries(schemas)) {
    const disc = resolveDiscriminator(schema);
    if (!disc) continue;

    const name = typeName(rawName);
    registerDiscriminatedUnion(registry, name, schema, disc);
    for (const variant of disc.variants) {
      variantInfo.set(typeName(variant.name), { skipProperty: disc.property });
    }
  }

  // Pass 2: register everything else (structs, enums, merged objects, array/map/scalar aliases).
  for (const rawName of Object.keys(schemas)) {
    const name = typeName(rawName);
    const existing = registry.models.get(name);
    if (existing) {
      if (existing.kind === "union" && existing.discriminant) continue; // registered in pass 1
      throw Error(`<a58975eb> Schema name collision after Go identifier conversion: "${rawName}" -> "${name}"`);
    }
    withResilience(
      `schema "${rawName}"`,
      () => registerTopLevel(registry, name, schemas[rawName], variantInfo.get(name)),
      () => addModel(registry, name, { name, kind: "alias", targetType: "any", description: null })
    );
  }

  return registry;
}
