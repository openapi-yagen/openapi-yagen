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
    // Overrides the engine's built-in file-extension -> comment-style table (see
    // lib/generator/file_header.h) used for the auto-generated-file header prepended to every
    // file this generator writes via renderTemplate/copyFile. One of buildDocComment's own 4
    // style literals ("/** */"/"//"/"///"/"#" - see functions.cpp) - not validated against that
    // set here, so an unrecognized value only surfaces once a file is actually written and
    // nodeBuildDocComment itself throws. Unset means "use the built-in extension table, or skip
    // the header for an extension the table doesn't recognize".
    OptStr commentStyle;
    std::vector<VariableDescriptor> variables;
};

GeneratorMetadata parseGeneratorMetadata(const NodeWalker& n);
