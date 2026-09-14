#pragma once

#include <optional>
#include <string>

namespace Generator {

// Looks up the line-comment style ("//" or "#" - the two styles this table currently uses,
// though a generator.yml commentStyle override may still pick "/** */"/"///" - see
// buildDocComment) for outFileName's extension, so the engine knows how to wrap an
// auto-generated-file header for a file it's about to write. Returns nullopt for an unrecognized
// extension (e.g. a future .json output, which has no comment syntax at all) - the caller must
// skip header injection entirely in that case rather than corrupt the file.
std::optional<std::string> commentStyleForExtension(const std::string& outFileName);

// The engine's own default header text (used unless the CLI's --header overrides it) - names the
// specific generator that produced the file, since "openapi-yagen" alone doesn't tell a reader
// which of several generators/specs to look at when tracking a file back to its source.
std::string defaultHeaderText(const std::string& generatorName);

}
