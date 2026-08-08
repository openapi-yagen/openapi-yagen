#pragma once

#include "../document.h"
#include "../version.h"

namespace OpenApi::V3 {

// Parses a raw OpenAPI 3.0/3.1/3.2 document (`w`) into the canonical Document/Schema model
// (lib/openapi/document.h, lib/openapi/schema.h). Tolerant of both dialect forms for every field
// that actually differs across 3.0/3.1/3.2 (`nullable`+scalar `type` as well as a `type` array;
// boolean `exclusiveMinimum`/`exclusiveMaximum` paired with `minimum`/`maximum` as well as the
// standalone numeric form) regardless of `version` - `version` is recorded on the resulting
// Document and used only for anything that genuinely can't be inferred from shape alone.
//
// This also doubles as spec validation: every field the spec marks required is read via
// NodeWalker::required<T>(), which throws a WalkError (with a path) on anything missing or the
// wrong shape - see docs/generator-format.md for what this does and doesn't catch.
Document Read(const NodeWalker& w, OpenApiVersion version);

}
