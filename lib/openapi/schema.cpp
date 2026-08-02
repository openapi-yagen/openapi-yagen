#include "schema.h"

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

    schema->enumValues
        = w["enum"].optionalList([](const NodeWalker& cw) { return cw.required<Node>(); }).value_or(vector<Node>());

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

Document parseDocument(const NodeWalker& w)
{
    Document doc;
    doc.components.schemas = w["components"]["schemas"].optionalMap(parseSchema).value_or(SchemaMap());
    return doc;
}

}
