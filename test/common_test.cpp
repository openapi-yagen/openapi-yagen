// clazy:excludeall=non-pod-global-static

#include <catch2/catch_all.hpp>

#include <lib/common/node_walker.h>
#include <lib/common/string_tools.h>

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
    }
    SECTION("To snake_case") { REQUIRE((toSnakeCase("firstSecond__ Third")) == "first_second_third"); }
    SECTION("To SCREAMING_SNAKE_CASE") { REQUIRE((toScreamingSnakeCase("firstSecondThird")) == "FIRST_SECOND_THIRD"); }
    SECTION("To PascalCase") { REQUIRE((toPascalCase("first_second_third")) == "FirstSecondThird"); }
    SECTION("To camelCase") { REQUIRE((toCamelCase("first_second_third")) == "firstSecondThird"); }
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
