#include "functions.h"

#include "../common/node.h"
#include "../common/std_tools.h"
#include "../common/string_tools.h"
#include "../logger/logger.h"

using namespace std;

namespace Generator {
namespace {
LogFacade::Logger logger("Generator::Functions");
}

Node nodeToCamelCase(const Node::Vec& args) { return { toCamelCase((args | firstOrThrow()).get<string>()) }; }
Node nodeToPascalCase(const Node::Vec& args) { return { toPascalCase((args | firstOrThrow()).get<string>()) }; }
Node nodeToSnakeCase(const Node::Vec& args) { return { toSnakeCase((args | firstOrThrow()).get<string>()) }; }
Node nodeToScreamingSnakeCase(const Node::Vec& args)
{
    return { toScreamingSnakeCase((args | firstOrThrow()).get<string>()) };
}

Node nodeIsValidIdentifier(const Node::Vec& args)
{
    return { isValidIdentifier((args | firstOrThrow()).get<string>()) };
}
Node nodeSanitizeIdentifier(const Node::Vec& args)
{
    return { sanitizeIdentifier((args | firstOrThrow()).get<string>()) };
}
Node nodeToStringLiteral(const Node::Vec& args) { return { toStringLiteral((args | firstOrThrow()).get<string>()) }; }
Node nodeSplitPathTemplate(const Node::Vec& args)
{
    auto path = (args | firstOrThrow()).get<string>();
    Node::Vec segments;
    for (const auto& seg : splitPathTemplate(path)) {
        Node::Map m;
        if (seg.isParam)
            m["param"] = { seg.value };
        else
            m["literal"] = { seg.value };
        segments.push_back({ m });
    }
    return { segments };
}

Node dumpNode(const Node::Vec& args)
{
    bool first = true;
    stringstream ss;
    for (const auto& n : args) {
        if (!first)
            ss << ", ";
        else
            first = false;
        ss << n;
    }
    logger.info("<10c1e269> Dump: {}", ss.str());
    return { Node::NullValue };
}

Functions getCommonFunctions()
{
    Functions res;
    res.push_back({ .name = "dump", .func = dumpNode });
    res.push_back({ .name = "toCamelCase", .func = nodeToCamelCase });
    res.push_back({ .name = "toPascalCase", .func = nodeToPascalCase });
    res.push_back({ .name = "toSnakeCase", .func = nodeToSnakeCase });
    res.push_back({ .name = "toScreamingSnakeCase", .func = nodeToScreamingSnakeCase });
    res.push_back({ .name = "isValidIdentifier", .func = nodeIsValidIdentifier });
    res.push_back({ .name = "sanitizeIdentifier", .func = nodeSanitizeIdentifier });
    res.push_back({ .name = "toStringLiteral", .func = nodeToStringLiteral });
    res.push_back({ .name = "splitPathTemplate", .func = nodeSplitPathTemplate });
    return res;
}

}
