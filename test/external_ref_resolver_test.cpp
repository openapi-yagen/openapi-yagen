// clazy:excludeall=non-pod-global-static

#include <filesystem>
#include <format>
#include <fstream>
#include <random>

#include <catch2/catch_all.hpp>

#include <lib/common/node_walker.h>
#include <lib/generator/spec_file.h>
#include <lib/openapi/resolve.h>
#include <lib/openapi/schema.h>
#include <lib/openapi/v2/reader.h>
#include <lib/openapi/v3/reader.h>
#include <lib/openapi/version.h>

#include "common/tools.h"

using namespace std;
using namespace OpenApi;
using Catch::Matchers::ContainsSubstring;
using Catch::Matchers::MessageMatches;

namespace {

// A throwaway directory of spec files.
class SpecDir {
public:
    SpecDir()
        : root(filesystem::temp_directory_path() / format("openapi-yagen-refs-{}", random_device { }()))
    {
        filesystem::create_directories(root);
    }

    ~SpecDir()
    {
        error_code ec;
        filesystem::remove_all(root, ec);
    }

    SpecDir(const SpecDir&) = delete;
    SpecDir& operator=(const SpecDir&) = delete;

    void add(const string& relPath, const string& content) const
    {
        auto path = root / relPath;
        filesystem::create_directories(path.parent_path());
        ofstream(path) << content;
    }

    string path(const string& relPath = "") const { return (root / relPath).string(); }

private:
    filesystem::path root;
};

// A root spec made of the header and `body`.
string spec(const string& body) { return "openapi: 3.1.0\ninfo: {title: t, version: 1.0.0}\n" + body; }

// A root spec with one operation whose response body is `ref`.
string specReturning(const string& ref)
{
    return spec(format(R"(paths:
  /items:
    get:
      operationId: listItems
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema: {{$ref: '{}'}}
)",
                       ref));
}

Document read(const Node& node)
{
    auto doc = V3::Read(NodeWalker(node), OpenApiVersion::V3_1);
    resolveAllRefs(doc);
    return doc;
}

SchemaPtr responseSchema(const Document& doc, const string& path = "/items")
{
    return doc.paths.at(path).operations.at("get").responses.at("200")->content.at("application/json").schema;
}

vector<string> names(const auto& map)
{
    vector<string> result;
    for (const auto& [name, _] : map)
        result.push_back(name);
    return result;
}

}

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
        // A plain fragment file doesn't bring its own authorization.
        REQUIRE_FALSE(op.security.has_value());
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
        auto schema = doc.paths.at("/recursive")
                          .operations.at("get")
                          .responses.at("200")
                          ->content.at("application/json")
                          .schema;
        REQUIRE(schema->type == vector<string> { "object" });
        REQUIRE(schema->properties.at("children")->items->ref == "#/components/schemas/node");
    }
}

TEST_CASE("An unresolvable $ref fails the read", "[external_ref]")
{
    SpecDir dir;
    dir.add("parts/lib.yaml", R"(components:
  schemas:
    Item: {type: object}
    Broken:
      type: object
      properties:
        other: {$ref: '#/components/schemas/Missing'}
)");
    dir.add("secret.yaml", "x: {type: string}\n");

    auto failure = [&](const string& specPath, const string& ref) {
        dir.add(specPath, specReturning(ref));
        try {
            readSpecFile(dir.path(specPath));
        } catch (const exception& e) {
            return string(e.what());
        }
        return string();
    };

    SECTION("Missing file - the error names the $ref, where it is written and why")
    {
        auto error = failure("main.yaml", "parts/nope.yaml#/components/schemas/Item");
        REQUIRE_THAT(error, ContainsSubstring("parts/nope.yaml#/components/schemas/Item"));
        REQUIRE_THAT(error, ContainsSubstring(dir.path("main.yaml")));
        REQUIRE_THAT(error, ContainsSubstring("#/paths/~1items/get/responses/200/content/application~1json/schema"));
        REQUIRE_THAT(error, ContainsSubstring("file not found"));
    }

    SECTION("Missing fragment")
    {
        auto error = failure("main.yaml", "parts/lib.yaml#/components/schemas/Nope");
        REQUIRE_THAT(error, ContainsSubstring("parts/lib.yaml#/components/schemas/Nope"));
        REQUIRE_THAT(error, ContainsSubstring("fragment \"/components/schemas/Nope\" not found"));
    }

    SECTION("Missing fragment of a local ref inside an external file")
    {
        auto error = failure("main.yaml", "parts/lib.yaml#/components/schemas/Broken");
        REQUIRE_THAT(error, ContainsSubstring("#/components/schemas/Missing"));
        REQUIRE_THAT(error, ContainsSubstring(dir.path("parts/lib.yaml")));
        REQUIRE_THAT(error, ContainsSubstring("#/components/schemas/Broken/properties/other"));
    }

    SECTION("A file outside the ref root")
    {
        auto error = failure("sub/main.yaml", "../secret.yaml#/x");
        REQUIRE_THAT(error, ContainsSubstring("outside the ref root"));
    }

    SECTION("A symlink leading outside the ref root")
    {
        filesystem::create_directories(dir.path("sub"));
        filesystem::create_symlink(dir.path("secret.yaml"), dir.path("sub/link.yaml"));
        REQUIRE_THAT(failure("sub/main.yaml", "link.yaml#/x"), ContainsSubstring("outside the ref root"));
    }

    SECTION("A remote ref")
    {
        auto error = failure("main.yaml", "https://example.com/spec.yaml#/x");
        REQUIRE_THAT(error, ContainsSubstring("remote references are not supported"));
    }

    SECTION("A cycle of files that can only be inlined")
    {
        dir.add("a.yaml", "type: array\nitems: {$ref: 'b.yaml'}\n");
        dir.add("b.yaml", "type: array\nitems: {$ref: 'a.yaml'}\n");
        REQUIRE_THAT(failure("main.yaml", "a.yaml"), ContainsSubstring("cyclic $ref"));
    }

    SECTION("A cycle of aliases")
    {
        dir.add("a.yaml", "components: {schemas: {A: {$ref: 'b.yaml#/components/schemas/A'}}}\n");
        dir.add("b.yaml", "components: {schemas: {A: {$ref: 'a.yaml#/components/schemas/A'}}}\n");
        REQUIRE_THAT(failure("main.yaml", "a.yaml#/components/schemas/A"), ContainsSubstring("cyclic $ref"));
    }
}

TEST_CASE("The ref root bounds which files $refs can reach", "[external_ref]")
{
    SpecDir dir;
    dir.add("parts/lib.yaml", "components: {schemas: {Item: {type: object}}}\n");
    dir.add("sub/main.yaml", specReturning("../parts/lib.yaml#/components/schemas/Item"));

    REQUIRE_THROWS_MATCHES(readSpecFile(dir.path("sub/main.yaml")), runtime_error,
                           MessageMatches(ContainsSubstring("outside the ref root")));

    auto doc = read(readSpecFile(dir.path("sub/main.yaml"), dir.path()));
    REQUIRE(responseSchema(doc) == doc.components.schemas.at("Item"));

    // A trailing slash changes nothing.
    REQUIRE_NOTHROW(readSpecFile(dir.path("sub/main.yaml"), dir.path() + "/"));

    REQUIRE_THROWS_MATCHES(readSpecFile(dir.path("sub/main.yaml"), dir.path("parts")), runtime_error,
                           MessageMatches(ContainsSubstring("is outside the ref root")));
    REQUIRE_THROWS_MATCHES(readSpecFile(dir.path("sub/main.yaml"), dir.path("nope")), runtime_error,
                           MessageMatches(ContainsSubstring("is not a directory")));
}

TEST_CASE("Components of other files go to the same section", "[external_ref]")
{
    SpecDir dir;
    dir.add("parts/lib.yaml", R"(openapi: 3.1.0
info: {title: lib, version: 1.0.0}
paths:
  /other:
    get:
      responses:
        '200': {$ref: '#/components/responses/Unused'}
components:
  parameters:
    ItemID: {name: id, in: path, required: true, schema: {type: string}}
    Limit: {name: limit, in: query, schema: {$ref: '#/components/schemas/Limit'}}
  responses:
    Unused: {description: unused}
    Item:
      description: one item
      headers:
        X-Rate: {$ref: '#/components/headers/Rate'}
      content:
        application/json:
          schema: {$ref: '#/components/schemas/Item'}
  headers:
    Rate: {schema: {type: integer}}
  schemas:
    Item: {type: object, properties: {name: {type: string}}}
    Limit: {type: integer}
    Unused: {type: string}
)");

    SECTION("Only what the selected component reaches is copied")
    {
        dir.add("main.yaml", specReturning("parts/lib.yaml#/components/schemas/Item"));
        auto doc = read(readSpecFile(dir.path("main.yaml")));
        REQUIRE(names(doc.components.schemas) == vector<string> { "Item" });
        REQUIRE(doc.components.parameters.empty());
        REQUIRE(doc.components.responses.empty());
        REQUIRE(responseSchema(doc) == doc.components.schemas.at("Item"));
    }

    SECTION("Each kind of component keeps its section, with what it refers to")
    {
        dir.add("main.yaml", spec(R"(paths:
  /items:
    get:
      parameters:
        - {$ref: 'parts/lib.yaml#/components/parameters/Limit'}
      responses:
        '200': {$ref: 'parts/lib.yaml#/components/responses/Item'}
)"));
        auto node = readSpecFile(dir.path("main.yaml"));
        REQUIRE(node.get<Node::Map>()
                    .at("paths")
                    .get<Node::Map>()
                    .at("/items")
                    .get<Node::Map>()
                    .at("get")
                    .get<Node::Map>()
                    .at("responses")
                    .get<Node::Map>()
                    .at("200")
                == Node { Node::Map { { "$ref", Node { string("#/components/responses/Item") } } } });
        auto doc = read(node);
        REQUIRE(names(doc.components.schemas) == vector<string> { "Item", "Limit" });
        REQUIRE(names(doc.components.parameters) == vector<string> { "Limit" });
        REQUIRE(names(doc.components.responses) == vector<string> { "Item" });
        REQUIRE(names(doc.components.headers) == vector<string> { "Rate" });
    }

    SECTION("A ref in the root's own component slot defines that component, whatever refers to it first")
    {
        dir.add("pet.yaml", "type: object\nproperties:\n  parent: {$ref: 'pet.yaml'}\n");
        dir.add("main.yaml", spec(R"(paths:
  /items:
    get:
      parameters:
        - {$ref: 'parts/lib.yaml#/components/parameters/Limit'}
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema: {$ref: 'pet.yaml'}
components:
  schemas:
    Pet: {$ref: 'pet.yaml'}
    PageSize: {$ref: 'parts/lib.yaml#/components/schemas/Limit'}
)"));
        auto doc = read(readSpecFile(dir.path("main.yaml")));
        REQUIRE(names(doc.components.schemas) == vector<string> { "PageSize", "Pet" });
        auto pet = doc.components.schemas.at("Pet");
        REQUIRE(responseSchema(doc) == pet);
        REQUIRE(pet->properties.at("parent") == pet);
        REQUIRE(doc.components.parameters.at("Limit")->schema == doc.components.schemas.at("PageSize"));
    }

    SECTION("A ref back into the root spec stays a local ref")
    {
        dir.add("back.yaml", "type: object\nproperties:\n  own: {$ref: 'main.yaml#/components/schemas/Own'}\n");
        dir.add("main.yaml", specReturning("back.yaml") + "components:\n  schemas:\n    Own: {type: string}\n");
        auto doc = read(readSpecFile(dir.path("main.yaml")));
        REQUIRE(names(doc.components.schemas) == vector<string> { "Own" });
        REQUIRE(responseSchema(doc)->properties.at("own") == doc.components.schemas.at("Own"));
    }

    SECTION("Discriminator mapping targets are refs too")
    {
        dir.add("pets.yaml", R"(components:
  schemas:
    Pet:
      type: object
      required: [kind]
      properties: {kind: {type: string}}
      discriminator:
        propertyName: kind
        mapping:
          cat: '#/components/schemas/Cat'
          dog: Dog
          fish: './fish.yaml'
    Cat: {type: object}
    Dog: {type: object}
)");
        dir.add("fish.yaml", "type: object\n");
        dir.add("main.yaml", specReturning("pets.yaml#/components/schemas/Pet"));
        auto doc = read(readSpecFile(dir.path("main.yaml")));
        REQUIRE(names(doc.components.schemas) == vector<string> { "Cat", "Dog", "Pet", "fish" });
        const auto& mapping = doc.components.schemas.at("Pet")->discriminator->mapping;
        REQUIRE(mapping.at("cat") == "#/components/schemas/Cat");
        REQUIRE(mapping.at("dog") == "#/components/schemas/Dog");
        REQUIRE(mapping.at("fish") == "#/components/schemas/fish");
    }

    SECTION("definitions of a plain JSON Schema file are schemas")
    {
        dir.add("defs.json", R"({"definitions": {"Id": {"type": "string"}}})");
        dir.add("main.yaml", specReturning("defs.json#/definitions/Id"));
        auto doc = read(readSpecFile(dir.path("main.yaml")));
        REQUIRE(responseSchema(doc) == doc.components.schemas.at("Id"));
    }

    SECTION("A Swagger 2.0 spec gets them in its own sections")
    {
        dir.add("lib2.yaml", "definitions: {Item: {type: object}}\n");
        dir.add("main.yaml", R"(swagger: '2.0'
info: {title: t, version: 1.0.0}
paths:
  /items:
    get:
      responses:
        '200': {description: ok, schema: {$ref: 'lib2.yaml#/definitions/Item'}}
)");
        auto node = readSpecFile(dir.path("main.yaml"));
        REQUIRE(node.get<Node::Map>().at("definitions").get<Node::Map>().contains("Item"));
        REQUIRE_NOTHROW(V2::Read(NodeWalker(node)));
    }
}

TEST_CASE("Components with the same name from different files", "[external_ref]")
{
    SpecDir dir;
    // Self-referential, so that equality has to cope with recursion.
    const string item = R"(components:
  schemas:
    Item:
      type: object
      properties:
        next: {$ref: '#/components/schemas/Item'}
)";
    dir.add("lib.yaml", item);
    dir.add("lib2.yaml", item);
    dir.add("lib3.yaml", "components: {schemas: {Item: {type: string}}}\n");
    dir.add("reexport.yaml", "components: {schemas: {Item: {$ref: 'lib.yaml#/components/schemas/Item'}}}\n");

    auto twoRefs = [&](const string& first, const string& second) {
        dir.add("main.yaml",
                spec(format(R"(paths:
  /items:
    get:
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema: {{$ref: '{}'}}
    post:
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema: {{$ref: '{}'}}
)",
                            first, second)));
        return dir.path("main.yaml");
    };

    SECTION("Identical content is one component")
    {
        auto doc
            = read(readSpecFile(twoRefs("lib.yaml#/components/schemas/Item", "lib2.yaml#/components/schemas/Item")));
        REQUIRE(names(doc.components.schemas) == vector<string> { "Item" });
    }

    SECTION("A re-export is the component it re-exports")
    {
        auto doc = read(
            readSpecFile(twoRefs("reexport.yaml#/components/schemas/Item", "lib.yaml#/components/schemas/Item")));
        REQUIRE(names(doc.components.schemas) == vector<string> { "Item" });
        REQUIRE(doc.components.schemas.at("Item")->type == vector<string> { "object" });
    }

    SECTION("Different content is an error naming both sources")
    {
        auto path = twoRefs("lib.yaml#/components/schemas/Item", "lib3.yaml#/components/schemas/Item");
        REQUIRE_THROWS_MATCHES(readSpecFile(path), runtime_error,
                               MessageMatches(ContainsSubstring("lib.yaml#/components/schemas/Item")
                                              && ContainsSubstring("lib3.yaml#/components/schemas/Item")));
    }

    SECTION("So is a clash with the root spec's own component")
    {
        dir.add("main.yaml",
                specReturning("lib3.yaml#/components/schemas/Item")
                    + "components:\n  schemas:\n    Item: {type: integer}\n");
        REQUIRE_THROWS_MATCHES(readSpecFile(dir.path("main.yaml")), runtime_error,
                               MessageMatches(ContainsSubstring("main.yaml#/components/schemas/Item")
                                              && ContainsSubstring("lib3.yaml#/components/schemas/Item")));
    }
}

TEST_CASE("Path items of other files", "[external_ref]")
{
    SpecDir dir;
    dir.add("parts/lib.yaml", R"(openapi: 3.1.0
info: {title: lib, version: 1.0.0}
security: [{bearerAuth: []}]
tags:
  - {name: items, description: Items of the library}
  - {name: unused, description: Not carried over}
paths:
  /items:
    parameters:
      - {$ref: '#/components/parameters/Trace'}
    get:
      operationId: listItems
      tags: [items]
      responses:
        '200': {description: ok}
    post:
      operationId: createItem
      tags: [items]
      security: [{apiKey: []}]
      responses:
        '200': {description: ok}
  /shared: {$ref: '#/components/pathItems/Shared'}
components:
  parameters:
    Trace: {name: X-Trace, in: header, schema: {type: string}}
  pathItems:
    Shared:
      get:
        operationId: getShared
        responses:
          '200': {description: ok}
  securitySchemes:
    bearerAuth: {type: http, scheme: bearer}
    apiKey: {type: apiKey, in: header, name: X-Key}
    unused: {type: http, scheme: basic}
)");
    dir.add("parts/open.yaml", R"(openapi: 3.1.0
info: {title: open, version: 1.0.0}
paths:
  /ping:
    get:
      operationId: ping
      responses:
        '200': {description: ok}
)");

    SECTION("Operations, path parameters, authorization and tag descriptions are carried over")
    {
        dir.add("main.yaml", spec(R"(security: [{rootAuth: []}]
paths:
  /items: {$ref: 'parts/lib.yaml#/paths/~1items'}
  /ping: {$ref: 'parts/open.yaml#/paths/~1ping'}
components:
  securitySchemes:
    rootAuth: {type: http, scheme: basic}
)"));
        auto doc = read(readSpecFile(dir.path("main.yaml")));
        const auto& items = doc.paths.at("/items");
        REQUIRE(items.operations.at("get").operationId == "listItems");
        REQUIRE(items.parameters.at(0)->name == "X-Trace");
        REQUIRE(names(items.operations.at("get").security->at(0)) == vector<string> { "bearerAuth" });
        REQUIRE(names(items.operations.at("post").security->at(0)) == vector<string> { "apiKey" });
        // The library declares no security for it, so the root's mustn't apply.
        const auto& ping = doc.paths.at("/ping").operations.at("get");
        REQUIRE(ping.security.has_value());
        REQUIRE(ping.security->empty());
        REQUIRE(names(doc.components.securitySchemes) == vector<string> { "apiKey", "bearerAuth", "rootAuth" });
        REQUIRE(doc.tags.size() == 1);
        REQUIRE(doc.tags[0].name == "items");
        REQUIRE(doc.tags[0].description == "Items of the library");
    }

    SECTION("A local ref to a shared path item inside the other file")
    {
        dir.add("main.yaml", spec("paths:\n  /shared: {$ref: 'parts/lib.yaml#/paths/~1shared'}\n"));
        auto doc = read(readSpecFile(dir.path("main.yaml")));
        const auto& op = doc.paths.at("/shared").operations.at("get");
        REQUIRE(op.operationId == "getShared");
        REQUIRE(names(op.security->at(0)) == vector<string> { "bearerAuth" });
    }

    SECTION("components.pathItems, referenced directly or through the root's own components")
    {
        dir.add("main.yaml", spec(R"(paths:
  /direct: {$ref: 'parts/lib.yaml#/components/pathItems/Shared'}
  /local: {$ref: '#/components/pathItems/Local', summary: Extra}
components:
  pathItems:
    Local: {$ref: 'parts/lib.yaml#/components/pathItems/Shared'}
)"));
        auto doc = read(readSpecFile(dir.path("main.yaml")));
        REQUIRE(doc.paths.at("/direct").operations.at("get").operationId == "getShared");
        REQUIRE(doc.paths.at("/local").operations.at("get").operationId == "getShared");
        REQUIRE(doc.paths.at("/local").summary == "Extra");
    }

    SECTION("An operation taken on its own keeps its authorization as well")
    {
        dir.add("main.yaml", spec("paths:\n  /one:\n    get: {$ref: 'parts/lib.yaml#/paths/~1items/get'}\n"));
        auto doc = read(readSpecFile(dir.path("main.yaml")));
        REQUIRE(names(doc.paths.at("/one").operations.at("get").security->at(0)) == vector<string> { "bearerAuth" });
    }

    SECTION("A security scheme clashing with the root's is an error")
    {
        dir.add("main.yaml", spec(R"(paths:
  /items: {$ref: 'parts/lib.yaml#/paths/~1items'}
components:
  securitySchemes:
    bearerAuth: {type: http, scheme: basic}
)"));
        REQUIRE_THROWS_MATCHES(readSpecFile(dir.path("main.yaml")), runtime_error,
                               MessageMatches(ContainsSubstring("securitySchemes/bearerAuth")));
    }
}
