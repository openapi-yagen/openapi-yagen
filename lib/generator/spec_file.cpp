#include "spec_file.h"

#include <filesystem>
#include <format>
#include <fstream>
#include <stdexcept>

#include "../common/yaml_or_json_parser.h"
#include "../filesystem/tools.h"
#include "../openapi/document_field_order.h"
#include "external_ref_resolver.h"

using namespace std;

Node readSpecFile(const string& filePath, const string& refRoot)
{
    try {
        auto specFile = FS::readFile(filePath);
        auto node = parseYamlOrJsonToNode(specFile);
        resolveExternalRefs(node, filePath, refRoot);
        return node;
    } catch (const exception& e) {
        throw runtime_error(format("<2b4ec139> Cannot read spec file \"{}\". Error: {}", filePath, e.what()));
    }
}

void writeSpecFile(const Node& spec, OpenApi::OpenApiVersion version, const string& filePath, const string& format)
{
    auto fieldOrder = OpenApi::documentFieldOrder(version);
    bool asJson = format == "json" || (format.empty() && filePath.ends_with(".json"));
    auto text = asJson ? nodeToJsonText(spec, fieldOrder) : nodeToYamlText(spec, fieldOrder);

    ofstream out(filePath, ios::binary);
    if (!out)
        throw runtime_error(std::format("<e5f6a7b8> Cannot open \"{}\" for writing", filePath));
    out << text;
    out.flush();
    if (!out)
        throw runtime_error(std::format("<f6a7b8c9> Failed writing to \"{}\"", filePath));
}
