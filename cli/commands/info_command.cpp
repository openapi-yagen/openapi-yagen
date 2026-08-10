#include "info_command.h"

#include <iostream>
#include <memory>
#include <sstream>
#include <vector>

#include <sys/ioctl.h>
#include <unistd.h>

#include <termcolor/termcolor.hpp>

#include <lib/common/node_walker.h>
#include <lib/common/yaml_or_json_parser.h>
#include <lib/filesystem/dir_file_reader_backend.h>
#include <lib/filesystem/embedded_file_reader_backend.h>
#include <lib/filesystem/file_reader.h>
#include <lib/filesystem/remote_file_reader_backend.h>
#include <lib/filesystem/zip_file_reader_backend.h>
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

void printWrapped(const string& text, const string& indent, unsigned int wrapWidth)
{
    cout << tc::bright_grey;
    for (const auto& line : wrapText(text, wrapWidth))
        cout << indent << line << "\n";
    cout << tc::reset;
}

}

InfoCommand::InfoCommand() { }

void InfoCommand::reg(CLI::App& app)
{
    auto cmd = app.add_subcommand("info", "Show a generator's metadata: name, description, OpenAPI version, and declared variables")
                   ->alias("i")
                   ->callback(std::bind(&InfoCommand::process, this));
    cmd->add_option("generator", generatorPath,
                    "Path to generator. It can be a directory, zip archive, HTTP URL, or a built-in generator "
                    "(builtin:<name> - see the list-generators command)")
        ->required();
}

void InfoCommand::process()
{
    vector<FS::FileReaderBackendFactoryPtr> factories = {
        make_shared<FS::EmbeddedFileReaderBackendFactory>(),
        make_shared<FS::DirFileReaderBackendFactory>(),
        make_shared<FS::ZipFileReaderBackendFactory>(),
        make_shared<FS::RemoteFileReaderBackendFactory>(),
    };

    auto fileReader = make_shared<FS::FileReader>(
        FS::FileReader::Opts { { FS::createBackend(generatorPath, factories) } });

    auto metadataNode = parseYamlOrJsonToNode(fileReader->read("generator.yml"));
    auto metadata = parseGeneratorMetadata(NodeWalker(metadataNode));

    auto wrapWidth = max(minWrapWidth, min(maxWrapWidth, terminalWidth()) - indentWidth);
    string indent(indentWidth, ' ');

    cout << tc::bold << tc::bright_white << metadata.name << tc::reset << "\n";
    if (metadata.description)
        printWrapped(*metadata.description, indent, wrapWidth);

    cout << "\n";
    cout << "OpenAPI version: " << metadata.openApiVersion.value_or("3.0")
         << (metadata.openApiVersion ? "" : " (default)") << "\n";
    cout << "Main script: " << metadata.mainScriptPath.value_or("main.js")
         << (metadata.mainScriptPath ? "" : " (default)") << "\n";
    cout << "\n";

    if (metadata.variables.empty()) {
        cout << "This generator has no variables.\n";
        return;
    }

    cout << tc::bold << "Variables:" << tc::reset << "\n";
    bool first = true;
    for (const auto& v : metadata.variables) {
        if (!first)
            cout << "\n";
        first = false;

        cout << indent << tc::bold << v.name << tc::reset << " (" << (v.required ? "required" : "optional") << ")\n";
        if (v.description)
            printWrapped(*v.description, indent + indent, wrapWidth - indentWidth);
        if (v.defaultValue)
            cout << indent << indent << "Default: " << *v.defaultValue << "\n";
    }
}
