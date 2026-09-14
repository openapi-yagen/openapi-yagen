#pragma once

#include "../common/function.h"

namespace Generator {

Functions getCommonFunctions();

// Exported for reuse outside the JS bridge - see file_header.cpp's writeGeneratedFile(), which
// calls this directly (in-process, no JS round-trip) to format the auto-generated-file header in
// whichever of the 4 buildDocComment styles applies, instead of duplicating that per-style
// line-wrapping logic.
Node nodeBuildDocComment(const Node::Vec& args);

}
