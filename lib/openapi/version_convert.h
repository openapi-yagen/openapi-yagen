#pragma once

#include "../common/node.h"
#include "version.h"

namespace OpenApi {

// Converts a raw OpenAPI document from one version to another, at the level of what
// lib/openapi/document.h's model covers (see the design doc's "Fidelity" section for exactly
// what that does and doesn't include). A thin dispatcher, not itself version-aware: it hands off
// to the reader/writer module for `from`'s and `to`'s family (currently only
// lib/openapi/v3/ - OAS 3.0/3.1/3.2; a future Swagger 2.0 module slots in here without touching
// v3/ at all). Throws a clear "not yet supported" error if either version isn't implemented yet.
//
// A no-op (returns `doc` unchanged) when `from == to` is NOT handled here - callers that want to
// skip conversion entirely for the common same-version case (avoiding any fidelity loss at all)
// should check that themselves before calling this.
Node convertVersion(const Node& doc, OpenApiVersion from, OpenApiVersion to);

}
