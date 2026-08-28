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

// Same mocked backend as inja_macro_test.cpp (duplicated rather than shared - see that file's own
// comment for why going through InjaTemplateRenderer, not inja::Environment directly, matters
// here), but renderFiles() below registers a whole map of named templates instead of just one, so
// {% include %}/{% extends %} can reference each other by name.
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

string renderFiles(const map<string, string>& files, const string& entryPoint)
{
    auto fileReader = make_shared<FileReader>(FileReader::Opts {
        .backends = { make_shared<MockedFileReaderBackend>(files) },
    });
    Templates::InjaTemplateRenderer renderer(Templates::InjaTemplateRenderer::Opts { .fileReader = fileReader });
    return renderer.render(entryPoint, Node {}, {});
}

}

// Coverage for {% include %}/{% extends %} cycle detection (Parser::add_to_template_storage's
// include_resolution_stack) - previously a template including/extending itself, directly or
// through a chain of other templates, recursed until the C++ call stack overflowed (SIGSEGV, no
// inja::ParserError, no diagnosable error) instead of failing generation cleanly. Mirrors
// inja_macro_test.cpp's "runaway recursion" coverage for the analogous macro-recursion guard.
TEST_CASE("Inja include/extends recursion guard", "[templates][include]")
{
    SECTION("non-cyclic include chain renders normally")
    {
        CHECK(renderFiles(
                  {
                      { "a.j2", "before-a,{% include \"b.j2\" %},after-a" },
                      { "b.j2", "before-b,{% include \"c.j2\" %},after-b" },
                      { "c.j2", "inside-c" },
                  },
                  "a.j2")
            == "before-a,before-b,inside-c,after-b,after-a");
    }

    SECTION("diamond include (same file included from two different places) is not a cycle")
    {
        CHECK(renderFiles(
                  {
                      { "a.j2", "{% include \"b.j2\" %}|{% include \"c.j2\" %}" },
                      { "b.j2", "{% include \"shared.j2\" %}" },
                      { "c.j2", "{% include \"shared.j2\" %}" },
                      { "shared.j2", "S" },
                  },
                  "a.j2")
            == "S|S");
    }

    SECTION("direct self-include throws inja::ParserError instead of crashing")
    {
        REQUIRE_THROWS_WITH(
            renderFiles({ { "a.j2", "{% include \"a.j2\" %}" } }, "a.j2"),
            Catch::Matchers::ContainsSubstring("include/extends cycle detected: a.j2 -> a.j2"));
    }

    SECTION("mutual include cycle (a includes b includes a) throws inja::ParserError")
    {
        // The entry-point template itself ("a.j2") is never pushed onto the resolution stack -
        // only a *named* include/extends target is (see add_to_template_storage) - so the
        // reported chain starts from "b.j2", the first named template actually resolved.
        REQUIRE_THROWS_WITH(
            renderFiles(
                {
                    { "a.j2", "{% include \"b.j2\" %}" },
                    { "b.j2", "{% include \"a.j2\" %}" },
                },
                "a.j2"),
            Catch::Matchers::ContainsSubstring("include/extends cycle detected: b.j2 -> a.j2 -> b.j2"));
    }

    SECTION("direct self-extend throws inja::ParserError instead of crashing")
    {
        REQUIRE_THROWS_WITH(
            renderFiles({ { "a.j2", "{% extends \"a.j2\" %}" } }, "a.j2"),
            Catch::Matchers::ContainsSubstring("include/extends cycle detected: a.j2 -> a.j2"));
    }

    SECTION("legitimate extends chain (base + override block) renders normally")
    {
        CHECK(renderFiles(
                  {
                      { "base.j2", "base-start{% block content %}default{% endblock %}base-end" },
                      { "child.j2", "{% extends \"base.j2\" %}{% block content %}custom{% endblock %}" },
                  },
                  "child.j2")
            == "base-startcustombase-end");
    }

    SECTION("include cycle through an extends hop is still detected")
    {
        REQUIRE_THROWS_WITH(
            renderFiles(
                {
                    { "a.j2", "{% extends \"b.j2\" %}" },
                    { "b.j2", "{% include \"a.j2\" %}" },
                },
                "a.j2"),
            Catch::Matchers::ContainsSubstring("include/extends cycle detected: b.j2 -> a.j2 -> b.j2"));
    }
}
