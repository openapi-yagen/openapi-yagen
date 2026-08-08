// Maps OpenAPI schemas to TypeScript types and builds a registry of named models to render.
//
// This is deliberately much simpler than a nominally-typed-language generator (compare
// ../../../kotlin_ktor_client_generator/src/lib/types.js): TypeScript's type system is structural
// and fully erased at runtime, so there is no (de)serialization layer to drive and therefore no
// runtime type-dispatch machinery to generate.
//
// Concretely, oneOf/anyOf (discriminated or not) always becomes a plain native TS union
// (`type X = A | B;`) - no sealed-interface marker, no generated shape-dispatching deserializer.
// JSON.parse already returns a plain value, and TS's own control-flow narrowing
// (`if (x.kind === "circle")`) works on any shared property automatically. The only thing
// discriminated unions need beyond an ordinary union is forcing each variant's discriminator
// property to a string-literal type (e.g. `shapeType: "circle"`, not `shapeType: string`) so that
// narrowing actually works - see registerInterface's `variantOpts` handling below.
//
// Every type-mapping function returns not just a printable TS type string but also a structural
// "descriptor" (see lib/validation.js) describing the same type as a small tagged object
// ({kind:"primitive"|"literal"|"ref"|"array"|"record"|"union"|"unknown", ...}). This is what lets
// the optional `validateResponses` mode (see generator.yml) generate a recursive runtime type
// guard per model without re-parsing the printed TS type string - the descriptor is the type
// mapper's own "AST", kept alongside the string it printed.
//
// `schema` (global) has no `$ref` anywhere - every reference is already the actual target object.
// `nameOf(x)` recovers the components.schemas name a resolved schema was reached through (null for
// an inline/anonymous one). `kindOf`/`nameOf` only work while still in this main-script phase,
// before a schema is passed into renderTemplate (see lib/operations.js's note on the same thing).

import { typeName, enumMemberName, propertyKeyLiteral } from "./naming.js";
import { withResilience } from "./strict.js";

function newRegistry() {
  return { models: new Map(), order: [] };
}

function addModel(registry, name, entry) {
  registry.models.set(name, entry);
  registry.order.push(name);
}

// Registers `name` as `export interface Name { ... }`. `variantOpts`, when present
// (`{ property, literal }`), is set only for a discriminated oneOf/anyOf variant: the named
// property's type is forced to the literal discriminator value instead of its schema-declared
// type, and treated as always-required - this is what makes TS's discriminated-union narrowing
// work on the resulting union. Unlike a nominally-typed generator, the property still needs to
// stay in the interface (TS has no out-of-band discriminator channel to recover it from).
function registerInterface(registry, name, schema, variantOpts) {
  if (registry.models.has(name)) return;
  const required = new Set(schema.required || []);
  const props = [];
  for (const [propName, propSchema] of Object.entries(schema.properties || {})) {
    const isDiscriminator = !!variantOpts && variantOpts.property === propName;
    let tsTypeStr;
    let descriptor;
    let nullable;
    let isRequired;
    if (isDiscriminator) {
      tsTypeStr = JSON.stringify(variantOpts.literal);
      descriptor = { kind: "literal", value: variantOpts.literal };
      nullable = false;
      isRequired = true;
    } else {
      const t = tsType(registry, propSchema, name + typeName(propName));
      tsTypeStr = t.type;
      descriptor = t.descriptor;
      nullable = propSchema.nullable === true;
      isRequired = required.has(propName);
    }
    props.push({
      keyLiteral: propertyKeyLiteral(propName),
      tsType: tsTypeStr,
      descriptor,
      required: isRequired,
      nullable,
      description: propSchema.description || null,
    });
  }
  addModel(registry, name, { name, kind: "interface", description: schema.description || null, properties: props });
}

function registerEnum(registry, name, schema) {
  if (registry.models.has(name)) return;
  const isNumeric = schema.type === "integer" || schema.type === "number";
  // A literal `null` entry (some real-world specs write `enum: [foo, bar, null]` alongside
  // `nullable: true`) isn't a real enum member - the property's TS type already becomes
  // `X | null` via `nullable`, so a JSON null there needs no enum member of its own.
  const entries = (schema.enum || [])
    .filter((v) => v !== null)
    .map((v) => ({ memberName: enumMemberName(v), valueLiteral: isNumeric ? String(v) : JSON.stringify(String(v)) }));
  addModel(registry, name, { name, kind: "enum", description: schema.description || null, entries });
}

// Flattens allOf branches into a single interface (merged properties), like a nominally-typed
// generator's "merge into one object" strategy - NOT `extends`/an intersection type, because
// allOf branches are frequently inline (not all named $refs, so `extends` can't cleanly apply to
// every branch) and because TS's `&` silently collapses incompatible primitive types to `never`
// instead of erroring, which would turn a spec authoring mistake into a confusing generated type.
// Uses the engine's flattenAllOf() (see docs/javascript-api.md), which recursively merges nested
// allOf branches - handles a branch that itself uses allOf, which a one-level-only merge would
// silently drop properties from.
function registerMergedAllOf(registry, name, schema, variantOpts) {
  if (registry.models.has(name)) return;
  const flat = flattenAllOf(schema);
  const merged = { type: "object", properties: flat.properties, required: flat.required, description: schema.description || null };
  registerInterface(registry, name, merged, variantOpts);
}

// Registers a oneOf/anyOf (discriminated or not) as a plain native TS union type alias.
function registerUnionAlias(registry, name, schema) {
  if (registry.models.has(name)) return;
  const variants = schema.oneOf || schema.anyOf || [];
  const members = variants.map((variant, index) => {
    const variantRawName = nameOf(variant);
    const hint = name + (variantRawName ? typeName(variantRawName) : `Variant${index + 1}`);
    return tsType(registry, variant, hint);
  });
  addModel(registry, name, {
    name,
    kind: "alias",
    description: schema.description || null,
    targetType: members.length ? members.map((m) => m.type).join(" | ") : "unknown",
    targetDescriptor: members.length ? { kind: "union", members: members.map((m) => m.descriptor) } : { kind: "unknown" },
  });
}

// Maps a schema's `type`/`format` to a TS primitive, or null if it isn't a plain scalar. Every
// numeric format (int32/int64/float/double) maps to the same `number` - see README's Known
// Limitations for the int64-precision trade-off this implies. `date`/`date-time`/`byte`/`binary`
// all stay `string`: mapping to `Date` while the actual runtime value from JSON.parse is a string
// would be a type-system lie no consumer could catch at compile time.
function primitiveTsType(s) {
  const type = s.type;
  if (type === "string") return "string";
  if (type === "integer" || type === "number") return "number";
  if (type === "boolean") return "boolean";
  return null;
}

// Maps a schema appearing in a property/parameter/array-item position to a TS type string plus
// its structural descriptor (see this file's header comment), registering any newly-discovered
// named model along the way. `hintName` is only used if an inline (non-named) schema needs to be
// turned into its own named model.
export function tsType(registry, schema, hintName) {
  const s = schema || {};

  const name = nameOf(s);
  if (name) {
    const n = typeName(name);
    return { type: n, descriptor: { kind: "ref", refName: n } };
  }

  const kind = kindOf(s);
  if (kind === "Enum") {
    registerEnum(registry, hintName, s);
    return { type: hintName, descriptor: { kind: "ref", refName: hintName } };
  }
  if (kind === "OneOf" || kind === "AnyOf") {
    registerUnionAlias(registry, hintName, s);
    return { type: hintName, descriptor: { kind: "ref", refName: hintName } };
  }
  if (kind === "AllOf") {
    registerMergedAllOf(registry, hintName, s);
    return { type: hintName, descriptor: { kind: "ref", refName: hintName } };
  }
  if (kind === "Array") {
    const itemType = tsType(registry, s.items || {}, hintName + "Item");
    return { type: `${itemType.type}[]`, descriptor: { kind: "array", item: itemType.descriptor } };
  }
  if (kind === "Object") {
    registerInterface(registry, hintName, s);
    return { type: hintName, descriptor: { kind: "ref", refName: hintName } };
  }
  if (kind === "Map") {
    if (s.additionalProperties && typeof s.additionalProperties === "object") {
      const valueType = tsType(registry, s.additionalProperties, hintName + "Value");
      return { type: `Record<string, ${valueType.type}>`, descriptor: { kind: "record", value: valueType.descriptor } };
    }
    return { type: "Record<string, unknown>", descriptor: { kind: "record", value: null } };
  }
  const prim = primitiveTsType(s);
  if (prim) return { type: prim, descriptor: { kind: "primitive", type: prim } };
  return { type: "unknown", descriptor: { kind: "unknown" } };
}

function registerTopLevel(registry, name, schema, variantOpts) {
  const kind = kindOf(schema);
  if (kind === "Enum") {
    registerEnum(registry, name, schema);
    return;
  }
  if (kind === "AllOf") {
    registerMergedAllOf(registry, name, schema, variantOpts);
    return;
  }
  if (kind === "OneOf" || kind === "AnyOf") {
    registerUnionAlias(registry, name, schema);
    return;
  }
  if (kind === "Array") {
    const itemType = tsType(registry, schema.items || {}, name + "Item");
    addModel(registry, name, {
      name,
      kind: "alias",
      targetType: `${itemType.type}[]`,
      targetDescriptor: { kind: "array", item: itemType.descriptor },
      description: schema.description || null,
    });
    return;
  }
  if (kind === "Object") {
    registerInterface(registry, name, schema, variantOpts);
    return;
  }
  if (kind === "Map") {
    if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
      const valueType = tsType(registry, schema.additionalProperties, name + "Value");
      addModel(registry, name, {
        name,
        kind: "alias",
        targetType: `Record<string, ${valueType.type}>`,
        targetDescriptor: { kind: "record", value: valueType.descriptor },
        description: schema.description || null,
      });
    } else {
      addModel(registry, name, {
        name,
        kind: "alias",
        targetType: "Record<string, unknown>",
        targetDescriptor: { kind: "record", value: null },
        description: schema.description || null,
      });
    }
    return;
  }
  const prim = primitiveTsType(schema);
  if (prim) {
    addModel(registry, name, {
      name,
      kind: "alias",
      targetType: prim,
      targetDescriptor: { kind: "primitive", type: prim },
      description: schema.description || null,
    });
    return;
  }
  // Fallback: an unrecognized/free-form shape becomes an (empty-ish) interface, mirroring the
  // most permissive reasonable guess rather than erroring outright.
  registerInterface(registry, name, schema, variantOpts);
}

// Walks schema.components.schemas and builds the full model registry: plain union type aliases
// for oneOf/anyOf (discriminated or not), enums, flattened allOf interfaces, array/map/scalar
// type aliases, and plain interfaces - including any inline types discovered transitively along
// the way (via tsType, called both here and from lib/operations.js while building operation
// param/body/response descriptors).
export function buildModelRegistry(root) {
  const registry = newRegistry();
  const schemas = (root.components && root.components.schemas) || {};

  // Pass 1: find discriminated unions via the engine's resolveDiscriminator() (see
  // docs/javascript-api.md - it already resolves each variant's component name and discriminator
  // literal, including the mapping-less "falls back to the component name itself" default),
  // register them immediately as a plain union alias (unlike a nominally-typed generator, the
  // alias's right-hand side is already fully known - no forward-declared marker needed), and
  // record which variant schemas need their discriminator property forced to a literal type
  // (must happen before pass 2 registers the variants as interfaces). Anything else shaped like
  // oneOf/anyOf - no discriminator, or variants that aren't a reference to a named schema - is
  // left for pass 2 to register as an ordinary union alias with no literal-narrowing (still a
  // perfectly usable TS union; it just can't be dispatched on a single property no oneOf/anyOf
  // schema promised existed on every branch).
  const discriminatedUnionNames = new Set();
  const variantInfo = new Map();
  for (const [rawName, schema] of Object.entries(schemas)) {
    const disc = resolveDiscriminator(schema);
    if (!disc) continue;

    const name = typeName(rawName);
    const memberNames = disc.variants.map((v) => typeName(v.name));
    addModel(registry, name, {
      name,
      kind: "alias",
      description: schema.description || null,
      targetType: memberNames.join(" | "),
      targetDescriptor: { kind: "union", members: memberNames.map((n) => ({ kind: "ref", refName: n })) },
    });
    discriminatedUnionNames.add(name);

    for (const variant of disc.variants) {
      const variantName = typeName(variant.name);
      variantInfo.set(variantName, { property: disc.property, literal: variant.literal });
    }
  }

  // Pass 2: register everything else (interfaces, enums, merged-allOf interfaces, array/map/
  // scalar type aliases, undiscriminated unions).
  for (const rawName of Object.keys(schemas)) {
    const name = typeName(rawName);
    const existing = registry.models.get(name);
    if (existing) {
      if (discriminatedUnionNames.has(name)) continue; // already registered in pass 1
      throw Error(`<b7c1e2a9> Schema name collision after TypeScript identifier conversion: "${rawName}" -> "${name}"`);
    }
    withResilience(
      `schema "${rawName}"`,
      () => registerTopLevel(registry, name, schemas[rawName], variantInfo.get(name)),
      () =>
        addModel(registry, name, {
          name,
          kind: "alias",
          targetType: "unknown",
          targetDescriptor: { kind: "unknown" },
          description: null,
        })
    );
  }

  return registry;
}
