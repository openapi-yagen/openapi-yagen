#include "embedded_generators_registry.h"

#include <format>
#include <stdexcept>
#include <vector>

#include "../common/string_tools.h"

using namespace std;

namespace FS::Embedded {

const GeneratorFiles& requireGenerator(const std::string& generatorName)
{
    const auto& reg = registry();
    auto it = reg.find(generatorName);
    if (it == reg.end()) {
        vector<string> names;
        for (const auto& [name, files] : reg)
            names.push_back(name);
        throw runtime_error(format("<f1a4c9e2> Unknown built-in generator \"{}\". Available: {}", generatorName,
            names | joinToString(", ")));
    }
    return it->second;
}

}
