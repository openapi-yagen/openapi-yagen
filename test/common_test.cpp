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
    }
    SECTION("To snake_case") { REQUIRE((toSnakeCase("firstSecond__ Third")) == "first_second_third"); }
    SECTION("To SCREAMING_SNAKE_CASE") { REQUIRE((toScreamingSnakeCase("firstSecondThird")) == "FIRST_SECOND_THIRD"); }
    SECTION("To PascalCase") { REQUIRE((toPascalCase("first_second_third")) == "FirstSecondThird"); }
    SECTION("To camelCase") { REQUIRE((toCamelCase("first_second_third")) == "firstSecondThird"); }
}
