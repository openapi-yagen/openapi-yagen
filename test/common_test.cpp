// clazy:excludeall=non-pod-global-static

#include <format>

#include <catch2/catch_all.hpp>

#include <lib/common/node_walker.h>
#include <lib/common/process_executor.h>
#include <lib/common/string_tools.h>
#include <lib/common/yaml_or_json_parser.h>

using namespace std;

TEST_CASE("NodeWalker", "[common]")
{
    Node::Map root;
    root["name"] = { Node::String("foo") };
    NodeWalker w(Node { root });

    SECTION("Walking through a present-but-empty section stays empty, not an error")
    {
        REQUIRE(w["components"].isEmpty());
        REQUIRE(w["components"]["schemas"].isEmpty());
        REQUIRE(w["components"]["schemas"]["Pet"]["properties"].isEmpty());
    }

    SECTION("Walking into a genuinely wrong type still throws") { REQUIRE_THROWS_AS(w["name"]["nested"], WalkError); }
}

TEST_CASE("Change case", "[common]")
{
    SECTION("Split words")
    {
        REQUIRE((splitToWords("FirstSecond") | joinToString("-")) == "first-second");
        REQUIRE((splitToWords("firstSecondThird") | joinToString("-")) == "first-second-third");
        REQUIRE((splitToWords("First  Second") | joinToString("-")) == "first-second");
        REQUIRE((splitToWords("First - Second") | joinToString("-")) == "first-second");
        REQUIRE((splitToWords("First - SeconD") | joinToString("-")) == "first-secon-d");
        REQUIRE((splitToWords("   First  -_  SeconD   ") | joinToString("-")) == "first-secon-d");
        REQUIRE((splitToWords("first_second") | joinToString("-")) == "first-second");
        REQUIRE((splitToWords("First-Second") | joinToString("-")) == "first-second");
        REQUIRE((splitToWords("FIRST.SECOND") | joinToString("-")) == "first-second");
        REQUIRE((splitToWords("x-next") | joinToString("-")) == "x-next");
        REQUIRE((splitToWords("pet/status") | joinToString("-")) == "pet-status");
        REQUIRE((splitToWords("foo@bar#baz") | joinToString("-")) == "foo-bar-baz");
        REQUIRE((splitToWords("oauth2Auth") | joinToString("-")) == "oauth-2-auth");
        REQUIRE((splitToWords("ipv4Address") | joinToString("-")) == "ipv-4-address");
        REQUIRE((splitToWords("http2Something") | joinToString("-")) == "http-2-something");
    }
    SECTION("To snake_case") { REQUIRE((toSnakeCase("firstSecond__ Third")) == "first_second_third"); }
    SECTION("To SCREAMING_SNAKE_CASE") { REQUIRE((toScreamingSnakeCase("firstSecondThird")) == "FIRST_SECOND_THIRD"); }
    SECTION("To PascalCase") { REQUIRE((toPascalCase("first_second_third")) == "FirstSecondThird"); }
    SECTION("To camelCase") { REQUIRE((toCamelCase("first_second_third")) == "firstSecondThird"); }
    SECTION("To camelCase across a digit-to-letter boundary")
    {
        REQUIRE((toCamelCase("oauth2AuthToken")) == "oauth2AuthToken");
        REQUIRE((toCamelCase("ipv4Address")) == "ipv4Address");
    }
}

TEST_CASE("Identifier sanitization", "[common]")
{
    SECTION("isValidIdentifier")
    {
        REQUIRE(isValidIdentifier("foo"));
        REQUIRE(isValidIdentifier("_foo123"));
        REQUIRE(isValidIdentifier("Foo_Bar"));
        REQUIRE_FALSE(isValidIdentifier(""));
        REQUIRE_FALSE(isValidIdentifier("123foo"));
        REQUIRE_FALSE(isValidIdentifier("foo-bar"));
        REQUIRE_FALSE(isValidIdentifier("foo bar"));
    }
    SECTION("sanitizeIdentifier")
    {
        REQUIRE(sanitizeIdentifier("foo") == "foo");
        REQUIRE(sanitizeIdentifier("foo-bar") == "foo_bar");
        REQUIRE(sanitizeIdentifier("x-next") == "x_next");
        REQUIRE(sanitizeIdentifier("123foo") == "_123foo");
        REQUIRE(sanitizeIdentifier("") == "_");
        REQUIRE(isValidIdentifier(sanitizeIdentifier("123foo")));
        REQUIRE(isValidIdentifier(sanitizeIdentifier("pet/status@2")));
    }
}

TEST_CASE("toStringLiteral", "[common]")
{
    REQUIRE(toStringLiteral("foo") == "\"foo\"");
    REQUIRE(toStringLiteral("") == "\"\"");
    REQUIRE(toStringLiteral("foo\"bar") == "\"foo\\\"bar\"");
    REQUIRE(toStringLiteral("foo\\bar") == "\"foo\\\\bar\"");
    REQUIRE(toStringLiteral("line1\nline2") == "\"line1\\nline2\"");
    REQUIRE(toStringLiteral("a\tb\rc") == "\"a\\tb\\rc\"");
    REQUIRE(toStringLiteral(string(1, '\x01')) == "\"\\u0001\"");
}

TEST_CASE("shellSingleQuote", "[common]")
{
    REQUIRE(shellSingleQuote("plain") == "'plain'");
    REQUIRE(shellSingleQuote("") == "''");
    REQUIRE(shellSingleQuote("it's a test") == "'it'\\''s a test'");
    REQUIRE(shellSingleQuote("a'b'c") == "'a'\\''b'\\''c'");

    SECTION("Shell metacharacters are inert once substituted into a real command")
    {
        string payload = "$(touch /tmp/should-not-exist-shellquote-test); `echo pwned`; \"; rm -rf /tmp/x";
        auto cmd = format("echo {}", shellSingleQuote(payload));
        auto result = ProcessExecutor::executeAndCheckResult(cmd);
        REQUIRE((result.stdOut | trim()) == payload);
    }
}

TEST_CASE("splitPathTemplate", "[common]")
{
    auto segs = splitPathTemplate("/pets/{petId}/ratings");
    REQUIRE(segs.size() == 3);
    REQUIRE_FALSE(segs[0].isParam);
    REQUIRE(segs[0].value == "pets");
    REQUIRE(segs[1].isParam);
    REQUIRE(segs[1].value == "petId");
    REQUIRE_FALSE(segs[2].isParam);
    REQUIRE(segs[2].value == "ratings");

    SECTION("leading/trailing/doubled slashes produce no empty segments")
    {
        REQUIRE(splitPathTemplate("/pets/").size() == 1);
        REQUIRE(splitPathTemplate("pets").size() == 1);
        REQUIRE(splitPathTemplate("//pets//").size() == 1);
        REQUIRE(splitPathTemplate("/").empty());
        REQUIRE(splitPathTemplate("").empty());
    }
}

TEST_CASE("nodeToYamlText/nodeToJsonText quote string scalars that would otherwise misparse as a "
          "different type",
          "[common]")
{
    // A response status code map key ("200") is the OpenAPI-specific case that motivated this -
    // left unquoted, a YAML 1.1 core-schema parser (js-yaml, most spec linters/editors) reads it
    // back as the integer 200, not the string "200" the spec requires as a Responses Object key.
    Node::Map inner;
    inner["description"] = { Node::String("ok") };
    Node::Map responses;
    responses["200"] = { inner };
    Node::Map root;
    root["responses"] = { responses };
    root["version"] = { Node::String("true") }; // a string value that looks like a bool
    root["nullish"] = { Node::String("null") }; // ... and null
    root["pi"] = { Node::String("1.5") }; // ... and a float
    root["title"] = { Node::String("3.0.0") }; // NOT ambiguous (two dots) - stays unquoted

    auto yaml = nodeToYamlText({ root });
    REQUIRE_THAT(yaml, Catch::Matchers::ContainsSubstring("\"200\":"));
    REQUIRE_THAT(yaml, Catch::Matchers::ContainsSubstring("version: \"true\""));
    REQUIRE_THAT(yaml, Catch::Matchers::ContainsSubstring("nullish: \"null\""));
    REQUIRE_THAT(yaml, Catch::Matchers::ContainsSubstring("pi: \"1.5\""));
    REQUIRE_THAT(yaml, Catch::Matchers::ContainsSubstring("title: 3.0.0"));

    // Round-trips back to the original string values, not (say) an int/bool/float/null.
    auto reparsed = parseYamlOrJsonToNode(yaml);
    NodeWalker w(reparsed);
    REQUIRE(w["responses"]["200"]["description"].required<string>() == "ok");
    REQUIRE(w["version"].required<string>() == "true");
    REQUIRE(w["nullish"].required<string>() == "null");
    REQUIRE(w["pi"].required<string>() == "1.5");
    REQUIRE(w["title"].required<string>() == "3.0.0");
}

TEST_CASE("nodeToYamlText/nodeToJsonText's topLevelKeyOrder reorders the root object's keys",
          "[common]")
{
    Node::Map root;
    root["paths"] = { Node::Map {} };
    root["components"] = { Node::Map {} };
    root["info"] = { Node::Map {} };
    root["openapi"] = { Node::String("3.0.0") };
    root["x-vendor"] = { Node::String("extra") }; // not in the order list

    vector<string> order = { "openapi", "info", "paths", "components" };

    SECTION("YAML")
    {
        auto yaml = nodeToYamlText({ root }, order);
        auto openapiPos = yaml.find("openapi:");
        auto infoPos = yaml.find("info:");
        auto pathsPos = yaml.find("paths:");
        auto componentsPos = yaml.find("components:");
        auto vendorPos = yaml.find("x-vendor:");
        REQUIRE(openapiPos < infoPos);
        REQUIRE(infoPos < pathsPos);
        REQUIRE(pathsPos < componentsPos);
        // Keys absent from the order list still come out, after the ordered ones.
        REQUIRE(componentsPos < vendorPos);
    }

    SECTION("JSON")
    {
        auto json = nodeToJsonText({ root }, order);
        auto openapiPos = json.find("\"openapi\"");
        auto infoPos = json.find("\"info\"");
        auto pathsPos = json.find("\"paths\"");
        auto componentsPos = json.find("\"components\"");
        auto vendorPos = json.find("\"x-vendor\"");
        REQUIRE(openapiPos < infoPos);
        REQUIRE(infoPos < pathsPos);
        REQUIRE(pathsPos < componentsPos);
        REQUIRE(componentsPos < vendorPos);
    }
}
