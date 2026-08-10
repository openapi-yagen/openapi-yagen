#include "tools.h"

#include <fstream>
#include <sstream>

#include <filesystem>
#include <format>

using namespace std;

namespace FS {

std::string readFile(const std::string& filePath)
{
    if (!filesystem::exists(filePath))
        throw runtime_error(format("<4966367b> File not found: {}", filePath));
    try {
        std::ifstream s(filePath);
        std::stringstream buffer;
        buffer << s.rdbuf();
        return buffer.str();
    } catch (const exception& e) {
        throw runtime_error(format("<d70e5c1f> Cannot read file \"{}\"", filePath));
    }
}

bool isPathTraversalSafe(const std::string& relPath)
{
    filesystem::path p(relPath);
    if (p.is_absolute())
        return false;
    auto normalized = p.lexically_normal();
    auto it = normalized.begin();
    return !(it != normalized.end() && *it == "..");
}

std::optional<filesystem::path> confineToRoot(const std::string& rootDir, const std::string& relPath, bool mustExist)
{
    error_code ec;
    auto canonicalRoot = filesystem::weakly_canonical(rootDir, ec);
    if (ec)
        return nullopt;

    auto candidate = filesystem::path(rootDir) / relPath;
    auto canonicalCandidate
        = mustExist ? filesystem::canonical(candidate, ec) : filesystem::weakly_canonical(candidate, ec);
    if (ec)
        return nullopt;

    auto rootStr = canonicalRoot.string();
    auto candidateStr = canonicalCandidate.string();
    if (candidateStr != rootStr && !candidateStr.starts_with(rootStr + filesystem::path::preferred_separator))
        return nullopt;

    return canonicalCandidate;
}

}
