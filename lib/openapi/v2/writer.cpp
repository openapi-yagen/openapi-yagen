#include "writer.h"

#include <regex>

#include "../../logger/logger.h"

using namespace std;

namespace OpenApi::V2 {

namespace {

LogFacade::Logger logger("OpenApi::V2::Write");

Node mkStr(const Str& s) { return Node{ s }; }
Node mkBool(bool b) { return Node{ b }; }
Node mkInt(int64_t i) { return Node{ i }; }
Node mkMap(Node::Map m = {}) { return Node{ std::move(m) }; }
Node mkVec(Node::Vec v = {}) { return Node{ std::move(v) }; }

Node writeStringList(const vector<Str>& items)
{
    Node::Vec v;
    for (const auto& s : items)
        v.push_back(mkStr(s));
    return mkVec(std::move(v));
}

// #/components/schemas/X -> #/definitions/X, #/components/parameters/X -> #/parameters/X,
// #/components/responses/X -> #/responses/X - the only three component registries 2.0 has.
// Anything else (a $ref to a header/example/link/callback/securityScheme/pathItem - none of which
// 2.0 has a registry for at all) is left unrewritten and logged, since there's nowhere correct to
// point it.
Str rewriteRef(const Str& ref)
{
    static const pair<string, string> prefixes[] = {
        { "#/components/schemas/", "#/definitions/" },
        { "#/components/parameters/", "#/parameters/" },
        { "#/components/responses/", "#/responses/" },
    };
    for (const auto& [from, to] : prefixes) {
        if (ref.rfind(from, 0) == 0)
            return to + ref.substr(from.size());
    }
    logger.warn("<68953efe> $ref \"{}\" has no Swagger 2.0 equivalent registry - left unrewritten", ref);
    return ref;
}

// ---- forward declarations ----

Node writeSchema(const Schema& schema);
void flattenSchemaIntoFields(Node::Map& m, const Schema& schema);

// ---- Schema (2.0's `definitions`/body-schema shape: full draft-4, recursive) ----

void writeCommonConstraints(Node::Map& m, const Schema& schema)
{
    if (schema.format)
        m["format"] = mkStr(*schema.format);
    if (schema.defaultValue)
        m["default"] = *schema.defaultValue;
    if (schema.multipleOf)
        m["multipleOf"] = *schema.multipleOf;
    // draft-4: exclusiveMinimum/Maximum are booleans paired with minimum/maximum.
    if (schema.exclusiveMinimum) {
        m["minimum"] = *schema.exclusiveMinimum;
        m["exclusiveMinimum"] = mkBool(true);
    } else if (schema.minimum) {
        m["minimum"] = *schema.minimum;
    }
    if (schema.exclusiveMaximum) {
        m["maximum"] = *schema.exclusiveMaximum;
        m["exclusiveMaximum"] = mkBool(true);
    } else if (schema.maximum) {
        m["maximum"] = *schema.maximum;
    }
    if (schema.minLength)
        m["minLength"] = mkInt(*schema.minLength);
    if (schema.maxLength)
        m["maxLength"] = mkInt(*schema.maxLength);
    if (schema.pattern)
        m["pattern"] = mkStr(*schema.pattern);
    if (schema.minItems)
        m["minItems"] = mkInt(*schema.minItems);
    if (schema.maxItems)
        m["maxItems"] = mkInt(*schema.maxItems);
    if (schema.uniqueItems)
        m["uniqueItems"] = mkBool(*schema.uniqueItems);
    if (!schema.enumValues.empty()) {
        Node::Vec vals;
        for (const auto& v : schema.enumValues)
            vals.push_back(v);
        m["enum"] = mkVec(std::move(vals));
    }
}

// Collapses the canonical type set to 2.0's single scalar `type`, folding "null" into the
// de-facto `x-nullable: true` vendor-extension convention (Autorest, drf-yasg, ... - 2.0 has no
// official nullability keyword at all).
void writeType(Node::Map& m, const Schema& schema)
{
    if (schema.type.empty())
        return;
    vector<Str> nonNull;
    bool nullable = false;
    for (const auto& t : schema.type) {
        if (t == "null")
            nullable = true;
        else
            nonNull.push_back(t);
    }
    if (nonNull.size() > 1)
        logger.warn("<b4084c0e> Schema has multiple types ({}) - Swagger 2.0 only supports one; keeping \"{}\"",
                    nonNull.size(), nonNull.front());
    if (!nonNull.empty())
        m["type"] = mkStr(nonNull.front());
    if (nullable)
        m["x-nullable"] = mkBool(true);
}

Node writeXML(const XML& x)
{
    Node::Map m;
    if (x.name)
        m["name"] = mkStr(*x.name);
    if (x.namespace_)
        m["namespace"] = mkStr(*x.namespace_);
    if (x.prefix)
        m["prefix"] = mkStr(*x.prefix);
    if (x.attribute)
        m["attribute"] = mkBool(*x.attribute);
    if (x.wrapped)
        m["wrapped"] = mkBool(*x.wrapped);
    // x.nodeType (OAS 3.2+) has no 2.0 equivalent - silently omitted.
    return mkMap(std::move(m));
}

Node writeExternalDocs(const ExternalDocs& e)
{
    Node::Map m;
    if (e.description)
        m["description"] = mkStr(*e.description);
    m["url"] = mkStr(e.url);
    return mkMap(std::move(m));
}

Node writeSchema(const Schema& schema)
{
    Node::Map m;
    if (schema.ref)
        m["$ref"] = mkStr(rewriteRef(*schema.ref));

    if (schema.title)
        m["title"] = mkStr(*schema.title);
    if (schema.description)
        m["description"] = mkStr(*schema.description);

    writeType(m, schema);
    writeCommonConstraints(m, schema);

    if (schema.items)
        m["items"] = writeSchema(*schema.items);

    if (!schema.properties.empty()) {
        Node::Map props;
        for (const auto& [name, s] : schema.properties)
            props[name] = writeSchema(*s);
        m["properties"] = mkMap(std::move(props));
    }
    if (!schema.required.empty())
        m["required"] = writeStringList(schema.required);

    if (schema.additionalPropertiesBool)
        m["additionalProperties"] = mkBool(*schema.additionalPropertiesBool);
    else if (schema.additionalPropertiesSchema)
        m["additionalProperties"] = writeSchema(*schema.additionalPropertiesSchema);

    if (!schema.allOf.empty()) {
        Node::Vec v;
        for (const auto& s : schema.allOf)
            v.push_back(writeSchema(*s));
        m["allOf"] = mkVec(std::move(v));
    }
    // oneOf/anyOf/not have no Swagger 2.0 equivalent at all (added alongside the 3.0 JSON-Schema
    // alignment) - a real semantic loss, so it's logged rather than silently dropped.
    if (!schema.oneOf.empty() || !schema.anyOf.empty() || schema.notSchema)
        logger.warn("<5397669a> Dropping oneOf/anyOf/not - no Swagger 2.0 equivalent");

    if (schema.discriminator) {
        // 2.0's discriminator is just the bare property-name string - an explicit `mapping` (only
        // representable in OAS 3.x) is lost.
        if (!schema.discriminator->mapping.empty())
            logger.warn("<e864294f> Dropping discriminator.mapping - Swagger 2.0's discriminator is a bare "
                        "property-name string");
        m["discriminator"] = mkStr(schema.discriminator->propertyName);
    }

    if (schema.readOnly)
        m["readOnly"] = mkBool(*schema.readOnly);
    if (schema.xml)
        m["xml"] = writeXML(*schema.xml);
    if (schema.externalDocs)
        m["externalDocs"] = writeExternalDocs(*schema.externalDocs);
    if (schema.example)
        m["example"] = *schema.example;
    else if (!schema.examples.empty())
        m["example"] = schema.examples.front(); // 2.0 has no plural "examples" array

    if (schema.ref && m.size() > 1) {
        // 2.0, like OAS 3.0, doesn't allow $ref siblings.
        return mkMap({ { "$ref", m["$ref"] } });
    }
    return mkMap(std::move(m));
}

// Reverse of the reader's parseFlatSchema/Items-Object shape - used for non-body Parameter,
// Header, and formData-exploded properties, all of which put type/format/items/... directly on
// the object rather than nested under a `schema` key.
void flattenSchemaIntoFields(Node::Map& m, const Schema& schema)
{
    if (!schema.type.empty())
        m["type"] = mkStr(schema.type.front()); // 2.0's Items Object has no nullable concept either
    writeCommonConstraints(m, schema);
    if (schema.items) {
        Node::Map itemsMap;
        flattenSchemaIntoFields(itemsMap, *schema.items);
        m["items"] = mkMap(std::move(itemsMap));
    }
}

// style/explode -> collectionFormat (the reverse of the reader's mapping). Styles with no 2.0
// equivalent (simple/matrix/label/deepObject) are logged and left as 2.0's own default ("csv").
void writeCollectionFormat(Node::Map& m, const Parameter& p)
{
    if (!p.schema || p.schema->type.empty() || p.schema->type.front() != "array")
        return;
    auto style = p.style.value_or("form");
    bool explode = p.explode.value_or(true);
    if (style == "form" && !explode) {
        // "csv" is 2.0's own default - omitting the field is equivalent and reads cleaner.
    } else if (style == "form" && explode) {
        m["collectionFormat"] = mkStr("multi");
    } else if (style == "spaceDelimited") {
        m["collectionFormat"] = mkStr("ssv");
    } else if (style == "pipeDelimited") {
        m["collectionFormat"] = mkStr("pipes");
    } else {
        logger.warn("<e8cd8f99> Parameter \"{}\" style \"{}\" has no Swagger 2.0 collectionFormat equivalent - "
                    "using the default (csv)",
                    p.name, style);
    }
}

// ---- Info / Tag / Security ----

Node writeContact(const Contact& c)
{
    Node::Map m;
    if (c.name)
        m["name"] = mkStr(*c.name);
    if (c.url)
        m["url"] = mkStr(*c.url);
    if (c.email)
        m["email"] = mkStr(*c.email);
    return mkMap(std::move(m));
}

Node writeLicense(const License& l)
{
    Node::Map m;
    m["name"] = mkStr(l.name);
    if (l.url)
        m["url"] = mkStr(*l.url);
    // l.identifier (OAS 3.1+) has no 2.0 equivalent - silently omitted.
    return mkMap(std::move(m));
}

Node writeInfo(const Info& info)
{
    Node::Map m;
    m["title"] = mkStr(info.title);
    // info.summary (OAS 3.1+) has no 2.0 equivalent - silently omitted.
    if (info.description)
        m["description"] = mkStr(*info.description);
    if (info.termsOfService)
        m["termsOfService"] = mkStr(*info.termsOfService);
    if (info.contact)
        m["contact"] = writeContact(*info.contact);
    if (info.license)
        m["license"] = writeLicense(*info.license);
    m["version"] = mkStr(info.version);
    return mkMap(std::move(m));
}

Node writeTag(const Tag& t)
{
    Node::Map m;
    m["name"] = mkStr(t.name);
    if (t.description)
        m["description"] = mkStr(*t.description);
    if (t.externalDocs)
        m["externalDocs"] = writeExternalDocs(*t.externalDocs);
    // summary/parent/kind (OAS 3.2+) have no 2.0 equivalent - silently omitted.
    return mkMap(std::move(m));
}

// Picks host/basePath/scheme(s) out of the first Server's URL - 2.0 can only represent one origin
// (no per-server list, no URL variables). Additional servers are dropped with a warning.
void writeHostBasePathSchemes(Node::Map& m, const vector<Server>& servers)
{
    if (servers.empty())
        return;
    if (servers.size() > 1)
        logger.warn("<f6a7b9c0> {} servers declared - Swagger 2.0 only supports one host/basePath; using the first",
                    servers.size());
    static const regex urlRe(R"(^([a-zA-Z][a-zA-Z0-9+.-]*)://([^/]+)(/.*)?$)");
    smatch match;
    const auto& url = servers.front().url;
    if (!regex_match(url, match, urlRe) || url.find('{') != string::npos) {
        // Either doesn't parse as scheme://host/path at all, or contains an OAS 3.x server
        // variable placeholder (`{env}`) - 2.0 has no server-variable concept, so a literal
        // "{env}.example.com" would be a misleading, unusable `host` value.
        logger.warn("<a7b9c0d1> Server URL \"{}\" doesn't fit host/basePath/schemes (unparseable, or has an "
                    "unresolved {{variable}}) - left unset",
                    url);
        return;
    }
    m["schemes"] = mkVec({ mkStr(match[1].str()) });
    m["host"] = mkStr(match[2].str());
    if (match[3].matched && !match[3].str().empty())
        m["basePath"] = mkStr(match[3].str());
}

Node::Map writeOAuthFlowFlat(const OAuthFlow& f)
{
    Node::Map m;
    if (f.authorizationUrl)
        m["authorizationUrl"] = mkStr(*f.authorizationUrl);
    if (f.tokenUrl)
        m["tokenUrl"] = mkStr(*f.tokenUrl);
    Node::Map scopes;
    for (const auto& [k, v] : f.scopes)
        scopes[k] = mkStr(v);
    m["scopes"] = mkMap(std::move(scopes));
    return m;
}

Node writeSecurityScheme(const SecurityScheme& s)
{
    if (s.ref)
        return mkMap({ { "$ref", mkStr(rewriteRef(*s.ref)) } });

    Node::Map m;
    if (s.type == "http" && s.scheme == "basic") {
        m["type"] = mkStr("basic");
    } else if (s.type == "apiKey") {
        m["type"] = mkStr("apiKey");
        if (s.name)
            m["name"] = mkStr(*s.name);
        if (s.in)
            m["in"] = mkStr(*s.in);
    } else if (s.type == "oauth2" && s.flows) {
        m["type"] = mkStr("oauth2");
        struct FlowChoice {
            const optional<OAuthFlow>* flow;
            const char* flowName;
        };
        const FlowChoice choices[] = {
            { &s.flows->authorizationCode, "accessCode" },
            { &s.flows->implicit_, "implicit" },
            { &s.flows->password, "password" },
            { &s.flows->clientCredentials, "application" },
        };
        int present = (s.flows->authorizationCode ? 1 : 0) + (s.flows->implicit_ ? 1 : 0)
            + (s.flows->password ? 1 : 0) + (s.flows->clientCredentials ? 1 : 0);
        if (present > 1)
            logger.warn(
                "<b9c0d1e2> Security scheme has {} OAuth2 flows - Swagger 2.0 only supports one; using the first",
                present);
        for (const auto& choice : choices) {
            if (!*choice.flow)
                continue;
            m["flow"] = mkStr(choice.flowName);
            auto flowFields = writeOAuthFlowFlat(**choice.flow);
            for (auto& [k, v] : flowFields)
                m[k] = v;
            break;
        }
        if (s.flows->deviceAuthorization && present == 0)
            logger.warn("<53bdceea> Dropping OAuth2 device authorization flow - no Swagger 2.0 equivalent");
    } else {
        logger.warn("<4d78a350> Security scheme type \"{}\" has no Swagger 2.0 equivalent - dropped", s.type);
        return Node { Node::NullValue }; // caller skips null entries
    }
    if (s.description)
        m["description"] = mkStr(*s.description);
    return mkMap(std::move(m));
}

Node writeSecurityRequirement(const SecurityRequirement& req)
{
    Node::Map m;
    for (const auto& [scheme, scopes] : req)
        m[scheme] = writeStringList(scopes);
    return mkMap(std::move(m));
}

Node writeSecurityRequirements(const vector<SecurityRequirement>& reqs)
{
    Node::Vec v;
    for (const auto& r : reqs)
        v.push_back(writeSecurityRequirement(r));
    return mkVec(std::move(v));
}

// ---- Parameters / Headers / RequestBody / Response ----

Node writeParameter(const Parameter& p)
{
    if (p.ref)
        return mkMap({ { "$ref", mkStr(rewriteRef(*p.ref)) } });
    Node::Map m;
    m["name"] = mkStr(p.name);
    m["in"] = mkStr(p.in);
    if (p.description)
        m["description"] = mkStr(*p.description);
    if (p.required)
        m["required"] = mkBool(true);
    if (p.allowEmptyValue)
        m["allowEmptyValue"] = mkBool(*p.allowEmptyValue);
    if (p.schema) {
        flattenSchemaIntoFields(m, *p.schema);
        writeCollectionFormat(m, p);
    } else if (!p.content.empty()) {
        if (p.content.size() > 1)
            logger.warn("<e2f3a4b5> Parameter \"{}\" has {} content media types - Swagger 2.0 needs exactly one "
                        "type per (non-body) parameter; using the first",
                        p.name, p.content.size());
        if (p.content.begin()->second.schema)
            flattenSchemaIntoFields(m, *p.content.begin()->second.schema);
    }
    return mkMap(std::move(m));
}

Node writeHeader(const Header& h)
{
    if (h.ref)
        return mkMap({ { "$ref", mkStr(rewriteRef(*h.ref)) } });
    Node::Map m;
    if (h.description)
        m["description"] = mkStr(*h.description);
    if (h.schema)
        flattenSchemaIntoFields(m, *h.schema);
    return mkMap(std::move(m));
}

// Picks the schema to represent an OAS 3.x content map as 2.0's single schema+media-type-list
// shape, logging if more than one media type actually carried a (potentially different) schema.
SchemaPtr pickContentSchema(const map<Str, MediaType>& content, const Str& contextLabel)
{
    if (content.empty())
        return nullptr;
    if (content.size() > 1)
        logger.warn("<f3a4b5c6> {} has {} content media types - Swagger 2.0 needs exactly one schema; using the "
                    "first (\"{}\")",
                    contextLabel, content.size(), content.begin()->first);
    return content.begin()->second.schema;
}

// True if `content` is shaped like a 2.0 formData request body (a single object-typed schema
// under application/x-www-form-urlencoded or multipart/form-data).
bool isFormDataShaped(const map<Str, MediaType>& content)
{
    if (content.size() != 1)
        return false;
    const auto& [mediaType, media] = *content.begin();
    if (mediaType != "application/x-www-form-urlencoded" && mediaType != "multipart/form-data")
        return false;
    return media.schema && !media.schema->properties.empty()
        && (media.schema->type.empty() || media.schema->type.front() == "object");
}

// Appends the parameters representing `rb` (either one `body` parameter, or one `formData`
// parameter per property of a form-shaped request body) onto `params`.
void appendRequestBodyParams(Node::Vec& params, const RequestBodyPtr& rb)
{
    if (!rb)
        return;
    if (isFormDataShaped(rb->content)) {
        const auto& schema = *rb->content.begin()->second.schema;
        for (const auto& [name, propSchema] : schema.properties) {
            Node::Map m;
            m["name"] = mkStr(name);
            m["in"] = mkStr("formData");
            bool required = find(schema.required.begin(), schema.required.end(), name) != schema.required.end();
            if (required)
                m["required"] = mkBool(true);
            flattenSchemaIntoFields(m, *propSchema);
            params.push_back(mkMap(std::move(m)));
        }
        return;
    }

    auto schema = pickContentSchema(rb->content, "requestBody");
    if (!schema)
        return;
    Node::Map m;
    m["name"] = mkStr("body");
    m["in"] = mkStr("body");
    if (rb->description)
        m["description"] = mkStr(*rb->description);
    if (rb->required)
        m["required"] = mkBool(true);
    m["schema"] = writeSchema(*schema);
    params.push_back(mkMap(std::move(m)));
}

Node writeResponse(const Response& r)
{
    if (r.ref)
        return mkMap({ { "$ref", mkStr(rewriteRef(*r.ref)) } });
    Node::Map m;
    m["description"] = mkStr(r.description.value_or(""));
    if (!r.headers.empty()) {
        Node::Map headers;
        for (const auto& [name, h] : r.headers)
            headers[name] = writeHeader(*h);
        m["headers"] = mkMap(std::move(headers));
    }
    if (auto schema = pickContentSchema(r.content, "a response"))
        m["schema"] = writeSchema(*schema);
    // r.links (OAS 3.x only) has no 2.0 equivalent - silently omitted.
    return mkMap(std::move(m));
}

// ---- Operation / PathItem ----

// Every media type actually used by an operation's requestBody/responses, so `consumes`/
// `produces` reflect what the schemas were really declared for instead of always defaulting.
vector<Str> collectMediaTypes(const map<Str, MediaType>& content)
{
    vector<Str> types;
    for (const auto& [mt, media] : content)
        types.push_back(mt);
    return types;
}

Node writeOperation(const Operation& op)
{
    Node::Map m;
    if (op.operationId)
        m["operationId"] = mkStr(*op.operationId);
    if (op.summary)
        m["summary"] = mkStr(*op.summary);
    if (op.description)
        m["description"] = mkStr(*op.description);
    if (op.externalDocs)
        m["externalDocs"] = writeExternalDocs(*op.externalDocs);
    if (!op.tags.empty())
        m["tags"] = writeStringList(op.tags);
    if (op.deprecated)
        m["deprecated"] = mkBool(*op.deprecated);
    if (op.security)
        m["security"] = writeSecurityRequirements(*op.security);

    Node::Vec params;
    for (const auto& p : op.parameters)
        params.push_back(writeParameter(*p));
    appendRequestBodyParams(params, op.requestBody);
    if (!params.empty())
        m["parameters"] = mkVec(std::move(params));

    if (op.requestBody && !op.requestBody->content.empty())
        m["consumes"] = writeStringList(collectMediaTypes(op.requestBody->content));

    vector<Str> produces;
    for (const auto& [status, r] : op.responses)
        for (const auto& mt : collectMediaTypes(r->content))
            if (find(produces.begin(), produces.end(), mt) == produces.end())
                produces.push_back(mt);
    if (!produces.empty())
        m["produces"] = writeStringList(produces);

    if (!op.responses.empty()) {
        Node::Map responses;
        for (const auto& [status, r] : op.responses)
            responses[status] = writeResponse(*r);
        m["responses"] = mkMap(std::move(responses));
    } else {
        m["responses"] = mkMap(); // required field
    }

    return mkMap(std::move(m));
}

Node writePathItem(const PathItem& item)
{
    Node::Map m;
    for (const auto& [method, op] : item.operations) {
        static const vector<Str> v2Methods = { "get", "put", "post", "delete", "options", "head", "patch" };
        if (find(v2Methods.begin(), v2Methods.end(), method) == v2Methods.end()) {
            logger.warn("<5f70f29b> Dropping \"{}\" operation - Swagger 2.0 has no equivalent method", method);
            continue;
        }
        m[method] = writeOperation(op);
    }
    if (!item.additionalOperations.empty())
        logger.warn("<decc135a> Dropping {} additionalOperations entry(ies) - no Swagger 2.0 equivalent",
                    item.additionalOperations.size());
    return mkMap(std::move(m));
}

Node writePaths(const Paths& paths)
{
    Node::Map m;
    for (const auto& [path, item] : paths)
        m[path] = writePathItem(item);
    return mkMap(std::move(m));
}

}

Node Write(const Document& doc)
{
    Node::Map m;
    m["swagger"] = mkStr("2.0");
    m["info"] = writeInfo(doc.info);
    writeHostBasePathSchemes(m, doc.servers);
    m["paths"] = writePaths(doc.paths);

    if (!doc.webhooks.empty())
        logger.warn("<02d06be2> Dropping {} webhook(s) - no Swagger 2.0 equivalent", doc.webhooks.size());

    if (!doc.components.schemas.empty()) {
        Node::Map defs;
        for (const auto& [name, s] : doc.components.schemas)
            defs[name] = writeSchema(*s);
        m["definitions"] = mkMap(std::move(defs));
    }
    if (!doc.components.parameters.empty()) {
        Node::Map params;
        for (const auto& [name, p] : doc.components.parameters)
            params[name] = writeParameter(*p);
        m["parameters"] = mkMap(std::move(params));
    }
    if (!doc.components.responses.empty()) {
        Node::Map responses;
        for (const auto& [name, r] : doc.components.responses)
            responses[name] = writeResponse(*r);
        m["responses"] = mkMap(std::move(responses));
    }
    if (!doc.components.securitySchemes.empty()) {
        Node::Map schemes;
        for (const auto& [name, s] : doc.components.securitySchemes) {
            auto written = writeSecurityScheme(*s);
            if (!holds_alternative<Node::Null>(written.value))
                schemes[name] = written;
        }
        if (!schemes.empty())
            m["securityDefinitions"] = mkMap(std::move(schemes));
    }
    size_t droppedComponents = doc.components.examples.size() + doc.components.headers.size()
        + doc.components.links.size() + doc.components.callbacks.size() + doc.components.pathItems.size();
    if (droppedComponents > 0)
        logger.warn("<d7e8f9a0> Dropping {} components.{{examples,headers,links,callbacks,pathItems}} entry(ies) - "
                    "no Swagger 2.0 equivalent registry",
                    droppedComponents);

    if (!doc.security.empty())
        m["security"] = writeSecurityRequirements(doc.security);
    if (!doc.tags.empty()) {
        Node::Vec tags;
        for (const auto& t : doc.tags)
            tags.push_back(writeTag(t));
        m["tags"] = mkVec(std::move(tags));
    }
    if (doc.externalDocs)
        m["externalDocs"] = writeExternalDocs(*doc.externalDocs);

    return mkMap(std::move(m));
}

}
