#pragma once

#include "../document.h"

namespace OpenApi::V2 {

// Serializes a canonical Document back into a raw Swagger 2.0 Node tree - the reverse of
// reader.h's Read(). Like lib/openapi/v3/writer.h, reconstructs everything from the typed model
// (no raw-node passthrough), and only needs to produce a correct *export* shape: this never feeds
// the generation pipeline's JS bridge (OpenApiGenerator::generate() rejects a generator declaring
// `openApiVersion: "2.0"` - see openapi_generator.cpp - since the JS bridge's overlay pattern
// assumes OAS 3.x's raw shape (`content` maps, nested `schema` on Parameter, ...) throughout, and
// 2.0's shape is structurally too different for that to work). It exists purely for the `convert`
// CLI command's `--to 2.0` and for OpenApiGenerator::generate() converting a 2.0 *source* spec up
// to whatever OAS 3.x version a generator declares (Write() is never called in that direction -
// only V2::Read() + V3::Write() are, both of which do feed the pipeline).
//
// See writer.cpp for exactly which OAS 3.x-only constructs get dropped (with a logged warning
// when the loss is semantically real, e.g. oneOf/anyOf/not, multiple servers, multiple distinct
// content schemas) versus silently omitted (things 2.0 never had a concept of at all, e.g. $defs,
// OAS 3.2 additions) - and the two de-facto conventions used to preserve meaning that would
// otherwise be lost outright: `x-nullable: true` for a nullable schema, and folding a
// `application/x-www-form-urlencoded`/`multipart/form-data` object-schema request body back into
// individual `formData` parameters.
Node Write(const Document& doc);

}
