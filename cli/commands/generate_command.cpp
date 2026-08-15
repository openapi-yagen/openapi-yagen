#include "generate_command.h"

#include <vector>

#include <lib/filesystem/dir_file_reader_backend.h>
#include <lib/filesystem/dir_file_writer.h>
#include <lib/filesystem/embedded_file_reader_backend.h>
#include <lib/filesystem/file_post_processor.h>
#include <lib/filesystem/remote_file_reader_backend.h>
#include <lib/filesystem/tools.h>
#include <lib/filesystem/zip_file_reader_backend.h>
#include <lib/generator/openapi_generator.h>
#include <lib/js/executor.h>
#include <lib/logger/logger.h>
#include <lib/templates/inja_template_renderer.h>

using namespace std;

namespace {
LogFacade::Logger logger("GenerateCommand");
}

GenerateCommand::GenerateCommand() { }

void GenerateCommand::reg(CLI::App& app)
{
    auto cmd = app.add_subcommand("generate", "Generate sources from openapi specification")
                   ->alias("g")
                   ->callback(std::bind(&GenerateCommand::process, this));
    cmd->add_option("spec-file", specPath, "Specification file")->default_val("openapi.yaml");
    cmd->add_option("--override-dir", overrideDir, "Directory with overridden generator files");
    cmd->add_option("-o, --out-dir", outDir, "Output directory for generated code")->default_val(".");
    cmd->add_option("-g, --generator", generatorPath,
                    "Path to generator. It can be a directory, zip archive, HTTP URL, or a built-in generator "
                    "(builtin:<name> - see the list-generators command)")
        ->required();
    cmd->add_option("-p, --post-process", postProcessTools, "Post process file with specified tool for extension")
        ->take_all();
    cmd->add_flag("-c, --clear", clearOutDir, "Clear output directory before generating");
    cmd->add_option("-v, --var", vars, "Set variable. Syntax is: -v (var_name)=(var_value)")->take_all();
    cmd->add_option("-t, --tags", tags,
                    "Only generate operations/models tagged with one of these tags (default: generate everything)")
        ->take_all();
}

void GenerateCommand::process()
{
    vector<FS::FileReaderBackendPtr> fsBackends;
    if (!overrideDir.empty()) {
        fsBackends.push_back(make_shared<FS::DirFileReaderBackend>(overrideDir));
    }

    vector<FS::FileReaderBackendFactoryPtr> fileReaderBackendFactories = {
        make_shared<FS::EmbeddedFileReaderBackendFactory>(),
        make_shared<FS::DirFileReaderBackendFactory>(),
        make_shared<FS::ZipFileReaderBackendFactory>(),
        make_shared<FS::RemoteFileReaderBackendFactory>(),
    };

    fsBackends.push_back(FS::createBackend(generatorPath, fileReaderBackendFactories));
    auto fileReader = make_shared<FS::FileReader>(FS::FileReader::Opts { fsBackends });

    auto templateRenderer = make_shared<Templates::InjaTemplateRenderer>(Templates::InjaTemplateRenderer::Opts {
        .fileReader = fileReader,
    });

    auto filePostProcessor = make_shared<FS::SystemToolsFilePostProcessor>(postProcessTools);

    auto fileWriter = make_shared<FS::DirFileWriter>(FS::DirFileWriter::Opts {
        .outDir = outDir,
        .filePostProcessor = filePostProcessor,
    });

    auto jsExecutor = make_shared<JS::Executor>(JS::Executor::Opts {
        .fileReader = fileReader,
    });

    Generator::OpenApiGenerator g(Generator::OpenApiGenerator::Opts {
        .fileReader = fileReader,
        .fileWriter = fileWriter,
        .jsExecutor = jsExecutor,
        .templateRenderer = templateRenderer,
        .defaultMainSciptPath = "main.js",
        .metadataPath = "generator.yml",
        .clearOutDir = clearOutDir,
        .vars = vars,
        .tags = tags,
    });

    if (specPath.empty())
        throw runtime_error("<d6cb8e9c> Spec file not provided");

    logger.debug(
        "<b1f2a941> Generate output: schema={}, generator={}, clearOutputDir={}", specPath, generatorPath, clearOutDir);
    g.generate(specPath);
}
