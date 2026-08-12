#include "zip_file_reader_backend.h"

#include <filesystem>
#include <format>
#include <fstream>

#include <zip/zip.h>

#include "../common/finalize.h"

using namespace std;
using namespace std::filesystem;

namespace FS {

class ZipError : public std::runtime_error {
public:
    ZipError(const std::string& message, int errnum)
        : std::runtime_error(format("{}: {}", message, zip_strerror(errnum)))
    {
    }
};

ZipFileReaderBackend::ZipFileReaderBackend(const std::string& zipPath)
{
    int errnum;
    auto res = zip_openwitherror(zipPath.c_str(), 0, 'r', &errnum);
    if (!res)
        throw ZipError(format("<84e9b859> Cannot open zip=\"{}\"", zipPath), errnum);
    zip = shared_ptr<zip_t>(res, [](auto z) { zip_close(z); });
}

std::optional<string> ZipFileReaderBackend::read(const std::string& filePath)
{
    auto res = zip_entry_open(zip.get(), filePath.c_str());
    if (res == ZIP_ENOENT)
        return nullopt;
    if (res != 0)
        throw ZipError(format("<896c1e42> Cannot open zip entry=\"{}\"", filePath), res);
    finalize { zip_entry_close(zip.get()); };
    void* buf;
    size_t size;
    res = zip_entry_read(zip.get(), &buf, &size);
    if (res < 0)
        throw ZipError(format("<bb2b6f5a> Cannot read zip entry=\"{}\"", filePath), res);
    return string((char*)buf, size);
}

FileReaderBackendPtr ZipFileReaderBackendFactory::createBackend(const std::string& uri)
{
    return make_shared<ZipFileReaderBackend>(uri);
}

bool ZipFileReaderBackendFactory::isUriSupported(const std::string& uri)
{
    if (!is_regular_file(uri) && !is_symlink(uri))
        return false;
    std::ifstream fs(uri, std::ios::binary);
    std::vector<char> head(4, 0);
    std::vector<char> zipHead = { 0x50, 0x4b, 0x03, 0x04 };
    fs.read(head.data(), head.size());
    return head == zipHead;
}
}
