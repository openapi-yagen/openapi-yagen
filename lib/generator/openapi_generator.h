#pragma once

#include <optional>
#include <vector>

#include "../filesystem/definitions.h"
#include "../js/definitions.h"
#include "../templates/definitions.h"
#include "generator_metadata.h"

namespace Generator {

class OpenApiGenerator {
public:
    struct Opts {
        FS::FileReaderPtr fileReader;
        FS::FileWriterPtr fileWriter;
        JS::ExecutorPtr jsExecutor;
        Templates::TemplateRendererPtr templateRenderer;
        std::string defaultMainSciptPath;
        std::string metadataPath;
        bool clearOutDir = false;
        std::vector<std::string> vars;
        std::vector<std::string> tags;
        // CLI --header: overrides the auto-generated-file header text prepended to every file
        // written via renderTemplate/copyFile (see openapi_generator.cpp's writeGeneratedFile).
        // Unset means "use file_header.h's defaultHeaderText(metadata.name)".
        std::optional<std::string> headerText;
        // CLI --no-header: disables that header entirely for this run.
        bool noHeader = false;
    };

    OpenApiGenerator(Opts&& opts);

    void generate(const std::string& specPath);

    Opts opts;
    // Populated by generate() itself (via readMetadata), before mainScriptPath ever runs - so
    // it's already valid by the time a generator's own main.js can call copyFile/renderTemplate
    // (see openapi_generator.cpp's writeGeneratedFile, which reads metadata.name/commentStyle).
    GeneratorMetadata metadata;
};

using GeneratorPtr = std::shared_ptr<OpenApiGenerator>;

}
