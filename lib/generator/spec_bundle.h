#pragma once

#include <optional>
#include <string>
#include <vector>

#include "../common/node.h"
#include "../openapi/version.h"

struct BundleOpts {
    // See external_ref_resolver.h - empty means the spec file's own directory.
    std::string refRoot { };
    // Unset keeps the spec's own version.
    std::optional<OpenApi::OpenApiVersion> targetVersion { };
    // Same filtering as `generate --tags`; empty keeps everything.
    std::vector<std::string> tags { };
};

struct BundledSpec {
    Node node;
    OpenApi::OpenApiVersion version = OpenApi::OpenApiVersion::V3_0;
};

// The `bundle` CLI command: the spec as a single document - external $refs resolved, optionally
// filtered by tags and converted to another version. In-document $refs stay refs. Throws if the
// result isn't a valid spec (missing required fields, dangling in-document $refs).
BundledSpec bundleSpec(const std::string& specPath, const BundleOpts& opts);
