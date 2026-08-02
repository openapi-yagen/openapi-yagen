#pragma once

#include <map>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "../common/node.h"
#include "../common/node_walker.h"
#include "schema.h"

namespace OpenApi {

struct Parameter {
    OptStr ref;

    Str name;
    Str in; // "query" | "path" | "header" | "cookie"
    OptStr description;
    bool required = false;
    SchemaPtr schema;

    Node raw;
};
using ParameterPtr = std::shared_ptr<Parameter>;
using ParameterMap = std::map<Str, ParameterPtr>;

struct MediaType {
    SchemaPtr schema;
    Node raw;
};

struct RequestBody {
    OptStr ref;

    OptStr description;
    bool required = false;
    std::map<Str, MediaType> content; // media type (e.g. "application/json") -> MediaType

    Node raw;
};
using RequestBodyPtr = std::shared_ptr<RequestBody>;
using RequestBodyMap = std::map<Str, RequestBodyPtr>;

struct Response {
    OptStr ref;

    OptStr description;
    std::map<Str, MediaType> content;

    Node raw;
};
using ResponsePtr = std::shared_ptr<Response>;
using ResponseMap = std::map<Str, ResponsePtr>;

// One method (get/post/...) under a Path Item Object. Parameters here are exactly what the spec
// declared at the operation level - path-level parameters declared as a sibling of "get"/"post"/
// etc are on PathItem::parameters and still need merging in (see collectOperations).
struct Operation {
    OptStr operationId;
    OptStr summary;
    OptStr description;
    std::vector<Str> tags;
    std::vector<ParameterPtr> parameters;
    RequestBodyPtr requestBody; // null if the operation has none
    ResponseMap responses; // keyed by status code string, "default" included as-is
};

struct PathItem {
    std::vector<ParameterPtr> parameters; // common to every operation on this path
    std::map<Str, Operation> operations; // keyed by lowercase HTTP method
};
using Paths = std::map<Str, PathItem>;

// Every HTTP method OpenAPI allows on a Path Item Object. Whether a given target framework
// supports all of them (e.g. some HTTP libraries have no `trace` builder) is a generator concern,
// not a parsing one - PathItem::operations only contains methods the spec actually declared.
extern const std::vector<Str> httpMethods;

ParameterPtr parseParameter(const NodeWalker& w);
RequestBodyPtr parseRequestBody(const NodeWalker& w);
ResponsePtr parseResponse(const NodeWalker& w);
Operation parseOperation(const NodeWalker& w);
PathItem parsePathItem(const NodeWalker& w);

struct Components {
    SchemaMap schemas;
    ParameterMap parameters;
    RequestBodyMap requestBodies;
    ResponseMap responses;
};

struct Document {
    Components components;
    Paths paths;
};

Document parseDocument(const NodeWalker& w);

ParameterPtr derefParameter(const Document& doc, const ParameterPtr& parameter);
RequestBodyPtr derefRequestBody(const Document& doc, const RequestBodyPtr& requestBody);
ResponsePtr derefResponse(const Document& doc, const ResponsePtr& response);

struct ResolvedOperation {
    Str method; // lowercase: get/put/post/delete/options/head/patch/trace
    Str path;
    OptStr operationId;
    OptStr summary;
    OptStr description;
    std::vector<Str> tags;

    // Path-level and operation-level parameters merged (operation-level wins on the same
    // (in, name) pair, per the OpenAPI spec), each already deref'd.
    std::vector<ParameterPtr> parameters;

    RequestBodyPtr requestBody; // deref'd; null if the operation has none
    ResponseMap responses; // deref'd values, keyed by status code string ("default" included)
};

// Walks every Path Item Object in `doc`, merges path-level and operation-level parameters, and
// deref's parameters/requestBody/responses - so generators get a flat, ready-to-use operation
// list instead of re-deriving this merge/deref bookkeeping themselves. Language-specific policy
// (which tag "owns" an operation, how to name it, type mapping, ...) is deliberately left out;
// that's for the generator to decide.
std::vector<ResolvedOperation> collectOperations(const Document& doc);

}
