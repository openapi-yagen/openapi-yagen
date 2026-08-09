// clazy:excludeall=non-pod-global-static

#include <catch2/catch_all.hpp>

#include <lib/common/node_walker.h>
#include <lib/common/yaml_or_json_parser.h>
#include <lib/openapi/v2/reader.h>
#include <lib/openapi/v2/writer.h>
#include <lib/openapi/v3/reader.h>
#include <lib/openapi/version.h>
#include <lib/openapi/version_convert.h>

#include "common/tools.h"

using namespace std;
using namespace OpenApi;

namespace {
Node loadPetstore20() { return parseYamlOrJsonToNode(readResource("petstore_2.0.yaml")); }
}

TEST_CASE("V2::Read maps Swagger 2.0 constructs onto the canonical model", "[v2]")
{
    auto doc = V2::Read(NodeWalker(loadPetstore20()));
    REQUIRE(doc.version == OpenApiVersion::V2_0);

    SECTION("host/basePath/schemes synthesize a Server")
    {
        REQUIRE(doc.servers.size() == 1);
        REQUIRE(doc.servers[0].url == "https://petstore.swagger.io/v2");
    }

    SECTION("definitions become components.schemas, x-nullable becomes canonical nullability")
    {
        const auto& pet = *doc.components.schemas.at("Pet");
        REQUIRE(pet.type == vector<string> { "object" });
        REQUIRE(pet.required == vector<string> { "id", "name" });
        REQUIRE(isNullable(*pet.properties.at("tag")));
        REQUIRE(pet.properties.at("tag")->type == vector<string> { "string", "null" });
    }

    SECTION("securityDefinitions: apiKey direct, oauth2 flat fields fold into one named flow")
    {
        const auto& apiKey = *doc.components.securitySchemes.at("api_key");
        REQUIRE(apiKey.type == "apiKey");
        REQUIRE(apiKey.name == "X-Api-Key");

        const auto& oauth = *doc.components.securitySchemes.at("petstore_auth");
        REQUIRE(oauth.type == "oauth2");
        REQUIRE(oauth.flows->authorizationCode->authorizationUrl == "https://petstore.swagger.io/oauth/authorize");
        REQUIRE(oauth.flows->authorizationCode->tokenUrl == "https://petstore.swagger.io/oauth/token");
        REQUIRE(oauth.flows->authorizationCode->scopes.at("write:pets") == "modify pets");
        REQUIRE_FALSE(oauth.flows->implicit_.has_value());
    }

    SECTION("query parameter: flat type/items + collectionFormat -> schema + style/explode")
    {
        const auto& get = doc.paths.at("/pets").operations.at("get");
        const auto& tags = *get.parameters[0];
        REQUIRE(tags.name == "tags");
        REQUIRE(tags.schema->type == vector<string> { "array" });
        REQUIRE(tags.schema->items->type == vector<string> { "string" });
        REQUIRE(tags.style == "form");
        REQUIRE(tags.explode == true); // collectionFormat: multi
    }

    SECTION("body parameter becomes requestBody")
    {
        const auto& post = doc.paths.at("/pets").operations.at("post");
        REQUIRE(post.requestBody != nullptr);
        REQUIRE(post.requestBody->required == true);
        REQUIRE(post.requestBody->content.at("application/json").schema->ref == "#/components/schemas/Pet");
        REQUIRE(post.security->at(0).at("petstore_auth") == vector<string> { "write:pets" });
    }

    SECTION("formData parameters merge into one object-schema requestBody")
    {
        const auto& upload = doc.paths.at("/pets/{petId}/photo").operations.at("post");
        REQUIRE(upload.requestBody != nullptr);
        const auto& media = upload.requestBody->content.at("multipart/form-data");
        REQUIRE(media.schema->type == vector<string> { "object" });
        REQUIRE(media.schema->properties.contains("caption"));
        REQUIRE(media.schema->properties.contains("file"));
        REQUIRE(media.schema->required == vector<string> { "file" });
    }

    SECTION("response schema + produces synthesize content")
    {
        const auto& get = doc.paths.at("/pets").operations.at("get");
        const auto& resp200 = *get.responses.at("200");
        REQUIRE(resp200.content.at("application/json").schema->type == vector<string> { "array" });
    }
}

TEST_CASE("convertVersion(2.0 -> 3.0) produces a fully-formed OAS 3.0 document", "[v2]")
{
    auto node30 = convertVersion(loadPetstore20(), OpenApiVersion::V2_0, OpenApiVersion::V3_0);
    REQUIRE(NodeWalker(node30)["openapi"].required<string>() == "3.0.0");

    auto doc30 = V3::Read(NodeWalker(node30), OpenApiVersion::V3_0);
    REQUIRE(doc30.servers[0].url == "https://petstore.swagger.io/v2");
    const auto& pet = *doc30.components.schemas.at("Pet");
    // Canonical `type` always includes "null" for a nullable schema (see schema.h) - the 2.0
    // source's `x-nullable: true` round-tripped through the freshly-written OAS 3.0 `nullable:
    // true` and back into this same canonical form.
    REQUIRE(pet.properties.at("tag")->type == vector<string> { "string", "null" });
    REQUIRE(isNullable(*pet.properties.at("tag")));

    auto ops = collectOperations(doc30);
    auto createPet = find_if(ops.begin(), ops.end(),
                             [](const auto& op) { return op.operationId && *op.operationId == "createPet"; });
    REQUIRE(createPet != ops.end());
    REQUIRE(createPet->requestBody != nullptr);
}

TEST_CASE("V2::Write denormalizes a canonical Document into Swagger 2.0", "[v2]")
{
    auto doc31 = V3::Read(NodeWalker(parseYamlOrJsonToNode(readResource("full_spec_3.1.yaml"))), OpenApiVersion::V3_1);
    auto node20 = V2::Write(doc31);
    NodeWalker w(node20);

    REQUIRE(w["swagger"].required<string>() == "2.0");

    SECTION("nullable type-array folds into x-nullable")
    {
        auto nameNode = w["definitions"]["Widget"]["properties"]["name"];
        REQUIRE(nameNode["type"].required<string>() == "string");
        REQUIRE(nameNode["x-nullable"].required<bool>() == true);
    }

    SECTION("$ref prefixes rewritten to 2.0's registries")
    {
        auto namedAllOf0Ref = w["definitions"]["Named"]["allOf"][to_string(0)]["$ref"].required<string>();
        REQUIRE(namedAllOf0Ref == "#/definitions/Widget");
    }

    SECTION("a JSON requestBody becomes a single body parameter")
    {
        auto createParams = w["paths"]["/widgets"]["post"]["parameters"];
        // Find the "body" parameter among the operation's parameters.
        bool foundBody = false;
        auto arr = createParams.required<Node>().get<Node::Vec>();
        for (size_t i = 0; i < arr.size(); i++) {
            auto pw = createParams[to_string(i)];
            if (pw["in"].optional<string>() == string("body")) {
                foundBody = true;
                REQUIRE(pw["schema"]["$ref"].required<string>() == "#/definitions/Widget");
            }
        }
        REQUIRE(foundBody);
    }

    SECTION("a server URL with an unresolved {variable} can't become host/basePath/schemes - left unset")
    {
        // full_spec_3.1.yaml's only server is "https://{env}.example.com/{basePath}" - 2.0 has no
        // server-variable concept, so this is a documented, honest gap rather than emitting a
        // literal (and misleading) "{env}.example.com" host.
        REQUIRE_FALSE(w["host"].optional<string>().has_value());
    }
}

TEST_CASE("V2::Write synthesizes host/basePath/schemes from a plain server URL", "[v2]")
{
    auto doc30 = V3::Read(NodeWalker(parseYamlOrJsonToNode(readResource("petstore.yaml"))), OpenApiVersion::V3_0);
    auto node20 = V2::Write(doc30);
    NodeWalker w(node20);
    REQUIRE(w["host"].required<string>() == "petstore.swagger.io");
    REQUIRE(w["basePath"].required<string>() == "/v1");
    REQUIRE(w["schemes"][to_string(0)].required<string>() == "http");
}
