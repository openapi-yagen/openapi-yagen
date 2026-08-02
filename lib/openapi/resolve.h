#pragma once

#include "document.h"

namespace OpenApi {

// Fully resolves every $ref reachable from `doc`, IN PLACE: every SchemaPtr/ParameterPtr/
// RequestBodyPtr/ResponsePtr field holding a $ref-only placeholder is replaced with the actual
// shared_ptr from the corresponding components registry (including doc.components.schemas' own
// entries - a pure-alias component like `Foo: {$ref: Bar}` becomes literally Bar's own pointer in
// the map). After this call, nothing reachable from `doc` still has `.ref` set anywhere.
//
// Cycle-safe: a self-referential schema (TreeNode.properties.children.items -> $ref TreeNode)
// terminates - each distinct Schema node (by pointer identity) is visited exactly once, via a
// visited-set local to this call.
//
// Idempotent - safe to call more than once. Call after parseDocument() and before consuming `doc`
// any further (collectOperations(), exposing it to JS, ...).
void resolveAllRefs(Document& doc);

}
