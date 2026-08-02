// clazy:excludeall=non-pod-global-static

#include <catch2/catch_all.hpp>

#include <lib/common/node_walker.h>
#include <lib/common/yaml_or_json_parser.h>
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
