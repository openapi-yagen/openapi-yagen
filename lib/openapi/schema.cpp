#include "schema.h"

#include <algorithm>
#include <stdexcept>

#include "ref.h"

using namespace std;

namespace OpenApi {

bool isNullable(const Schema& schema)
{
    return find(schema.type.begin(), schema.type.end(), "null") != schema.type.end();
}

namespace {
bool hasType(const Schema& schema, const Str& t)
{
    return find(schema.type.begin(), schema.type.end(), t) != schema.type.end();
}
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
    if (hasType(schema, "array"))
        return SchemaKind::Array;
    // A fixed set of named properties makes it an Object regardless of whether `type: object` was
    // spelled out; `type: object` with no properties (an explicit or implicit free-form map) is
    // Map instead - so the two need checking in this order, not "type includes object" first.
    if (!schema.properties.empty())
        return SchemaKind::Object;
    if (hasType(schema, "object") || schema.additionalPropertiesSchema || schema.additionalPropertiesBool)
        return SchemaKind::Map;
    if (hasType(schema, "string") || hasType(schema, "integer") || hasType(schema, "number") || hasType(schema, "boolean"))
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
    throw runtime_error("<b95f37fe> Unreachable: unknown SchemaKind");
}

bool Constraints::any() const
{
    return minimum || maximum || exclusiveMinimum || exclusiveMaximum || multipleOf || minLength || maxLength
        || minItems || maxItems || minProperties || maxProperties || pattern || uniqueItems;
}

Constraints constraintsOf(const Schema& schema)
{
    return {
        .minimum = schema.minimum,
        .maximum = schema.maximum,
        .exclusiveMinimum = schema.exclusiveMinimum,
        .exclusiveMaximum = schema.exclusiveMaximum,
        .multipleOf = schema.multipleOf,
        .minLength = schema.minLength,
        .maxLength = schema.maxLength,
        .minItems = schema.minItems,
        .maxItems = schema.maxItems,
        .minProperties = schema.minProperties,
        .maxProperties = schema.maxProperties,
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
