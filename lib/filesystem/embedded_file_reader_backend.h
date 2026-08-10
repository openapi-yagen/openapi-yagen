#pragma once

#include <string>

#include "file_reader.h"

namespace FS {

// Reads files from a built-in generator embedded into the binary (see
// embedded_generators_registry.h), addressed via `-g builtin:<name>`. A plain in-memory map
// lookup - no real filesystem access at all, so it's inherently immune to path traversal.
class EmbeddedFileReaderBackend : public FileReaderBackend {
public:
    EmbeddedFileReaderBackend(const std::string& generatorName);
    std::optional<std::string> read(const std::string& filePath) override;

private:
    std::string generatorName;
};

class EmbeddedFileReaderBackendFactory : public FileReaderBackendFactory {
public:
    FileReaderBackendPtr createBackend(const std::string& uri) override;
    bool isUriSupported(const std::string& uri) override;
};

}
