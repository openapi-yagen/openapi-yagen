#pragma once

#include <string>

#include <nlohmann/json.hpp>

#include "node.h"

Node parseYamlOrJsonToNode(const std::string& yaml);

// Node <-> nlohmann::json - shared by anything that needs to hand a Node off to an
// nlohmann::json-based library (Inja's callback bridge, the YAML/JSON text writers below, ...).
nlohmann::json nodeToJson(const Node& n);
Node jsonToNode(const nlohmann::json& json);

// The reverse of parseYamlOrJsonToNode/nodeToJson - serializes a Node back out to YAML or JSON
// text (e.g. for the `convert` CLI command, which needs to write a converted spec back to disk).
std::string nodeToYamlText(const Node& n);
std::string nodeToJsonText(const Node& n);
