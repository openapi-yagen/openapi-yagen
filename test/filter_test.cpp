// clazy:excludeall=non-pod-global-static

#include <catch2/catch_all.hpp>

#include <algorithm>

#include <lib/common/node_walker.h>
#include <lib/common/yaml_or_json_parser.h>
#include <lib/openapi/document.h>
#include <lib/openapi/filter.h>
#include <lib/openapi/resolve.h>
#include <lib/openapi/schema.h>
#include <lib/openapi/v3/reader.h>
#include <lib/openapi/version.h>

using namespace std;
using namespace OpenApi;

namespace {
// Same helper as test/openapi_test.cpp's parseDoc() - injects a minimal "openapi"/"info" if the
// fixture doesn't already declare one - but also hands back the raw parsed Node alongside the
// typed Document, since filterByTags() needs to prune both in lockstep (see filter.h).
struct Parsed {
    Document doc;
    Node node;
};

Parsed parse(const string& content)
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
    Node fullNode { m };
    auto doc = V3::Read(NodeWalker(fullNode), OpenApiVersion::V3_0);
    return { doc, fullNode };
}

// True if raw `node` has a Map value with (nested, dot-separated) `path` leading to a Map/Vec that
// contains `key` - used to check that filterByTags() pruned the raw spec tree, not just `doc`.
bool rawMapContains(const Node& node, const vector<string>& path, const string& key)
{
    const Node* cur = &node;
    for (const auto& segment : path) {
        auto m = cur->getIf<Node::Map>();
        if (!m)
            return false;
        auto it = m->find(segment);
        if (it == m->end())
            return false;
        cur = &it->second;
    }
    auto m = cur->getIf<Node::Map>();
    return m && m->contains(key);
}
}

TEST_CASE("filterByTags: no-op when tags is empty", "[filter]")
{
    auto [doc, node] = parse(R"(
tags:
  - name: pets
paths:
  /pets:
    get:
      operationId: listPets
      tags: [pets]
      responses:
        "200": { description: ok }
components:
  schemas:
    Pet:
      type: object
)");
    resolveAllRefs(doc);
    filterByTags(doc, node, {});
    REQUIRE(doc.paths.size() == 1);
    REQUIRE(doc.components.schemas.size() == 1);
    REQUIRE(doc.tags.size() == 1);
    REQUIRE(rawMapContains(node, {}, "paths"));
    REQUIRE(rawMapContains(node, { "paths" }, "/pets"));
}

TEST_CASE("filterByTags: keeps only operations matching a requested tag", "[filter]")
{
    auto [doc, node] = parse(R"(
paths:
  /pets:
    get:
      operationId: listPets
      tags: [pets]
      responses:
        "200": { description: ok }
  /orders:
    get:
      operationId: listOrders
      tags: [orders]
      responses:
        "200": { description: ok }
)");
    resolveAllRefs(doc);
    filterByTags(doc, node, { "pets" });

    REQUIRE(doc.paths.size() == 1);
    REQUIRE(doc.paths.contains("/pets"));
    REQUIRE(doc.paths.at("/pets").operations.contains("get"));

    auto ops = collectOperations(doc);
    REQUIRE(ops.size() == 1);
    REQUIRE(ops[0].operationId == "listPets");

    // The raw spec tree (what the JS bridge clones as the `schema` global's base object) must be
    // pruned too, or the filtered-out path would still leak into JS as unprocessed raw JSON.
    REQUIRE(rawMapContains(node, { "paths" }, "/pets"));
    REQUIRE_FALSE(rawMapContains(node, { "paths" }, "/orders"));
}

TEST_CASE("filterByTags: operation with multiple tags matches if any is requested", "[filter]")
{
    auto [doc, node] = parse(R"(
paths:
  /pets:
    get:
      operationId: listPets
      tags: [pets, animals]
      responses:
        "200": { description: ok }
)");
    resolveAllRefs(doc);
    filterByTags(doc, node, { "animals" });
    REQUIRE(doc.paths.size() == 1);
}

TEST_CASE("filterByTags: untagged operation is dropped once a filter is active", "[filter]")
{
    auto [doc, node] = parse(R"(
paths:
  /pets:
    get:
      operationId: listPets
      tags: [pets]
      responses:
        "200": { description: ok }
  /misc:
    get:
      operationId: untagged
      responses:
        "200": { description: ok }
)");
    resolveAllRefs(doc);
    filterByTags(doc, node, { "pets" });
    REQUIRE(doc.paths.size() == 1);
    REQUIRE(doc.paths.contains("/pets"));
}

TEST_CASE("filterByTags: a path left with zero operations is removed entirely", "[filter]")
{
    auto [doc, node] = parse(R"(
paths:
  /pets:
    get:
      operationId: listPets
      tags: [pets]
      responses:
        "200": { description: ok }
    post:
      operationId: createPet
      tags: [admin]
      responses:
        "201": { description: created }
)");
    resolveAllRefs(doc);
    filterByTags(doc, node, { "admin" });
    REQUIRE(doc.paths.size() == 1);
    REQUIRE(doc.paths.at("/pets").operations.size() == 1);
    REQUIRE(doc.paths.at("/pets").operations.contains("post"));
    // The raw path item survives (still has "post"), but its raw "get" key must be gone too.
    REQUIRE(rawMapContains(node, { "paths" }, "/pets"));
    REQUIRE(rawMapContains(node, { "paths", "/pets" }, "post"));
    REQUIRE_FALSE(rawMapContains(node, { "paths", "/pets" }, "get"));

    filterByTags(doc, node, { "nonexistent" });
    REQUIRE(doc.paths.empty());
    REQUIRE_FALSE(rawMapContains(node, { "paths" }, "/pets"));
}

TEST_CASE("filterByTags: prunes unreachable models, keeps transitively reachable ones", "[filter]")
{
    auto [doc, node] = parse(R"(
paths:
  /pets:
    get:
      operationId: listPets
      tags: [pets]
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Pets"
  /orders:
    get:
      operationId: listOrders
      tags: [orders]
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Order"
components:
  schemas:
    Pets:
      type: array
      items:
        $ref: "#/components/schemas/Pet"
    Pet:
      type: object
      properties:
        name: { type: string }
    Order:
      type: object
      properties:
        id: { type: integer }
)");
    resolveAllRefs(doc);
    filterByTags(doc, node, { "pets" });

    REQUIRE(doc.components.schemas.contains("Pets"));
    REQUIRE(doc.components.schemas.contains("Pet")); // reachable via Pets.items
    REQUIRE_FALSE(doc.components.schemas.contains("Order"));

    REQUIRE(rawMapContains(node, { "components", "schemas" }, "Pets"));
    REQUIRE(rawMapContains(node, { "components", "schemas" }, "Pet"));
    REQUIRE_FALSE(rawMapContains(node, { "components", "schemas" }, "Order"));
}

TEST_CASE("filterByTags: a model shared by a surviving and a filtered-out operation is kept", "[filter]")
{
    auto [doc, node] = parse(R"(
paths:
  /pets:
    get:
      operationId: listPets
      tags: [pets]
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Shared"
  /orders:
    get:
      operationId: listOrders
      tags: [orders]
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Shared"
components:
  schemas:
    Shared:
      type: object
)");
    resolveAllRefs(doc);
    filterByTags(doc, node, { "pets" });
    REQUIRE(doc.components.schemas.contains("Shared"));
    REQUIRE(rawMapContains(node, { "components", "schemas" }, "Shared"));
}

TEST_CASE("filterByTags: prunes unreachable named parameters/requestBodies/responses/headers", "[filter]")
{
    auto [doc, node] = parse(R"(
paths:
  /pets:
    get:
      operationId: listPets
      tags: [pets]
      parameters:
        - $ref: "#/components/parameters/PetsLimit"
      responses:
        "200":
          $ref: "#/components/responses/PetsOk"
  /orders:
    post:
      operationId: createOrder
      tags: [orders]
      requestBody:
        $ref: "#/components/requestBodies/OrderBody"
      responses:
        "201":
          description: created
components:
  parameters:
    PetsLimit:
      name: limit
      in: query
      schema: { type: integer }
  requestBodies:
    OrderBody:
      content:
        application/json:
          schema: { type: object }
  headers:
    XNext:
      description: next page link
      schema: { type: string }
  responses:
    PetsOk:
      description: ok
      headers:
        x-next:
          $ref: "#/components/headers/XNext"
)");
    resolveAllRefs(doc);
    filterByTags(doc, node, { "pets" });

    REQUIRE(doc.components.parameters.contains("PetsLimit"));
    REQUIRE(doc.components.responses.contains("PetsOk"));
    REQUIRE(doc.components.headers.contains("XNext"));
    REQUIRE_FALSE(doc.components.requestBodies.contains("OrderBody"));

    REQUIRE(rawMapContains(node, { "components", "parameters" }, "PetsLimit"));
    REQUIRE(rawMapContains(node, { "components", "responses" }, "PetsOk"));
    REQUIRE(rawMapContains(node, { "components", "headers" }, "XNext"));
    REQUIRE_FALSE(rawMapContains(node, { "components", "requestBodies" }, "OrderBody"));
}

TEST_CASE("filterByTags: trims doc.tags to the requested tag names", "[filter]")
{
    auto [doc, node] = parse(R"(
tags:
  - name: pets
    description: Pet operations
  - name: orders
    description: Order operations
paths:
  /pets:
    get:
      operationId: listPets
      tags: [pets]
      responses:
        "200": { description: ok }
  /orders:
    get:
      operationId: listOrders
      tags: [orders]
      responses:
        "200": { description: ok }
)");
    resolveAllRefs(doc);
    filterByTags(doc, node, { "pets" });
    REQUIRE(doc.tags.size() == 1);
    REQUIRE(doc.tags[0].name == "pets");

    auto rawTags = node.get<Node::Map>().at("tags").get<Node::Vec>();
    REQUIRE(rawTags.size() == 1);
    REQUIRE(rawTags[0].get<Node::Map>().at("name").get<Node::String>() == "pets");
}
