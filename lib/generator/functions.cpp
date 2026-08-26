#include "functions.h"

#include <optional>
#include <set>
#include <sstream>

#include "../common/node.h"
#include "../common/std_tools.h"
#include "../common/string_tools.h"
#include "../logger/logger.h"

using namespace std;

namespace Generator {
namespace {
LogFacade::Logger logger("Generator::Functions");
}

Node nodeToCamelCase(const Node::Vec& args) { return { toCamelCase((args | firstOrThrow()).get<string>()) }; }
Node nodeToPascalCase(const Node::Vec& args) { return { toPascalCase((args | firstOrThrow()).get<string>()) }; }
Node nodeToSnakeCase(const Node::Vec& args) { return { toSnakeCase((args | firstOrThrow()).get<string>()) }; }
Node nodeToScreamingSnakeCase(const Node::Vec& args)
{
    return { toScreamingSnakeCase((args | firstOrThrow()).get<string>()) };
}

Node nodeIsValidIdentifier(const Node::Vec& args)
{
    return { isValidIdentifier((args | firstOrThrow()).get<string>()) };
}
Node nodeSanitizeIdentifier(const Node::Vec& args)
{
    return { sanitizeIdentifier((args | firstOrThrow()).get<string>()) };
}
Node nodeToStringLiteral(const Node::Vec& args) { return { toStringLiteral((args | firstOrThrow()).get<string>()) }; }
Node nodeSplitPathTemplate(const Node::Vec& args)
{
    auto path = (args | firstOrThrow()).get<string>();
    Node::Vec segments;
    for (const auto& seg : splitPathTemplate(path)) {
        Node::Map m;
        if (seg.isParam)
            m["param"] = { seg.value };
        else
            m["literal"] = { seg.value };
        segments.push_back({ m });
    }
    return { segments };
}

// Builds a doc comment block from a summary, a longer description, and a list of {name,
// description} @param entries, in one of four comment styles selected by the literal marker
// string `style` itself (so a call site reads as what it produces, not an enum name to look up):
// - `"/** */"` (default) - Javadoc/KDoc/TSDoc/Doxygen: Kotlin, TypeScript/JS, Java, C#, C/C++.
// - `"//"` - a plain line-comment block, one `//` per line: Go, Rust (a plain, non-rustdoc
//   comment), C/C++/Java/C#/Kotlin/TS/JS/Dart when a doc-comment marker isn't wanted/supported.
// - `"///"` - triple-slash doc comments: Dart (dartdoc) and Rust (rustdoc) both parse this as
//   markdown prose with no formal `@param`-style tag syntax of their own - the `@param` lines this
//   function still emits are perfectly valid markdown text, just not a tag either tool recognizes
//   specially; still useful for the human reading the source.
// - `"#"` - a plain line-comment block, one `#` per line: Python (a preceding comment, NOT a
//   docstring - Python's actual convention is a `"""..."""` string literal as the function/class
//   body's first statement, which needs to be positioned *inside* the body, not attached above the
//   declaration like every other style here, so it isn't reachable via this same "one string,
//   printed above the declaration" shape a generator template expects), Ruby (RDoc/YARD's own
//   convention - a comment block directly above the method/class), Bash/shell, Perl, YAML, TOML.
// Unrecognized `style` values throw rather than silently falling back, so a typo in a generator's
// own call site fails loudly at generation time instead of emitting silently-wrong comments.
//
// Returns Node::NullValue (not "") when there's nothing to document: Inja's {% if %} treats an
// empty string as truthy (only false/null/0/[] are falsy), so templates can guard with a plain
// `{% if docComment %}` and reindent the (possibly multi-line) result to their own call site's
// depth via indent() (see docs/templating.md) instead of each generator re-splitting/reindenting
// per line by hand.
Node nodeBuildDocComment(const Node::Vec& args)
{
    if (args.size() < 1)
        throw runtime_error("<9a93f7b2> buildDocComment requires 1-4 arguments (summary: string|null, "
                             "description?: string|null, params?: [{name, description}], "
                             "style?: \"/** */\"|\"//\"|\"///\"|\"#\")");
    auto getOptStr = [&](size_t i) -> optional<string> {
        if (i >= args.size())
            return nullopt;
        auto s = args[i].getIf<string>();
        return s ? optional<string>(*s) : nullopt;
    };

    auto style = getOptStr(3).value_or("/** */");
    if (style != "/** */" && style != "//" && style != "///" && style != "#")
        throw runtime_error(format(
            "<219d3c07> buildDocComment: unrecognized style \"{}\" - expected one of \"/** */\", \"//\", \"///\", \"#\"",
            style));

    // Splits `text` on embedded newlines (tolerating a trailing "\r" per line for CRLF input) and
    // appends each resulting line to `target` individually - `summary`/`description`/a single
    // param's `description` are otherwise treated as one opaque line each, which is harmless for
    // the "/** */" style (a C-family block comment tolerates a raw newline mid-comment just fine)
    // but corrupts "//"/"///"/"#" output: a real multi-paragraph OpenAPI description commonly
    // contains "\n", and an un-prefixed continuation line for those styles isn't a comment at all
    // - it splices straight into the surrounding source.
    auto appendLines = [](vector<string>& target, const string& text) {
        size_t start = 0;
        while (true) {
            auto pos = text.find('\n', start);
            auto line = pos == string::npos ? text.substr(start) : text.substr(start, pos - start);
            if (!line.empty() && line.back() == '\r')
                line.pop_back();
            target.push_back(line);
            if (pos == string::npos)
                break;
            start = pos + 1;
        }
    };

    vector<string> paramLines;
    if (args.size() >= 3) {
        auto params = args[2].getIf<Node::Vec>();
        if (params) {
            for (const auto& p : *params) {
                auto m = p.getIf<Node::Map>();
                if (!m)
                    continue;
                auto nameIt = m->find("name");
                auto descIt = m->find("description");
                if (descIt == m->end())
                    continue;
                auto desc = descIt->second.getIf<string>();
                if (!desc || desc->empty())
                    continue;
                auto name = nameIt != m->end() && nameIt->second.getIf<string>() ? *nameIt->second.getIf<string>() : "";
                // A multi-line param description gets "@param name" on its first line only;
                // continuation lines are plain text, matching how every other doc-comment
                // convention here renders a wrapped @param description.
                vector<string> descLines;
                appendLines(descLines, *desc);
                paramLines.push_back(format("@param {} {}", name, descLines[0]));
                for (size_t i = 1; i < descLines.size(); i++)
                    paramLines.push_back(descLines[i]);
            }
        }
    }

    vector<string> lines;
    for (auto s : { getOptStr(0), getOptStr(1) })
        if (s && !s->empty())
            appendLines(lines, *s);
    if (!paramLines.empty()) {
        if (!lines.empty())
            lines.push_back("");
        for (auto& l : paramLines)
            lines.push_back(l);
    }

    if (lines.empty())
        return { Node::NullValue };

    if (style == "/** */") {
        if (lines.size() == 1)
            return { format("/** {} */", lines[0]) };
        stringstream ss;
        ss << "/**";
        for (const auto& l : lines)
            ss << "\n" << (l.empty() ? " *" : " * " + l);
        ss << "\n */";
        return { ss.str() };
    }

    // "//" / "///" / "#": every line (including the blank separator before @param lines) gets its
    // own leading marker, with no trailing space on an otherwise-blank line - mirrors "/** */"'s
    // bare " *" continuation line above.
    stringstream ss;
    for (size_t i = 0; i < lines.size(); i++) {
        if (i > 0)
            ss << "\n";
        ss << style;
        if (!lines[i].empty())
            ss << " " << lines[i];
    }
    return { ss.str() };
}

// Disambiguates `candidate` against `reservedNames`: returns `candidate` unchanged if it doesn't
// collide, else the first of `candidateWrapper`, `candidateWrapper2`, `candidateWrapper3`, ... not
// itself in `reservedNames`. For a generator's hint-derived synthetic type name that turns out to
// collide with a real top-level schema's own generated name (nameOf() only resolves names reached
// via $ref, so every generator that synthesizes a name for an inline oneOf/allOf/object needs its
// own collision check against real schema names).
Node nodeDisambiguateName(const Node::Vec& args)
{
    if (args.size() < 2)
        throw runtime_error(
            "<f9f48ac8> disambiguateName requires 2 arguments (candidate: string, reservedNames: [string])");
    auto candidate = args[0].get<string>();
    auto reservedVec = args[1].getIf<Node::Vec>();
    if (!reservedVec)
        throw runtime_error("<af74e55c> disambiguateName's reservedNames argument must be an array of strings");
    set<string> reserved;
    for (const auto& n : *reservedVec)
        if (auto s = n.getIf<string>())
            reserved.insert(*s);

    if (!reserved.count(candidate))
        return { candidate };
    if (auto withWrapper = candidate + "Wrapper"; !reserved.count(withWrapper))
        return { withWrapper };
    for (int i = 2;; i++) {
        auto attempt = format("{}Wrapper{}", candidate, i);
        if (!reserved.count(attempt))
            return { attempt };
    }
}

Node dumpNode(const Node::Vec& args)
{
    bool first = true;
    stringstream ss;
    for (const auto& n : args) {
        if (!first)
            ss << ", ";
        else
            first = false;
        ss << n;
    }
    logger.info("<79107a8a> Dump: {}", ss.str());
    return { Node::NullValue };
}

Functions getCommonFunctions()
{
    Functions res;
    res.push_back({ .name = "dump", .func = dumpNode });
    res.push_back({ .name = "toCamelCase", .func = nodeToCamelCase });
    res.push_back({ .name = "toPascalCase", .func = nodeToPascalCase });
    res.push_back({ .name = "toSnakeCase", .func = nodeToSnakeCase });
    res.push_back({ .name = "toScreamingSnakeCase", .func = nodeToScreamingSnakeCase });
    res.push_back({ .name = "isValidIdentifier", .func = nodeIsValidIdentifier });
    res.push_back({ .name = "sanitizeIdentifier", .func = nodeSanitizeIdentifier });
    res.push_back({ .name = "toStringLiteral", .func = nodeToStringLiteral });
    res.push_back({ .name = "splitPathTemplate", .func = nodeSplitPathTemplate });
    res.push_back({ .name = "buildDocComment", .func = nodeBuildDocComment });
    res.push_back({ .name = "disambiguateName", .func = nodeDisambiguateName });
    return res;
}

}
