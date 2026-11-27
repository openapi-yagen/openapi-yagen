#pragma once

#include <string>

#include "../common/node.h"

// Bundles a multi-file spec into one document, IN PLACE: every $ref pointing at another file
// ({ "$ref": "<relative-file-path>[#<json-pointer>]" }) reachable from `root` is resolved, so that
// afterwards only in-document "#/..." refs remain. `specPath` is the file `root` was parsed from.
// Paths are relative to whichever file the $ref is written in, and every target must lie inside
// `refRoot` (empty = the directory of `specPath`), including after resolving symlinks.
//
// Strict: a $ref that cannot be resolved (missing file, outside `refRoot`, missing fragment, remote
// URL, cycle) throws, naming the $ref, the file and location it is written at, and the reason.
//
// Where the referenced content ends up depends on what the ref points at:
//  - a component of another file ("#/components/<section>/<Name>", "#/definitions/<Name>") is
//    copied into the same section of `root` under the same name, and the $ref is rewritten to point
//    there. Only components actually reachable through refs are copied. Two sources providing the
//    same name merge if their content is identical and throw otherwise;
//  - a $ref standing directly in one of `root`'s own component slots defines that component: the
//    target's content is placed into the slot, and other refs to the same target reuse its name;
//  - a Path Item (under paths/webhooks/callbacks) is always inlined, as is anything referenced by a
//    pointer outside of components (a whole file, "#/paths/~1items", "#/some/key") - real specs use
//    $ref in positions OpenAPI doesn't allow (tags[].description, a whole Operation standing in for
//    `get:`), and those are spliced in on a best-effort basis;
//  - a "#/..." ref inside another file means "root of THAT file". If it doesn't point at a
//    component, the fragment (it may be self-referential, so it can't be inlined) becomes a schema
//    component named after the pointer's last segment.
// "#/..." refs written in `root` itself are left untouched, except for a Path Item referencing
// "#/components/pathItems/<Name>", which is inlined.
//
// Operations taken from another complete OpenAPI document keep that document's authorization: its
// global `security` is written into operations without their own (`[]` if it declares none), the
// security schemes they name are copied over, as are the descriptions of their tags. Files without a
// top-level "openapi"/"swagger" field are plain fragments, so `root`'s own `security` applies.
void resolveExternalRefs(Node& root, const std::string& specPath, const std::string& refRoot = std::string());
