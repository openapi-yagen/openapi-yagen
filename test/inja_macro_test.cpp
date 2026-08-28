// clazy:excludeall=non-pod-global-static

#include <catch2/catch_all.hpp>

#include <map>
#include <memory>
#include <optional>
#include <string>

#include <lib/filesystem/file_reader.h>
#include <lib/templates/inja_template_renderer.h>

using namespace std;
using namespace FS;

namespace {

// Minimal file backend: hands back whichever template source each test registers under a path,
// so a template can be rendered inline without touching disk. Needed as a real FileReaderBackend
// (rather than calling inja::Environment directly) because InjaTemplateRenderer is the actual
// integration point every generator renders through - it wires up set_include_callback and
// set_search_included_templates_in_files, so going through it here also exercises that wiring.
class MockedFileReaderBackend : public FileReaderBackend {
public:
    using Files = std::map<std::string, std::string>;
    MockedFileReaderBackend(Files files)
        : files(std::move(files))
    {
    }
    std::optional<string> read(const string& filePath) override
    {
        auto it = files.find(filePath);
        if (it != files.end())
            return it->second;
        return nullopt;
    }

private:
    Files files;
};

string renderTemplate(const string& templateSource)
{
    auto fileReader = make_shared<FileReader>(FileReader::Opts {
        .backends = { make_shared<MockedFileReaderBackend>(MockedFileReaderBackend::Files { { "t.j2", templateSource } }) },
    });
    Templates::InjaTemplateRenderer renderer(Templates::InjaTemplateRenderer::Opts { .fileReader = fileReader });
    return renderer.render("t.j2", Node {}, {});
}

}

// Coverage for {% macro %}/{% endmacro %} (see docs/templating.md's "Macros" section), including
// the depth guard added to guard against a macro that recurses without a base case - previously
// that crashed the whole process (SIGSEGV, no inja::RenderError, no diagnosable error) instead of
// failing the generation run cleanly.
TEST_CASE("Inja macros", "[templates][macro]")
{
    SECTION("basic call and default parameter")
    {
        CHECK(renderTemplate(
                  R"({% macro link(href, label="click me") %}<a href="{{ href }}">{{ label }}</a>{% endmacro %}{{ link("/pets") }} {{ link("/pets", "See pets") }})")
            == R"(<a href="/pets">click me</a> <a href="/pets">See pets</a>)");
    }

    SECTION("missing required argument throws inja::RenderError")
    {
        REQUIRE_THROWS_WITH(
            renderTemplate("{% macro m(a, b) %}x{% endmacro %}{{ m(1) }}"),
            Catch::Matchers::ContainsSubstring("missing required argument 'b' for macro 'm'"));
    }

    SECTION("too many arguments throws inja::RenderError")
    {
        REQUIRE_THROWS_WITH(
            renderTemplate("{% macro m(a) %}x{% endmacro %}{{ m(1, 2) }}"),
            Catch::Matchers::ContainsSubstring("too many arguments for macro 'm'"));
    }

    SECTION("macro calling another (non-self) macro")
    {
        CHECK(renderTemplate(
                  "{% macro a(x) %}A({{ x }}){% endmacro %}{% macro b(x) %}B[{{ a(x) }}]{% endmacro %}{{ b(\"y\") }}")
            == "B[A(y)]");
    }

    SECTION("self-recursive macro")
    {
        CHECK(renderTemplate(
                  "{% macro down(n) %}{% if n > 0 %}{{ n }},{{ down(n - 1) }}{% endif %}{% endmacro %}{{ down(3) }}")
            == "3,2,1,");
    }

    SECTION("runaway recursion (no base case) throws inja::RenderError instead of crashing")
    {
        REQUIRE_THROWS_WITH(
            renderTemplate("{% macro loop(n) %}{{ n }},{{ loop(n + 1) }}{% endmacro %}{{ loop(1) }}"),
            Catch::Matchers::ContainsSubstring("macro recursion depth exceeded"));
    }

    SECTION("## line-statement macro form")
    {
        CHECK(renderTemplate("## macro foo()\ntest\n## endmacro\n[{{ foo() }}]") == "[test]");
    }
}
