#pragma once

#include <string>

#include "../common/node.h"

// Resolves every non-standard EXTERNAL $ref ({ "$ref": "<relative-file-path>[#<json-pointer>]" })
// reachable from `root`, IN PLACE, by loading the referenced file from disk and splicing its
// content (or the value at <json-pointer>, if given) in place of the {$ref: ...} node - recursing
// into freshly-loaded content too, in case it has further external refs of its own. Every
// candidate file path is resolved relative to whichever file is doing the referencing (root spec
// for top-level refs, that file's own directory once inside a loaded file) and reconfirmed to
// still land inside `specDir`'s own tree (see FS::confineToRoot) - this can only ever read files
// that live alongside the spec you pointed us at, never escape it.
//
// $ref values starting with "#" (local, in-document pointers) found in the TOP-LEVEL document are
// left completely untouched, for the existing typed-reader + resolveAllRefs
// (lib/openapi/resolve.h) machinery to keep resolving exactly as it does today (e.g.
// "#/components/schemas/Foo"). A bare "#/..." ref found INSIDE a freshly-loaded external file is a
// different case - per JSON Reference semantics it means "root of THAT file", used by some shared
// utility files to cross-reference their own sibling keys (DigitalOcean's shared/pages.yml). Since
// such a fragment can legitimately be self-referential (a recursive schema like DigitalOcean's
// apiAgent, whose own child_agents contains more apiAgent items - naive inlining-by-value can't
// represent that, it's infinite once flattened), it's instead hoisted into the root document's own
// `components.schemas` under a fresh unique name and rewritten to a normal
// "#/components/schemas/<Name>" ref - reusing the existing, already cycle-safe (shared_ptr
// identity based) schema resolution machinery instead of reinventing it. Each distinct (file,
// pointer) pair is hoisted at most once (memoized), so repeated references to the same fragment
// share one schema.
//
// This is deliberately spec-illegal in scope: real OpenAPI only allows $ref in a handful of
// positions (Schema/Parameter/RequestBody/Header/Response/Example/Link/Callback/PathItem) - this
// resolves an external $ref found ANYWHERE in the document (e.g. a Redocly-bundled spec's
// tags[].description, or a whole Operation standing in for `get:`/`post:`/... as seen in
// DigitalOcean's public spec) on a pragmatic best-effort basis.
//
// A missing/unreadable/out-of-tree target doesn't fail the read: the {$ref: ...} node becomes
// Node{} (absent - same sentinel NodeWalker already uses for "field not present"), with a warning
// logged. A field that's actually required still fails with its own normal "value expected" error
// if left absent this way - required-field strictness is unaffected.
void resolveExternalRefs(Node& root, const std::string& specDir);
