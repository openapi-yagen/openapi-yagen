// clazy:excludeall=non-pod-global-static

#include <catch2/catch_all.hpp>

#include <lib/common/node_walker.h>
#include <lib/generator/spec_file.h>
#include <lib/openapi/schema.h>
#include <lib/openapi/v3/reader.h>
#include <lib/openapi/version.h>

#include "common/tools.h"

using namespace std;
using namespace OpenApi;

TEST_CASE("External $ref resolution", "[external_ref]")
{
    auto node = readSpecFile(getResourcePath("external_ref_spec/main.yaml"));
    auto doc = V3::Read(NodeWalker(node), OpenApiVersion::V3_0);

    SECTION("A description $ref to a local sibling file is resolved through its json pointer")
    {
        REQUIRE(doc.tags[0].name == "intro");
        REQUIRE(doc.tags[0].description == "Loaded from an external file.");
    }

    SECTION("An operation $ref to a local sibling file is resolved and spliced in whole")
    {
        const auto& op = doc.paths.at("/foo").operations.at("get");
        REQUIRE(op.operationId == "getFoo");
        REQUIRE(op.summary == "Get foo");
        REQUIRE(op.responses.contains("200"));
    }

    SECTION("A $ref to a missing file is treated as absent, not an error")
    {
        REQUIRE(doc.tags[1].name == "missing");
        REQUIRE(doc.tags[1].description == nullopt);
    }

    SECTION("A $ref that would escape the spec's directory is rejected, not read")
    {
        REQUIRE(doc.tags[2].name == "escaping");
        REQUIRE(doc.tags[2].description == nullopt);
    }

    SECTION("A self-referential schema inside an externally-loaded file is hoisted into "
            "components.schemas instead of being inlined infinitely")
    {
        REQUIRE(doc.components.schemas.contains("node"));
        auto nodeSchema = doc.components.schemas.at("node");

        auto childrenItems = nodeSchema->properties.at("children")->items;
        REQUIRE(childrenItems->ref == "#/components/schemas/node");
        REQUIRE(deref(doc.components.schemas, childrenItems) == nodeSchema);

        // The response schema is reached via an external file+pointer ref ("resources/recursive.yml#/node"),
        // which splices the target's actual content in place (like the /foo operation above) rather than
        // hoisting it - only the self-reference found WITHIN that content (children.items above) needed
        // hoisting, to avoid an infinite inline copy.
        auto responseSchema = doc.paths.at("/recursive").operations.at("get").responses.at("200")->content.at("application/json").schema;
        REQUIRE(responseSchema->type == vector<string> { "object" });
        REQUIRE(responseSchema->properties.at("children")->items->ref == "#/components/schemas/node");
    }
}
