#pragma once

#include <string>

#include "../common/node.h"

// Reads a YAML or JSON OpenAPI spec file from disk and parses it into a Node - shared by
// OpenApiGenerator::generate() and the `convert` CLI command. Lives here (rather than
// lib/common, alongside parseYamlOrJsonToNode) because it needs FS::readFile
// (lib/filesystem), which itself depends on lib/common - putting it in lib/common would be a
// circular dependency.
Node readSpecFile(const std::string& filePath);
