// clazy:excludeall=non-pod-global-static

#include <catch2/catch_all.hpp>

#include <sstream>

#include <lib/filesystem/file_reader.h>
#include <lib/filesystem/file_writer.h>
#include <lib/generator/openapi_generator.h>
#include <lib/js/executor.h>
#include <lib/templates/template_renderer.h>

#include "common/tools.h"

using namespace std;
using namespace FS;

class MockedTemplateRenderer : public Templates::TemplateRenderer {
public:
    string render(const string& filePath, const Node& data, const Functions& funcs) override
    {
        stringstream ss;
        ss << "template=" << filePath << ", data=" << data;
        return ss.str();
    }
};

class MockedFileReaderBackend : public FileReaderBackend {
public:
    using Files = std::map<std::string, std::string>;
    MockedFileReaderBackend(const Files& files = { })
        : files(files)
    {
    }
    std::optional<string> read(const string& filePath) override
    {
        auto it = files.find(filePath);
        if (it != files.end())
            return it->second;
        else
            return nullopt;
    }

private:
    Files files;
};

class MockedFileWriter : public FileWriter {
public:
    void write(const string& fileName, const string& content) override { files[fileName] = content; }
    void clear() override { files.clear(); }

    std::map<std::string, std::string> files;
};

TEST_CASE("Generate", "[generator]")
{
    auto fileWriter = make_shared<MockedFileWriter>();
    auto templateRenderer = make_shared<MockedTemplateRenderer>();

    MockedFileReaderBackend::Files files = {
        { "main.js", "renderTemplate(\"test_template\", schema, \"outfile\")" },
        { "generator.yml", readResource("generator.yml") },
    };

    auto fileReader = make_shared<FileReader>(FileReader::Opts {
        .backends = { make_shared<MockedFileReaderBackend>(files) },
    });

    auto jsExecutor = make_shared<JS::Executor>(JS::Executor::Opts {
        .fileReader = fileReader,
    });

    Generator::OpenApiGenerator gen(Generator::OpenApiGenerator::Opts {
        .fileReader = fileReader,
        .fileWriter = fileWriter,
        .jsExecutor = jsExecutor,
        .templateRenderer = templateRenderer,
        .defaultMainSciptPath = "main.js",
        .metadataPath = "generator.yml",
        .vars = { "OPT1=true" },
    });

    gen.generate(getResourcePath("petstore.yaml"));

    // `schema` is now fully resolved: no $ref anywhere, and a $ref position (Pets.items) shows
    // Pet's actual content in place.
    REQUIRE_THAT(fileWriter->files["outfile"], !Catch::Matchers::ContainsSubstring("$ref"));
    REQUIRE_THAT(fileWriter->files["outfile"],
                 Catch::Matchers::ContainsSubstring(
                     "Pets={items={properties={id={format=int64,type=integer},name={type=string},tag={type=string}}"));
}

TEST_CASE("copyFile copies a static file verbatim without templating", "[generator]")
{
    auto fileWriter = make_shared<MockedFileWriter>();
    auto templateRenderer = make_shared<MockedTemplateRenderer>();

    MockedFileReaderBackend::Files files = {
        { "main.js", "copyFile(\"Validation.kt\", \"out/Validation.kt\")" },
        { "generator.yml", readResource("generator.yml") },
        { "Validation.kt", "fun requireMin(v: Int, min: Int, label: String) { /* {{ not a template }} */ }\n" },
    };

    auto fileReader = make_shared<FileReader>(FileReader::Opts {
        .backends = { make_shared<MockedFileReaderBackend>(files) },
    });
    auto jsExecutor = make_shared<JS::Executor>(JS::Executor::Opts { .fileReader = fileReader });
    Generator::OpenApiGenerator gen(Generator::OpenApiGenerator::Opts {
        .fileReader = fileReader,
        .fileWriter = fileWriter,
        .jsExecutor = jsExecutor,
        .templateRenderer = templateRenderer,
        .defaultMainSciptPath = "main.js",
        .metadataPath = "generator.yml",
        .vars = { },
    });

    gen.generate(getResourcePath("petstore.yaml"));

    REQUIRE(fileWriter->files["out/Validation.kt"]
            == "fun requireMin(v: Int, min: Int, label: String) { /* {{ not a template }} */ }\n");
}

TEST_CASE("Generate exposes kindOf/constraintsOf/nameOf/collectOperations", "[generator]")
{
    auto fileWriter = make_shared<MockedFileWriter>();
    auto templateRenderer = make_shared<MockedTemplateRenderer>();

    MockedFileReaderBackend::Files files = {
        { "main.js",
          "const pet = schema.components.schemas.Pet;\n"
          "const ops = collectOperations();\n"
          "const limitParam = ops[0].parameters[0];\n"
          "renderTemplate(\"test_template\", {\n"
          "  opsCount: ops.length,\n"
          "  firstOpMethod: ops[0].method,\n"
          "  petKind: kindOf(pet),\n"
          "  petsKind: kindOf(schema.components.schemas.Pets),\n"
          "  petName: nameOf(pet),\n"
          "  petsItemsName: nameOf(schema.components.schemas.Pets.items),\n"
          "  limitParamName: limitParam.name,\n"
          "  limitParamSchemaName: nameOf(limitParam.schema),\n"
          "  limitConstraints: constraintsOf(limitParam.schema),\n"
          "  firstOpSecurity: JSON.stringify(ops[0].security),\n"
          "}, \"outfile\")" },
        { "generator.yml", readResource("generator.yml") },
    };

    auto fileReader = make_shared<FileReader>(FileReader::Opts {
        .backends = { make_shared<MockedFileReaderBackend>(files) },
    });
    auto jsExecutor = make_shared<JS::Executor>(JS::Executor::Opts { .fileReader = fileReader });
    Generator::OpenApiGenerator gen(Generator::OpenApiGenerator::Opts {
        .fileReader = fileReader,
        .fileWriter = fileWriter,
        .jsExecutor = jsExecutor,
        .templateRenderer = templateRenderer,
        .defaultMainSciptPath = "main.js",
        .metadataPath = "generator.yml",
        .vars = { },
    });

    gen.generate(getResourcePath("petstore.yaml"));

    auto& out = fileWriter->files["outfile"];
    REQUIRE_THAT(out, Catch::Matchers::ContainsSubstring("opsCount=3"));
    REQUIRE_THAT(out, Catch::Matchers::ContainsSubstring("firstOpMethod=get"));
    REQUIRE_THAT(out, Catch::Matchers::ContainsSubstring("petKind=Object"));
    REQUIRE_THAT(out, Catch::Matchers::ContainsSubstring("petsKind=Array"));
    REQUIRE_THAT(out, Catch::Matchers::ContainsSubstring("petName=Pet"));
    REQUIRE_THAT(out, Catch::Matchers::ContainsSubstring("petsItemsName=Pet"));
    REQUIRE_THAT(out, Catch::Matchers::ContainsSubstring("limitParamName=limit"));
    REQUIRE_THAT(out, Catch::Matchers::ContainsSubstring("limitParamSchemaName=null"));
    REQUIRE_THAT(out, Catch::Matchers::ContainsSubstring("limitConstraints={maximum=100}"));
    // petstore.yaml declares no security anywhere - collectOperations() resolves the "inherits
    // the document default" fallback to an empty list rather than leaving it undefined.
    REQUIRE_THAT(out, Catch::Matchers::ContainsSubstring("firstOpSecurity=[]"));
}

TEST_CASE("Generate exposes flattenAllOf/resolveDiscriminator/firstSuccessResponse", "[generator]")
{
    auto fileWriter = make_shared<MockedFileWriter>();
    auto templateRenderer = make_shared<MockedTemplateRenderer>();

    MockedFileReaderBackend::Files files = {
        { "main.js", R"JS(
const schemas = schema.components.schemas;
const ops = collectOperations();
const listOp = ops.find((o) => o.operationId === "listWidgets");
const legacyOp = ops.find((o) => o.operationId === "legacyOnlyDefault");

const flat = flattenAllOf(schemas.Widget);
const shapeDisc = resolveDiscriminator(schemas.Shape);
const undispatchable = resolveDiscriminator(schemas.UndispatchableUnion);
const listResp = firstSuccessResponse(listOp.responses);
const legacyResp = firstSuccessResponse(legacyOp.responses);

renderTemplate("test_template", {
  flatPropertyNames: Object.keys(flat.properties).sort().join(","),
  flatRequired: flat.required.join(","),
  flatIdType: flat.properties.id.type,
  flatSpeciesType: flat.properties.species.type,
  flatPrimaryShapeIsCircle: flat.properties.primaryShape === schemas.Circle,
  flatPrimaryShapeName: nameOf(flat.properties.primaryShape),
  shapeDiscProperty: shapeDisc.property,
  shapeDiscVariantCount: shapeDisc.variants.length,
  shapeDiscCircleLiteral: shapeDisc.variants.find((v) => v.name === "Circle").literal,
  shapeDiscSquareLiteral: shapeDisc.variants.find((v) => v.name === "Square").literal,
  undispatchableIsNull: undispatchable === null,
  listRespStatusCode: listResp.statusCode,
  listRespItemsIsWidget: listResp.response.content["application/json"].schema.items === schemas.Widget,
  legacyRespStatusCode: legacyResp.statusCode,
}, "outfile");
)JS" },
        { "generator.yml", readResource("generator.yml") },
    };

    auto fileReader = make_shared<FileReader>(FileReader::Opts {
        .backends = { make_shared<MockedFileReaderBackend>(files) },
    });
    auto jsExecutor = make_shared<JS::Executor>(JS::Executor::Opts { .fileReader = fileReader });
    Generator::OpenApiGenerator gen(Generator::OpenApiGenerator::Opts {
        .fileReader = fileReader,
        .fileWriter = fileWriter,
        .jsExecutor = jsExecutor,
        .templateRenderer = templateRenderer,
        .defaultMainSciptPath = "main.js",
        .metadataPath = "generator.yml",
        .vars = { },
    });

    gen.generate(getResourcePath("allof_discriminator.yaml"));

    auto& out = fileWriter->files["outfile"];
    // flattenAllOf: recurses into a nested allOf branch (Base+WithSpecies) plus the outer branch's
    // own properties, merging everything into one flat {properties, required}.
    REQUIRE_THAT(out, Catch::Matchers::ContainsSubstring("flatPropertyNames=id,name,primaryShape,species"));
    REQUIRE_THAT(out, Catch::Matchers::ContainsSubstring("flatRequired=id,species,name,primaryShape"));
    REQUIRE_THAT(out, Catch::Matchers::ContainsSubstring("flatIdType=integer"));
    REQUIRE_THAT(out, Catch::Matchers::ContainsSubstring("flatSpeciesType=string"));
    // A merged-in property that's a $ref keeps its exact JS object identity - nameOf still works.
    REQUIRE_THAT(out, Catch::Matchers::ContainsSubstring("flatPrimaryShapeIsCircle=1"));
    REQUIRE_THAT(out, Catch::Matchers::ContainsSubstring("flatPrimaryShapeName=Circle"));

    // resolveDiscriminator: Circle's literal comes from the explicit mapping entry; Square has no
    // mapping entry, so its literal falls back to its own component name (spec default).
    REQUIRE_THAT(out, Catch::Matchers::ContainsSubstring("shapeDiscProperty=shapeType"));
    REQUIRE_THAT(out, Catch::Matchers::ContainsSubstring("shapeDiscVariantCount=2"));
    REQUIRE_THAT(out, Catch::Matchers::ContainsSubstring("shapeDiscCircleLiteral=circle"));
    REQUIRE_THAT(out, Catch::Matchers::ContainsSubstring("shapeDiscSquareLiteral=Square"));
    // No discriminator at all -> null, left for the caller to treat as an ordinary union.
    REQUIRE_THAT(out, Catch::Matchers::ContainsSubstring("undispatchableIsNull=1"));

    // firstSuccessResponse: picks the declared 2xx when present, falls back to "default" when a
    // response map has no 2xx at all - and the picked response's nested schema keeps its identity.
    REQUIRE_THAT(out, Catch::Matchers::ContainsSubstring("listRespStatusCode=200"));
    REQUIRE_THAT(out, Catch::Matchers::ContainsSubstring("listRespItemsIsWidget=1"));
    REQUIRE_THAT(out, Catch::Matchers::ContainsSubstring("legacyRespStatusCode=default"));
}

TEST_CASE("Generate validates the spec structurally while parsing (no external JSON-schema step anymore)", "[generator]")
{
    auto fileWriter = make_shared<MockedFileWriter>();
    auto templateRenderer = make_shared<MockedTemplateRenderer>();

    auto makeGen = [&] {
        MockedFileReaderBackend::Files files = {
            { "main.js", "renderTemplate(\"test_template\", schema, \"outfile\")" },
            { "generator.yml", readResource("generator.yml") },
        };
        auto fileReader
            = make_shared<FileReader>(FileReader::Opts { .backends = { make_shared<MockedFileReaderBackend>(files) } });
        auto jsExecutor = make_shared<JS::Executor>(JS::Executor::Opts { .fileReader = fileReader });
        return Generator::OpenApiGenerator(Generator::OpenApiGenerator::Opts {
            .fileReader = fileReader,
            .fileWriter = fileWriter,
            .jsExecutor = jsExecutor,
            .templateRenderer = templateRenderer,
            .defaultMainSciptPath = "main.js",
            .metadataPath = "generator.yml",
            .clearOutDir = false,
            .vars = { },
        });
    };

    SECTION("Happy path: well-formed spec generates fine")
    {
        auto gen = makeGen();
        REQUIRE_NOTHROW(gen.generate(getResourcePath("petstore.yaml")));
    }

    SECTION("Unhappy path: spec missing the required info.title/info.version throws")
    {
        auto gen = makeGen();
        REQUIRE_THROWS(gen.generate(getResourcePath("petstore_missing_info.yaml")));
    }
}

TEST_CASE("Generate converts a spec to the generator's declared openApiVersion", "[generator]")
{
    auto fileWriter = make_shared<MockedFileWriter>();
    auto templateRenderer = make_shared<MockedTemplateRenderer>();

    MockedFileReaderBackend::Files files = {
        { "main.js",
          "const pet = schema.components.schemas.Pet;\n"
          "renderTemplate(\"test_template\", {\n"
          "  tagKind: kindOf(pet.properties.tag),\n"
          "  tagType: pet.properties.tag.type,\n"
          "  tagNullable: pet.properties.tag.nullable,\n"
          "}, \"outfile\")" },
        // No explicit openApiVersion - defaults to "3.0", so a 3.1 input spec must be converted.
        { "generator.yml", "name: test_generator\nmainScriptPath: main.js\n" },
    };
    auto fileReader
        = make_shared<FileReader>(FileReader::Opts { .backends = { make_shared<MockedFileReaderBackend>(files) } });
    auto jsExecutor = make_shared<JS::Executor>(JS::Executor::Opts { .fileReader = fileReader });
    Generator::OpenApiGenerator gen(Generator::OpenApiGenerator::Opts {
        .fileReader = fileReader,
        .fileWriter = fileWriter,
        .jsExecutor = jsExecutor,
        .templateRenderer = templateRenderer,
        .defaultMainSciptPath = "main.js",
        .metadataPath = "generator.yml",
        .clearOutDir = false,
        .vars = { },
    });

    // petstore_31.yaml declares "openapi: 3.1.0" and Pet.tag as `type: [string, "null"]` - the
    // exact construct that used to crash generation outright before version conversion existed.
    REQUIRE_NOTHROW(gen.generate(getResourcePath("petstore_31.yaml")));

    auto& out = fileWriter->files["outfile"];
    // Converted to OAS 3.0 shape: nullable+scalar type, not a type array.
    REQUIRE_THAT(out, Catch::Matchers::ContainsSubstring("tagKind=Primitive"));
    REQUIRE_THAT(out, Catch::Matchers::ContainsSubstring("tagType=string"));
    REQUIRE_THAT(out, Catch::Matchers::ContainsSubstring("tagNullable=1"));
}

TEST_CASE("Generate rejects a generator declaring openApiVersion 2.0 as its target", "[generator]")
{
    auto fileWriter = make_shared<MockedFileWriter>();
    auto templateRenderer = make_shared<MockedTemplateRenderer>();

    MockedFileReaderBackend::Files files = {
        { "main.js", "renderTemplate(\"test_template\", schema, \"outfile\")" },
        { "generator.yml", "name: test_generator\nmainScriptPath: main.js\nopenApiVersion: \"2.0\"\n" },
    };
    auto fileReader
        = make_shared<FileReader>(FileReader::Opts { .backends = { make_shared<MockedFileReaderBackend>(files) } });
    auto jsExecutor = make_shared<JS::Executor>(JS::Executor::Opts { .fileReader = fileReader });
    Generator::OpenApiGenerator gen(Generator::OpenApiGenerator::Opts {
        .fileReader = fileReader,
        .fileWriter = fileWriter,
        .jsExecutor = jsExecutor,
        .templateRenderer = templateRenderer,
        .defaultMainSciptPath = "main.js",
        .metadataPath = "generator.yml",
        .clearOutDir = false,
        .vars = { },
    });

    // 2.0 can be a spec *input* (converted up), but the JS-bridge's raw+overlay pattern assumes an
    // OAS 3.x raw shape, so a generator may never declare 2.0 as its own generation target.
    REQUIRE_THROWS(gen.generate(getResourcePath("petstore.yaml")));
}
