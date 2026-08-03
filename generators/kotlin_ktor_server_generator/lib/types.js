// Maps OpenAPI schemas to Kotlin types and builds a registry of named models to render.
//
// Supported: object/array/primitives (with format mapping), $ref, enum, allOf (flattened merge),
// oneOf/anyOf *with* a discriminator (sealed interface + one @Serializable subtype per variant).
//
// Not supported (v1 limitation, throws a clear error instead of guessing): oneOf/anyOf without a
// discriminator, and oneOf/anyOf variants that aren't a $ref to a named schema.
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

function newRegistry() {
  return { models: new Map(), order: [] };
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
      nullable,
      description: propSchema.description || null,
      constraints,
      validationCalls: buildValidationCalls(kotlinName, propName, t.type, constraints),
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
  const entries = schema.enum.map((v) => ({ ktName: enumConstantName(v), wireValue: String(v) }));
  addModel(registry, name, { name, kind: "enum", baseType, entries, description: schema.description || null });
}

function registerMerged(registry, name, schema, variantOpts) {
  if (registry.models.has(name)) return;
  const merged = { type: "object", properties: {}, required: [], description: schema.description || null };
  for (const sub of schema.allOf) {
    Object.assign(merged.properties, sub.properties || {});
    merged.required.push(...(sub.required || []));
  }
  registerObject(registry, name, merged, variantOpts);
}

// Maps a schema's `type`/`format` to a Kotlin primitive, or null if it isn't a plain scalar
// (object/array/etc). Shared by ktType (property/param positions) and registerTopLevel (named
// top-level schemas that are themselves just a scalar, e.g. `AnnouncementMessage: {type: string}`).
function primitiveKtType(s) {
  const type = s.type;
  if (type === "string") {
    if (s.format === "date") return "kotlinx.datetime.LocalDate";
    if (s.format === "date-time") return "kotlinx.datetime.Instant";
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
    registerEnum(registry, hintName, s);
    return { type: hintName };
  }
  if (kind === "OneOf" || kind === "AnyOf") {
    throw Error(`<a5b6c7d8> Inline oneOf/anyOf (not a named schema) is not supported: ${hintName}`);
  }
  if (kind === "AllOf") {
    registerMerged(registry, hintName, s);
    return { type: hintName };
  }
  if (kind === "Array") {
    const itemType = ktType(registry, s.items || {}, hintName + "Item");
    const container = s.uniqueItems ? "Set" : "List";
    return { type: `${container}<${itemType.type}>` };
  }
  if (kind === "Object") {
    registerObject(registry, hintName, s);
    return { type: hintName };
  }
  if (kind === "Map") {
    if (s.additionalProperties && typeof s.additionalProperties === "object") {
      const valueType = ktType(registry, s.additionalProperties, hintName + "Value");
      return { type: `Map<String, ${valueType.type}>` };
    }
    return { type: "kotlinx.serialization.json.JsonObject" };
  }
  const prim = primitiveKtType(s);
  if (prim) return { type: prim };
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
    addModel(registry, name, { name, kind: "typealias", targetType: prim, description: s.description || null });
    return;
  }
  registerObject(registry, name, s, variantOpts);
}

// Walks schema.components.schemas and builds the full model registry: sealed interfaces for
// discriminated oneOf/anyOf plus their variants, enums, merged allOf objects, array typealiases,
// and plain data classes - including any inline types discovered transitively along the way.
export function buildModelRegistry(root) {
  const registry = newRegistry();
  const schemas = (root.components && root.components.schemas) || {};

  // Pass 1: find discriminated sealed parents, register their markers, and record which
  // variants need to implement them (must happen before pass 2 registers the variants).
  const variantInfo = new Map();
  for (const [rawName, schema] of Object.entries(schemas)) {
    const variants = schema.oneOf || schema.anyOf;
    if (!variants) continue;
    const name = className(rawName);
    if (!schema.discriminator || !schema.discriminator.propertyName) {
      throw Error(
        `<b6c7d8e9> Undiscriminated oneOf/anyOf is not supported: "${rawName}". Add a "discriminator.propertyName".`
      );
    }
    const discProp = schema.discriminator.propertyName;
    // discriminator.mapping's values are still literal ref strings (discriminator isn't itself a
    // schema, so the engine's $ref resolution doesn't touch it) - match by the ref's trailing
    // name segment against nameOf(variant) rather than resolving the ref ourselves.
    const mapping = schema.discriminator.mapping || {};
    const nameToSerialName = new Map(Object.entries(mapping).map(([value, ref]) => [ref.split("/").pop(), value]));
    addModel(registry, name, {
      name,
      kind: "sealed",
      discriminatorProperty: discProp,
      description: schema.description || null,
    });
    for (const variant of variants) {
      const variantRawName = nameOf(variant);
      if (!variantRawName) {
        throw Error(`<c7d8e9fa> oneOf/anyOf variants must be a reference to a named schema: "${rawName}"`);
      }
      const variantName = className(variantRawName);
      const serialName = nameToSerialName.get(variantRawName) || variantRawName;
      variantInfo.set(variantName, { implements: name, serialName, skipProperty: discProp });
    }
  }

  // Pass 2: register everything else (data classes, enums, merged objects, array typealiases).
  for (const rawName of Object.keys(schemas)) {
    const name = className(rawName);
    const existing = registry.models.get(name);
    if (existing) {
      if (existing.kind === "sealed") continue; // marker already registered in pass 1
      throw Error(`<d8e9faab> Schema name collision after Kotlin identifier conversion: "${rawName}" -> "${name}"`);
    }
    registerTopLevel(registry, name, schemas[rawName], variantInfo.get(name));
  }

  return registry;
}
