#pragma once

#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "node.h"

Node parseYamlOrJsonToNode(const std::string& yaml);

// Node <-> nlohmann::json - shared by anything that needs to hand a Node off to an
// nlohmann::json-based library (Inja's callback bridge, the YAML/JSON text writers below, ...).
nlohmann::json nodeToJson(const Node& n);
Node jsonToNode(const nlohmann::json& json);

// The reverse of parseYamlOrJsonToNode/nodeToJson - serializes a Node back out to YAML or JSON
// text (e.g. for the `convert` CLI command, which needs to write a converted spec back to disk).
//
// `n` is always a std::map internally (Node::Map), so its keys come out alphabetical unless
// `topLevelKeyOrder` says otherwise: when `n` is a Map, keys listed in `topLevelKeyOrder` are
// emitted first, in that order (any not present in `n` are skipped), followed by any of `n`'s
// remaining keys in their natural (alphabetical) order. Only the top level is reordered - nested
// maps (an object's own nested fields, `properties`, ...) still come out alphabetical; callers
// that want a human-readable field order for a whole document pass its top-level field order here
// (e.g. OpenApi::documentFieldOrder(version) in lib/openapi/canonical_order.h).
std::string nodeToYamlText(const Node& n, const std::vector<std::string>& topLevelKeyOrder = {});
std::string nodeToJsonText(const Node& n, const std::vector<std::string>& topLevelKeyOrder = {});
