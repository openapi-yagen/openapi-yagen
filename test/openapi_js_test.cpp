// clazy:excludeall=non-pod-global-static

#include <catch2/catch_all.hpp>

#include <quickjs/quickjs.h>

#include <lib/common/node_walker.h>
#include <lib/common/yaml_or_json_parser.h>
#include <lib/generator/openapi_js_bridge.h>
#include <lib/js/tools.h>
#include <lib/openapi/resolve.h>

using namespace std;
using namespace OpenApi;
using namespace JS;

namespace {

Document parseDoc(const string& content)
{
    auto node = parseYamlOrJsonToNode(content);
    return parseDocument(NodeWalker(node));
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
