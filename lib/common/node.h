#pragma once

#include <cstdint>
#include <format>
#include <map>
#include <stdexcept>
#include <string>
#include <variant>
#include <vector>

template <typename T>
std::string_view getTypeName();

struct Node {
    using Null = struct { };
    using Bool = bool;
    using Int = std::int64_t;
    using String = std::string;
    using Map = std::map<std::string, Node>;
    using Vec = std::vector<Node>;

    static constexpr Null NullValue = {};

    using Value = std::variant<Null, Bool, Int, String, Vec, Map>;
    Value value;

    // Deep structural equality.
    bool operator==(const Node& other) const;

    template <typename T>
    inline const T* getIf() const
    {
        return std::get_if<T>(&value);
    }

    template <typename T>
    const T& get() const
    {
        auto v = getIf<T>();
        if (!v)
            throw std::runtime_error(std::format("<27bfea60> Expected {}", getTypeName<T>()));
        return *v;
    }
};

std::ostream& operator<<(std::ostream& os, const Node& n);

struct ToNodeMarker { };
inline ToNodeMarker toNode() { return {}; }

inline Node operator>>(const bool& v, const ToNodeMarker&) { return { v }; }
inline Node operator>>(const int64_t& v, const ToNodeMarker&) { return { v }; }
inline Node operator>>(const std::string& v, const ToNodeMarker&) { return { v }; }

template <typename T>
inline Node operator>>(const std::optional<T>& v, const ToNodeMarker&)
{
    if (v)
        return { *v >> toNode() };
    return { {} };
}

template <typename T>
Node operator>>(const std::vector<T>& v, const ToNodeMarker&)
{
    std::vector<Node> res;
    for (const auto& it : v) {
        res.push_back(it >> toNode());
    }
    return { res };
}

template <typename T>
Node operator>>(const std::map<std::string, T>& m, const ToNodeMarker&)
{
    std::map<std::string, Node> res;
    for (const auto& it : m) {
        res[it.first] = it.second >> toNode();
    }
    return { res };
}
