#include "reader.h"

#include "../../logger/logger.h"

using namespace std;

namespace OpenApi::V2 {

namespace {

LogFacade::Logger logger("OpenApi::V2::Read");

// ---- forward declarations (Schema is recursive; PathItem doesn't recurse in 2.0 - no callbacks) ----

SchemaPtr parseSchema(const NodeWalker& w);
ExternalDocs parseExternalDocs(const NodeWalker& w);

vector<Str> parseStringList(const NodeWalker& w)
{
    return w.optionalList([](const NodeWalker& cw) { return cw.required<Str>(); }).value_or(vector<Str>());
}

// The canonical model always uses OAS 3.x's ref prefixes ("#/components/schemas/...", etc, see
// lib/openapi/v3/reader.cpp/writer.cpp) regardless of source version - rewrite 2.0's equivalents
// on the way in, mirroring writer.cpp's rewriteRef in the opposite direction.
Str rewriteRefToCanonical(const Str& ref)
{
    static const pair<string, string> prefixes[] = {
        { "#/definitions/", "#/components/schemas/" },
        { "#/parameters/", "#/components/parameters/" },
        { "#/responses/", "#/components/responses/" },
    };
    for (const auto& [from, to] : prefixes) {
        if (ref.rfind(from, 0) == 0)
            return to + ref.substr(from.size());
    }
    return ref;
}

// ---- Schema Object (2.0's `definitions`/body-parameter schemas: full draft-4, recursive) ----

// Shared with the "Items Object" reader below (parseFlatSchema) for the handful of keywords both
// shapes have in common.
void readCommonConstraints(const NodeWalker& w, Schema& schema)
{
    schema.format = w["format"].optional<Str>();
    schema.defaultValue = w["default"].optional<Node>();
    schema.multipleOf = w["multipleOf"].optional<Node>();
    schema.minimum = w["minimum"].optional<Node>();
    schema.maximum = w["maximum"].optional<Node>();
    // 2.0, like OAS 3.0, is draft-4-based: exclusiveMinimum/Maximum are booleans paired with
    // minimum/maximum, not a standalone value (that's a 3.1+/2020-12 JSON Schema thing) - fold
    // into the canonical numeric form the same way the v3 reader does.
    if (w["exclusiveMinimum"].optional<bool>().value_or(false) && schema.minimum) {
        schema.exclusiveMinimum = schema.minimum;
        schema.minimum = nullopt;
    }
    if (w["exclusiveMaximum"].optional<bool>().value_or(false) && schema.maximum) {
        schema.exclusiveMaximum = schema.maximum;
        schema.maximum = nullopt;
    }
    schema.minLength = w["minLength"].optional<Node::Int>();
    schema.maxLength = w["maxLength"].optional<Node::Int>();
    schema.pattern = w["pattern"].optional<Str>();
    schema.minItems = w["minItems"].optional<Node::Int>();
    schema.maxItems = w["maxItems"].optional<Node::Int>();
    schema.uniqueItems = w["uniqueItems"].optional<bool>();
    schema.enumValues = w["enum"]
                             .optionalList([](const NodeWalker& cw) { return cw.optional<Node>().value_or(Node{ Node::NullValue }); })
                             .value_or(vector<Node>());
}

// The "Items Object" - a non-recursive-into-object subset used by non-body Parameter/Header
// `items` (and their own nested `items`, for an array of arrays).
SchemaPtr parseFlatSchema(const NodeWalker& w)
{
    auto schema = make_shared<Schema>();
    schema->raw = w.required<Node>();
    auto type = w["type"].optional<Str>();
    if (type)
        schema->type = { *type };
    readCommonConstraints(w, *schema);
    auto itemsWalker = w["items"];
    if (!itemsWalker.isEmpty())
        schema->items = parseFlatSchema(itemsWalker);
    return schema;
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

    if (auto ref = w["$ref"].optional<Str>())
        schema->ref = rewriteRefToCanonical(*ref);
    // Unlike OAS 3.1+, 2.0 doesn't allow $ref siblings at all - if a spec has them anyway
    // (invalid, but tolerated), they're parsed the same as everywhere else; nothing extra to do.

    schema->title = w["title"].optional<Str>();
    schema->description = w["description"].optional<Str>();

    auto type = w["type"].optional<Str>(); // always a single string in 2.0 - no type arrays
    if (type)
        schema->type = { *type };
    // 2.0 has no "nullable" keyword at all (it predates the concept); the de-facto
    // `x-nullable`/`x-nullable: true` vendor-extension convention (Autorest, drf-yasg, ...) is
    // common enough in practice to honor on read, even though it isn't part of the official spec.
    if (w["x-nullable"].optional<bool>().value_or(false)) {
        if (schema->type.empty())
            schema->type.push_back("object"); // shouldn't normally happen; keeps `type` non-empty
        schema->type.push_back("null");
    }

    readCommonConstraints(w, *schema);

    schema->properties = w["properties"].optionalMap(parseSchema).value_or(SchemaMap());
    schema->required = parseStringList(w["required"]);

    auto itemsWalker = w["items"];
    if (!itemsWalker.isEmpty())
        schema->items = parseSchema(itemsWalker);

    auto additionalPropertiesWalker = w["additionalProperties"];
    if (auto raw = additionalPropertiesWalker.optional<Node>()) {
        if (auto b = raw->getIf<Node::Bool>())
            schema->additionalPropertiesBool = *b;
        else if (raw->getIf<Node::Map>())
            schema->additionalPropertiesSchema = parseSchema(additionalPropertiesWalker);
    }

    schema->allOf = w["allOf"].optionalList(parseSchema).value_or(vector<SchemaPtr>());
    // 2.0 has no oneOf/anyOf/not (added later, alongside the 3.0 JSON-Schema alignment) and no
    // Discriminator Object - `discriminator` here is just the bare property-name string.
    if (auto d = w["discriminator"].optional<Str>())
        schema->discriminator = Discriminator { .propertyName = *d, .mapping = {}, .defaultMapping = nullopt };

    schema->readOnly = w["readOnly"].optional<bool>();
    auto xmlWalker = w["xml"];
    if (!xmlWalker.isEmpty())
        schema->xml = parseXML(xmlWalker);
    auto extDocsWalker = w["externalDocs"];
    if (!extDocsWalker.isEmpty())
        schema->externalDocs = parseExternalDocs(extDocsWalker);
    schema->example = w["example"].optional<Node>();

    return schema;
}

// ---- Info / Tag / ExternalDocs / Server synthesis ----

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
        .identifier = nullopt, // OAS 3.1+ only
    };
}

Info parseInfo(const NodeWalker& w)
{
    Info info;
    info.title = w["title"].required<Str>();
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

// host + basePath + schemes -> one Server per scheme (e.g. "https", "http") - the closest
// equivalent OAS 3.x concept. `schemes` defaults to a single implicit entry (the spec is silent
// about which - most tooling assumes "https") when absent but `host` is present; with no `host`
// at all, no servers are synthesized (2.0 also allows an entirely relative API, resolved against
// whatever document served the spec - there's nothing to put in a Server URL for that case).
vector<Server> synthesizeServers(const NodeWalker& w)
{
    auto host = w["host"].optional<Str>();
    if (!host)
        return {};
    auto basePath = w["basePath"].optional<Str>().value_or("");
    auto schemes = parseStringList(w["schemes"]);
    if (schemes.empty())
        schemes.push_back("https");

    vector<Server> servers;
    for (const auto& scheme : schemes)
        servers.push_back(Server { .url = scheme + "://" + *host + basePath, .description = nullopt, .variables = {} });
    return servers;
}

// ---- Security ----

SecuritySchemePtr parseSecurityScheme(const NodeWalker& w)
{
    auto s = make_shared<SecurityScheme>();
    s->raw = w.required<Node>();
    auto type = w["type"].required<Str>();
    s->description = w["description"].optional<Str>();

    if (type == "basic") {
        s->type = "http";
        s->scheme = "basic";
    } else if (type == "apiKey") {
        s->type = "apiKey";
        s->name = w["name"].optional<Str>();
        s->in = w["in"].optional<Str>();
    } else if (type == "oauth2") {
        s->type = "oauth2";
        OAuthFlows flows;
        OAuthFlow flow;
        flow.authorizationUrl = w["authorizationUrl"].optional<Str>();
        flow.tokenUrl = w["tokenUrl"].optional<Str>();
        flow.scopes = w["scopes"].optionalMap([](const NodeWalker& cw) { return cw.required<Str>(); }).value_or(map<Str, Str>());
        auto flowName = w["flow"].optional<Str>().value_or("");
        if (flowName == "implicit")
            flows.implicit_ = flow;
        else if (flowName == "password")
            flows.password = flow;
        else if (flowName == "application")
            flows.clientCredentials = flow;
        else if (flowName == "accessCode")
            flows.authorizationCode = flow;
        else
            logger.info("<a1b2c3d4> Unrecognized oauth2 \"flow\" value \"{}\" - security scheme ignored", flowName);
        s->flows = flows;
    } else {
        logger.info("<b2c3d4e5> Unrecognized security scheme type \"{}\" - kept as-is, unmapped", type);
        s->type = type;
    }

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

// ---- Header (flat shape, like Items Object + description) ----

HeaderPtr parseHeader(const NodeWalker& w)
{
    auto h = make_shared<Header>();
    h->raw = w.required<Node>();
    h->description = w["description"].optional<Str>();
    auto flat = parseFlatSchema(w);
    h->schema = flat;
    return h;
}

// ---- consumes/produces resolution + content-map synthesis ----

struct DocContext {
    vector<Str> consumes;
    vector<Str> produces;
};

map<Str, MediaType> synthesizeContent(const vector<Str>& mediaTypes, const SchemaPtr& schema)
{
    map<Str, MediaType> content;
    // No declared media type at all is unusual but not invalid - fall back to a reasonable
    // default so the schema isn't silently lost.
    auto effective = mediaTypes.empty() ? vector<Str> { "application/json" } : mediaTypes;
    for (const auto& mt : effective) {
        MediaType media;
        media.schema = schema;
        content[mt] = media;
    }
    return content;
}

// ---- Parameter parsing: splits each operation's parameter list into (non-body) Parameters, a
// synthesized `body` RequestBody, and formData parameters merged into one synthesized RequestBody.
// ----

// A $ref'd parameter (e.g. {"$ref": "#/parameters/Foo"}) is NOT eagerly resolved here to check
// whether it's a body/formData parameter - that would need looking up the top-level `parameters`
// registry while still parsing it. It's kept as an ordinary, unresolved Parameter stub (like the
// v3 reader does for every other $ref), which OpenApi::resolveAllRefs later resolves against
// components.parameters normally. In the rare case where the referenced definition is actually
// `in: body`/`formData`, it will NOT be folded into the operation's requestBody the way an inline
// one is - a documented, deliberately scoped gap (body/formData parameters are overwhelmingly
// declared inline per-operation in practice, since each operation's body usually has its own
// distinct shape).
struct ParsedParams {
    vector<ParameterPtr> parameters;
    RequestBodyPtr requestBody;
};

ParsedParams parseOperationParameters(const vector<NodeWalker>& items, const DocContext& ctx)
{
    ParsedParams result;
    SchemaMap formDataProps;
    vector<Str> formDataRequired;
    Node formDataRaw = Node { Node::Map() };

    for (const auto& item : items) {
        if (item.isEmpty())
            continue;
        if (auto ref = item["$ref"].optional<Str>()) {
            auto p = make_shared<Parameter>();
            p->raw = item.required<Node>();
            p->ref = rewriteRefToCanonical(*ref);
            result.parameters.push_back(p);
            continue;
        }

        auto in = item["in"].required<Str>();
        if (in == "body") {
            auto bodySchema = parseSchema(item["schema"]);
            auto rb = make_shared<RequestBody>();
            rb->raw = item.required<Node>();
            rb->description = item["description"].optional<Str>();
            rb->required = item["required"].optional<bool>().value_or(false);
            rb->content = synthesizeContent(ctx.consumes, bodySchema);
            result.requestBody = rb;
        } else if (in == "formData") {
            auto name = item["name"].required<Str>();
            formDataProps[name] = parseFlatSchema(item);
            if (item["required"].optional<bool>().value_or(false))
                formDataRequired.push_back(name);
        } else {
            auto p = make_shared<Parameter>();
            p->raw = item.required<Node>();
            p->name = item["name"].required<Str>();
            p->in = in;
            p->description = item["description"].optional<Str>();
            p->required = item["required"].optional<bool>().value_or(in == "path");
            p->allowEmptyValue = item["allowEmptyValue"].optional<bool>();
            p->schema = parseFlatSchema(item);
            if (!p->schema->type.empty() && p->schema->type.front() == "array") {
                auto cf = item["collectionFormat"].optional<Str>().value_or("csv");
                if (cf == "csv") {
                    p->style = "form";
                    p->explode = false;
                } else if (cf == "multi") {
                    p->style = "form";
                    p->explode = true;
                } else if (cf == "ssv") {
                    p->style = "spaceDelimited";
                } else if (cf == "pipes") {
                    p->style = "pipeDelimited";
                } else {
                    logger.info("<c3d4e5f6> collectionFormat \"tsv\" has no OAS 3.x equivalent - "
                                "parameter \"{}\" array serialization left unspecified",
                                p->name);
                }
            }
            result.parameters.push_back(p);
        }
    }

    if (!formDataProps.empty()) {
        auto formSchema = make_shared<Schema>();
        formSchema->type = { "object" };
        formSchema->properties = formDataProps;
        formSchema->required = formDataRequired;
        formSchema->raw = formDataRaw;
        auto rb = make_shared<RequestBody>();
        rb->raw = formDataRaw;
        rb->required = !formDataRequired.empty();
        auto formMediaTypes = ctx.consumes;
        if (formMediaTypes.empty())
            formMediaTypes = { "application/x-www-form-urlencoded" };
        rb->content = synthesizeContent(formMediaTypes, formSchema);
        result.requestBody = rb; // a 2.0 operation has either body or formData params, never both
    }

    return result;
}

ResponsePtr parseResponse(const NodeWalker& w, const DocContext& ctx)
{
    auto r = make_shared<Response>();
    r->raw = w.required<Node>();
    if (auto ref = w["$ref"].optional<Str>())
        r->ref = rewriteRefToCanonical(*ref);
    if (r->ref)
        return r;
    r->description = w["description"].optional<Str>();
    r->headers = w["headers"].optionalMap(parseHeader).value_or(HeaderMap());
    auto schemaWalker = w["schema"];
    if (!schemaWalker.isEmpty())
        r->content = synthesizeContent(ctx.produces, parseSchema(schemaWalker));
    return r;
}

Operation parseOperation(const NodeWalker& w, const DocContext& docCtx, const vector<NodeWalker>& pathLevelParams)
{
    Operation op;
    op.operationId = w["operationId"].optional<Str>();
    op.summary = w["summary"].optional<Str>();
    op.description = w["description"].optional<Str>();
    auto edw = w["externalDocs"];
    if (!edw.isEmpty())
        op.externalDocs = parseExternalDocs(edw);
    op.tags = parseStringList(w["tags"]);
    op.deprecated = w["deprecated"].optional<bool>();
    auto secw = w["security"];
    if (!secw.isEmpty())
        op.security = parseSecurityRequirements(secw);

    DocContext ctx = docCtx;
    if (auto c = w["consumes"].optional<Node>())
        ctx.consumes = parseStringList(w["consumes"]);
    if (auto p = w["produces"].optional<Node>())
        ctx.produces = parseStringList(w["produces"]);

    // Path-item-level parameters, then operation-level ones layered on top - approximated by
    // concatenating both lists (operation-level entries come last, so a formData/body set at the
    // operation level naturally wins via parseOperationParameters's "last write wins" behavior;
    // regular Parameters are merged the usual way downstream, in collectOperations()).
    vector<NodeWalker> combined = pathLevelParams;
    auto paramsWalker = w["parameters"];
    if (!paramsWalker.isEmpty()) {
        auto opParams = paramsWalker.requiredList([](const NodeWalker& cw) { return cw; });
        combined.insert(combined.end(), opParams.begin(), opParams.end());
    }
    auto parsed = parseOperationParameters(combined, ctx);
    op.parameters = parsed.parameters;
    op.requestBody = parsed.requestBody;

    op.responses = w["responses"].optionalMap([&](const NodeWalker& cw) { return parseResponse(cw, ctx); }).value_or(ResponseMap());

    return op;
}

PathItem parsePathItem(const NodeWalker& w, const DocContext& docCtx)
{
    PathItem item;
    auto pathLevelParams = w["parameters"].optionalList([](const NodeWalker& cw) { return cw; }).value_or(vector<NodeWalker>());
    for (const auto& method : { "get", "put", "post", "delete", "options", "head", "patch" }) {
        auto opWalker = w[method];
        if (!opWalker.isEmpty())
            item.operations[method] = parseOperation(opWalker, docCtx, pathLevelParams);
    }
    return item;
}

}

Document Read(const NodeWalker& w)
{
    Document doc;
    doc.version = OpenApiVersion::V2_0;
    doc.info = parseInfo(w["info"]);
    doc.servers = synthesizeServers(w);

    DocContext docCtx;
    docCtx.consumes = parseStringList(w["consumes"]);
    docCtx.produces = parseStringList(w["produces"]);

    doc.paths = w["paths"].optionalMap([&](const NodeWalker& cw) { return parsePathItem(cw, docCtx); }).value_or(Paths());

    doc.components.schemas = w["definitions"].optionalMap(parseSchema).value_or(SchemaMap());

    // Top-level reusable parameter definitions - `in: body`/`formData` ones are kept in the same
    // registry using the best fidelity that fits Parameter's shape (schema built from the flat
    // fields/body schema directly, `in` left as "body"/"formData" verbatim) rather than dropped,
    // even though a $ref to one won't be folded into a requestBody the way an inline one is (see
    // the comment on parseOperationParameters).
    doc.components.parameters = w["parameters"].optionalMap([](const NodeWalker& cw) {
                                        auto p = make_shared<Parameter>();
                                        p->raw = cw.required<Node>();
                                        p->name = cw["name"].optional<Str>().value_or("");
                                        p->in = cw["in"].required<Str>();
                                        p->description = cw["description"].optional<Str>();
                                        p->required = cw["required"].optional<bool>().value_or(p->in == "path");
                                        if (p->in == "body")
                                            p->schema = parseSchema(cw["schema"]);
                                        else
                                            p->schema = parseFlatSchema(cw);
                                        return p;
                                    })
                                    .value_or(ParameterMap());

    doc.components.responses = w["responses"].optionalMap([&](const NodeWalker& cw) { return parseResponse(cw, docCtx); }).value_or(ResponseMap());

    doc.components.securitySchemes
        = w["securityDefinitions"].optionalMap(parseSecurityScheme).value_or(SecuritySchemeMap());

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
