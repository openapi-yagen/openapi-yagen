// Maps OpenAPI schemas to a registry of named Python models to render (see main.js), mirroring the
// shape of the sibling generators' lib/types.js (compare ../../ruby_faraday_client_generator/src/
// lib/types.js's rubyType()). "Object" (and multi-branch "AllOf") schemas become dataclasses;
// "Enum" and "oneOf"/"anyOf" schemas become a plain class acting as a from_wire/to_wire dispatch
// namespace (see registerEnum/registerUnionDiscriminated/registerUnionDispatch below) - no
// instances of that class are ever constructed for a union, only for an enum, where the class
// itself IS the value type (Python's own enum.Enum). Every other kind (Array/Map/primitive)
// resolves to its own structural descriptor directly, inlined wherever it's used - a named
// Map/Array/primitive schema still gets its own alias model (for re-export), just with no runtime
// dispatch object behind it.
//
// This generator declares openApiVersion "3.2" (see generator.yml), so nullability is read from the
// JSON Schema 2020-12 dialect OAS 3.1+ uses: a schema is nullable when its `type` is an array
// containing "null" (there is no `nullable` boolean key in this dialect - see isNullable below).

import { className, fieldName, moduleName, enumConstantName } from "./naming.js";
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

// A schema is nullable in the OAS 3.1+/3.2 dialect when its `type` is an array containing "null" -
// there is no `nullable` boolean key in this dialect (that's 3.0-only).
function isNullable(schema) {
  return Array.isArray(schema.type) && schema.type.includes("null");
}

// The schema's own scalar type keyword, ignoring "null" - `type` may be a plain string or (OAS
// 3.1+) an array like ["string", "null"].
function baseType(schema) {
  if (Array.isArray(schema.type)) return schema.type.find((t) => t !== "null") || null;
  return schema.type || null;
}

function primitiveDescriptor(s) {
  const t = baseType(s);
  if (t === "string") {
    // `format: date`/`date-time` get a real datetime.date/datetime.datetime type (not a plain
    // str) - the parse IS the validation (see serialization.js's buildFromWireExpr, which routes
    // through runtime.parse_date/parse_datetime), same design as this project's Kotlin server
    // generator. Fully module-qualified ("datetime.date", not a bare "date") so every generated
    // file needs only a plain `import datetime`, never `from datetime import date` (which would
    // otherwise collide with a property named "date" and, for "datetime", awkwardly shadow the
    // module name with the class name of the same spelling).
    if (s.format === "date") return { kind: "primitive", pyType: "datetime.date" };
    if (s.format === "date-time") return { kind: "primitive", pyType: "datetime.datetime" };
    // `format: binary` means "arbitrary file/binary content" (OpenAPI's convention for a
    // multipart file field) - mapped to a real `bytes` instead of the generic `str` every other
    // string format falls back to, so a multipart form field can be received as actual bytes (see
    // operations.js's buildRequestBody, which routes a `bytes`-typed multipart field through
    // `self.request.files` instead of `self.get_body_argument`). A JSON body's own `format:
    // binary` property is a separate, unsupported edge case this doesn't attempt to fix (json.
    // dumps can't serialize `bytes` at all) - the same scope this project's Go/Kotlin server
    // generators accept for the identical schema shape.
    if (s.format === "binary") return { kind: "primitive", pyType: "bytes" };
    return { kind: "primitive", pyType: "str" };
  }
  if (t === "integer") return { kind: "primitive", pyType: "int" };
  if (t === "number") return { kind: "primitive", pyType: "float" };
  if (t === "boolean") return { kind: "primitive", pyType: "bool" };
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
//
// A "ref" descriptor is the one exception: `{refName}.from_wire(expr)` is already precisely typed
// as `Optional["{refName}"]` by that class's own from_wire signature (a dataclass/enum/union all
// declare it that way) - wrapping an already-Optional-typed expression in cast(Optional[...], ...)
// for an optional/nullable property would be a no-op mypy flags as a redundant cast under --strict.
// A *required*, non-nullable ref property still needs the cast (to narrow away that Optional[...]
// down to the bare type, same trust-the-validated-contract reasoning as every other kind here).
function buildFromWireExprTyped(t, expr, optional) {
  const raw = buildFromWireExpr(t.descriptor, expr);
  if (t.descriptor.kind === "ref" && optional) return raw;
  const castType = optional ? `Optional[${t.label}]` : t.label;
  return `cast(${castType}, ${raw})`;
}

// Turns a property's `default` schema keyword into a Python literal - used both as the dataclass
// field's own `= <literal>` default (instead of always `= None`) and, via fromWireExpr below, as
// what from_wire falls back to when the JSON key is absent. Returns null for any shape not
// recognized (e.g. an object/array default, or an enum value that doesn't match one of its own
// entries) - the property then falls back to its ordinary `None` default, same as if `default`
// were absent.
function buildDefaultLiteral(registry, descriptor, value) {
  if (value === undefined) return null;
  if (descriptor.kind === "primitive") {
    if (descriptor.pyType === "str") return escapePythonString(String(value));
    if (descriptor.pyType === "int" || descriptor.pyType === "float") return String(value);
    if (descriptor.pyType === "bool") return value ? "True" : "False";
    return null; // datetime.date/datetime.datetime: no literal syntax worth generating for this
  }
  if (descriptor.kind === "ref") {
    const model = registry.models.get(descriptor.refName);
    if (!model || model.kind !== "enum") return null;
    const literal = model.isInt ? String(value) : escapePythonString(String(value));
    const entry = model.entries.find((e) => e.wireValueLiteral === literal);
    return entry ? `${descriptor.refName}.${entry.constantName}` : null;
  }
  return null;
}

function registerClass(registry, name, schema) {
  if (registry.models.has(name)) return;
  const required = new Set(schema.required || []);
  const allProps = [];
  for (const [propName, propSchema] of Object.entries(schema.properties || {})) {
    const pyName = fieldName(propName);
    const t = pyType(registry, propSchema, name + className(propName));
    const isRequired = required.has(propName);
    const nullable = isNullable(propSchema);
    const validateStatements = buildValidateStatements(t.descriptor, propSchema, `self.${pyName}`, propName);
    if (isRequired && !nullable) {
      validateStatements.unshift(`if self.${pyName} is None: raise ValidationError('"${propName}" is required')`);
    }
    // Only an optional property gets a default literal - a `default` alongside a required
    // property is unusual (the property is never actually absent) and not worth special-casing.
    const defaultLiteral = !isRequired && "default" in propSchema ? buildDefaultLiteral(registry, t.descriptor, propSchema.default) : null;
    allProps.push({
      pyName,
      wireName: propName,
      wireLiteral: escapePythonString(propName),
      descriptor: t.descriptor,
      label: t.label,
      required: isRequired,
      nullable,
      optional: !isRequired || nullable,
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
      // An absent key uses the default; an explicit JSON null (key present, value None) still
      // goes through the normal from_wire conversion below, which is None-safe and correctly
      // yields None, not the default - the same "absent vs. explicit null" distinction the
      // Go/Kotlin generators' own default handling preserves. Built as a plain ternary (not
      // routed through the from_wire conversion the way a present key's value is) so an enum
      // default doesn't get redundantly re-passed through that enum's own from_wire - the literal
      // is already the correctly-typed final value. Python's `key in d` is what makes this cheap
      // to express directly, unlike Go (which needs a custom UnmarshalJSON).
      defaultLiteral,
      fromWireExpr: defaultLiteral
        ? `(${buildFromWireExprTyped(t, `d[${escapePythonString(propName)}]`, !isRequired || nullable)} if ${escapePythonString(propName)} in d else ${defaultLiteral})`
        : buildFromWireExprTyped(t, `runtime.field(d, ${escapePythonString(propName)})`, !isRequired || nullable),
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

// Registers an enum as a plain `class Name(str, Enum)`/`class Name(int, Enum)` (see
// templates/models.py.j2) - from_wire/to_wire wrap the constructor (`Name(value)` already raises
// ValueError on an unrecognized value, caught and re-raised as ValidationError) and validate() is a
// no-op, so this reuses the exact same "ref" descriptor every other named model already returns -
// no new descriptor kind needed anywhere else in this file or in lib/operations.js.
function registerEnum(registry, name, schema) {
  if (registry.models.has(name)) return;
  const isInt = baseType(schema) === "integer";
  // A literal `null` entry (some real-world specs write `enum: [foo, bar, null]` alongside a
  // nullable type) isn't a real enum member - an optional/nullable property already allows a bare
  // JSON null without needing one of its own (nullable/required are handled at the property level,
  // same as every sibling generator's own registerEnum).
  const entries = (schema.enum || [])
    .filter((v) => v !== null)
    .map((v) => ({ constantName: enumConstantName(v), wireValueLiteral: isInt ? String(v) : escapePythonString(String(v)) }));
  addModel(registry, name, { name, kind: "enum", module: moduleName(name), description: schema.description || null, isInt, entries });
}

// Registers a discriminated oneOf/anyOf (resolveDiscriminator() already guarantees every variant is
// a $ref to a named schema) as a from_wire/to_wire dispatch namespace class - no instance of this
// class is ever created, and no `skipProperty` mechanism is needed for the variants' own
// discriminator field: Python has no static type to narrow on it, so it just stays an ordinary
// property on the variant dataclass, same simplification the Ruby generator already makes.
function registerUnionDiscriminated(registry, name, schema, disc) {
  const variants = disc.variants.map((v) => ({ label: className(v.name), literalLiteral: escapePythonString(v.literal) }));
  addModel(registry, name, {
    name,
    kind: "union",
    module: moduleName(name),
    description: schema.description || null,
    discriminant: disc.property,
    discriminantLiteral: escapePythonString(disc.property),
    variantLabelsJoined: variants.map((v) => v.label).join(", "),
    variants,
    fallbackFromWireExpr: null,
  });
}

// Python boolean expression testing whether raw (still-JSON-shaped) `value` belongs to a variant
// classified as `dispatchKind`/`dispatchField` (see the engine's resolveUnionDispatch(),
// docs/javascript-api.md) - null means "matches anything" (only possible for dispatchKind "any",
// rendered as a plain `else` rather than an `if`/`elif` guard).
function dispatchGuard(dispatchKind, dispatchField) {
  switch (dispatchKind) {
    case "object":
      return dispatchField ? `isinstance(value, dict) and ${escapePythonString(dispatchField)} in value` : "isinstance(value, dict)";
    case "array":
      return "isinstance(value, list)";
    case "string":
      return "isinstance(value, str)";
    case "number":
      return "isinstance(value, (int, float)) and not isinstance(value, bool)";
    case "boolean":
      return "isinstance(value, bool)";
    case "any":
    default:
      return null;
  }
}

// Python boolean expression testing whether an already-Python-typed `value` (not raw JSON) belongs
// to a variant with this descriptor - the inverse direction of dispatchGuard, needed for to_wire
// (given a constructed value, which variant's own toWireExpr applies). A ref-kind variant's own
// class name; primitive/array/record kinds map to their natural Python type. "unknown" (free-form/
// any) always matches - only ever the trailing fallback.
function valueGuard(descriptor) {
  switch (descriptor.kind) {
    case "ref":
      return `isinstance(value, ${descriptor.refName})`;
    case "array":
      return "isinstance(value, list)";
    case "record":
      return "isinstance(value, dict)";
    case "primitive":
      if (descriptor.pyType === "str") return "isinstance(value, str)";
      if (descriptor.pyType === "int") return "isinstance(value, int) and not isinstance(value, bool)";
      if (descriptor.pyType === "float") return "isinstance(value, (int, float)) and not isinstance(value, bool)";
      if (descriptor.pyType === "bool") return "isinstance(value, bool)";
      if (descriptor.pyType === "bytes") return "isinstance(value, bytes)";
      // datetime.datetime is a SUBCLASS of datetime.date, so the date check excludes it explicitly
      // - otherwise a datetime.datetime value would also match a sibling "date" union variant.
      if (descriptor.pyType === "datetime.date") return "isinstance(value, datetime.date) and not isinstance(value, datetime.datetime)";
      if (descriptor.pyType === "datetime.datetime") return "isinstance(value, datetime.datetime)";
      return null;
    case "unknown":
    default:
      return null;
  }
}

// Registers an undiscriminated oneOf/anyOf as a from_wire/to_wire dispatch namespace class, using
// the engine's resolveUnionDispatch() - see docs/javascript-api.md for exactly what shapes/
// uniqueness it guarantees. Variants are reordered so the dispatch chain checks the most specific
// case first: object variants with their own distinguishing field, then other single-shape variants
// (array/string/number/boolean), then at most one shape-only/field-less fallback last - mirrors the
// Kotlin/Ruby/Go generators' own dispatcher ordering.
function registerUnionDispatch(registry, name, schema) {
  if (registry.models.has(name)) return;
  const variants = schema.oneOf || schema.anyOf || [];
  const dispatch = resolveUnionDispatch(schema);
  const built = variants.map((variant, index) => {
    const variantRawName = nameOf(variant);
    const hint = name + (variantRawName ? className(variantRawName) : `Variant${index + 1}`);
    const t = pyType(registry, variant, hint);
    const d = dispatch.variants[index];
    return {
      label: t.label,
      dispatchKind: d.dispatchKind,
      dispatchField: d.dispatchField,
      guardExpr: dispatchGuard(d.dispatchKind, d.dispatchField),
      valueGuardExpr: valueGuard(t.descriptor),
      fromWireExpr: buildFromWireExpr(t.descriptor, "value"),
      toWireExpr: buildToWireExpr(t.descriptor, "value"),
    };
  });
  const withField = built.filter((v) => v.dispatchKind === "object" && v.dispatchField);
  const shapeOnly = built.filter((v) => ["array", "string", "number", "boolean"].includes(v.dispatchKind));
  const fallback = built.filter((v) => (v.dispatchKind === "object" && !v.dispatchField) || v.dispatchKind === "any");
  const orderedVariants = [...withField, ...shapeOnly, ...fallback];
  // Non-null only when the last variant's guard is unconditional (dispatchKind "any") - meaning the
  // generated from_wire dispatch chain always terminates in a matching branch (this becomes the
  // template's trailing `return`) instead of needing a "no variant matched" `raise` at the end.
  const last = orderedVariants[orderedVariants.length - 1];
  const fallbackFromWireExpr = last && last.guardExpr === null ? last.fromWireExpr : null;
  addModel(registry, name, {
    name,
    kind: "union",
    module: moduleName(name),
    description: schema.description || null,
    discriminant: null,
    variantLabelsJoined: orderedVariants.map((v) => v.label).join(", "),
    variants: orderedVariants,
    fallbackFromWireExpr,
  });
}

// Registers a Map/Array/primitive top-level schema purely for its own re-export - see this file's
// header comment for why it carries no from_wire/to_wire/validate of its own (callers use
// `descriptor` directly, inlined at each use site).
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
  if (kind === "Enum") {
    const name = nameOf(s) ? className(nameOf(s)) : disambiguateHintName(registry, hintName);
    registerEnum(registry, name, s);
    return { label: name, descriptor: { kind: "ref", refName: name } };
  }
  if (kind === "OneOf" || kind === "AnyOf") {
    // A single-variant oneOf/anyOf is trivially just that one variant's schema - a common
    // real-world idiom (attaching a sibling description next to a $ref) that shouldn't need its
    // own dispatch class - same simplification every sibling generator's own type-mapper makes.
    const variants = s.oneOf || s.anyOf || [];
    if (variants.length === 1) return pyType(registry, variants[0], hintName);
    const name = nameOf(s) ? className(nameOf(s)) : disambiguateHintName(registry, hintName);
    registerUnionDispatch(registry, name, s);
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
  return { label: "Any", descriptor: { kind: "unknown" } };
}

function registerTopLevel(registry, name, schema) {
  const kind = kindOf(schema);
  if (kind === "Enum") return registerEnum(registry, name, schema);
  if (kind === "AllOf" && (schema.allOf || []).length > 1) return registerMergedAllOf(registry, name, schema);
  if (kind === "AllOf") return registerTopLevel(registry, name, (schema.allOf || [])[0] || {});
  if (kind === "OneOf" || kind === "AnyOf") {
    const variants = schema.oneOf || schema.anyOf || [];
    // Same single-variant shortcut as pyType() - a named top-level schema whose oneOf/anyOf has
    // just one branch is really just that branch, registered directly under this name instead of
    // a dispatch class with nothing to dispatch on.
    if (variants.length === 1) return registerTopLevel(registry, name, variants[0]);
    return registerUnionDispatch(registry, name, schema);
  }
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

  // Pass 1: discriminated unions - resolveDiscriminator() already guarantees every variant is a
  // $ref to a named schema, so this only registers the union's own dispatch class; each variant
  // (e.g. "Circle") is left for pass 2 below, which registers it exactly like any other top-level
  // schema (registerUnionDiscriminated needs no skipProperty/variant pre-registration, unlike
  // Kotlin's sealed-interface design - see that function's own comment).
  for (const [rawName, schema] of Object.entries(schemas)) {
    const disc = resolveDiscriminator(schema);
    if (!disc) continue;
    const name = className(rawName);
    registerUnionDiscriminated(registry, name, schema, disc);
    sourceOf.set(name, rawName);
  }

  // Pass 2: everything else.
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
