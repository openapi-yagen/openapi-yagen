#include "convert_command.h"

#include <format>
#include <fstream>
#include <stdexcept>

#include <lib/common/yaml_or_json_parser.h>
#include <lib/generator/spec_file.h>
#include <lib/logger/logger.h>
#include <lib/openapi/document_field_order.h>
#include <lib/openapi/version.h>
#include <lib/openapi/version_convert.h>

using namespace std;

namespace {
LogFacade::Logger logger("ConvertCommand");

bool endsWith(const string& s, const string& suffix)
{
    return s.size() >= suffix.size() && s.compare(s.size() - suffix.size(), suffix.size(), suffix) == 0;
}
}

ConvertCommand::ConvertCommand() { }

void ConvertCommand::reg(CLI::App& app)
{
    auto cmd = app.add_subcommand("convert", "Convert an OpenAPI spec from one version to another")
                   ->callback(std::bind(&ConvertCommand::process, this));
    cmd->add_option("spec-file", specPath, "Specification file to convert")->required();
    cmd->add_option("--from", fromVersion, "Source OpenAPI version (e.g. 2.0, 3.0, 3.1, 3.2) - "
                                            "auto-detected from the spec's own \"openapi\"/\"swagger\" field if omitted");
    cmd->add_option("--to", toVersion, "Target OpenAPI version (e.g. 2.0, 3.0, 3.1, 3.2)")->required();
    cmd->add_option("-o,--out", outPath, "Output file path")->required();
    cmd->add_option("--format", outputFormat,
                    "Output format: \"yaml\" or \"json\" - inferred from --out's extension if omitted");
}

void ConvertCommand::process()
{
    auto specNode = readSpecFile(specPath);

    OpenApi::OpenApiVersion from;
    if (!fromVersion.empty()) {
        auto parsed = OpenApi::parseVersionString(fromVersion);
        if (!parsed)
            throw runtime_error(format("<a1b2c3d4> Unrecognized --from version \"{}\"", fromVersion));
        from = *parsed;
    } else {
        auto detected = OpenApi::detectVersion(specNode);
        if (!detected)
            throw runtime_error("<b2c3d4e5> Cannot determine the spec's OpenAPI version - expected a top-level "
                                 "\"openapi\" (3.x) or \"swagger\" (2.0) field with a recognized value, or pass --from");
        from = *detected;
    }

    auto to = OpenApi::parseVersionString(toVersion);
    if (!to)
        throw runtime_error(format("<c3d4e5f6> Unrecognized --to version \"{}\"", toVersion));

    logger.info("<d4e5f6a7> Converting \"{}\" from OpenAPI {} to {}", specPath, OpenApi::toVersionString(from),
                OpenApi::toVersionString(*to));
    // Reading `specNode` into the canonical model also doubles as its structural validation (see
    // OpenApi::V3::Read/V2::Read) - a malformed input throws here, before anything is written.
    auto converted = OpenApi::convertVersion(specNode, from, *to);

    auto fieldOrder = OpenApi::documentFieldOrder(*to);
    bool asJson = outputFormat == "json" || (outputFormat.empty() && endsWith(outPath, ".json"));
    auto text = asJson ? nodeToJsonText(converted, fieldOrder) : nodeToYamlText(converted, fieldOrder);

    ofstream out(outPath, ios::binary);
    if (!out)
        throw runtime_error(format("<e5f6a7b8> Cannot open \"{}\" for writing", outPath));
    out << text;
    if (!out)
        throw runtime_error(format("<f6a7b8c9> Failed writing to \"{}\"", outPath));

    logger.info("<a7b8c9d0> Wrote {}", outPath);
}
