#include "extract_command.h"

#include <format>

#include <lib/filesystem/dir_file_writer.h>
#include <lib/filesystem/embedded_generators_registry.h>
#include <lib/logger/logger.h>

using namespace std;

namespace {
LogFacade::Logger logger("ExtractCommand");
}

ExtractCommand::ExtractCommand() { }

void ExtractCommand::reg(CLI::App& app)
{
    auto cmd = app.add_subcommand("extract",
                                  "Extract a built-in generator's files to a directory, e.g. to customize "
                                  "it further without starting from scratch")
                   ->alias("e")
                   ->callback(std::bind(&ExtractCommand::process, this));
    cmd->add_option("name", name, "Built-in generator name (see the list-generators command)")->required();
    cmd->add_option("-o, --out-dir", outDir, "Output directory")->required();
}

void ExtractCommand::process()
{
    const auto& files = FS::Embedded::requireGenerator(name);

    auto fileWriter = FS::DirFileWriter(FS::DirFileWriter::Opts { .outDir = outDir, .filePostProcessor = nullptr });
    for (const auto& [relPath, content] : files)
        fileWriter.write(relPath, content);

    logger.info("<7d3a5e91> Extracted {} file(s) of built-in generator \"{}\" to \"{}\"", files.size(), name, outDir);
}
