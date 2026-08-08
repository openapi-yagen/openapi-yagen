#pragma once

#include "../document.h"
#include "../version.h"

namespace OpenApi::V3 {

// Serializes a canonical Document back into a raw OpenAPI Node tree shaped like `to` (3.0/3.1/
// 3.2). Reconstructs every field from the typed model - NOT a raw+overlay of some original
// source node (there isn't a single one to overlay onto: the source document may have been a
// different version entirely) - so anything the model doesn't cover (vendor extensions, fields
// outside Stage 1's scope) does not survive a cross-version conversion. See the "Fidelity"
// section of the design doc for the full list of what's intentionally out of scope.
//
// Operates on a Document straight out of V3::Read - i.e. BEFORE OpenApi::resolveAllRefs runs, so
// every $ref is still a bare pointer string, not yet aliased into a shared object. This is what
// keeps this writer trivially cycle-safe: a $ref'd Schema/Parameter/etc. is a leaf (just
// `{"$ref": "..."}`), never recursed into.
Node Write(const Document& doc, OpenApiVersion to);

}
