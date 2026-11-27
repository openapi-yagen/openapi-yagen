#include "spec_bundle.h"

#include <format>
#include <stdexcept>

#include "../common/node_walker.h"
#include "../openapi/filter.h"
#include "../openapi/resolve.h"
#include "../openapi/v2/reader.h"
#include "../openapi/v3/reader.h"
#include "../openapi/version_convert.h"
#include "spec_file.h"

using namespace std;

BundledSpec bundleSpec(const string& specPath, const BundleOpts& opts)
{
    BundledSpec result { .node = readSpecFile(specPath, opts.refRoot) };

    auto detected = OpenApi::detectVersion(result.node);
    if (!detected)
        throw runtime_error("<00d4b692> Cannot determine the spec's OpenAPI version - expected a top-level "
                            "\"openapi\" (3.x) or \"swagger\" (2.0) field with a recognized value");
    result.version = *detected;
    auto target = opts.targetVersion.value_or(*detected);

    auto convertToTarget = [&] {
        if (result.version == target)
            return;
        result.node = OpenApi::convertVersion(result.node, result.version, target);
        result.version = target;
    };

    if (!opts.tags.empty() && !OpenApi::isV3(result.version)) {
        if (!OpenApi::isV3(target))
            throw runtime_error("<454d44b4> Filtering by tags needs an OpenAPI 3.x document - pass --to with a "
                                "3.x version for a Swagger 2.0 spec");
        convertToTarget();
    }

    // Reading into the typed model is what validates the document.
    if (OpenApi::isV3(result.version)) {
        auto doc = OpenApi::V3::Read(NodeWalker(result.node), result.version);
        OpenApi::resolveAllRefs(doc);
        if (!opts.tags.empty())
            OpenApi::filterByTags(doc, result.node, opts.tags);
    } else {
        auto doc = OpenApi::V2::Read(NodeWalker(result.node));
        OpenApi::resolveAllRefs(doc);
    }

    convertToTarget();
    return result;
}
