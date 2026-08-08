#include "generator_metadata.h"

#include "../common/node_walker.h"

using namespace std;

template <typename From, typename To>
To convert(const From&);

template <>
Str convert(const Node::Null&)
{
    return "null";
}

template <>
Str convert(const Node::Bool& v)
{
    return v ? "true" : "false";
}

template <>
Str convert(const Node::Int& v)
{
    return to_string(v);
}

template <>
Str convert(const Node::String& v)
{
    return v;
}

template <>
Str convert(const Node::Map& v)
{
    throw runtime_error("<e2a7040f> Unsupported");
}

template <>
Str convert(const Node::Vec& v)
{
    throw runtime_error("<c91b6db7> Unsupported");
}

VariableDescriptor parseVariableDescriptor(const NodeWalker& w)
{
    auto defValueNode = w["defaultValue"].optional<Node>();
    OptStr defValue = defValueNode ? optional(visit(
                                         [](auto&& v) {
                                             using From = std::decay_t<decltype(v)>;
                                             return convert<From, Str>(v);
                                         },
                                         defValueNode->value))
                                   : nullopt;

    return {
        .name = w["name"].required<Str>(),
        .description = w["description"].optional<Str>(),
        .defaultValue = defValue,
        .required = w["required"].optional<bool>().value_or(false),
    };
}

GeneratorMetadata parseGeneratorMetadata(const NodeWalker& w)
{
    return {
        .name = w["name"].required<Str>(),
        .description = w["description"].optional<Str>(),
        .mainScriptPath = w["mainScriptPath"].optional<Str>(),
        .openApiVersion = w["openApiVersion"].optional<Str>(),
        .variables = w["variables"].optionalList(parseVariableDescriptor).value_or(std::vector<VariableDescriptor>()),
    };
}
