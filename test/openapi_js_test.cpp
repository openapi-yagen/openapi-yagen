// clazy:excludeall=non-pod-global-static

#include <catch2/catch_all.hpp>

#include <quickjs/quickjs.h>

#include <lib/common/node_walker.h>
#include <lib/common/yaml_or_json_parser.h>
#include <lib/generator/openapi_js_bridge.h>
#include <lib/js/tools.h>
#include <lib/openapi/resolve.h>
#include <lib/openapi/v3/reader.h>
#include <lib/openapi/version.h>

#include "common/tools.h"

using namespace std;
using namespace OpenApi;
using namespace JS;

namespace {

Document parseDoc(const string& content)
{
    auto node = parseYamlOrJsonToNode(content);
    auto m = node.getIf<Node::Map>() ? *node.getIf<Node::Map>() : Node::Map();
    if (!m.contains("openapi"))
        m["openapi"] = Node { string("3.0.0") };
    if (!m.contains("info"))
        m["info"] = Node { Node::Map {
            { "title", Node { string("Test") } },
            { "version", Node { string("1.0.0") } },
        } };
    return V3::Read(NodeWalker(Node { m }), OpenApiVersion::V3_0);
}

bool evalBool(JSContext* ctx, const string& code)
{
    auto result = JS_Eval(ctx, code.c_str(), code.size(), "<test>", JS_EVAL_TYPE_GLOBAL);
    checkForException(ctx, result, "<d9d9f6ab> eval failed");
    bool b = JS_ToBool(ctx, result) == 1;
    JS_FreeValue(ctx, result);
    return b;
}

}

TEST_CASE("OpenApiJsGraphBuilder builds a cycle-safe, identity-preserving schema graph", "[openapi_js]")
{
    auto doc = parseDoc(R"(
components:
  schemas:
    TreeNode:
      type: object
      properties:
        name:
          type: string
        children:
          type: array
          items:
            $ref: "#/components/schemas/TreeNode"
)");
    resolveAllRefs(doc);

    auto runtime = JS_NewRuntime();
    auto ctx = JS_NewContext(runtime);

    {
        Generator::OpenApiJsGraphBuilder builder(ctx);
        auto treeNodeValue = builder.buildSchemaValue(doc.components.schemas.at("TreeNode"));
        auto globalObj = JS_GetGlobalObject(ctx);
        setObjProperty(ctx, globalObj, "treeNode", treeNodeValue);
        JS_FreeValue(ctx, globalObj);

        REQUIRE(evalBool(ctx, "treeNode.properties.children.items === treeNode"));
        REQUIRE(evalBool(ctx, "treeNode.type === 'object'"));
        REQUIRE(evalBool(ctx, "treeNode.properties.name.type === 'string'"));
        REQUIRE(evalBool(ctx, "treeNode.properties.children.type === 'array'"));
        REQUIRE(evalBool(ctx, "treeNode['$ref'] === undefined"));
    }

    JS_FreeContext(ctx);
    JS_FreeRuntime(runtime);
}

TEST_CASE("OpenApiJsGraphBuilder preserves vendor/unmodeled fields verbatim", "[openapi_js]")
{
    auto doc = parseDoc(R"(
components:
  schemas:
    Pet:
      type: object
      title: A pet
      x-custom-vendor-field: hello
      properties:
        name:
          type: string
)");
    resolveAllRefs(doc);

    auto runtime = JS_NewRuntime();
    auto ctx = JS_NewContext(runtime);
    {
        Generator::OpenApiJsGraphBuilder builder(ctx);
        auto petValue = builder.buildSchemaValue(doc.components.schemas.at("Pet"));
        auto globalObj = JS_GetGlobalObject(ctx);
        setObjProperty(ctx, globalObj, "pet", petValue);
        JS_FreeValue(ctx, globalObj);

        REQUIRE(evalBool(ctx, "pet.title === 'A pet'"));
        REQUIRE(evalBool(ctx, "pet['x-custom-vendor-field'] === 'hello'"));
    }
    JS_FreeContext(ctx);
    JS_FreeRuntime(runtime);
}

TEST_CASE("OpenApiJsGraphBuilder shares identity for a schema reused across two properties", "[openapi_js]")
{
    auto doc = parseDoc(R"(
components:
  schemas:
    Pet:
      type: object
      properties:
        name:
          type: string
    Wrapper:
      type: object
      properties:
        a:
          $ref: "#/components/schemas/Pet"
        b:
          $ref: "#/components/schemas/Pet"
)");
    resolveAllRefs(doc);

    auto runtime = JS_NewRuntime();
    auto ctx = JS_NewContext(runtime);
    {
        Generator::OpenApiJsGraphBuilder builder(ctx);
        auto wrapperValue = builder.buildSchemaValue(doc.components.schemas.at("Wrapper"));
        auto globalObj = JS_GetGlobalObject(ctx);
        setObjProperty(ctx, globalObj, "wrapper", wrapperValue);
        JS_FreeValue(ctx, globalObj);

        REQUIRE(evalBool(ctx, "wrapper.properties.a === wrapper.properties.b"));
    }
    JS_FreeContext(ctx);
    JS_FreeRuntime(runtime);
}

TEST_CASE("OpenApiJsGraphBuilder builds the whole document, resolving $ref by identity", "[openapi_js]")
{
    auto rawNode = parseYamlOrJsonToNode(readResource("petstore.yaml"));
    auto doc = V3::Read(NodeWalker(rawNode), OpenApiVersion::V3_0);
    resolveAllRefs(doc);

    auto runtime = JS_NewRuntime();
    auto ctx = JS_NewContext(runtime);
    {
        Generator::OpenApiJsGraphBuilder builder(ctx);
        auto schemaValue = builder.buildDocumentValue(rawNode, doc);
        auto globalObj = JS_GetGlobalObject(ctx);
        setObjProperty(ctx, globalObj, "schema", schemaValue);
        JS_FreeValue(ctx, globalObj);

        // Pets.items was `$ref: Pet` - now literally the same object as components.schemas.Pet.
        REQUIRE(evalBool(ctx, "schema.components.schemas.Pets.items === schema.components.schemas.Pet"));
        REQUIRE(evalBool(ctx, "schema.components.schemas.Pets.items['$ref'] === undefined"));

        // Non-schema top-level document fields survive untouched.
        REQUIRE(evalBool(ctx, "schema.info.title === 'Swagger Petstore'"));

        // Path-level/operation-level structure preserved; response schema resolved by identity.
        REQUIRE(evalBool(ctx,
                         "schema.paths['/pets'].get.responses['200'].content['application/json'].schema === "
                         "schema.components.schemas.Pets"));
        REQUIRE(evalBool(ctx, "schema.paths['/pets/{petId}'].get.parameters[0].name === 'petId'"));

        // nameOf: a named component resolves to its registered name; an inline schema does not.
        auto petValue = builder.buildSchemaValue(doc.components.schemas.at("Pet"));
        REQUIRE(builder.nameOf(petValue) == string("Pet"));
        JS_FreeValue(ctx, petValue);

        auto limitParamSchema
            = builder.buildSchemaValue(doc.paths.at("/pets").operations.at("get").parameters[0]->schema);
        REQUIRE_FALSE(builder.nameOf(limitParamSchema).has_value());
        JS_FreeValue(ctx, limitParamSchema);
    }
    JS_FreeContext(ctx);
    JS_FreeRuntime(runtime);
}
