// Maps OpenAPI schemas to a registry of named Python models to render (see main.js), mirroring the
// shape of the sibling generators' lib/types.js (compare ../../ruby_faraday_client_generator/src/
// lib/types.js's rubyType()) but simplified for this generator's v1 scope: no oneOf/anyOf/enum
// support yet (see README "Known limitations"), so unlike Ruby's rubyType(), a *named* Map/Array/
// primitive schema never becomes an opaque "ref" needing its own from_wire/to_wire dispatch -
// Python has no lightweight way to hang classmethods off a bare `Name = Dict[str, str]` type alias
// the way Ruby hangs `self.from_h`/`self.to_wire` off a module. Instead, only "Object" (and
// multi-branch "AllOf") schemas become real classes with a ref descriptor; every other kind
// resolves to its own structural descriptor directly, inlined wherever it's used - a named Map/
// Array/primitive schema still gets its own `models/<name>.py` file (for readability and re-export
// from `models/__init__.py`), just with no runtime dispatch object behind it.

import { className, fieldName, moduleName } from "./naming.js";
import { escapePythonString } from "./keywords.js";
import { buildFromWireExpr, buildToWireExpr, buildValidateStatements } from "./serialization.js";
import { withResilience } from "./strict.js";

function newRegistry(reservedNames) {
  return { models: new Map(), order: [], reservedNames };
}

function disambiguateHintName(registry, candidate) {
  return disambiguateName(candidate, registry.reservedNames);
}

function addModel(registry, name, entry) {
  registry.models.set(name, entry);
  registry.order.push(name);
}

function primitiveDescriptor(s) {
  if (s.type === "string") return { kind: "primitive", pyType: "str" };
  if (s.type === "integer") return { kind: "primitive", pyType: "int" };
  if (s.type === "number") return { kind: "primitive", pyType: "float" };
  if (s.type === "boolean") return { kind: "primitive", pyType: "bool" };
  return null;
}

function primitiveLabel(descriptor) {
  return descriptor.pyType;
}

// See the fromWireExpr comment below (registerClass) for why every property's fromWireExpr is
// wrapped in cast(): buildFromWireExpr's array/record/ref cases null-guard every level (matching
// the sibling Ruby generator's own `&.` null-safety), which makes mypy infer an Optional element
// type even one level down inside a nested comprehension (e.g. a List[Dict[str, str]] property
// still infers List[Dict[str, str] | None] internally, from the same defensive per-element guard)
// - cast() to the property's own declared type (Optional[...] for an optional/nullable property,
// bare otherwise) tells mypy to trust the schema's own shape wholesale instead of re-deriving it
// from the conversion expression's internals.
function buildFromWireExprTyped(t, expr, optional) {
  const raw = buildFromWireExpr(t.descriptor, expr);
  const castType = optional ? `Optional[${t.label}]` : t.label;
  return `cast(${castType}, ${raw})`;
}

function registerClass(registry, name, schema) {
  if (registry.models.has(name)) return;
  const required = new Set(schema.required || []);
  const allProps = [];
  for (const [propName, propSchema] of Object.entries(schema.properties || {})) {
    const pyName = fieldName(propName);
    const t = pyType(registry, propSchema, name + className(propName));
    const isRequired = required.has(propName);
    const isNullable = propSchema.nullable === true;
    const validateStatements = buildValidateStatements(t.descriptor, propSchema, `self.${pyName}`, propName);
    if (isRequired && !isNullable) {
      validateStatements.unshift(`if self.${pyName} is None: raise ValidationError('"${propName}" is required')`);
    }
    allProps.push({
      pyName,
      wireName: propName,
      wireLiteral: escapePythonString(propName),
      descriptor: t.descriptor,
      label: t.label,
      required: isRequired,
      nullable: isNullable,
      optional: !isRequired || isNullable,
      description: propSchema.description || null,
      // runtime.field(d, key) instead of a bare d.get(key): mypy --strict infers dict.get()'s
      // no-default overload as returning "V | None" even when V is already Any, which then fails
      // an "arg-type" check against a required (non-Optional) property - wrapping through a
      // helper explicitly typed to return plain Any (see runtime.py) avoids that false positive
      // without changing runtime behavior at all.
      //
      // A required, non-nullable property's fromWireExpr is additionally wrapped in cast() (a
      // mypy-only no-op at runtime) - buildFromWireExpr's array/record/ref cases always null-guard
      // ("X if expr is not None else None", same null-safety as the sibling Ruby generator's `&.`),
      // so the expression's real inferred type is Optional even for a field the dataclass declares
      // as required (no default). Actual safety isn't weakened by the cast: a genuinely missing/
      // null value for a required field is still caught by the required-field check this function
      // adds to validateStatements below (`raise ValidationError` if still None), and callers are
      // expected to call validate() before trusting a from_wire()'d instance - cast() only tells
      // mypy to trust that contract at the type level, same as at every other codegen boundary
      // between "untyped JSON" and "the type this schema promises".
      fromWireExpr: buildFromWireExprTyped(t, `runtime.field(d, ${escapePythonString(propName)})`, !isRequired || isNullable),
      toWireExpr: buildToWireExpr(t.descriptor, `value.${pyName}`),
      validateStatements,
    });
  }
  // Dataclass fields without a default must precede fields with one - required fields first,
  // optional/nullable ones (which get `= None`) after, same ordering choice
  // kotlin_ktor_server_generator's lib/operations.js buildSignature makes for the same reason.
  const properties = [...allProps.filter((p) => !p.optional), ...allProps.filter((p) => p.optional)];
  const validateBodyLines = properties.flatMap((p) => p.validateStatements);
  if (validateBodyLines.length === 0) validateBodyLines.push("pass");
  addModel(registry, name, {
    name,
    kind: "class",
    module: moduleName(name),
    description: schema.description || null,
    properties,
    validateBodyLines,
  });
}

function registerMergedAllOf(registry, name, schema) {
  if (registry.models.has(name)) return;
  const flat = flattenAllOf(schema);
  registerClass(registry, name, { type: "object", properties: flat.properties, required: flat.required, description: schema.description || null });
}

// Registers a Map/Array/primitive top-level schema purely for its own `models/<name>.py` file and
// `models/__init__.py` re-export - see this file's header comment for why it carries no from_wire/
// to_wire/validate of its own (callers use `descriptor` directly, inlined at each use site).
function registerAlias(registry, name, description, descriptor, label) {
  if (registry.models.has(name)) return;
  addModel(registry, name, { name, kind: "alias", module: moduleName(name), description: description || null, descriptor, label });
}

// Maps a schema to a { label, descriptor } pair, registering any newly-discovered named model
// along the way. `hintName` is only used if an inline (non-named) schema needs its own class.
export function pyType(registry, schema, hintName) {
  const s = schema || {};
  const kind = kindOf(s);

  if (kind === "AllOf") {
    if ((s.allOf || []).length <= 1) return pyType(registry, (s.allOf || [])[0] || {}, hintName);
    const name = nameOf(s) ? className(nameOf(s)) : disambiguateHintName(registry, hintName);
    registerMergedAllOf(registry, name, s);
    return { label: name, descriptor: { kind: "ref", refName: name } };
  }
  if (kind === "Object") {
    const name = nameOf(s) ? className(nameOf(s)) : disambiguateHintName(registry, hintName);
    registerClass(registry, name, s);
    return { label: name, descriptor: { kind: "ref", refName: name } };
  }
  if (kind === "Array") {
    const item = pyType(registry, s.items || {}, hintName + "Item");
    const label = `List[${item.label}]`;
    const descriptor = { kind: "array", item: item.descriptor };
    const rawName = nameOf(s);
    if (rawName) registerAlias(registry, className(rawName), s.description, descriptor, label);
    return { label, descriptor };
  }
  if (kind === "Map") {
    let label, descriptor;
    if (s.additionalProperties && typeof s.additionalProperties === "object") {
      const value = pyType(registry, s.additionalProperties, hintName + "Value");
      label = `Dict[str, ${value.label}]`;
      descriptor = { kind: "record", value: value.descriptor };
    } else {
      label = "Dict[str, Any]";
      descriptor = { kind: "record", value: null };
    }
    const rawName = nameOf(s);
    if (rawName) registerAlias(registry, className(rawName), s.description, descriptor, label);
    return { label, descriptor };
  }
  const prim = primitiveDescriptor(s);
  if (prim) {
    const label = primitiveLabel(prim);
    const rawName = nameOf(s);
    if (rawName) registerAlias(registry, className(rawName), s.description, prim, label);
    return { label, descriptor: prim };
  }
  if (kind === "Enum" || kind === "OneOf" || kind === "AnyOf") {
    throw Error(`<f3a9c2e1> Unsupported schema kind "${kind}" - enums/oneOf/anyOf are not supported in v1 (see README "Known limitations")`);
  }
  return { label: "Any", descriptor: { kind: "unknown" } };
}

function registerTopLevel(registry, name, schema) {
  const kind = kindOf(schema);
  if (kind === "Enum" || kind === "OneOf" || kind === "AnyOf") {
    throw Error(`<a7d4e6b2> Unsupported schema kind "${kind}" for "${name}" - enums/oneOf/anyOf are not supported in v1 (see README "Known limitations")`);
  }
  if (kind === "AllOf" && (schema.allOf || []).length > 1) return registerMergedAllOf(registry, name, schema);
  if (kind === "AllOf") return registerTopLevel(registry, name, (schema.allOf || [])[0] || {});
  if (kind === "Object") return registerClass(registry, name, schema);
  // Array/Map/Primitive: pyType() itself registers the alias (it re-derives the name via nameOf,
  // same name we were called with) - just need to trigger it.
  pyType(registry, schema, name);
}

// Walks schema.components.schemas and builds the full model registry - including any inline types
// discovered transitively along the way (via pyType(), called both here and from lib/operations.js
// while building operation param/body/response descriptors).
export function buildModelRegistry(root) {
  const schemas = (root.components && root.components.schemas) || {};
  const registry = newRegistry(Object.keys(schemas).map(className));
  // Tracks which raw schema name first claimed each converted className - a schema reached via a
  // $ref from an earlier-processed sibling (e.g. NewWidget.labels: allOf [$ref WidgetLabels]) is
  // already in registry.models by the time this loop reaches its own top-level entry; that's an
  // idempotent re-visit of the SAME schema (registerAlias/registerClass are themselves no-ops on
  // an already-registered name), not a collision - only two DIFFERENT raw names converging on one
  // className is the real error this guards against.
  const sourceOf = new Map();

  for (const rawName of Object.keys(schemas)) {
    const name = className(rawName);
    const existingSource = sourceOf.get(name);
    if (existingSource && existingSource !== rawName) {
      throw Error(`<c4e1b9a0> Schema name collision after Python identifier conversion: "${existingSource}" and "${rawName}" both become "${name}"`);
    }
    sourceOf.set(name, rawName);
    if (registry.models.has(name)) continue;
    withResilience(
      `schema "${rawName}"`,
      () => registerTopLevel(registry, name, schemas[rawName]),
      () => addModel(registry, name, { name, kind: "alias", module: moduleName(name), description: null, descriptor: { kind: "unknown" }, label: "Any" })
    );
  }

  return registry;
}
