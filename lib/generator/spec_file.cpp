#include "spec_file.h"

#include <filesystem>
#include <format>
#include <stdexcept>

#include "../common/yaml_or_json_parser.h"
#include "../filesystem/tools.h"
#include "external_ref_resolver.h"

using namespace std;

Node readSpecFile(const string& filePath)
{
    try {
        auto specFile = FS::readFile(filePath);
        auto node = parseYamlOrJsonToNode(specFile);
        resolveExternalRefs(node, filesystem::path(filePath).parent_path().string());
        return node;
    } catch (const exception& e) {
        throw runtime_error(format("<2b4ec139> Cannot read spec file \"{}\". Error: {}", filePath, e.what()));
    }
}
