// Builds the source of a recursive runtime type-guard function per model, used only when the
// `validateResponses` generator variable is "true" (see generator.yml). Consumes the structural
// "descriptor" every lib/types.js type-mapping function returns alongside its printed TS type
// string (see that file's header comment) - this module never re-parses a TS type string, it just
// walks the same descriptor tree the type mapper already built.
//
// A descriptor is one of:
//   { kind: "primitive", type: "string"|"number"|"boolean" }
//   { kind: "literal", value: <the exact discriminator value> }
//   { kind: "ref", refName: <name of another registered model - has its own is<Name> guard> }
//   { kind: "array", item: <descriptor> }
//   { kind: "record", value: <descriptor> | null }   // null = Record<string, unknown>, no per-value check
//   { kind: "union", members: <descriptor[]> }
//   { kind: "unknown" }                                // no meaningful check possible - always passes
//
// Every registered model (interface/enum/alias) gets its own `export function is<Name>(value:
// unknown): value is <Name>` in its own file, so a "ref" descriptor always compiles to a plain
// function call - recursion (a model referencing itself, directly or through a cycle) works
// unmodified, since the guard is a hoisted `function` declaration in the same file it recurses
// into itself from, and a *mutual* cycle across files works too (each side just calls the other's
// already-exported guard).

// Builds a boolean TS expression testing whether `valueExpr` (any string expression, e.g. "value"
// or 'v["id"]') satisfies `descriptor`.
export function buildValidationExpr(descriptor, valueExpr) {
  switch (descriptor.kind) {
    case "primitive":
      return `typeof ${valueExpr} === ${JSON.stringify(descriptor.type)}`;
    case "literal":
      return `${valueExpr} === ${JSON.stringify(descriptor.value)}`;
    case "ref":
      return `is${descriptor.refName}(${valueExpr})`;
    case "array":
      return `(Array.isArray(${valueExpr}) && ${valueExpr}.every((item) => ${buildValidationExpr(descriptor.item, "item")}))`;
    case "record":
      if (!descriptor.value) return `(typeof ${valueExpr} === "object" && ${valueExpr} !== null)`;
      return (
        `(typeof ${valueExpr} === "object" && ${valueExpr} !== null && ` +
        `Object.values(${valueExpr}).every((item) => ${buildValidationExpr(descriptor.value, "item")}))`
      );
    case "union":
      return descriptor.members.length
        ? `(${descriptor.members.map((m) => buildValidationExpr(m, valueExpr)).join(" || ")})`
        : "false";
    case "unknown":
    default:
      return "true";
  }
}

// Builds the single boolean check for one interface property, folding in required/nullable so the
// caller doesn't need its own presence/null handling: an absent (required: false) or null
// (nullable: true) value short-circuits to true without evaluating descriptor's own check.
function buildPropertyCheck(descriptor, valueExpr, required, nullable) {
  const escapes = [];
  if (!required) escapes.push(`${valueExpr} === undefined`);
  if (nullable) escapes.push(`${valueExpr} === null`);
  const own = buildValidationExpr(descriptor, valueExpr);
  return escapes.length ? `(${escapes.join(" || ")} || ${own})` : own;
}

// Builds the full `export function is<Name>(value: unknown): value is <Name> { ... }` source for
// one registry model, dispatching on its kind.
export function buildGuardFunction(model) {
  const signature = `export function is${model.name}(value: unknown): value is ${model.name} {`;
  if (model.kind === "enum") {
    const checks = model.entries.map((e) => `value === ${model.name}.${e.memberName}`);
    return `${signature}\n  return ${checks.length ? checks.join(" || ") : "false"};\n}`;
  }
  if (model.kind === "interface") {
    const lines = ['  if (typeof value !== "object" || value === null) return false;', "  const v = value as Record<string, unknown>;"];
    for (const p of model.properties) {
      const check = buildPropertyCheck(p.descriptor, `v[${p.keyLiteral}]`, p.required, p.nullable);
      // The parens around ${check} are load-bearing: `!typeof x === "number"` parses as
      // `(!typeof x) === "number"` (always false, so the guard would never reject anything) -
      // JS's `!` binds tighter than `===`, so a bare unparenthesized check after `!` is a silent
      // no-op bug, not just a style nit.
      lines.push(`  if (!(${check})) return false;`);
    }
    lines.push("  return true;");
    return `${signature}\n${lines.join("\n")}\n}`;
  }
  // alias (array/map/union/scalar type alias)
  return `${signature}\n  return ${buildValidationExpr(model.targetDescriptor, "value")};\n}`;
}
