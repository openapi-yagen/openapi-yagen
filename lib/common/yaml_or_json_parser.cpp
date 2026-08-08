#include "yaml_or_json_parser.h"

#include <format>
#include <stdexcept>

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

nlohmann::json nodeToJson(const Node& n)
{
    return visit(
        [](auto&& v) -> nlohmann::json {
            using T = decay_t<decltype(v)>;
            if constexpr (is_same_v<T, Node::Null>) {
                return nullptr;
            } else if constexpr (is_same_v<T, Node::Vec>) {
                auto arr = nlohmann::json::array();
                for (const auto& e : v)
                    arr.push_back(nodeToJson(e));
                return arr;
            } else if constexpr (is_same_v<T, Node::Map>) {
                auto obj = nlohmann::json::object();
                for (const auto& [key, value] : v)
                    obj[key] = nodeToJson(value);
                return obj;
            } else {
                return v; // Bool, Int, String all convert implicitly to nlohmann::json
            }
        },
        n.value);
}

Node jsonToNode(const nlohmann::json& json)
{
    if (json.is_boolean()) {
        return { json.get<bool>() };
    } else if (json.is_string()) {
        return { json.get<string>() };
    } else if (json.is_number_integer()) {
        return { json.get<int64_t>() };
    } else if (json.is_null()) {
        return { Node::NullValue };
    } else if (json.is_object()) {
        Node::Map res;
        for (auto it = json.begin(); it != json.end(); ++it)
            res[it.key()] = jsonToNode(*it);
        return { res };
    } else if (json.is_array()) {
        Node::Vec res;
        for (auto it = json.begin(); it != json.end(); ++it)
            res.push_back(jsonToNode(*it));
        return { res };
    } else {
        throw runtime_error(format("<c2f4f8a1> Unsupported value: {}", json.type_name()));
    }
}

namespace {

void emitNode(YAML::Emitter& out, const Node& n)
{
    visit(
        [&](auto&& v) {
            using T = decay_t<decltype(v)>;
            if constexpr (is_same_v<T, Node::Null>) {
                out << YAML::Null;
            } else if constexpr (is_same_v<T, Node::Bool>) {
                out << v;
            } else if constexpr (is_same_v<T, Node::Int>) {
                out << v;
            } else if constexpr (is_same_v<T, Node::String>) {
                out << v;
            } else if constexpr (is_same_v<T, Node::Vec>) {
                out << YAML::BeginSeq;
                for (const auto& e : v)
                    emitNode(out, e);
                out << YAML::EndSeq;
            } else if constexpr (is_same_v<T, Node::Map>) {
                out << YAML::BeginMap;
                for (const auto& [key, value] : v) {
                    out << YAML::Key << key;
                    out << YAML::Value;
                    emitNode(out, value);
                }
                out << YAML::EndMap;
            }
        },
        n.value);
}

}

string nodeToYamlText(const Node& n)
{
    YAML::Emitter out;
    emitNode(out, n);
    if (!out.good())
        throw runtime_error(format("<d3f5f9b2> Failed to serialize to YAML: {}", out.GetLastError()));
    return string(out.c_str()) + "\n";
}

string nodeToJsonText(const Node& n) { return nodeToJson(n).dump(2) + "\n"; }
