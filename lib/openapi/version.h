#pragma once

#include <optional>
#include <string>
#include <string_view>

#include "../common/node.h"

namespace OpenApi {

// Every OpenAPI/Swagger spec version this engine knows about, at minor-version granularity -
// patch releases within a minor line (e.g. 3.0.0..3.0.4, 3.1.0..3.1.2) are textual
// clarifications/errata to the human-readable spec document, not schema/structural changes, so
// they're not distinguished here. V2_0 (Swagger) is handled by lib/openapi/v2/ - a structurally
// different document shape than 3.x (definitions/host+basePath+schemes/body+formData parameters/
// consumes+produces instead of components/servers/requestBody/content), so it's read/written
// separately from lib/openapi/v3/ rather than sharing its reader/writer. It's supported as a spec
// *input* (and as the `convert` command's output) but not as a generator's declared
// `openApiVersion` - see OpenApiGenerator::generate()'s version check for why.
enum class OpenApiVersion { V2_0, V3_0, V3_1, V3_2 };

// True for the versions lib/openapi/v3/ (reader.cpp/writer.cpp) knows how to handle.
bool isV3(OpenApiVersion v);

// Reads the top-level "openapi" (3.x) or "swagger" (2.0) field and classifies it. nullopt if
// neither field is present/parseable, or the version string isn't one this engine recognizes.
std::optional<OpenApiVersion> detectVersion(const Node& doc);

// Parses a bare version string (e.g. "3.0", "3.0.3", "3.1", "2.0") the same way detectVersion
// does - tolerant of a patch component, which is ignored (see enum comment above).
std::optional<OpenApiVersion> parseVersionString(const std::string& s);

// The version string this engine writes into a converted document's own "openapi"/"swagger"
// field - the lowest patch release of that minor line (e.g. V3_0 -> "3.0.0").
std::string_view toVersionString(OpenApiVersion v);

}
