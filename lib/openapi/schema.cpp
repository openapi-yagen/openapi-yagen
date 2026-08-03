#include "schema.h"

#include <stdexcept>

#include "ref.h"

using namespace std;

namespace OpenApi {

namespace {

vector<Str> parseStringList(const NodeWalker& w)
{
    return w.optionalList([](const NodeWalker& cw) { return cw.required<Str>(); }).value_or(vector<Str>());
}

Discriminator parseDiscriminator(const NodeWalker& w)
{
    Discriminator d;
    d.propertyName = w["propertyName"].required<Str>();
    d.mapping
        = w["mapping"].optionalMap([](const NodeWalker& cw) { return cw.required<Str>(); }).value_or(map<Str, Str>());
    return d;
}

}

SchemaPtr parseSchema(const NodeWalker& w)
{
    auto schema = make_shared<Schema>();
    schema->raw = w.required<Node>();

    schema->ref = w["$ref"].optional<Str>();
    if (schema->ref)
        return schema;

    schema->type = w["type"].optional<Str>();
    schema->format = w["format"].optional<Str>();
    schema->description = w["description"].optional<Str>();
    schema->nullable = w["nullable"].optional<bool>();

    schema->properties = w["properties"].optionalMap(parseSchema).value_or(SchemaMap());
    schema->required = parseStringList(w["required"]);

    auto itemsWalker = w["items"];
    if (!itemsWalker.isEmpty())
        schema->items = parseSchema(itemsWalker);

    auto additionalPropertiesWalker = w["additionalProperties"];
    if (auto raw = additionalPropertiesWalker.optional<Node>()) {
        if (auto b = raw->getIf<Node::Bool>())
            schema->additionalPropertiesBool = *b;
        else if (raw->getIf<Node::Map>())
            schema->additionalPropertiesSchema = parseSchema(additionalPropertiesWalker);
    }

    // A plain required<Node>() would reject a literal `null` entry (e.g. `enum: [foo, bar, null]`,
    // a real-world pattern for "nullable enum" some specs use alongside `nullable: true`) since
    // NodeWalker treats a Null node the same as an absent one - fall back to Null explicitly
    // instead of throwing on what's a perfectly valid enum member.
    schema->enumValues = w["enum"]
                             .optionalList([](const NodeWalker& cw) { return cw.optional<Node>().value_or(Node{ Node::NullValue }); })
                             .value_or(vector<Node>());

    schema->allOf = w["allOf"].optionalList(parseSchema).value_or(vector<SchemaPtr>());
    schema->oneOf = w["oneOf"].optionalList(parseSchema).value_or(vector<SchemaPtr>());
    schema->anyOf = w["anyOf"].optionalList(parseSchema).value_or(vector<SchemaPtr>());

    auto discriminatorWalker = w["discriminator"];
    if (!discriminatorWalker.isEmpty())
        schema->discriminator = parseDiscriminator(discriminatorWalker);

    schema->minimum = w["minimum"].optional<Node>();
    schema->maximum = w["maximum"].optional<Node>();
    schema->minLength = w["minLength"].optional<Node::Int>();
    schema->maxLength = w["maxLength"].optional<Node::Int>();
    schema->minItems = w["minItems"].optional<Node::Int>();
    schema->maxItems = w["maxItems"].optional<Node::Int>();
    schema->pattern = w["pattern"].optional<Str>();
    schema->uniqueItems = w["uniqueItems"].optional<bool>();

    return schema;
}

SchemaKind kindOf(const Schema& schema)
{
    if (schema.ref)
        return SchemaKind::Ref;
    if (!schema.enumValues.empty())
        return SchemaKind::Enum;
    if (!schema.allOf.empty())
        return SchemaKind::AllOf;
    if (!schema.oneOf.empty())
        return SchemaKind::OneOf;
    if (!schema.anyOf.empty())
        return SchemaKind::AnyOf;
    if (schema.type == "array")
        return SchemaKind::Array;
    // A fixed set of named properties makes it an Object regardless of whether `type: object` was
    // spelled out; `type: object` with no properties (an explicit or implicit free-form map) is
    // Map instead - so the two need checking in this order, not "type == object" first.
    if (!schema.properties.empty())
        return SchemaKind::Object;
    if (schema.type == "object" || schema.additionalPropertiesSchema || schema.additionalPropertiesBool)
        return SchemaKind::Map;
    if (schema.type == "string" || schema.type == "integer" || schema.type == "number" || schema.type == "boolean")
        return SchemaKind::Primitive;
    return SchemaKind::Unknown;
}

string_view toString(SchemaKind kind)
{
    switch (kind) {
        case SchemaKind::Ref:
            return "Ref";
        case SchemaKind::Enum:
            return "Enum";
        case SchemaKind::AllOf:
            return "AllOf";
        case SchemaKind::OneOf:
            return "OneOf";
        case SchemaKind::AnyOf:
            return "AnyOf";
        case SchemaKind::Array:
            return "Array";
        case SchemaKind::Object:
            return "Object";
        case SchemaKind::Map:
            return "Map";
        case SchemaKind::Primitive:
            return "Primitive";
        case SchemaKind::Unknown:
            return "Unknown";
    }
    throw runtime_error("<f0f0f6a7> Unreachable: unknown SchemaKind");
}

bool Constraints::any() const
{
    return minimum || maximum || minLength || maxLength || minItems || maxItems || pattern || uniqueItems;
}

Constraints constraintsOf(const Schema& schema)
{
    return {
        .minimum = schema.minimum,
        .maximum = schema.maximum,
        .minLength = schema.minLength,
        .maxLength = schema.maxLength,
        .minItems = schema.minItems,
        .maxItems = schema.maxItems,
        .pattern = schema.pattern,
        .uniqueItems = schema.uniqueItems,
    };
}

const Str schemaRefPrefix = "#/components/schemas/";

SchemaPtr resolveSchemaRef(const SchemaMap& schemas, const Str& ref)
{
    return resolveRefChain(schemas, schemaRefPrefix, ref);
}

SchemaPtr deref(const SchemaMap& schemas, const SchemaPtr& schema)
{
    return derefChain(schemas, schemaRefPrefix, schema);
}

}
