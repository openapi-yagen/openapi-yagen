#pragma once

#include <string>

#include "../common/node.h"
#include "../openapi/version.h"

// Reads a YAML or JSON OpenAPI spec file from disk, parses it into a Node and bundles the files it
// refers to into it (see external_ref_resolver.h, also for `refRoot`) - shared by
// OpenApiGenerator::generate() and the `convert`/`bundle` CLI commands. Lives here (rather than
// lib/common, alongside parseYamlOrJsonToNode) because it needs FS::readFile
// (lib/filesystem), which itself depends on lib/common - putting it in lib/common would be a
// circular dependency.
Node readSpecFile(const std::string& filePath, const std::string& refRoot = std::string());

// Writes a spec document, keys in the customary order of `version`. `format` is "json", "yaml" or
// empty to go by `filePath`'s extension.
void writeSpecFile(const Node& spec, OpenApi::OpenApiVersion version, const std::string& filePath,
                   const std::string& format);
