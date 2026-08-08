#include "spec_file.h"

#include <format>
#include <stdexcept>

#include "../common/yaml_or_json_parser.h"
#include "../filesystem/tools.h"

using namespace std;

Node readSpecFile(const string& filePath)
{
    try {
        auto specFile = FS::readFile(filePath);
        return parseYamlOrJsonToNode(specFile);
    } catch (const exception& e) {
        throw runtime_error(format("<2b4ec139> Cannot read spec file \"{}\". Error: {}", filePath, e.what()));
    }
}
