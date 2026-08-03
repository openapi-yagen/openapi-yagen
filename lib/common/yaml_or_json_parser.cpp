#include "yaml_or_json_parser.h"

#include <format>

#include <yaml-cpp/yaml.h>

using namespace std;

Node convertNode(const YAML::Node& n);

Node convertScalar(const YAML::Node& n)
{
    bool b;
    int64_t i;
    string s;
    // A quoted scalar ("+1", "42", "true") gets YAML's non-specific "!" tag, meaning: don't run
    // implicit type resolution on its content, it's a string, full stop. Only a plain/unquoted
    // scalar (tag "?") is a candidate for bool/int coercion - otherwise real-world specs that
    // quote numeric-looking strings (e.g. reaction names "+1"/"-1") get silently miscoerced to int.
    if (n.Tag() == "?" && YAML::convert<bool>::decode(n, b)) {
        return { b };
    } else if (n.Tag() == "?" && YAML::convert<int64_t>::decode(n, i)) {
        return { i };
    } else if (YAML::convert<string>::decode(n, s)) {
        return { s };
    } else {
        throw runtime_error("<bd6fb38c> Unknown scalar node type");
    }
}

Node convertMap(const YAML::Node& n)
{
    Node::Map res;
    for (auto it = n.begin(); it != n.end(); ++it) {
        auto key = it->first.as<string>();
        res[key] = convertNode(it->second);
    }
    return { res };
}

Node convertSequence(const YAML::Node& node)
{
    Node::Vec res;
    for (auto i = 0u; i < node.size(); i++) {
        auto n = node[i];
        res.push_back(convertNode(n));
    }
    return { res };
}

Node convertNode(const YAML::Node& n)
{
    if (n.IsNull()) {
        return { Node::NullValue };
    } else if (n.IsScalar()) {
        return convertScalar(n);
    } else if (n.IsMap()) {
        return convertMap(n);
    } else if (n.IsSequence()) {
        return convertSequence(n);
    } else {
        throw runtime_error(format("<b4cada15> Unsupported YAML node type: {}", static_cast<int>(n.Type())));
    }
}

Node parseYamlOrJsonToNode(const std::string& yaml) { return convertNode(YAML::Load(yaml)); }
