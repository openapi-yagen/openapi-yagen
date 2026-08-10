#include "remote_file_reader_backend.h"

#include <format>

#include "../common/process_executor.h"
#include "../common/string_tools.h"
#include "../logger/logger.h"

using namespace std;

namespace FS {

namespace {
LogFacade::Logger logger("FS::RemoteFileReaderBackend");
}

RemoteFileReaderBackend::RemoteFileReaderBackend(const std::string& baseUrl)
    : baseUrl(baseUrl)
{
}

std::optional<std::string> RemoteFileReaderBackend::read(const string& filePath)
{
    auto fileUrl = getFileUrl(filePath);
    logger.debug("<7c127a9> Read {}", fileUrl);
    auto cmd = format("curl --fail-with-body {}", shellSingleQuote(fileUrl));
    auto result = ProcessExecutor::executeAndCheckResult(cmd).stdOut;
    return result;
}

string RemoteFileReaderBackend::getFileUrl(const std::string& filePath)
{
    return baseUrl.ends_with("/") || filePath.starts_with("/") ? baseUrl + filePath : baseUrl + "/" + filePath;
}

FileReaderBackendPtr RemoteFileReaderBackendFactory::createBackend(const std::string& uri)
{
    return make_shared<RemoteFileReaderBackend>(uri);
}

bool RemoteFileReaderBackendFactory::isUriSupported(const std::string& uri)
{
    if (!uri.starts_with("http://") && !uri.starts_with("https://"))
        return false;
    return true;
}
}
