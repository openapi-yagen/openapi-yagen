#include "reader.h"

#include <algorithm>

using namespace std;

namespace OpenApi::V3 {

namespace {

// ---- forward declarations (mutual recursion: Schema -> Schema; MediaType -> Encoding -> Header
// -> MediaType; PathItem -> Operation -> Callback -> PathItem) ----

SchemaPtr parseSchema(const NodeWalker& w);
MediaType parseMediaType(const NodeWalker& w);
HeaderPtr parseHeader(const NodeWalker& w);
PathItem parsePathItem(const NodeWalker& w);
ExternalDocs parseExternalDocs(const NodeWalker& w);
Server parseServer(const NodeWalker& w);

vector<Str> parseStringList(const NodeWalker& w)
{
    return w.optionalList([](const NodeWalker& cw) { return cw.required<Str>(); }).value_or(vector<Str>());
}

vector<Server> parseServers(const NodeWalker& w)
{
    return w.optionalList(parseServer).value_or(vector<Server>());
}

map<Str, MediaType> parseContentMap(const NodeWalker& w)
{
    return w.optionalMap(parseMediaType).value_or(map<Str, MediaType>());
}

ExampleMap parseExampleMap(const NodeWalker& w)
{
    return w.optionalMap([](const NodeWalker& cw) {
               auto e = make_shared<Example>();
               e->raw = cw.required<Node>();
               e->ref = cw["$ref"].optional<Str>();
               if (e->ref)
                   return e;
               e->summary = cw["summary"].optional<Str>();
               e->description = cw["description"].optional<Str>();
               e->value = cw["value"].optional<Node>();
               e->externalValue = cw["externalValue"].optional<Str>();
               return e;
           })
        .value_or(ExampleMap());
}

// ---- Schema ----

// Folds OAS 3.0's `nullable: bool` + scalar `type` and OAS 3.1/3.2's `type` array into the
// canonical form (Schema::type as a set of type names, "null" among them if nullable) - accepts
// either source shape regardless of the document's declared version, since some real-world specs
// mix conventions.
void readSchemaType(const NodeWalker& w, Schema& schema)
{
    if (auto typeNode = w["type"].optional<Node>()) {
        if (auto s = typeNode->getIf<Node::String>()) {
            schema.type = { *s };
        } else if (auto vec = typeNode->getIf<Node::Vec>()) {
            for (const auto& t : *vec) {
                if (auto s = t.getIf<Node::String>())
                    schema.type.push_back(*s);
            }
        }
    }
    if (w["nullable"].optional<bool>().value_or(false)) {
        if (find(schema.type.begin(), schema.type.end(), "null") == schema.type.end())
            schema.type.push_back("null");
    }
}

// Folds OAS 3.0's boolean `exclusiveMinimum`/`exclusiveMaximum` (paired with `minimum`/`maximum`)
// and OAS 3.1/3.2's standalone numeric form into the canonical numeric form.
void readExclusiveBound(const NodeWalker& w, const char* key, optional<Node>& exclusiveOut, optional<Node>& inclusiveInOut)
{
    auto node = w[key].optional<Node>();
    if (!node)
        return;
    if (auto b = node->getIf<Node::Bool>()) {
        if (*b && inclusiveInOut) {
            exclusiveOut = inclusiveInOut;
            inclusiveInOut = nullopt;
        }
    } else {
        exclusiveOut = *node;
    }
}

Discriminator parseDiscriminator(const NodeWalker& w)
{
    Discriminator d;
    d.propertyName = w["propertyName"].required<Str>();
    d.mapping
        = w["mapping"].optionalMap([](const NodeWalker& cw) { return cw.required<Str>(); }).value_or(map<Str, Str>());
    return d;
}

XML parseXML(const NodeWalker& w)
{
    XML x;
    x.name = w["name"].optional<Str>();
    x.namespace_ = w["namespace"].optional<Str>();
    x.prefix = w["prefix"].optional<Str>();
    x.attribute = w["attribute"].optional<bool>();
    x.wrapped = w["wrapped"].optional<bool>();
    return x;
}

SchemaPtr parseSchema(const NodeWalker& w)
{
    auto schema = make_shared<Schema>();
    schema->raw = w.required<Node>();

    // OAS 3.1+ allows $ref to coexist with sibling keywords - keep parsing regardless of whether
    // ref is set; a writer targeting OAS 3.0 (which doesn't allow siblings) decides what to do.
    schema->ref = w["$ref"].optional<Str>();

    schema->title = w["title"].optional<Str>();
    schema->description = w["description"].optional<Str>();
    schema->defaultValue = w["default"].optional<Node>();
    schema->deprecated = w["deprecated"].optional<bool>();
    schema->readOnly = w["readOnly"].optional<bool>();
    schema->writeOnly = w["writeOnly"].optional<bool>();
    schema->constValue = w["const"].optional<Node>();

    readSchemaType(w, *schema);
    schema->format = w["format"].optional<Str>();

    schema->multipleOf = w["multipleOf"].optional<Node>();
    schema->minimum = w["minimum"].optional<Node>();
    schema->maximum = w["maximum"].optional<Node>();
    readExclusiveBound(w, "exclusiveMinimum", schema->exclusiveMinimum, schema->minimum);
    readExclusiveBound(w, "exclusiveMaximum", schema->exclusiveMaximum, schema->maximum);
    schema->minLength = w["minLength"].optional<Node::Int>();
    schema->maxLength = w["maxLength"].optional<Node::Int>();
    schema->pattern = w["pattern"].optional<Str>();

    schema->minItems = w["minItems"].optional<Node::Int>();
    schema->maxItems = w["maxItems"].optional<Node::Int>();
    schema->uniqueItems = w["uniqueItems"].optional<bool>();
    auto itemsWalker = w["items"];
    if (!itemsWalker.isEmpty())
        schema->items = parseSchema(itemsWalker);

    schema->properties = w["properties"].optionalMap(parseSchema).value_or(SchemaMap());
    schema->required = parseStringList(w["required"]);
    schema->minProperties = w["minProperties"].optional<Node::Int>();
    schema->maxProperties = w["maxProperties"].optional<Node::Int>();

    auto additionalPropertiesWalker = w["additionalProperties"];
    if (auto raw = additionalPropertiesWalker.optional<Node>()) {
        if (auto b = raw->getIf<Node::Bool>())
            schema->additionalPropertiesBool = *b;
        else if (raw->getIf<Node::Map>())
            schema->additionalPropertiesSchema = parseSchema(additionalPropertiesWalker);
    }

    // A plain required<Node>() would reject a literal `null` entry (e.g. `enum: [foo, bar, null]`)
    // since NodeWalker treats a Null node the same as an absent one - fall back to Null explicitly
    // instead of throwing on what's a perfectly valid enum member.
    schema->enumValues = w["enum"]
                             .optionalList([](const NodeWalker& cw) { return cw.optional<Node>().value_or(Node{ Node::NullValue }); })
                             .value_or(vector<Node>());

    schema->allOf = w["allOf"].optionalList(parseSchema).value_or(vector<SchemaPtr>());
    schema->oneOf = w["oneOf"].optionalList(parseSchema).value_or(vector<SchemaPtr>());
    schema->anyOf = w["anyOf"].optionalList(parseSchema).value_or(vector<SchemaPtr>());
    auto notWalker = w["not"];
    if (!notWalker.isEmpty())
        schema->notSchema = parseSchema(notWalker);

    auto discriminatorWalker = w["discriminator"];
    if (!discriminatorWalker.isEmpty())
        schema->discriminator = parseDiscriminator(discriminatorWalker);

    auto xmlWalker = w["xml"];
    if (!xmlWalker.isEmpty())
        schema->xml = parseXML(xmlWalker);
    auto extDocsWalker = w["externalDocs"];
    if (!extDocsWalker.isEmpty())
        schema->externalDocs = parseExternalDocs(extDocsWalker);

    schema->example = w["example"].optional<Node>();
    schema->examples = w["examples"].optionalList([](const NodeWalker& cw) { return cw.required<Node>(); }).value_or(vector<Node>());

    return schema;
}

// ---- Info / Server / Tag / ExternalDocs ----

ExternalDocs parseExternalDocs(const NodeWalker& w)
{
    ExternalDocs e;
    e.description = w["description"].optional<Str>();
    e.url = w["url"].required<Str>();
    return e;
}

Contact parseContact(const NodeWalker& w)
{
    return {
        .name = w["name"].optional<Str>(),
        .url = w["url"].optional<Str>(),
        .email = w["email"].optional<Str>(),
    };
}

License parseLicense(const NodeWalker& w)
{
    return {
        .name = w["name"].required<Str>(),
        .url = w["url"].optional<Str>(),
        .identifier = w["identifier"].optional<Str>(),
    };
}

Info parseInfo(const NodeWalker& w)
{
    Info info;
    info.title = w["title"].required<Str>();
    info.summary = w["summary"].optional<Str>();
    info.description = w["description"].optional<Str>();
    info.termsOfService = w["termsOfService"].optional<Str>();
    auto contactWalker = w["contact"];
    if (!contactWalker.isEmpty())
        info.contact = parseContact(contactWalker);
    auto licenseWalker = w["license"];
    if (!licenseWalker.isEmpty())
        info.license = parseLicense(licenseWalker);
    info.version = w["version"].required<Str>();
    return info;
}

ServerVariable parseServerVariable(const NodeWalker& w)
{
    ServerVariable sv;
    sv.enumValues = parseStringList(w["enum"]);
    sv.defaultValue = w["default"].required<Str>();
    sv.description = w["description"].optional<Str>();
    return sv;
}

Server parseServer(const NodeWalker& w)
{
    Server s;
    s.url = w["url"].required<Str>();
    s.description = w["description"].optional<Str>();
    s.variables = w["variables"].optionalMap(parseServerVariable).value_or(map<Str, ServerVariable>());
    return s;
}

Tag parseTag(const NodeWalker& w)
{
    Tag t;
    t.name = w["name"].required<Str>();
    t.description = w["description"].optional<Str>();
    auto edw = w["externalDocs"];
    if (!edw.isEmpty())
        t.externalDocs = parseExternalDocs(edw);
    return t;
}

// ---- Security ----

OAuthFlow parseOAuthFlow(const NodeWalker& w)
{
    OAuthFlow f;
    f.authorizationUrl = w["authorizationUrl"].optional<Str>();
    f.tokenUrl = w["tokenUrl"].optional<Str>();
    f.refreshUrl = w["refreshUrl"].optional<Str>();
    f.scopes = w["scopes"].optionalMap([](const NodeWalker& cw) { return cw.required<Str>(); }).value_or(map<Str, Str>());
    return f;
}

OAuthFlows parseOAuthFlows(const NodeWalker& w)
{
    OAuthFlows flows;
    auto fw = w["implicit"];
    if (!fw.isEmpty())
        flows.implicit_ = parseOAuthFlow(fw);
    fw = w["password"];
    if (!fw.isEmpty())
        flows.password = parseOAuthFlow(fw);
    fw = w["clientCredentials"];
    if (!fw.isEmpty())
        flows.clientCredentials = parseOAuthFlow(fw);
    fw = w["authorizationCode"];
    if (!fw.isEmpty())
        flows.authorizationCode = parseOAuthFlow(fw);
    return flows;
}

SecuritySchemePtr parseSecurityScheme(const NodeWalker& w)
{
    auto s = make_shared<SecurityScheme>();
    s->raw = w.required<Node>();
    s->ref = w["$ref"].optional<Str>();
    if (s->ref)
        return s;
    s->type = w["type"].required<Str>();
    s->description = w["description"].optional<Str>();
    s->name = w["name"].optional<Str>();
    s->in = w["in"].optional<Str>();
    s->scheme = w["scheme"].optional<Str>();
    s->bearerFormat = w["bearerFormat"].optional<Str>();
    auto fw = w["flows"];
    if (!fw.isEmpty())
        s->flows = parseOAuthFlows(fw);
    s->openIdConnectUrl = w["openIdConnectUrl"].optional<Str>();
    return s;
}

SecurityRequirement parseSecurityRequirement(const NodeWalker& w)
{
    return w.optionalMap([](const NodeWalker& cw) { return parseStringList(cw); }).value_or(SecurityRequirement());
}

vector<SecurityRequirement> parseSecurityRequirements(const NodeWalker& w)
{
    return w.optionalList(parseSecurityRequirement).value_or(vector<SecurityRequirement>());
}

// ---- MediaType / Encoding / Header / Parameter / Link ----

Encoding parseEncoding(const NodeWalker& w)
{
    Encoding e;
    e.contentType = w["contentType"].optional<Str>();
    e.headers = w["headers"].optionalMap(parseHeader).value_or(HeaderMap());
    e.style = w["style"].optional<Str>();
    e.explode = w["explode"].optional<bool>();
    e.allowReserved = w["allowReserved"].optional<bool>();
    return e;
}

MediaType parseMediaType(const NodeWalker& w)
{
    MediaType mt;
    mt.raw = w.required<Node>();
    auto sw = w["schema"];
    if (!sw.isEmpty())
        mt.schema = parseSchema(sw);
    mt.example = w["example"].optional<Node>();
    mt.examples = parseExampleMap(w["examples"]);
    mt.encoding = w["encoding"].optionalMap(parseEncoding).value_or(map<Str, Encoding>());
    return mt;
}

HeaderPtr parseHeader(const NodeWalker& w)
{
    auto h = make_shared<Header>();
    h->raw = w.required<Node>();
    h->ref = w["$ref"].optional<Str>();
    if (h->ref)
        return h;
    h->description = w["description"].optional<Str>();
    h->required = w["required"].optional<bool>().value_or(false);
    h->deprecated = w["deprecated"].optional<bool>();
    h->allowEmptyValue = w["allowEmptyValue"].optional<bool>();
    h->style = w["style"].optional<Str>();
    h->explode = w["explode"].optional<bool>();
    h->allowReserved = w["allowReserved"].optional<bool>();
    auto sw = w["schema"];
    if (!sw.isEmpty())
        h->schema = parseSchema(sw);
    h->content = parseContentMap(w["content"]);
    h->example = w["example"].optional<Node>();
    h->examples = parseExampleMap(w["examples"]);
    return h;
}

ParameterPtr parseParameter(const NodeWalker& w)
{
    auto p = make_shared<Parameter>();
    p->raw = w.required<Node>();

    p->ref = w["$ref"].optional<Str>();
    if (p->ref)
        return p;

    p->name = w["name"].required<Str>();
    p->in = w["in"].required<Str>();
    p->description = w["description"].optional<Str>();
    // Path parameters are implicitly required even if the spec omits "required" (per spec, they
    // always must be); every other "in" defaults to optional.
    p->required = w["required"].optional<bool>().value_or(p->in == "path");
    p->deprecated = w["deprecated"].optional<bool>();
    p->allowEmptyValue = w["allowEmptyValue"].optional<bool>();
    p->style = w["style"].optional<Str>();
    p->explode = w["explode"].optional<bool>();
    p->allowReserved = w["allowReserved"].optional<bool>();
    auto sw = w["schema"];
    if (!sw.isEmpty())
        p->schema = parseSchema(sw);
    p->content = parseContentMap(w["content"]);
    p->example = w["example"].optional<Node>();
    p->examples = parseExampleMap(w["examples"]);

    return p;
}

LinkPtr parseLink(const NodeWalker& w)
{
    auto l = make_shared<Link>();
    l->raw = w.required<Node>();
    l->ref = w["$ref"].optional<Str>();
    if (l->ref)
        return l;
    l->operationRef = w["operationRef"].optional<Str>();
    l->operationId = w["operationId"].optional<Str>();
    l->parameters
        = w["parameters"].optionalMap([](const NodeWalker& cw) { return cw.required<Node>(); }).value_or(map<Str, Node>());
    l->requestBody = w["requestBody"].optional<Node>();
    l->description = w["description"].optional<Str>();
    auto sw = w["server"];
    if (!sw.isEmpty())
        l->server = parseServer(sw);
    return l;
}

// ---- RequestBody / Response / Callback / Operation / PathItem ----

RequestBodyPtr parseRequestBody(const NodeWalker& w)
{
    auto rb = make_shared<RequestBody>();
    rb->raw = w.required<Node>();

    rb->ref = w["$ref"].optional<Str>();
    if (rb->ref)
        return rb;

    rb->description = w["description"].optional<Str>();
    rb->required = w["required"].optional<bool>().value_or(false);
    rb->content = parseContentMap(w["content"]);

    return rb;
}

ResponsePtr parseResponse(const NodeWalker& w)
{
    auto r = make_shared<Response>();
    r->raw = w.required<Node>();

    r->ref = w["$ref"].optional<Str>();
    if (r->ref)
        return r;

    // Required per spec, but some real-world specs omit it - don't hard-fail generation over a
    // missing description, just leave it unset.
    r->description = w["description"].optional<Str>();
    r->headers = w["headers"].optionalMap(parseHeader).value_or(HeaderMap());
    r->content = parseContentMap(w["content"]);
    r->links = w["links"].optionalMap(parseLink).value_or(LinkMap());

    return r;
}

CallbackPtr parseCallback(const NodeWalker& w)
{
    auto c = make_shared<Callback>();
    c->raw = w.required<Node>();
    c->ref = w["$ref"].optional<Str>();
    if (c->ref)
        return c;
    c->expressions = w.optionalMap([](const NodeWalker& cw) { return make_shared<PathItem>(parsePathItem(cw)); })
                          .value_or(map<Str, shared_ptr<PathItem>>());
    return c;
}

Operation parseOperation(const NodeWalker& w)
{
    Operation op;
    op.operationId = w["operationId"].optional<Str>();
    op.summary = w["summary"].optional<Str>();
    op.description = w["description"].optional<Str>();
    auto edw = w["externalDocs"];
    if (!edw.isEmpty())
        op.externalDocs = parseExternalDocs(edw);
    op.tags = parseStringList(w["tags"]);
    op.parameters = w["parameters"].optionalList(parseParameter).value_or(vector<ParameterPtr>());

    auto requestBodyWalker = w["requestBody"];
    if (!requestBodyWalker.isEmpty())
        op.requestBody = parseRequestBody(requestBodyWalker);

    op.responses = w["responses"].optionalMap(parseResponse).value_or(ResponseMap());
    op.callbacks = w["callbacks"].optionalMap(parseCallback).value_or(CallbackMap());
    op.deprecated = w["deprecated"].optional<bool>();
    auto secw = w["security"];
    if (!secw.isEmpty())
        op.security = parseSecurityRequirements(secw);
    op.servers = parseServers(w["servers"]);

    return op;
}

PathItem parsePathItem(const NodeWalker& w)
{
    PathItem item;
    item.ref = w["$ref"].optional<Str>();
    item.summary = w["summary"].optional<Str>();
    item.description = w["description"].optional<Str>();
    item.servers = parseServers(w["servers"]);
    item.parameters = w["parameters"].optionalList(parseParameter).value_or(vector<ParameterPtr>());
    for (const auto& method : httpMethods) {
        auto opWalker = w[method];
        if (!opWalker.isEmpty())
            item.operations[method] = parseOperation(opWalker);
    }
    return item;
}

Paths parsePaths(const NodeWalker& w)
{
    return w.optionalMap(parsePathItem).value_or(Paths());
}

Components parseComponents(const NodeWalker& w)
{
    Components c;
    c.schemas = w["schemas"].optionalMap(parseSchema).value_or(SchemaMap());
    c.responses = w["responses"].optionalMap(parseResponse).value_or(ResponseMap());
    c.parameters = w["parameters"].optionalMap(parseParameter).value_or(ParameterMap());
    c.examples = parseExampleMap(w["examples"]);
    c.requestBodies = w["requestBodies"].optionalMap(parseRequestBody).value_or(RequestBodyMap());
    c.headers = w["headers"].optionalMap(parseHeader).value_or(HeaderMap());
    c.securitySchemes = w["securitySchemes"].optionalMap(parseSecurityScheme).value_or(SecuritySchemeMap());
    c.links = w["links"].optionalMap(parseLink).value_or(LinkMap());
    c.callbacks = w["callbacks"].optionalMap(parseCallback).value_or(CallbackMap());
    c.pathItems = parsePaths(w["pathItems"]);
    return c;
}

}

Document Read(const NodeWalker& w, OpenApiVersion version)
{
    Document doc;
    doc.version = version;
    doc.info = parseInfo(w["info"]);
    doc.servers = parseServers(w["servers"]);
    doc.paths = parsePaths(w["paths"]);
    doc.webhooks = parsePaths(w["webhooks"]);
    auto componentsWalker = w["components"];
    if (!componentsWalker.isEmpty())
        doc.components = parseComponents(componentsWalker);
    auto securityWalker = w["security"];
    if (!securityWalker.isEmpty())
        doc.security = parseSecurityRequirements(securityWalker);
    doc.tags = w["tags"].optionalList(parseTag).value_or(vector<Tag>());
    auto externalDocsWalker = w["externalDocs"];
    if (!externalDocsWalker.isEmpty())
        doc.externalDocs = parseExternalDocs(externalDocsWalker);
    return doc;
}

}
