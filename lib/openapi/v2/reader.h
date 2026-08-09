#pragma once

#include "../document.h"

namespace OpenApi::V2 {

// Parses a raw Swagger 2.0 document into the same canonical Document/Schema model
// lib/openapi/v3/reader.h builds (lib/openapi/document.h, lib/openapi/schema.h) - so the rest of
// the engine (generation, the `convert` command, ...) never needs to know which family a spec
// came from. See reader.cpp for exactly how each 2.0-only construct (host/basePath/schemes,
// definitions, body/formData parameters, consumes/produces, flat non-body parameter schemas,
// securityDefinitions' flat oauth2 fields, ...) maps onto the shared model, and for the
// documented, deliberately scoped gaps (e.g. a $ref to a top-level `body`-type parameter
// definition isn't specially detected - see the comment above parseParameters).
//
// Also doubles as structural validation, like V3::Read - required<T>() throws a clear error on
// anything the spec itself requires but the document is missing/misshapes.
Document Read(const NodeWalker& w);

}
