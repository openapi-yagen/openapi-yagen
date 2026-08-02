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
}

TEST_CASE("Generate validates spec against jsonSchemaPath when declared", "[generator]")
{
    auto fileWriter = make_shared<MockedFileWriter>();
    auto templateRenderer = make_shared<MockedTemplateRenderer>();

    auto makeGen = [&](const string& jsonSchemaContent) {
        MockedFileReaderBackend::Files files = {
            { "main.js", "renderTemplate(\"test_template\", schema, \"outfile\")" },
            { "generator.yml", "name: test_generator\nmainScriptPath: main.js\njsonSchemaPath: schema.json\n" },
            { "schema.json", jsonSchemaContent },
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

    SECTION("Happy path: spec satisfies the declared schema")
    {
        auto gen
            = makeGen(R"({"type": "object", "required": ["openapi"], "properties": {"openapi": {"type": "string"}}})");
        REQUIRE_NOTHROW(gen.generate(getResourcePath("petstore.yaml")));
    }

    SECTION("Unhappy path: spec violates the declared schema")
    {
        auto gen = makeGen(R"({"type": "object", "required": ["thisFieldDoesNotExistInPetstore"]})");
        REQUIRE_THROWS(gen.generate(getResourcePath("petstore.yaml")));
    }

    SECTION("The declared JSON schema file itself is malformed")
    {
        auto gen = makeGen("{ not valid json");
        REQUIRE_THROWS(gen.generate(getResourcePath("petstore.yaml")));
    }
}
