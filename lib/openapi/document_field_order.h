#pragma once

#include <string>
#include <vector>

#include "version.h"

namespace OpenApi {

// The OpenAPI/Swagger specification's own documented field order for a Document's top-level
// object - purely a readability nicety when serializing a converted spec back to text (nothing
// else, including this engine's own JS bridge, cares about key order - it reads fields by name).
// Node::Map (std::map) is inherently alphabetical, so callers writing spec text back out pass this
// to nodeToYamlText/nodeToJsonText's topLevelKeyOrder parameter (lib/common/yaml_or_json_parser.h)
// to restore it. Only the document root is covered - nested objects (Info, Operation, Schema, ...)
// still come out alphabetical.
std::vector<std::string> documentFieldOrder(OpenApiVersion version);

}
