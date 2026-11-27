#include "node.h"

#include <ostream>
#include <type_traits>

bool Node::operator==(const Node& other) const
{
    if (value.index() != other.value.index())
        return false;
    return std::visit(
        [&other](const auto& v) {
            using T = std::decay_t<decltype(v)>;
            if constexpr (std::is_same_v<T, Null>)
                return true;
            else
                return v == std::get<T>(other.value);
        },
        value);
}

template <>
std::string_view getTypeName<std::string>()
{
    return "std::string";
}

template <>
std::string_view getTypeName<bool>()
{
    return "bool";
}

template <>
std::string_view getTypeName<std::int64_t>()
{
    return "int64_t";
}

template <>
std::string_view getTypeName<Node::Null>()
{
    return "Node::Null";
}

template <>
std::string_view getTypeName<Node::Vec>()
{
    return "Node::Vec";
}

template <>
std::string_view getTypeName<Node::Map>()
{
    return "Node::Map";
}

std::ostream& operator<<(std::ostream& os, const Node::Null& n)
{
    os << "null";
    return os;
}

std::ostream& operator<<(std::ostream& os, const Node::Map& map)
{
    os << "{";
    bool first = true;
    for (const auto& p : map) {
        if (!first) {
            os << ",";
        } else {
            first = false;
        }
        os << p.first << "=" << p.second;
    }
    os << "}";
    return os;
}

std::ostream& operator<<(std::ostream& os, const Node::Vec& vec)
{
    os << "[";
    bool first = true;
    for (const auto& v : vec) {
        if (!first) {
            os << ",";
        } else {
            first = false;
        }
        os << v;
    }
    os << "]";
    return os;
}

std::ostream& operator<<(std::ostream& os, const Node& n)
{
    std::visit([&](auto&& v) { os << v; }, n.value);
    return os;
}
