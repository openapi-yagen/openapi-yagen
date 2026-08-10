#include "list_generators_command.h"

#include <iostream>
#include <sstream>

#include <sys/ioctl.h>
#include <unistd.h>

#include <termcolor/termcolor.hpp>

#include <lib/common/node_walker.h>
#include <lib/common/yaml_or_json_parser.h>
#include <lib/filesystem/embedded_generators_registry.h>
#include <lib/generator/generator_metadata.h>

namespace tc = termcolor;

using namespace std;

namespace {

const unsigned int indentWidth = 4;
const unsigned int maxWrapWidth = 100;
const unsigned int minWrapWidth = 40;

unsigned int terminalWidth()
{
    struct winsize w { };
    if (isatty(STDOUT_FILENO) && ioctl(STDOUT_FILENO, TIOCGWINSZ, &w) == 0 && w.ws_col > 0)
        return w.ws_col;
    return maxWrapWidth; // not a tty (piped/redirected output) - wrap to a sane fixed width instead
}

// Greedily packs `text`'s whitespace-separated words into lines no wider than `width`, so a long
// prose description reads as a paragraph instead of one raw line the terminal hard-wraps mid-word.
vector<string> wrapText(const string& text, unsigned int width)
{
    vector<string> lines;
    istringstream words(text);
    string word, line;
    while (words >> word) {
        if (line.empty())
            line = word;
        else if (line.size() + 1 + word.size() <= width)
            line += " " + word;
        else {
            lines.push_back(line);
            line = word;
        }
    }
    if (!line.empty())
        lines.push_back(line);
    return lines;
}

}

ListGeneratorsCommand::ListGeneratorsCommand() { }

void ListGeneratorsCommand::reg(CLI::App& app)
{
    app.add_subcommand("list-generators",
                       "List built-in generators bundled with this binary (use with -g builtin:<name>)")
        ->alias("l")
        ->callback(std::bind(&ListGeneratorsCommand::process, this));
}

void ListGeneratorsCommand::process()
{
    auto wrapWidth = max(minWrapWidth, min(maxWrapWidth, terminalWidth()) - indentWidth);
    string indent(indentWidth, ' ');

    const auto& registry = FS::Embedded::registry();
    bool first = true;
    for (const auto& [name, files] : registry) {
        if (!first)
            cout << "\n";
        first = false;

        auto metadataNode = parseYamlOrJsonToNode(files.at("generator.yml"));
        auto metadata = parseGeneratorMetadata(NodeWalker(metadataNode));

        cout << tc::bold << tc::bright_white << name << tc::reset << "\n";
        if (metadata.description) {
            cout << tc::bright_grey;
            for (const auto& line : wrapText(*metadata.description, wrapWidth))
                cout << indent << line << "\n";
            cout << tc::reset;
        }
    }
}
