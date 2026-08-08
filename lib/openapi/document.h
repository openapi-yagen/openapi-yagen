#pragma once

#include <map>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "../common/node.h"
#include "../common/node_walker.h"
#include "info.h"
#include "schema.h"
#include "security.h"
#include "version.h"

namespace OpenApi {

struct Example {
    OptStr ref;

    OptStr summary;
    OptStr description;
    std::optional<Node> value;
    OptStr externalValue; // mutually exclusive with value, per spec

    Node raw;
};
using ExamplePtr = std::shared_ptr<Example>;
using ExampleMap = std::map<Str, ExamplePtr>;

// MediaType -> Encoding -> Header -> MediaType (a Header can itself have `content`) is mutually
// recursive; broken by holding Header via HeaderPtr (shared_ptr tolerates an incomplete type)
// instead of by value.
struct Header;
using HeaderPtr = std::shared_ptr<Header>;
using HeaderMap = std::map<Str, HeaderPtr>;

struct Encoding {
    OptStr contentType;
    HeaderMap headers;
    OptStr style;
    std::optional<bool> explode;
    std::optional<bool> allowReserved;
};

struct MediaType {
    SchemaPtr schema;
    std::optional<Node> example;
    ExampleMap examples;
    std::map<Str, Encoding> encoding;
    Node raw;
};

struct Parameter {
    OptStr ref;

    Str name;
    Str in; // "query" | "path" | "header" | "cookie"
    OptStr description;
    bool required = false;
    std::optional<bool> deprecated;
    std::optional<bool> allowEmptyValue;
    OptStr style;
    std::optional<bool> explode;
    std::optional<bool> allowReserved;
    SchemaPtr schema; // mutually exclusive with `content`, per spec
    std::map<Str, MediaType> content;
    std::optional<Node> example;
    ExampleMap examples;

    Node raw;
};
using ParameterPtr = std::shared_ptr<Parameter>;
using ParameterMap = std::map<Str, ParameterPtr>;

// Header Object - identical fields to Parameter, minus `name`/`in` (implied by the map key it's
// stored under and by always being a header).
struct Header {
    OptStr ref;

    OptStr description;
    bool required = false;
    std::optional<bool> deprecated;
    std::optional<bool> allowEmptyValue;
    OptStr style;
    std::optional<bool> explode;
    std::optional<bool> allowReserved;
    SchemaPtr schema;
    std::map<Str, MediaType> content;
    std::optional<Node> example;
    ExampleMap examples;

    Node raw;
};

struct Link {
    OptStr ref;

    OptStr operationRef;
    OptStr operationId;
    std::map<Str, Node> parameters; // param name -> runtime expression/constant value
    std::optional<Node> requestBody;
    OptStr description;
    std::optional<Server> server;

    Node raw;
};
using LinkPtr = std::shared_ptr<Link>;
using LinkMap = std::map<Str, LinkPtr>;

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
    HeaderMap headers;
    std::map<Str, MediaType> content;
    LinkMap links;

    Node raw;
};
using ResponsePtr = std::shared_ptr<Response>;
using ResponseMap = std::map<Str, ResponsePtr>;

// PathItem/Operation/Callback are mutually recursive (a Callback's Path Items have Operations
// that can themselves declare Callbacks); the cycle is broken by holding Callback's Path Items
// via shared_ptr (always fine with an incomplete type) instead of by value.
struct PathItem;

struct Callback {
    OptStr ref;
    std::map<Str, std::shared_ptr<PathItem>> expressions;
    Node raw;
};
using CallbackPtr = std::shared_ptr<Callback>;
using CallbackMap = std::map<Str, CallbackPtr>;

// One method (get/post/...) under a Path Item Object. Parameters here are exactly what the spec
// declared at the operation level - path-level parameters declared as a sibling of "get"/"post"/
// etc are on PathItem::parameters and still need merging in (see collectOperations).
struct Operation {
    OptStr operationId;
    OptStr summary;
    OptStr description;
    std::optional<ExternalDocs> externalDocs;
    std::vector<Str> tags;
    std::vector<ParameterPtr> parameters;
    RequestBodyPtr requestBody; // null if the operation has none
    ResponseMap responses; // keyed by status code string, "default" included as-is
    CallbackMap callbacks;
    std::optional<bool> deprecated;
    // nullopt = inherits the document-level `security` (not overridden); present-but-empty = "no
    // auth for this operation", per spec.
    std::optional<std::vector<SecurityRequirement>> security;
    std::vector<Server> servers;
};

struct PathItem {
    OptStr ref; // "Allows for a referenced definition of this path item" (rarely used)
    OptStr summary;
    OptStr description;
    std::vector<Server> servers;
    std::vector<ParameterPtr> parameters; // common to every operation on this path
    std::map<Str, Operation> operations; // keyed by lowercase HTTP method
};
using Paths = std::map<Str, PathItem>;

// Every HTTP method OpenAPI allows on a Path Item Object. Whether a given target framework
// supports all of them (e.g. some HTTP libraries have no `trace` builder) is a generator concern,
// not a parsing one - PathItem::operations only contains methods the spec actually declared.
extern const std::vector<Str> httpMethods;

struct Components {
    SchemaMap schemas;
    ResponseMap responses;
    ParameterMap parameters;
    ExampleMap examples;
    RequestBodyMap requestBodies;
    HeaderMap headers;
    SecuritySchemeMap securitySchemes;
    LinkMap links;
    CallbackMap callbacks;
    Paths pathItems; // OAS 3.1+
};

struct Document {
    OpenApiVersion version = OpenApiVersion::V3_0;
    Info info;
    std::vector<Server> servers;
    Paths paths;
    Paths webhooks; // OAS 3.1+
    Components components;
    std::vector<SecurityRequirement> security;
    std::vector<Tag> tags;
    std::optional<ExternalDocs> externalDocs;
};

ParameterPtr derefParameter(const Document& doc, const ParameterPtr& parameter);
RequestBodyPtr derefRequestBody(const Document& doc, const RequestBodyPtr& requestBody);
ResponsePtr derefResponse(const Document& doc, const ResponsePtr& response);
HeaderPtr derefHeader(const Document& doc, const HeaderPtr& header);
CallbackPtr derefCallback(const Document& doc, const CallbackPtr& callback);

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
