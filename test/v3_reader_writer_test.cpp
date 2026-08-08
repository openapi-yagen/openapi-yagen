// clazy:excludeall=non-pod-global-static

#include <catch2/catch_all.hpp>

#include <algorithm>

#include <lib/common/node_walker.h>
#include <lib/common/yaml_or_json_parser.h>
#include <lib/openapi/v3/reader.h>
#include <lib/openapi/v3/writer.h>
#include <lib/openapi/version.h>
#include <lib/openapi/version_convert.h>

#include "common/tools.h"

using namespace std;
using namespace OpenApi;

namespace {
Node loadFullSpec31() { return parseYamlOrJsonToNode(readResource("full_spec_3.1.yaml")); }
Node loadFullSpec32() { return parseYamlOrJsonToNode(readResource("full_spec_3.2.yaml")); }
}

TEST_CASE("V3::Read parses every Stage 1 construct from the full reference spec", "[v3]")
{
    auto doc = V3::Read(NodeWalker(loadFullSpec31()), OpenApiVersion::V3_1);

    SECTION("Info/Contact/License")
    {
        REQUIRE(doc.info.title == "Full Construct Test API");
        REQUIRE(doc.info.summary == "Exercises every Stage 1 construct");
        REQUIRE(doc.info.termsOfService == "https://example.com/terms");
        REQUIRE(doc.info.contact->name == "API Team");
        REQUIRE(doc.info.contact->email == "api@example.com");
        REQUIRE(doc.info.license->name == "Apache 2.0");
        REQUIRE(doc.info.license->identifier == "Apache-2.0");
        REQUIRE(doc.info.version == "2.0.0");
    }

    SECTION("Servers with variables")
    {
        REQUIRE(doc.servers.size() == 1);
        const auto& server = doc.servers[0];
        REQUIRE(server.url == "https://{env}.example.com/{basePath}");
        REQUIRE(server.variables.at("env").enumValues == vector<string> { "prod", "staging" });
        REQUIRE(server.variables.at("env").defaultValue == "prod");
        REQUIRE(server.variables.at("basePath").defaultValue == "v2");
    }

    SECTION("Tags and top-level externalDocs")
    {
        REQUIRE(doc.tags.size() == 1);
        REQUIRE(doc.tags[0].name == "widgets");
        REQUIRE(doc.tags[0].externalDocs->url == "https://example.com/docs/widgets");
        REQUIRE(doc.externalDocs->url == "https://example.com/docs");
    }

    SECTION("Document-level security requirements")
    {
        REQUIRE(doc.security.size() == 2);
        REQUIRE(doc.security[0].at("ApiKeyAuth").empty());
        REQUIRE(doc.security[1].at("OAuth2") == vector<string> { "read:widgets", "write:widgets" });
    }

    SECTION("Security schemes")
    {
        const auto& apiKey = *doc.components.securitySchemes.at("ApiKeyAuth");
        REQUIRE(apiKey.type == "apiKey");
        REQUIRE(apiKey.name == "X-Api-Key");
        REQUIRE(apiKey.in == "header");

        const auto& oauth2 = *doc.components.securitySchemes.at("OAuth2");
        REQUIRE(oauth2.type == "oauth2");
        REQUIRE(oauth2.flows->authorizationCode->authorizationUrl == "https://example.com/oauth/authorize");
        REQUIRE(oauth2.flows->authorizationCode->scopes.at("read:widgets") == "Read widgets");
    }

    SECTION("Reusable components: header/example/link/pathItem")
    {
        REQUIRE(doc.components.headers.at("RateLimitHeader")->schema->type == vector<string> { "integer" });
        REQUIRE(doc.components.examples.at("WidgetExample")->summary == "A widget example");
        REQUIRE(doc.components.links.at("GetWidgetByIdShared")->operationId == "getWidget");
        REQUIRE(doc.components.pathItems.at("SharedPathItem").operations.at("get").operationId == "sharedGet");
    }

    SECTION("Widget schema - full vocabulary")
    {
        const auto& widget = *doc.components.schemas.at("Widget");
        REQUIRE(widget.title == "Widget");
        REQUIRE(widget.required == vector<string> { "id", "kind" });
        REQUIRE(widget.properties.at("id")->readOnly == true);

        const auto& name = *widget.properties.at("name");
        REQUIRE(isNullable(name));
        REQUIRE(name.type == vector<string> { "string", "null" });

        const auto& weight = *widget.properties.at("weight");
        REQUIRE(weight.minimum->get<Node::Int>() == 0);
        REQUIRE(weight.exclusiveMinimum->get<Node::Int>() == 0);
        REQUIRE(weight.maximum->get<Node::Int>() == 1000);
        REQUIRE_FALSE(weight.exclusiveMaximum.has_value());

        REQUIRE(widget.properties.at("rating")->constValue->get<Node::Int>() == 5);
        REQUIRE(widget.properties.at("tags")->items->type == vector<string> { "string" });
        REQUIRE(widget.properties.at("tags")->uniqueItems == true);
        REQUIRE(widget.properties.at("extra")->additionalPropertiesSchema->type == vector<string> { "string" });
        REQUIRE(widget.properties.at("extra")->maxProperties == 10);

        REQUIRE(widget.xml->name == "widget");
        REQUIRE(widget.externalDocs->url == "https://example.com/docs/widget-schema");
        REQUIRE(widget.examples.size() == 1);
        REQUIRE(widget.discriminator->propertyName == "kind");
        REQUIRE(kindOf(widget) == SchemaKind::Object);
    }

    SECTION("allOf composition")
    {
        const auto& named = *doc.components.schemas.at("Named");
        REQUIRE(named.allOf.size() == 2);
        REQUIRE(named.allOf[0]->ref == "#/components/schemas/Widget");
        REQUIRE(kindOf(named) == SchemaKind::AllOf);
    }

    SECTION("Paths: parameters, headers, examples, links")
    {
        const auto& get = doc.paths.at("/widgets").operations.at("get");
        REQUIRE(get.deprecated == false);
        REQUIRE(get.parameters[0]->style == "form");
        REQUIRE(get.parameters[0]->explode == true);
        REQUIRE(get.parameters[1]->in == "header");

        const auto& resp200 = *get.responses.at("200");
        REQUIRE(resp200.headers.at("X-Rate-Limit")->schema->type == vector<string> { "integer" });
        REQUIRE(resp200.content.at("application/json").examples.at("sample")->summary == "Sample list");
        REQUIRE(resp200.links.at("GetWidgetById")->operationId == "getWidget");
    }

    SECTION("RequestBody encoding and Callbacks")
    {
        const auto& post = doc.paths.at("/widgets").operations.at("post");
        const auto& media = post.requestBody->content.at("application/json");
        REQUIRE(media.encoding.at("metadata").contentType == "application/json");
        REQUIRE(media.encoding.at("metadata").headers.at("X-Meta-Version")->schema->type == vector<string> { "string" });

        const auto& callback = *post.callbacks.at("widgetCreated");
        const auto& callbackPathItem = *callback.expressions.at("{$request.body#/callbackUrl}");
        REQUIRE(callbackPathItem.operations.at("post").responses.at("200")->description == "Callback acknowledged");
    }

    SECTION("Webhooks (OAS 3.1+)")
    {
        REQUIRE(doc.webhooks.contains("widgetPing"));
        REQUIRE(doc.webhooks.at("widgetPing").operations.at("post").operationId == "widgetPing");
    }
}

TEST_CASE("V3::Write denormalizes 3.1-only constructs for an OAS 3.0 target", "[v3]")
{
    auto doc31 = V3::Read(NodeWalker(loadFullSpec31()), OpenApiVersion::V3_1);
    auto node30 = V3::Write(doc31, OpenApiVersion::V3_0);
    auto doc30 = V3::Read(NodeWalker(node30), OpenApiVersion::V3_0);

    SECTION("openapi field rewritten")
    {
        REQUIRE(NodeWalker(node30)["openapi"].required<string>() == "3.0.0");
    }

    SECTION("nullable type-array folds into nullable:true + scalar type, and back into canonical on reread")
    {
        const auto& name = *doc30.components.schemas.at("Widget")->properties.at("name");
        REQUIRE(isNullable(name));
        REQUIRE(name.type == vector<string> { "string", "null" });
    }

    SECTION("exclusiveMinimum folds into bool+minimum form")
    {
        const auto& weight = *doc30.components.schemas.at("Widget")->properties.at("weight");
        REQUIRE(weight.exclusiveMinimum->get<Node::Int>() == 0);
        // The original independent `minimum: 0` is absorbed into the exclusive bound when
        // denormalizing to OAS 3.0's single-active-bound convention - a documented, semantically
        // harmless fold since both bounds held the same value here.
        REQUIRE_FALSE(weight.minimum.has_value());
    }

    SECTION("const dropped (OAS 3.0 has no \"const\" keyword)")
    {
        REQUIRE_FALSE(doc30.components.schemas.at("Widget")->properties.at("rating")->constValue.has_value());
    }

    SECTION("schema-level examples[] collapses into example (OAS 3.0 has no \"examples\" array)")
    {
        const auto& widget = *doc30.components.schemas.at("Widget");
        REQUIRE(widget.examples.empty());
        REQUIRE(widget.example.has_value());
    }

    SECTION("Info.summary and License.identifier dropped (no OAS 3.0 equivalent)")
    {
        REQUIRE_FALSE(doc30.info.summary.has_value());
        REQUIRE(doc30.info.license->name == "Apache 2.0");
        REQUIRE_FALSE(doc30.info.license->identifier.has_value());
    }

    SECTION("webhooks and components.pathItems dropped (no OAS 3.0 equivalent)")
    {
        REQUIRE(doc30.webhooks.empty());
        REQUIRE(doc30.components.pathItems.empty());
    }

    SECTION("Everything else survives: operations, parameters, callbacks, security schemes")
    {
        REQUIRE(doc30.paths.at("/widgets").operations.at("get").parameters[0]->style == "form");
        REQUIRE(doc30.paths.contains("/widgets/{widgetId}"));
        const auto& post = doc30.paths.at("/widgets").operations.at("post");
        REQUIRE(post.callbacks.at("widgetCreated")
                    ->expressions.at("{$request.body#/callbackUrl}")
                    ->operations.at("post")
                    .responses.contains("200"));
        REQUIRE(doc30.components.securitySchemes.at("OAuth2")->flows->authorizationCode->tokenUrl
                == "https://example.com/oauth/token");
    }
}

TEST_CASE("convertVersion round-trips the openapi field and same-version is a true no-op", "[v3]")
{
    auto node31 = loadFullSpec31();

    auto node30 = convertVersion(node31, OpenApiVersion::V3_1, OpenApiVersion::V3_0);
    REQUIRE(NodeWalker(node30)["openapi"].required<string>() == "3.0.0");

    auto backTo31 = convertVersion(node30, OpenApiVersion::V3_0, OpenApiVersion::V3_1);
    REQUIRE(NodeWalker(backTo31)["openapi"].required<string>() == "3.1.0");
    // Round-tripping 3.1 -> 3.0 -> 3.1 keeps nullability (even though it's now expressed via a
    // fresh type array rather than the original one, and the redundant minimum:0 was folded away
    // in the 3.0 leg - both documented, semantically-neutral effects of the conversion).
    auto reparsed = V3::Read(NodeWalker(backTo31), OpenApiVersion::V3_1);
    REQUIRE(isNullable(*reparsed.components.schemas.at("Widget")->properties.at("name")));
}

TEST_CASE("Same-version conversion is unnecessary and V3::Write output is self-consistent for 3.1->3.1", "[v3]")
{
    auto doc31 = V3::Read(NodeWalker(loadFullSpec31()), OpenApiVersion::V3_1);
    auto rewritten = V3::Write(doc31, OpenApiVersion::V3_1);
    auto reparsed = V3::Read(NodeWalker(rewritten), OpenApiVersion::V3_1);

    // Nothing 3.1-specific should be lost writing 3.1 -> 3.1.
    REQUIRE(reparsed.info.summary == "Exercises every Stage 1 construct");
    REQUIRE(reparsed.info.license->identifier == "Apache-2.0");
    REQUIRE(reparsed.components.schemas.at("Widget")->properties.at("rating")->constValue->get<Node::Int>() == 5);
    REQUIRE(reparsed.webhooks.contains("widgetPing"));
    REQUIRE(reparsed.components.pathItems.contains("SharedPathItem"));
}

TEST_CASE("V3::Read parses every Stage 2 (OAS 3.2) construct", "[v3]")
{
    auto doc = V3::Read(NodeWalker(loadFullSpec32()), OpenApiVersion::V3_2);

    REQUIRE(doc.self == "https://example.com/openapi.json");

    SECTION("Tag summary/parent/kind")
    {
        REQUIRE(doc.tags[0].summary == "Widget stuff");
        REQUIRE(doc.tags[0].kind == "nav");
        REQUIRE(doc.tags[1].parent == "widgets");
        REQUIRE(doc.tags[1].kind == "badge");
    }

    SECTION("query operation and additionalOperations")
    {
        const auto& item = doc.paths.at("/widgets");
        REQUIRE(item.operations.at("query").operationId == "queryWidgets");
        REQUIRE(item.additionalOperations.at("PURGE").operationId == "purgeWidgets");

        // collectOperations() flattens additionalOperations entries too, keyed by their exact
        // (non-lowercased) method name.
        auto ops = collectOperations(doc);
        auto purge = find_if(ops.begin(), ops.end(), [](const auto& op) { return op.method == "PURGE"; });
        REQUIRE(purge != ops.end());
        REQUIRE(purge->operationId == "purgeWidgets");
    }

    SECTION("Schema: XML nodeType, discriminator.defaultMapping, JSON Schema 2020-12 keywords")
    {
        const auto& widget = *doc.components.schemas.at("Widget");
        REQUIRE(widget.xml->nodeType == "attribute");
        REQUIRE(widget.discriminator->defaultMapping == "#/components/schemas/Widget");
        REQUIRE(widget.comment == "internal note for schema authors");
        REQUIRE(widget.anchor == "WidgetAnchor");
        REQUIRE(widget.dynamicAnchor == "WidgetDynamicAnchor");
        REQUIRE(widget.defs.at("Inner")->type == vector<string> { "string" });
    }

    SECTION("Example dataValue/serializedValue")
    {
        const auto& ex = *doc.components.examples.at("WidgetExample");
        REQUIRE(ex.dataValue.has_value());
        REQUIRE(ex.serializedValue == "{\"id\":1,\"kind\":\"basic\"}");
    }

    SECTION("MediaType.itemSchema")
    {
        const auto& media = doc.components.requestBodies.at("WidgetStream")->content.at("application/jsonl");
        REQUIRE(media.itemSchema->ref == "#/components/schemas/Widget");
    }

    SECTION("Security: deviceAuthorization flow, oauth2MetadataUrl, deprecated")
    {
        const auto& apiKey = *doc.components.securitySchemes.at("ApiKeyAuth");
        REQUIRE(apiKey.deprecated == true);

        const auto& oauth2 = *doc.components.securitySchemes.at("OAuth2");
        REQUIRE(oauth2.oauth2MetadataUrl == "https://example.com/.well-known/oauth-authorization-server");
        REQUIRE(oauth2.flows->deviceAuthorization->deviceAuthorizationUrl == "https://example.com/oauth/device");
        REQUIRE(oauth2.flows->deviceAuthorization->tokenUrl == "https://example.com/oauth/token");
    }
}

TEST_CASE("V3::Write denormalizes OAS 3.2 constructs for older targets", "[v3]")
{
    auto doc32 = V3::Read(NodeWalker(loadFullSpec32()), OpenApiVersion::V3_2);

    SECTION("Targeting 3.1: 3.2-only fields dropped, JSON Schema 2020-12 keywords kept")
    {
        auto node31 = V3::Write(doc32, OpenApiVersion::V3_1);
        auto doc31 = V3::Read(NodeWalker(node31), OpenApiVersion::V3_1);

        REQUIRE_FALSE(doc31.self.has_value());
        REQUIRE(doc31.tags[0].kind.value_or("") == ""); // dropped - no OAS 3.1 equivalent
        REQUIRE(doc31.paths.at("/widgets").operations.contains("query")); // "query" always kept (additive)
        REQUIRE(doc31.paths.at("/widgets").additionalOperations.empty()); // dropped - no OAS 3.1 equivalent

        const auto& widget = *doc31.components.schemas.at("Widget");
        REQUIRE_FALSE(widget.xml->nodeType.has_value()); // dropped
        REQUIRE_FALSE(widget.discriminator->defaultMapping.has_value()); // dropped
        // $comment/$anchor/$dynamicAnchor/$defs are 3.1+ JSON Schema keywords, not 3.2-only - kept.
        REQUIRE(widget.comment == "internal note for schema authors");
        REQUIRE(widget.defs.at("Inner")->type == vector<string> { "string" });

        REQUIRE_FALSE(doc31.components.requestBodies.at("WidgetStream")->content.at("application/jsonl").itemSchema);

        const auto& oauth2 = *doc31.components.securitySchemes.at("OAuth2");
        REQUIRE_FALSE(oauth2.oauth2MetadataUrl.has_value());
        REQUIRE_FALSE(oauth2.flows->deviceAuthorization.has_value());
    }

    SECTION("Targeting 3.0: security scheme deprecated folds into x-oai-deprecated")
    {
        auto node30 = V3::Write(doc32, OpenApiVersion::V3_0);
        NodeWalker w(node30);
        auto apiKeyNode = w["components"]["securitySchemes"]["ApiKeyAuth"];
        REQUIRE_FALSE(apiKeyNode["deprecated"].optional<bool>().has_value());
        REQUIRE(apiKeyNode["x-oai-deprecated"].required<bool>() == true);
    }

    SECTION("Targeting 3.0: Example.dataValue folds into value")
    {
        auto node30 = V3::Write(doc32, OpenApiVersion::V3_0);
        auto doc30 = V3::Read(NodeWalker(node30), OpenApiVersion::V3_0);
        const auto& ex = *doc30.components.examples.at("WidgetExample");
        REQUIRE(ex.value.has_value());
        REQUIRE_FALSE(ex.dataValue.has_value());
        REQUIRE_FALSE(ex.serializedValue.has_value());
    }
}
