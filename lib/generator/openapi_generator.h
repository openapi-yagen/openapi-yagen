#pragma once

#include <vector>

#include "../filesystem/definitions.h"
#include "../js/definitions.h"
#include "../templates/definitions.h"

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
    };

    OpenApiGenerator(Opts&& opts);

    void generate(const std::string& specPath);

    Opts opts;
};

using GeneratorPtr = std::shared_ptr<OpenApiGenerator>;

}
