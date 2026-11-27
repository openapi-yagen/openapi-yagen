#include "convert_command.h"

#include <format>
#include <stdexcept>

#include <lib/generator/spec_file.h>
#include <lib/logger/logger.h>
#include <lib/openapi/version.h>
#include <lib/openapi/version_convert.h>

using namespace std;

namespace {
LogFacade::Logger logger("ConvertCommand");
}

ConvertCommand::ConvertCommand() { }

void ConvertCommand::reg(CLI::App& app)
{
    auto cmd = app.add_subcommand("convert", "Convert an OpenAPI spec from one version to another")
                   ->alias("c")
                   ->callback(std::bind(&ConvertCommand::process, this));
    cmd->add_option("spec-file", specPath, "Specification file to convert")->required();
    cmd->add_option("--from", fromVersion,
                    "Source OpenAPI version (e.g. 2.0, 3.0, 3.1, 3.2) - "
                    "auto-detected from the spec's own \"openapi\"/\"swagger\" field if omitted");
    cmd->add_option("--to", toVersion, "Target OpenAPI version (e.g. 2.0, 3.0, 3.1, 3.2)")->required();
    cmd->add_option("-o,--out", outPath, "Output file path")->required();
    cmd->add_option("--format", outputFormat,
                    "Output format: \"yaml\" or \"json\" - inferred from --out's extension if omitted");
    cmd->add_option("--ref-root", refRoot,
                    "Directory that files referenced through $ref must lie in (default: the spec file's directory)");
}

void ConvertCommand::process()
{
    auto specNode = readSpecFile(specPath, refRoot);

    auto from = [&] {
        if (!fromVersion.empty()) {
            auto parsed = OpenApi::parseVersionString(fromVersion);
            if (!parsed)
                throw runtime_error(format("<fa5b67d4> Unrecognized --from version \"{}\"", fromVersion));
            return *parsed;
        } else {
            auto detected = OpenApi::detectVersion(specNode);
            if (!detected)
                throw runtime_error("<9d5bc5c6> Cannot determine the spec's OpenAPI version - expected a top-level "
                                    "\"openapi\" (3.x) or \"swagger\" (2.0) field with a recognized value, "
                                    "or pass --from");
            return *detected;
        }
    }();

    auto to = OpenApi::parseVersionString(toVersion);
    if (!to)
        throw runtime_error(format("<561bbf40> Unrecognized --to version \"{}\"", toVersion));

    logger.info("<d4e5f6a7> Converting \"{}\" from OpenAPI {} to {}", specPath, OpenApi::toVersionString(from),
                OpenApi::toVersionString(*to));
    // Reading `specNode` into the canonical model also doubles as its structural validation (see
    // OpenApi::V3::Read/V2::Read) - a malformed input throws here, before anything is written.
    auto converted = OpenApi::convertVersion(specNode, from, *to);

    writeSpecFile(converted, *to, outPath, outputFormat);

    logger.info("<a7b8c9d0> Wrote {}", outPath);
}
