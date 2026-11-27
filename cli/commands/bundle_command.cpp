#include "bundle_command.h"

#include <format>
#include <stdexcept>

#include <lib/generator/spec_bundle.h>
#include <lib/generator/spec_file.h>
#include <lib/logger/logger.h>

using namespace std;

namespace {
LogFacade::Logger logger("BundleCommand");
}

BundleCommand::BundleCommand() { }

void BundleCommand::reg(CLI::App& app)
{
    auto cmd = app.add_subcommand("bundle", "Merge a specification and the files it refers to into one document")
                   ->alias("b")
                   ->callback(std::bind(&BundleCommand::process, this));
    cmd->add_option("spec-file", specPath, "Specification file to bundle")->required();
    cmd->add_option("-o,--out", outPath, "Output file path")->required();
    cmd->add_option("--format", outputFormat,
                    "Output format: \"yaml\" or \"json\" - inferred from --out's extension if omitted");
    cmd->add_option("--to", toVersion, "Also convert to this OpenAPI version (e.g. 2.0, 3.0, 3.1, 3.2)");
    cmd->add_option("--ref-root", refRoot,
                    "Directory that files referenced through $ref must lie in (default: the spec file's directory)");
    cmd->add_option("-t, --tags", tags,
                    "Only keep operations/models tagged with one of these tags (default: keep everything)")
        ->take_all();
}

void BundleCommand::process()
{
    BundleOpts opts { .refRoot = refRoot, .tags = tags };
    if (!toVersion.empty()) {
        opts.targetVersion = OpenApi::parseVersionString(toVersion);
        if (!opts.targetVersion)
            throw runtime_error(format("<e6334db2> Unrecognized --to version \"{}\"", toVersion));
    }

    auto bundled = bundleSpec(specPath, opts);
    writeSpecFile(bundled.node, bundled.version, outPath, outputFormat);
    logger.info("<3669b266> Wrote {}", outPath);
}
