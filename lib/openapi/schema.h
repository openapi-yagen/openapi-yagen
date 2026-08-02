#pragma once

#include <cstdint>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "../common/node.h"
#include "../common/node_walker.h"

namespace OpenApi {

using Str = std::string;
using OptStr = std::optional<std::string>;

struct Schema;
using SchemaPtr = std::shared_ptr<Schema>;
using SchemaMap = std::map<Str, SchemaPtr>;

struct Discriminator {
    Str propertyName;
    std::map<Str, Str> mapping;
};

// A parsed OpenAPI/JSON-Schema Schema Object. Fields mirror the spec directly (no
// language-specific interpretation) so any generator can consume it without re-deriving this
// shape from the raw JSON/YAML tree itself.
//
// $ref is intentionally left unresolved here (as the plain pointer string) - resolving it into
// an actual Schema is a separate concern (see the ref-resolution pass), so a Schema with `ref`
// set has every other field left at its default.
//
// `minimum`/`maximum` are kept as the raw parsed Node rather than a double: the engine's Node
// type currently has no floating-point variant (see lib/common/node.h), so a fractional bound
// like `minimum: 0.5` survives YAML/JSON parsing as a string, not a number. Exposing the raw Node
// here avoids silently asserting a precision the engine doesn't actually have; callers that only
// care about integer bounds can read it directly.
struct Schema {
    OptStr ref;

    OptStr type;
    OptStr format;
    OptStr description;
    std::optional<bool> nullable;

    SchemaMap properties;
    std::vector<Str> required;

    // Set only when `type: array`.
    SchemaPtr items;

    // At most one of these is set, mirroring `additionalProperties` being either a bool or a
    // schema in the source document; both unset means the keyword was absent.
    std::optional<bool> additionalPropertiesBool;
    SchemaPtr additionalPropertiesSchema;

    std::vector<Node> enumValues;

    std::vector<SchemaPtr> allOf;
    std::vector<SchemaPtr> oneOf;
    std::vector<SchemaPtr> anyOf;
    std::optional<Discriminator> discriminator;

    std::optional<Node> minimum;
    std::optional<Node> maximum;
    std::optional<int64_t> minLength;
    std::optional<int64_t> maxLength;
    std::optional<int64_t> minItems;
    std::optional<int64_t> maxItems;
    OptStr pattern;
    std::optional<bool> uniqueItems;

    // Unmodified source node for this schema, so vendor extensions (`x-*`) and any spec field
    // not modeled above are still reachable without falling all the way back to hand-walking the
    // whole document.
    Node raw;
};

SchemaPtr parseSchema(const NodeWalker& w);

// Resolves a single `$ref` pointer against `schemas` (as populated in Document::components).
// Only local refs of the form "#/components/schemas/<Name>" are supported - that's the only
// place a Schema $ref can point to, since parameters/requestBodies/responses are modeled
// separately. Throws a clear error for any other ref shape (external files, unsupported
// components) rather than guessing.
SchemaPtr resolveSchemaRef(const SchemaMap& schemas, const Str& ref);

// Follows `schema`'s $ref chain (if any) until it reaches a non-$ref schema. Returns `schema`
// unchanged if it isn't a $ref. Throws on a cyclic chain.
SchemaPtr deref(const SchemaMap& schemas, const SchemaPtr& schema);

}
