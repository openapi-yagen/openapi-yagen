#pragma once

#include <cstdint>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
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

// XML Object - metadata for XML representation of a schema/property.
struct XML {
    OptStr name;
    OptStr namespace_; // "namespace" is a C++ keyword
    OptStr prefix;
    std::optional<bool> attribute;
    std::optional<bool> wrapped;
};

// External Documentation Object - defined here (rather than in document.h, which includes this
// header) since it's referenced by Schema, and also reused as-is by Tag/Operation/Document.
struct ExternalDocs {
    OptStr description;
    Str url;
};

// A parsed OpenAPI/JSON-Schema Schema Object. Fields mirror the spec directly (no
// language-specific interpretation) so any generator can consume it without re-deriving this
// shape from the raw JSON/YAML tree itself.
//
// `$ref` may coexist with sibling keywords (full JSON Schema semantics, as OAS 3.1/3.2 allow) -
// `ref` and everything else are independent fields; a `Schema` with `ref` set represents "this
// $ref, plus whatever sibling keywords were written next to it" (empty/default for every other
// field when the source spec followed OAS 3.0's "$ref siblings are ignored" rule).
//
// The canonical (in-memory) dialect for `type`/`nullable` is OAS 3.1/3.2's: `type` is the set of
// JSON Schema type names this schema allows (e.g. `{"string"}`, or `{"string", "null"}` for a
// nullable string) - there is no separate `nullable` field. A reader for an OAS 3.0 document
// (`nullable: true` + `type: "string"`) folds that into `type: {"string", "null"}` when building
// this struct; a writer targeting 3.0 does the reverse. See lib/openapi/v3/reader.cpp and
// writer.cpp.
//
// Likewise `exclusiveMinimum`/`exclusiveMaximum` are kept in their OAS 3.1/3.2 form (a standalone
// bound value, not a boolean paired with `minimum`/`maximum`) - a 3.0 reader/writer folds the
// bool+minimum/maximum pairing into/out of this form.
//
// `minimum`/`maximum`/`exclusiveMinimum`/`exclusiveMaximum`/`multipleOf`/`default`/`const` are
// kept as the raw parsed Node rather than a double: the engine's Node type currently has no
// floating-point variant (see lib/common/node.h), so a fractional bound like `minimum: 0.5`
// survives YAML/JSON parsing as a string, not a number. Exposing the raw Node here avoids
// silently asserting a precision the engine doesn't actually have; callers that only care about
// integer bounds can read it directly.
struct Schema {
    OptStr ref;

    OptStr title;
    OptStr description;
    std::optional<Node> defaultValue; // "default" is a C++ keyword
    std::optional<bool> deprecated;
    std::optional<bool> readOnly;
    std::optional<bool> writeOnly;
    std::optional<Node> constValue; // "const" is a C++ keyword, OAS 3.1+

    std::vector<Str> type; // canonical form - see struct comment. Empty = no "type" keyword at all.
    OptStr format;

    std::optional<Node> multipleOf;
    std::optional<Node> minimum;
    std::optional<Node> maximum;
    std::optional<Node> exclusiveMinimum; // canonical (3.1/3.2) numeric form - see struct comment
    std::optional<Node> exclusiveMaximum;
    std::optional<int64_t> minLength;
    std::optional<int64_t> maxLength;
    OptStr pattern;

    std::optional<int64_t> minItems;
    std::optional<int64_t> maxItems;
    std::optional<bool> uniqueItems;
    // Set only when `type` includes "array".
    SchemaPtr items;

    SchemaMap properties;
    std::vector<Str> required;
    std::optional<int64_t> minProperties;
    std::optional<int64_t> maxProperties;
    // At most one of these is set, mirroring `additionalProperties` being either a bool or a
    // schema in the source document; both unset means the keyword was absent.
    std::optional<bool> additionalPropertiesBool;
    SchemaPtr additionalPropertiesSchema;

    std::vector<Node> enumValues;

    std::vector<SchemaPtr> allOf;
    std::vector<SchemaPtr> oneOf;
    std::vector<SchemaPtr> anyOf;
    SchemaPtr notSchema; // "not" is a C++ keyword
    std::optional<Discriminator> discriminator;

    std::optional<XML> xml;
    std::optional<ExternalDocs> externalDocs;

    std::optional<Node> example;
    std::vector<Node> examples;

    // Unmodified source node for this schema, so vendor extensions (`x-*`) and any spec field
    // not modeled above are still reachable without falling all the way back to hand-walking the
    // whole document.
    Node raw;
};

// The shape a Schema was written in, in precedence order (a schema could technically combine
// several of these keywords; the first match below wins, mirroring how generators need to decide
// one concrete representation to emit). Language-specific interpretation - which Kotlin/TS/...
// type a Primitive becomes, whether a target language even supports OneOf - is still up to the
// generator; this only answers "which shape is this", so generators stop re-deriving it from
// `Array.isArray(s.enum)`-style checks against the raw tree.
enum class SchemaKind {
    Ref, // schema->ref is set
    Enum, // enum: [...]
    AllOf,
    OneOf,
    AnyOf,
    Array, // type includes "array"
    Object, // type includes "object", or an inferred object (has properties)
    Map, // type includes "object" with only additionalProperties, no fixed properties (free-form map)
    Primitive, // string/integer/number/boolean scalar
    Unknown, // no recognizable shape (e.g. a schema with no keywords at all)
};

SchemaKind kindOf(const Schema& schema);
std::string_view toString(SchemaKind kind);

// True if `schema`'s canonical `type` includes "null" - i.e. it's nullable, regardless of whether
// the source spec spelled that as OAS 3.0's `nullable: true` or OAS 3.1/3.2's `type: [..., null]`.
bool isNullable(const Schema& schema);

// A flattened bundle of Schema's validation-related keywords, for generators that want to check
// "does this schema have any constraints at all" (e.g. to decide whether to emit a validate()
// method) without individually testing every optional field on Schema.
struct Constraints {
    std::optional<Node> minimum;
    std::optional<Node> maximum;
    std::optional<Node> exclusiveMinimum;
    std::optional<Node> exclusiveMaximum;
    std::optional<Node> multipleOf;
    std::optional<int64_t> minLength;
    std::optional<int64_t> maxLength;
    std::optional<int64_t> minItems;
    std::optional<int64_t> maxItems;
    std::optional<int64_t> minProperties;
    std::optional<int64_t> maxProperties;
    OptStr pattern;
    std::optional<bool> uniqueItems;

    bool any() const;
};

Constraints constraintsOf(const Schema& schema);

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
