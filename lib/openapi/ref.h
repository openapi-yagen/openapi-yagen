#pragma once

#include <format>
#include <map>
#include <memory>
#include <stdexcept>
#include <string>

namespace OpenApi {

// Generic local-$ref resolution shared by every referenceable OpenAPI object (Schema, Parameter,
// RequestBody, Response, ...). `T` must have an `std::optional<std::string> ref` member. Only
// refs of the form "<refPrefix><name>" are supported (e.g. "#/components/schemas/") - anything
// else (external files, unmodeled components) throws a clear error instead of guessing.
template <typename T>
std::shared_ptr<T> resolveRefChain(const std::map<std::string, std::shared_ptr<T>>& registry,
                                   const std::string& refPrefix, std::string ref)
{
    std::shared_ptr<T> result;
    for (int guard = 0;; guard++) {
        if (guard > 100)
            throw std::runtime_error(std::format("<c7c7f6a4> Too many nested $ref, possible cycle: {}", ref));
        if (ref.rfind(refPrefix, 0) != 0)
            throw std::runtime_error(
                std::format("<d8d8f6a5> Unsupported $ref target (only {}<Name> can be resolved): {}", refPrefix, ref));
        auto name = ref.substr(refPrefix.size());
        auto it = registry.find(name);
        if (it == registry.end())
            throw std::runtime_error(std::format("<e9e9f6a6> $ref not found: {}", ref));
        result = it->second;
        if (!result->ref)
            break;
        ref = *result->ref;
    }
    return result;
}

template <typename T>
std::shared_ptr<T> derefChain(const std::map<std::string, std::shared_ptr<T>>& registry, const std::string& refPrefix,
                              std::shared_ptr<T> item)
{
    if (!item || !item->ref)
        return item;
    return resolveRefChain(registry, refPrefix, *item->ref);
}

}
