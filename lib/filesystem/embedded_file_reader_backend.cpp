#include "embedded_file_reader_backend.h"

#include "../logger/logger.h"
#include "embedded_generators_registry.h"

using namespace std;

namespace FS {

namespace {
LogFacade::Logger logger("FS::EmbeddedFileReaderBackend");
const string uriPrefix = "builtin:";
}

EmbeddedFileReaderBackend::EmbeddedFileReaderBackend(const std::string& generatorName)
    : generatorName(generatorName)
{
}

std::optional<std::string> EmbeddedFileReaderBackend::read(const std::string& filePath)
{
    logger.debug("<9a2e6c1b> Read builtin:{}/{}", generatorName, filePath);

    const auto& reg = Embedded::registry();
    auto genIt = reg.find(generatorName);
    if (genIt == reg.end())
        return nullopt;

    auto fileIt = genIt->second.find(filePath);
    if (fileIt == genIt->second.end())
        return nullopt;

    return fileIt->second;
}

FileReaderBackendPtr EmbeddedFileReaderBackendFactory::createBackend(const std::string& uri)
{
    auto generatorName = uri.substr(uriPrefix.size());
    Embedded::requireGenerator(generatorName); // throws a clear, listing error if unknown
    return make_shared<EmbeddedFileReaderBackend>(generatorName);
}

bool EmbeddedFileReaderBackendFactory::isUriSupported(const std::string& uri)
{
    return uri.starts_with(uriPrefix);
}

}
