// clazy:excludeall=non-pod-global-static

#include <catch2/catch_all.hpp>

#include <sstream>

#include <lib/filesystem/embedded_file_reader_backend.h>
#include <lib/filesystem/file_reader.h>
#include <lib/filesystem/file_writer.h>
#include <lib/generator/openapi_generator.h>
#include <lib/js/executor.h>
#include <lib/templates/inja_template_renderer.h>
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
        .tags = {},
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
        .tags = {},
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
        .tags = {},
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
        .tags = {},
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

TEST_CASE("Generate exposes unwrapSchema/buildDocComment/disambiguateName", "[generator]")
{
    auto fileWriter = make_shared<MockedFileWriter>();
    auto templateRenderer = make_shared<MockedTemplateRenderer>();

    MockedFileReaderBackend::Files files = {
        { "main.js", R"JS(
// unwrapSchema: peels single-branch allOf/oneOf/anyOf wrappers down to the shape-determining
// schema - these are plain object literals, not part of the resolved `schema` graph, since
// unwrapSchema only ever reads shallow properties off whatever it's handed.
const wrappedEnum = { allOf: [ { type: "string", enum: ["A", "B"] } ] };
const unwrapped = unwrapSchema(wrappedEnum);

const notWrapped = { type: "object", properties: { a: { type: "string" } } };
const unwrappedNoop = unwrapSchema(notWrapped);

const multiOneOf = { oneOf: [ { type: "string" }, { type: "integer" } ] };
const unwrappedMulti = unwrapSchema(multiOneOf);

renderTemplate("test_template", {
  unwrappedKind: kindOf(unwrapped),
  unwrappedNoopIsSameObject: unwrappedNoop === notWrapped,
  unwrappedNoopKind: kindOf(unwrappedNoop),
  unwrappedMultiKind: kindOf(unwrappedMulti),

  docFull: buildDocComment("Summary line", "A longer description.", [
    { name: "a", description: "the a param" },
    { name: "b", description: null },
  ]),
  docSummaryOnly: buildDocComment("Just a summary", null, []),
  docNone: buildDocComment(null, null, []),

  docSlash: buildDocComment("Summary line", "A longer description.", [
    { name: "a", description: "the a param" },
  ], "//"),
  docTripleSlash: buildDocComment("Just a summary", null, [], "///"),
  docHash: buildDocComment("Summary line", "A longer description.", [
    { name: "a", description: "the a param" },
  ], "#"),

  nameNoCollision: disambiguateName("Foo", ["Bar", "Baz"]),
  nameOneCollision: disambiguateName("Foo", ["Foo", "Bar"]),
  nameTwoCollisions: disambiguateName("Foo", ["Foo", "FooWrapper", "Bar"]),
  nameThreeCollisions: disambiguateName("Foo", ["Foo", "FooWrapper", "FooWrapper2"]),
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
        .tags = {},
    });

    gen.generate(getResourcePath("petstore.yaml"));

    auto& out = fileWriter->files["outfile"];
    // unwrapSchema
    REQUIRE_THAT(out, Catch::Matchers::ContainsSubstring("unwrappedKind=Enum"));
    REQUIRE_THAT(out, Catch::Matchers::ContainsSubstring("unwrappedNoopIsSameObject=1"));
    REQUIRE_THAT(out, Catch::Matchers::ContainsSubstring("unwrappedNoopKind=Object"));
    // a 2-variant oneOf isn't a single-branch wrapper - stays unchanged (still OneOf-kind)
    REQUIRE_THAT(out, Catch::Matchers::ContainsSubstring("unwrappedMultiKind=OneOf"));

    // buildDocComment
    REQUIRE_THAT(out, Catch::Matchers::ContainsSubstring(
                           "docFull=/**\n * Summary line\n * A longer description.\n *\n * @param a the a param\n */"));
    REQUIRE_THAT(out, Catch::Matchers::ContainsSubstring("docSummaryOnly=/** Just a summary */"));
    REQUIRE_THAT(out, Catch::Matchers::ContainsSubstring("docNone=null"));

    // buildDocComment: line-comment styles ("//"/"///"/"#") - one marker per line, no trailing
    // space on the blank separator line before @param entries.
    REQUIRE_THAT(out, Catch::Matchers::ContainsSubstring(
                           "docSlash=// Summary line\n// A longer description.\n//\n// @param a the a param"));
    REQUIRE_THAT(out, Catch::Matchers::ContainsSubstring("docTripleSlash=/// Just a summary"));
    REQUIRE_THAT(out, Catch::Matchers::ContainsSubstring(
                           "docHash=# Summary line\n# A longer description.\n#\n# @param a the a param"));

    // disambiguateName
    REQUIRE_THAT(out, Catch::Matchers::ContainsSubstring("nameNoCollision=Foo"));
    REQUIRE_THAT(out, Catch::Matchers::ContainsSubstring("nameOneCollision=FooWrapper"));
    REQUIRE_THAT(out, Catch::Matchers::ContainsSubstring("nameTwoCollisions=FooWrapper2"));
    REQUIRE_THAT(out, Catch::Matchers::ContainsSubstring("nameThreeCollisions=FooWrapper3"));
}

TEST_CASE("buildDocComment rejects an unrecognized style", "[generator]")
{
    auto fileWriter = make_shared<MockedFileWriter>();
    auto templateRenderer = make_shared<MockedTemplateRenderer>();

    MockedFileReaderBackend::Files files = {
        { "main.js", R"JS(
buildDocComment("x", null, [], "/* */");
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
        .tags = {},
    });

    REQUIRE_THROWS_WITH(gen.generate(getResourcePath("petstore.yaml")),
                        Catch::Matchers::ContainsSubstring("unrecognized style"));
}

TEST_CASE("A plain JS-native throw in main.js surfaces its real message, not just a generic wrapper", "[generator]")
{
    auto fileWriter = make_shared<MockedFileWriter>();
    auto templateRenderer = make_shared<MockedTemplateRenderer>();

    MockedFileReaderBackend::Files files = {
        { "main.js", R"JS(
throw Error("boom");
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
        .tags = {},
    });

    REQUIRE_THROWS_WITH(gen.generate(getResourcePath("petstore.yaml")), Catch::Matchers::ContainsSubstring("boom"));
}

TEST_CASE("Generate exposes resolveUnionDispatch", "[generator]")
{
    auto fileWriter = make_shared<MockedFileWriter>();
    auto templateRenderer = make_shared<MockedTemplateRenderer>();

    MockedFileReaderBackend::Files files = {
        { "main.js", R"JS(
// Two object variants, each with its own required field the other doesn't declare.
const shape = { oneOf: [
  { type: "object", required: ["shapeType", "radius"],
    properties: { shapeType: { type: "string" }, radius: { type: "number" } } },
  { type: "object", required: ["shapeType", "base"],
    properties: { shapeType: { type: "string" }, base: { type: "number" } } },
] };
const dispatch = resolveUnionDispatch(shape);

const notUnion = { type: "string" };
const notUnionDispatch = resolveUnionDispatch(notUnion);

// A scalar variant, an object variant with a distinguishing field, and a field-less object
// variant (a subset of the other's fields) that can only ever be a trailing fallback - order is
// preserved exactly as declared (no "fallback sorts last" reordering at this layer).
const mixed = { oneOf: [
  { type: "string" },
  { type: "object", required: ["kind", "extra"],
    properties: { kind: { type: "string" }, extra: { type: "string" } } },
  { type: "object", properties: { kind: { type: "string" } } },
] };
const mixedDispatch = resolveUnionDispatch(mixed);

renderTemplate("test_template", {
  dispatchLen: dispatch.variants.length,
  dispatchKind0: dispatch.variants[0].dispatchKind,
  dispatchField0: dispatch.variants[0].dispatchField,
  dispatchKind1: dispatch.variants[1].dispatchKind,
  dispatchField1: dispatch.variants[1].dispatchField,
  notUnionIsNull: notUnionDispatch === null,
  mixedKind0: mixedDispatch.variants[0].dispatchKind,
  mixedField0: mixedDispatch.variants[0].dispatchField,
  mixedKind1: mixedDispatch.variants[1].dispatchKind,
  mixedField1: mixedDispatch.variants[1].dispatchField,
  mixedKind2: mixedDispatch.variants[2].dispatchKind,
  mixedField2: mixedDispatch.variants[2].dispatchField,
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
        .tags = {},
    });

    gen.generate(getResourcePath("petstore.yaml"));

    auto& out = fileWriter->files["outfile"];
    REQUIRE_THAT(out, Catch::Matchers::ContainsSubstring("dispatchLen=2"));
    REQUIRE_THAT(out, Catch::Matchers::ContainsSubstring("dispatchKind0=object"));
    REQUIRE_THAT(out, Catch::Matchers::ContainsSubstring("dispatchField0=radius"));
    REQUIRE_THAT(out, Catch::Matchers::ContainsSubstring("dispatchKind1=object"));
    REQUIRE_THAT(out, Catch::Matchers::ContainsSubstring("dispatchField1=base"));
    REQUIRE_THAT(out, Catch::Matchers::ContainsSubstring("notUnionIsNull=1"));

    REQUIRE_THAT(out, Catch::Matchers::ContainsSubstring("mixedKind0=string"));
    REQUIRE_THAT(out, Catch::Matchers::ContainsSubstring("mixedField0=null"));
    REQUIRE_THAT(out, Catch::Matchers::ContainsSubstring("mixedKind1=object"));
    REQUIRE_THAT(out, Catch::Matchers::ContainsSubstring("mixedField1=extra"));
    REQUIRE_THAT(out, Catch::Matchers::ContainsSubstring("mixedKind2=object"));
    REQUIRE_THAT(out, Catch::Matchers::ContainsSubstring("mixedField2=null"));
}

TEST_CASE("resolveUnionDispatch rejects unresolvable/ambiguous oneOf shapes", "[generator]")
{
    auto makeGen = [](const string& mainJs, const shared_ptr<MockedFileWriter>& fileWriter,
                      const shared_ptr<Templates::TemplateRenderer>& templateRenderer) {
        MockedFileReaderBackend::Files files = {
            { "main.js", mainJs },
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
            .vars = { },
            .tags = {},
        });
    };
    // Every scenario captures resolveUnionDispatch's thrown error message via try/catch rather
    // than asserting on the exception directly, since it's simpler to inspect the rendered output
    // than the exact exception type crossing the JS/C++ boundary.
    auto runAndCaptureError = [&](const char* badSchemaLiteral) {
        auto fileWriter = make_shared<MockedFileWriter>();
        auto templateRenderer = make_shared<MockedTemplateRenderer>();
        string mainJs = string("let errMsg = \"none\";\ntry { resolveUnionDispatch(") + badSchemaLiteral
            + "); } catch (e) { errMsg = e.message; }\nrenderTemplate(\"test_template\", { errMsg }, \"outfile\");\n";
        auto gen = makeGen(mainJs, fileWriter, templateRenderer);
        gen.generate(getResourcePath("petstore.yaml"));
        return fileWriter->files["outfile"];
    };

    SECTION("A variant with no recognizable JSON shape (nested oneOf) throws")
    {
        auto out = runAndCaptureError("{ oneOf: [ { oneOf: [ {type: \"string\"}, {type: \"integer\"} ] }, "
                                       "{ type: \"string\" } ] }");
        REQUIRE_THAT(out, Catch::Matchers::ContainsSubstring("no recognizable JSON shape to dispatch on"));
    }

    SECTION("Two object variants with no distinguishing field between them throws")
    {
        auto out = runAndCaptureError(
            "{ oneOf: [ { type: \"object\", properties: { a: {type: \"string\"} } }, "
            "{ type: \"object\", properties: { a: {type: \"string\"} } } ] }");
        REQUIRE_THAT(out, Catch::Matchers::ContainsSubstring("Cannot disambiguate object-shaped oneOf/anyOf variants"));
    }

    SECTION("Two variants of the same non-object dispatch kind throws")
    {
        auto out = runAndCaptureError("{ oneOf: [ { type: \"string\" }, { type: \"string\" } ] }");
        REQUIRE_THAT(out, Catch::Matchers::ContainsSubstring("Cannot disambiguate multiple \"string\"-shaped"));
    }

    SECTION("Two unconstrained catch-all variants throws")
    {
        auto out = runAndCaptureError("{ oneOf: [ {}, {} ] }");
        REQUIRE_THAT(out, Catch::Matchers::ContainsSubstring("unconstrained (\"{}\") variants"));
    }
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
            .tags = {},
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
        .tags = {},
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
        .tags = {},
    });

    // 2.0 can be a spec *input* (converted up), but the JS-bridge's raw+overlay pattern assumes an
    // OAS 3.x raw shape, so a generator may never declare 2.0 as its own generation target.
    REQUIRE_THROWS(gen.generate(getResourcePath("petstore.yaml")));
}

TEST_CASE("Generate runs end-to-end against a built-in (embedded) generator", "[generator]")
{
    // Real EmbeddedFileReaderBackend, real InjaTemplateRenderer and real JS::Executor (only the
    // file writer is mocked, to avoid touching disk) - exercises the exact same generation
    // pipeline `-g builtin:kotlin_ktor_client` uses, confirming the embedded copy of the generator
    // produces real output, not just that its files are individually readable.
    auto fileWriter = make_shared<MockedFileWriter>();

    EmbeddedFileReaderBackendFactory factory;
    auto fileReader = make_shared<FileReader>(FileReader::Opts {
        .backends = { factory.createBackend("builtin:kotlin_ktor_client") },
    });
    auto templateRenderer = make_shared<Templates::InjaTemplateRenderer>(Templates::InjaTemplateRenderer::Opts {
        .fileReader = fileReader,
    });
    auto jsExecutor = make_shared<JS::Executor>(JS::Executor::Opts { .fileReader = fileReader });

    Generator::OpenApiGenerator gen(Generator::OpenApiGenerator::Opts {
        .fileReader = fileReader,
        .fileWriter = fileWriter,
        .jsExecutor = jsExecutor,
        .templateRenderer = templateRenderer,
        .defaultMainSciptPath = "main.js",
        .metadataPath = "generator.yml",
        .vars = { "packageName=com.example.petstore" },
        .tags = {},
    });

    gen.generate(getResourcePath("petstore.yaml"));

    REQUIRE_THAT(fileWriter->files["apis/PetsApi.kt"], Catch::Matchers::ContainsSubstring("class PetsApi"));
    REQUIRE_THAT(fileWriter->files["apis/PetsApi.kt"], Catch::Matchers::ContainsSubstring("listPets"));
    REQUIRE_THAT(fileWriter->files["models/Pet.kt"], Catch::Matchers::ContainsSubstring("data class Pet"));
}
