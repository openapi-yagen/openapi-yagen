#pragma once

#include "document.h"

namespace OpenApi {

// Keeps only operations tagged with at least one of `tags` (in doc.paths and doc.webhooks), drops
// now-empty paths, prunes doc.components.schemas/parameters/requestBodies/responses/headers down
// to what's still reachable from a surviving operation, and trims doc.tags to `tags`. No-op if
// `tags` is empty.
//
// `schemaNode` is the same raw, not-yet-typed spec tree `doc` was parsed from (see V3::Read) - the
// JS bridge (OpenApiJsGraphBuilder::buildDocumentValue) clones it wholesale as the `schema` global's
// base object and only *overlays* typed fields from `doc` on top, without deleting stray keys. So
// `schemaNode` is pruned in lockstep with `doc` here (same paths/webhooks/components entries kept),
// otherwise a filtered-out path/model/tag would still leak into JS as unprocessed raw JSON.
//
// Must run after resolveAllRefs() - reachability is computed by pointer identity, relying on
// resolveAllRefs() having already replaced every $ref-only pointer with the actual shared_ptr from
// the corresponding components registry - and before collectOperations()/exposing `doc` to JS.
void filterByTags(Document& doc, Node& schemaNode, const std::vector<Str>& tags);

}
