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
