#pragma once

#include <filesystem>
#include <optional>
#include <string>

#include "definitions.h"

namespace FS {

std::string readFile(const std::string& filePath);

// True if `relPath` is safe to resolve relative to any root directory: not absolute, and doesn't
// net upward (via `..`) once lexically normalized - regardless of how deeply the `..` segments are
// nested (`a/../../x` normalizes to `../x`, still rejected; `a/b/../c` normalizes to `a/c`, still
// allowed). Doesn't touch the real filesystem, so it applies uniformly to every backend
// (directory, zip, remote) as the first line of defense against a generator/template requesting a
// path outside its intended root.
bool isPathTraversalSafe(const std::string& relPath);

// Resolves `relPath` under `rootDir` and returns the canonical result, or nullopt if it would
// escape `rootDir` - including via a symlink inside `rootDir` pointing elsewhere, which
// isPathTraversalSafe alone can't catch since it only inspects the path string. Use `mustExist`
// true for reads (the target is expected to already exist - uses std::filesystem::canonical) and
// false for writes (intermediate directories may not exist yet - uses weakly_canonical).
std::optional<std::filesystem::path> confineToRoot(const std::string& rootDir, const std::string& relPath, bool mustExist);

}
