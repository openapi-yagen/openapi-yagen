#include "dir_file_reader_backend.h"

#include <filesystem>
#include <format>

#include "../logger/logger.h"
#include "tools.h"

using namespace std;
using namespace std::filesystem;

namespace FS {

namespace {
LogFacade::Logger logger("FS::DirFileReaderBackend");
}

FileReaderBackendPtr DirFileReaderBackendFactory::createBackend(const std::string& uri)
{
    return make_shared<DirFileReaderBackend>(uri);
}

bool DirFileReaderBackendFactory::isUriSupported(const std::string& uri) { return is_directory(uri); }

DirFileReaderBackend::DirFileReaderBackend(const std::string_view& rootDir)
    : rootDir(rootDir)
{
    if (!is_directory(rootDir))
        throw runtime_error(format("<e6b710fc> Root dir path is not directory: {}", rootDir));
}

std::optional<string> DirFileReaderBackend::read(const std::string& filePath)
{
    auto fullPath = path(rootDir) / filePath;
    logger.debug("<06a09bf9> Read file: {}", fullPath.string());
    if (!exists(fullPath))
        return nullopt;

    // Catches a symlink inside rootDir pointing outside it - the caller-facing filePath string
    // itself may contain no ".." at all in that case, so this can't be caught lexically upstream.
    auto confined = confineToRoot(rootDir, filePath, /*mustExist=*/true);
    if (!confined)
        return nullopt;

    return FS::readFile(*confined);
}

}
