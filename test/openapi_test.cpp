// clazy:excludeall=non-pod-global-static

#include <catch2/catch_all.hpp>

#include <algorithm>

#include <lib/common/node_walker.h>
#include <lib/common/yaml_or_json_parser.h>
#include <lib/openapi/document.h>
#include <lib/openapi/schema.h>

#include "common/tools.h"

using namespace std;
using namespace OpenApi;

namespace {
Document parseDoc(const string& content)
{
    auto node = parseYamlOrJsonToNode(content);
    return parseDocument(NodeWalker(node));
}
}

TEST_CASE("Parse OpenAPI schemas", "[openapi]")
{
    auto doc = parseDoc(readResource("petstore.yaml"));
    const auto& schemas = doc.components.schemas;

    SECTION("Object schema with required properties")
    {
        auto pet = schemas.at("Pet");
        REQUIRE(pet->ref == nullopt);
        REQUIRE(pet->type == "object");
        REQUIRE(pet->required == vector<string> { "id", "name" });
        REQUIRE(pet->properties.size() == 3);
        REQUIRE(pet->properties.at("id")->type == "integer");
        REQUIRE(pet->properties.at("id")->format == "int64");
        REQUIRE(pet->properties.at("name")->type == "string");
    }

    SECTION("Array schema with $ref items and constraints")
    {
        auto pets = schemas.at("Pets");
        REQUIRE(pets->type == "array");
        REQUIRE(pets->maxItems == 100);
        REQUIRE(pets->items != nullptr);
        REQUIRE(pets->items->ref == "#/components/schemas/Pet");
    }

    SECTION("$ref-only schema has no other fields populated")
    {
        auto petsItems = schemas.at("Pets")->items;
        REQUIRE(petsItems->ref == "#/components/schemas/Pet");
        REQUIRE(petsItems->type == nullopt);
        REQUIRE(petsItems->properties.empty());
    }

    SECTION("deref resolves a $ref schema")
    {
        auto petsItems = schemas.at("Pets")->items;
        auto resolved = deref(schemas, petsItems);
        REQUIRE(resolved == schemas.at("Pet"));
        REQUIRE(resolved->type == "object");
    }

    SECTION("deref is a no-op on a non-$ref schema")
    {
        auto pet = schemas.at("Pet");
        REQUIRE(deref(schemas, pet) == pet);
    }

    SECTION("resolveSchemaRef throws on unsupported ref target")
    {
        REQUIRE_THROWS(resolveSchemaRef(schemas, "#/components/parameters/Foo"));
        REQUIRE_THROWS(resolveSchemaRef(schemas, "other.yaml#/components/schemas/Pet"));
    }

    SECTION("resolveSchemaRef throws on missing schema")
    {
        REQUIRE_THROWS(resolveSchemaRef(schemas, "#/components/schemas/Nope"));
    }
}

TEST_CASE("Detect cyclic $ref", "[openapi]")
{
    auto doc = parseDoc(R"(
components:
  schemas:
    A:
      $ref: "#/components/schemas/B"
    B:
      $ref: "#/components/schemas/A"
)");
    REQUIRE_THROWS(deref(doc.components.schemas, doc.components.schemas.at("A")));
}

TEST_CASE("Parse OpenAPI schema edge cases", "[openapi]")
{
    SECTION("enum")
    {
        auto doc = parseDoc(R"(
components:
  schemas:
    Status:
      type: string
      enum: [available, pending, sold]
)");
        auto status = doc.components.schemas.at("Status");
        REQUIRE(status->enumValues.size() == 3);
        REQUIRE(status->enumValues[0].get<Node::String>() == "available");
    }

    SECTION("allOf")
    {
        auto doc = parseDoc(R"(
components:
  schemas:
    Base:
      type: object
      properties:
        id:
          type: integer
    Extended:
      allOf:
        - $ref: "#/components/schemas/Base"
        - type: object
          properties:
            name:
              type: string
)");
        auto extended = doc.components.schemas.at("Extended");
        REQUIRE(extended->allOf.size() == 2);
        REQUIRE(extended->allOf[0]->ref == "#/components/schemas/Base");
        REQUIRE(extended->allOf[1]->properties.at("name")->type == "string");
    }

    SECTION("discriminated oneOf")
    {
        auto doc = parseDoc(R"(
components:
  schemas:
    Pet:
      oneOf:
        - $ref: "#/components/schemas/Cat"
        - $ref: "#/components/schemas/Dog"
      discriminator:
        propertyName: petType
        mapping:
          cat: "#/components/schemas/Cat"
          dog: "#/components/schemas/Dog"
    Cat:
      type: object
    Dog:
      type: object
)");
        auto pet = doc.components.schemas.at("Pet");
        REQUIRE(pet->oneOf.size() == 2);
        REQUIRE(pet->discriminator.has_value());
        REQUIRE(pet->discriminator->propertyName == "petType");
        REQUIRE(pet->discriminator->mapping.at("cat") == "#/components/schemas/Cat");
    }

    SECTION("additionalProperties as bool and as schema")
    {
        auto doc = parseDoc(R"(
components:
  schemas:
    FreeForm:
      type: object
      additionalProperties: true
    MapOfInts:
      type: object
      additionalProperties:
        type: integer
)");
        auto freeForm = doc.components.schemas.at("FreeForm");
        REQUIRE(freeForm->additionalPropertiesBool == true);
        REQUIRE(freeForm->additionalPropertiesSchema == nullptr);

        auto mapOfInts = doc.components.schemas.at("MapOfInts");
        REQUIRE(mapOfInts->additionalPropertiesBool == nullopt);
        REQUIRE(mapOfInts->additionalPropertiesSchema != nullptr);
        REQUIRE(mapOfInts->additionalPropertiesSchema->type == "integer");
    }

    SECTION("constraints")
    {
        auto doc = parseDoc(R"(
components:
  schemas:
    Constrained:
      type: string
      minLength: 1
      maxLength: 50
      pattern: "^[a-z]+$"
)");
        auto s = doc.components.schemas.at("Constrained");
        REQUIRE(s->minLength == 1);
        REQUIRE(s->maxLength == 50);
        REQUIRE(s->pattern == "^[a-z]+$");
    }
}

TEST_CASE("Collect operations", "[openapi]")
{
    auto doc = parseDoc(readResource("petstore.yaml"));
    auto ops = collectOperations(doc);
    REQUIRE(ops.size() == 3);

    auto listPets = find_if(ops.begin(), ops.end(),
                            [](const auto& op) { return op.operationId && *op.operationId == "listPets"; });
    REQUIRE(listPets != ops.end());
    REQUIRE(listPets->method == "get");
    REQUIRE(listPets->path == "/pets");
    REQUIRE(listPets->tags == vector<string> { "pets" });
    REQUIRE(listPets->parameters.size() == 1);
    REQUIRE(listPets->parameters[0]->name == "limit");
    REQUIRE(listPets->parameters[0]->in == "query");
    REQUIRE(listPets->parameters[0]->required == false);
    REQUIRE(listPets->requestBody == nullptr);
    REQUIRE(listPets->responses.contains("200"));
    REQUIRE(listPets->responses.contains("default"));
    REQUIRE(listPets->responses.at("200")->content.at("application/json").schema->ref == "#/components/schemas/Pets");

    auto createPets = find_if(ops.begin(), ops.end(),
                              [](const auto& op) { return op.operationId && *op.operationId == "createPets"; });
    REQUIRE(createPets != ops.end());
    REQUIRE(createPets->requestBody != nullptr);
    REQUIRE(createPets->requestBody->required == true);
    REQUIRE(createPets->requestBody->content.at("application/json").schema->ref == "#/components/schemas/Pet");

    auto showPetById = find_if(ops.begin(), ops.end(),
                               [](const auto& op) { return op.operationId && *op.operationId == "showPetById"; });
    REQUIRE(showPetById != ops.end());
    REQUIRE(showPetById->parameters.size() == 1);
    REQUIRE(showPetById->parameters[0]->name == "petId");
    REQUIRE(showPetById->parameters[0]->in == "path");
    REQUIRE(showPetById->parameters[0]->required == true);
}

TEST_CASE("Merge path-level and operation-level parameters", "[openapi]")
{
    auto doc = parseDoc(R"(
paths:
  /items/{id}:
    parameters:
      - name: id
        in: path
        required: true
        description: from path item
        schema: { type: string }
      - name: verbose
        in: query
        schema: { type: boolean }
    get:
      operationId: getItem
      parameters:
        - name: id
          in: path
          required: true
          description: overridden by operation
          schema: { type: string }
)");
    auto ops = collectOperations(doc);
    REQUIRE(ops.size() == 1);
    const auto& op = ops[0];
    // Same count as declared (path-level "id" is overridden in place, not duplicated), operation
    // order preserved: "id" (path-level position), then "verbose".
    REQUIRE(op.parameters.size() == 2);
    REQUIRE(op.parameters[0]->name == "id");
    REQUIRE(op.parameters[0]->description == "overridden by operation");
    REQUIRE(op.parameters[1]->name == "verbose");
}

TEST_CASE("Deref parameter/requestBody/response components", "[openapi]")
{
    auto doc = parseDoc(R"(
paths:
  /items:
    get:
      operationId: listItems
      parameters:
        - $ref: "#/components/parameters/Limit"
      responses:
        "200":
          $ref: "#/components/responses/Ok"
    post:
      operationId: createItem
      requestBody:
        $ref: "#/components/requestBodies/ItemBody"
      responses:
        "201":
          description: created
components:
  parameters:
    Limit:
      name: limit
      in: query
      schema: { type: integer }
  requestBodies:
    ItemBody:
      required: true
      content:
        application/json:
          schema:
            type: object
  responses:
    Ok:
      description: OK response
)");
    auto ops = collectOperations(doc);

    auto listItems = find_if(ops.begin(), ops.end(),
                             [](const auto& op) { return op.operationId && *op.operationId == "listItems"; });
    REQUIRE(listItems != ops.end());
    REQUIRE(listItems->parameters.size() == 1);
    REQUIRE(listItems->parameters[0]->ref == nullopt);
    REQUIRE(listItems->parameters[0]->name == "limit");
    REQUIRE(listItems->responses.at("200")->ref == nullopt);
    REQUIRE(listItems->responses.at("200")->description == "OK response");

    auto createItem = find_if(ops.begin(), ops.end(),
                              [](const auto& op) { return op.operationId && *op.operationId == "createItem"; });
    REQUIRE(createItem != ops.end());
    REQUIRE(createItem->requestBody->ref == nullopt);
    REQUIRE(createItem->requestBody->required == true);
}
