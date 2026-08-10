#include "extract_command.h"

#include <format>

#include <lib/filesystem/dir_file_writer.h>
#include <lib/filesystem/embedded_generators_registry.h>
#include <lib/logger/logger.h>

using namespace std;

namespace {
LogFacade::Logger logger("ExtractCommand");
const string builtinPrefix = "builtin:"; // accepted and stripped so list-generators' "builtin:<name>" output can be pasted here directly
}

ExtractCommand::ExtractCommand() { }

void ExtractCommand::reg(CLI::App& app)
{
    auto cmd = app.add_subcommand("extract",
                                  "Extract a built-in generator's files to a directory, e.g. to customize "
                                  "it further without starting from scratch")
                   ->alias("e")
                   ->callback(std::bind(&ExtractCommand::process, this));
    cmd->add_option("name", name, "Built-in generator name, with or without a \"builtin:\" prefix (see the list-generators command)")->required();
    cmd->add_option("-o, --out-dir", outDir, "Output directory")->required();
}

void ExtractCommand::process()
{
    auto generatorName = name.starts_with(builtinPrefix) ? name.substr(builtinPrefix.size()) : name;
    const auto& files = FS::Embedded::requireGenerator(generatorName);

    auto fileWriter = FS::DirFileWriter(FS::DirFileWriter::Opts { .outDir = outDir, .filePostProcessor = nullptr });
    for (const auto& [relPath, content] : files)
        fileWriter.write(relPath, content);

    logger.info(
        "<7d3a5e91> Extracted {} file(s) of built-in generator \"{}\" to \"{}\"", files.size(), generatorName, outDir);
}
