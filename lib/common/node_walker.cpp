#include "node_walker.h"

#include <format>

using namespace std;

template <typename T>
string nameForType();

template <>
string nameForType<Node::Bool>()
{
    return "BOOL";
}

template <>
string nameForType<Node::String>()
{
    return "STRING";
}

template <>
string nameForType<Node::Int>()
{
    return "INT";
}

template <>
string nameForType<Node::Null>()
{
    return "NULL";
}

template <>
string nameForType<Node::Map>()
{
    return "MAP";
}

template <>
string nameForType<Node::Vec>()
{
    return "LIST";
}

string getNodeType(const Node& n)
{
    return std::visit(
        [](auto&& v) {
            using T = std::decay_t<decltype(v)>;
            return nameForType<T>();
        },
        n.value);
}

WalkError::WalkError(const std::string& message, const std::string& path)
    : std::invalid_argument(format("{}: path={}", message, path))
{
}

NodeWalker::NodeWalker(const Node& v, const string& basePath)
    : v(v)
    , basePath(basePath)
{
}

NodeWalker NodeWalker::walk(const string& path) const
{
    auto splittedPath = path | split(".");
    const Node& cur = v;
    auto curPath = basePath;
    for (const auto& p : splittedPath) {
        curPath = joinPath(curPath, p);
        if (auto v = cur.getIf<Node::Map>()) {
            auto it = v->find(string(p));
            if (it != v->end())
                return NodeWalker(it->second, curPath);
            else
                return NodeWalker(Node(), curPath);
        } else if (auto v = cur.getIf<Node::Vec>()) {
            auto i = string(p) | toNumber<unsigned long>();
            if (i >= v->size())
                return NodeWalker(Node(), curPath);
            return NodeWalker(v->at(i), curPath);
        } else if (cur.getIf<Node::Null>()) {
            // Walking further into an absent parent (e.g. `w["components"]["schemas"]` when the
            // whole "components" section is missing) is still absent, not an error - callers can
            // chain through an optional section without an isEmpty() check at every level.
            return NodeWalker(Node(), curPath);
        } else {
            throw WalkError(format("<1ca056be> Cannot walk. Wrong current value type {}", getNodeType(cur)), curPath);
        }
    }
    return NodeWalker(cur, curPath);
}

bool NodeWalker::isEmpty() const { return std::holds_alternative<Node::Null>(v.value); }

void NodeWalker::requireValue() const
{
    if (isEmpty())
        throw WalkError("<95c01d51> Value expected", basePath);
}

std::string NodeWalker::joinPath(const string_view& left, const string_view& right) const
{
    auto leftEndsWithDot = !left.empty() && left[left.size() - 1] == '.';
    auto rightStartsWithDot = !right.empty() && right[0] == '.';
    return format("{}{}{}", left, leftEndsWithDot || rightStartsWithDot || left.empty() ? "" : ".", right);
}

template <>
bool nodeAs<Node::Bool>(const Node& n)
{
    if (auto v = n.getIf<Node::Bool>())
        return *v;
    else
        throw invalid_argument("<0406d673> Boolean expected");
}

template <>
Node::String nodeAs<Node::String>(const Node& n)
{
    if (auto v = n.getIf<Node::String>())
        return *v;
    else
        throw invalid_argument("<ff7231f3> String expected");
}

template <>
Node::Int nodeAs<Node::Int>(const Node& n)
{
    if (auto v = n.getIf<Node::Int>())
        return *v;
    else
        throw invalid_argument("<fe38d766> Integer expected");
}

template <>
Node::Map nodeAs<Node::Map>(const Node& n)
{
    if (auto v = n.getIf<Node::Map>())
        return *v;
    throw invalid_argument("<12415785> Variant map expected");
}

template <>
Node::Vec nodeAs<Node::Vec>(const Node& n)
{
    if (auto v = n.getIf<Node::Vec>())
        return *v;
    throw invalid_argument("<c8fd7e37> Variant list expected");
}
