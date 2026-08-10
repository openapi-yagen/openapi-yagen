#pragma once

#include <map>
#include <string>

namespace FS::Embedded {

// relative path (within the generator's own src/ root) -> file content
using GeneratorFiles = std::map<std::string, std::string>;

// generator name (matches its generator.yml's `name:` field) -> its files
using Registry = std::map<std::string, GeneratorFiles>;

// Populated at CMake configure/build time - see lib/filesystem/CMakeLists.txt and
// embedded_generators_registry.generated.cpp.in.
const Registry& registry();

// Throws a clear error listing available names if `generatorName` isn't registered.
const GeneratorFiles& requireGenerator(const std::string& generatorName);

}
