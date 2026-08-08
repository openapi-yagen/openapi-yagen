#pragma once

#include <optional>
#include <string>
#include <vector>

#include "../common/node_walker.h"

using Str = std::string;
using OptStr = std::optional<std::string>;

struct VariableDescriptor {
    Str name;
    OptStr description;
    OptStr defaultValue;
    bool required;
};

struct GeneratorMetadata {
    Str name;
    OptStr description;
    OptStr mainScriptPath;
    // The OpenAPI version this generator's main.js/templates are written to consume (e.g.
    // "3.0", "3.1", "3.2") - defaults to "3.0" if absent, matching every generator that predates
    // this field. The engine converts the input spec to this version before running main.js if
    // it declares a different one - see OpenApiGenerator::generate().
    OptStr openApiVersion;
    std::vector<VariableDescriptor> variables;
};

GeneratorMetadata parseGeneratorMetadata(const NodeWalker& n);
