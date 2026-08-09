#include "writer.h"

#include "../../logger/logger.h"

using namespace std;

namespace OpenApi::V3 {

namespace {

LogFacade::Logger logger("OpenApi::V3::Write");

bool isV31Plus(OpenApiVersion v) { return v == OpenApiVersion::V3_1 || v == OpenApiVersion::V3_2; }
bool isV32(OpenApiVersion v) { return v == OpenApiVersion::V3_2; }

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

// ---- forward declarations (mutual recursion, mirrors reader.cpp) ----

Node writeSchema(const Schema& schema, OpenApiVersion to);
Node writeMediaType(const MediaType& mt, OpenApiVersion to);
Node writeHeader(const Header& h, OpenApiVersion to);
Node writePathItem(const PathItem& item, OpenApiVersion to);
Node writeExternalDocs(const ExternalDocs& e);
Node writeServer(const Server& s);

Node writeServers(const vector<Server>& servers)
{
    Node::Vec v;
    for (const auto& s : servers)
        v.push_back(writeServer(s));
    return mkVec(std::move(v));
}

Node writeContentMap(const map<Str, MediaType>& content, OpenApiVersion to)
{
    Node::Map m;
    for (const auto& [mediaType, mt] : content)
        m[mediaType] = writeMediaType(mt, to);
    return mkMap(std::move(m));
}

Node writeExample(const Example& e, OpenApiVersion to)
{
    if (e.ref)
        return mkMap({ { "$ref", mkStr(*e.ref) } });
    Node::Map m;
    if (e.summary)
        m["summary"] = mkStr(*e.summary);
    if (e.description)
        m["description"] = mkStr(*e.description);
    if (e.value)
        m["value"] = *e.value;
    if (e.externalValue)
        m["externalValue"] = mkStr(*e.externalValue);
    if (isV32(to)) {
        if (e.dataValue)
            m["dataValue"] = *e.dataValue;
        if (e.externalDataValue)
            m["externalDataValue"] = mkStr(*e.externalDataValue);
        if (e.serializedValue)
            m["serializedValue"] = mkStr(*e.serializedValue);
    } else if (e.dataValue && !e.value) {
        // OAS <3.2 has no dataValue/serializedValue - dataValue is the structured-data
        // replacement for value, so fold it down instead of dropping the example's content
        // outright. serializedValue (the wire-format string) has no pre-3.2 equivalent at all.
        m["value"] = *e.dataValue;
    }
    return mkMap(std::move(m));
}

Node writeExampleMap(const ExampleMap& examples, OpenApiVersion to)
{
    Node::Map m;
    for (const auto& [name, e] : examples)
        m[name] = writeExample(*e, to);
    return mkMap(std::move(m));
}

// ---- Schema ----

void writeSchemaType(Node::Map& m, const Schema& schema, OpenApiVersion to)
{
    if (schema.type.empty())
        return;
    bool nullable = isNullable(schema);
    vector<Str> nonNullTypes;
    for (const auto& t : schema.type)
        if (t != "null")
            nonNullTypes.push_back(t);

    if (isV31Plus(to)) {
        if (schema.type.size() == 1) {
            m["type"] = mkStr(schema.type.front());
        } else {
            Node::Vec arr;
            for (const auto& t : schema.type)
                arr.push_back(mkStr(t));
            m["type"] = mkVec(std::move(arr));
        }
    } else {
        // OAS 3.0: scalar type + nullable bool. A schema with more than one non-null type (e.g.
        // `type: [string, integer]`, legal JSON Schema) can't be represented in 3.0 - keep the
        // first and log it as a documented lossy conversion.
        if (nonNullTypes.size() > 1)
            logger.warn("<b7c1e2a0> Schema has multiple types ({}) - OAS 3.0 only supports one; keeping \"{}\"",
                        nonNullTypes.size(), nonNullTypes.front());
        if (!nonNullTypes.empty())
            m["type"] = mkStr(nonNullTypes.front());
        if (nullable)
            m["nullable"] = mkBool(true);
    }
}

void writeExclusiveBound(Node::Map& m, const char* boundKey, const char* exclusiveKey, const optional<Node>& inclusive,
                         const optional<Node>& exclusive, OpenApiVersion to)
{
    if (isV31Plus(to)) {
        if (inclusive)
            m[boundKey] = *inclusive;
        if (exclusive)
            m[exclusiveKey] = *exclusive;
    } else {
        // OAS 3.0: exclusive bound folds into "<bound>" + "exclusive<Bound>: true"; an inclusive
        // bound also present (unusual - 3.1+ allows both at once, 3.0 only one active bound) is
        // dropped in favor of the exclusive one.
        if (exclusive) {
            m[boundKey] = *exclusive;
            m[exclusiveKey] = mkBool(true);
        } else if (inclusive) {
            m[boundKey] = *inclusive;
        }
    }
}

Node writeDiscriminator(const Discriminator& d, OpenApiVersion to)
{
    Node::Map m;
    m["propertyName"] = mkStr(d.propertyName);
    if (!d.mapping.empty()) {
        Node::Map mapping;
        for (const auto& [k, v] : d.mapping)
            mapping[k] = mkStr(v);
        m["mapping"] = mkMap(std::move(mapping));
    }
    if (d.defaultMapping && isV32(to))
        m["defaultMapping"] = mkStr(*d.defaultMapping); // OAS <3.2 has no "defaultMapping"
    return mkMap(std::move(m));
}

Node writeXML(const XML& x, OpenApiVersion to)
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
    if (x.nodeType && isV32(to))
        m["nodeType"] = mkStr(*x.nodeType); // OAS <3.2 has no "nodeType" - dropped otherwise
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

Node writeSchemaList(const vector<SchemaPtr>& schemas, OpenApiVersion to)
{
    Node::Vec v;
    for (const auto& s : schemas)
        v.push_back(writeSchema(*s, to));
    return mkVec(std::move(v));
}

Node writeSchema(const Schema& schema, OpenApiVersion to)
{
    Node::Map m;
    if (schema.ref)
        m["$ref"] = mkStr(*schema.ref);

    if (schema.title)
        m["title"] = mkStr(*schema.title);
    if (schema.description)
        m["description"] = mkStr(*schema.description);
    if (schema.defaultValue)
        m["default"] = *schema.defaultValue;
    if (schema.deprecated)
        m["deprecated"] = mkBool(*schema.deprecated);
    if (schema.readOnly)
        m["readOnly"] = mkBool(*schema.readOnly);
    if (schema.writeOnly)
        m["writeOnly"] = mkBool(*schema.writeOnly);
    if (schema.constValue && isV31Plus(to))
        m["const"] = *schema.constValue; // OAS 3.0 has no "const" - dropped otherwise

    writeSchemaType(m, schema, to);
    if (schema.format)
        m["format"] = mkStr(*schema.format);

    if (schema.multipleOf)
        m["multipleOf"] = *schema.multipleOf;
    writeExclusiveBound(m, "minimum", "exclusiveMinimum", schema.minimum, schema.exclusiveMinimum, to);
    writeExclusiveBound(m, "maximum", "exclusiveMaximum", schema.maximum, schema.exclusiveMaximum, to);
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
    if (schema.items)
        m["items"] = writeSchema(*schema.items, to);

    if (!schema.properties.empty()) {
        Node::Map props;
        for (const auto& [name, s] : schema.properties)
            props[name] = writeSchema(*s, to);
        m["properties"] = mkMap(std::move(props));
    }
    if (!schema.required.empty())
        m["required"] = writeStringList(schema.required);
    if (schema.minProperties)
        m["minProperties"] = mkInt(*schema.minProperties);
    if (schema.maxProperties)
        m["maxProperties"] = mkInt(*schema.maxProperties);

    if (schema.additionalPropertiesBool)
        m["additionalProperties"] = mkBool(*schema.additionalPropertiesBool);
    else if (schema.additionalPropertiesSchema)
        m["additionalProperties"] = writeSchema(*schema.additionalPropertiesSchema, to);

    if (!schema.enumValues.empty()) {
        Node::Vec vals;
        for (const auto& v : schema.enumValues)
            vals.push_back(v);
        m["enum"] = mkVec(std::move(vals));
    }

    if (!schema.allOf.empty())
        m["allOf"] = writeSchemaList(schema.allOf, to);
    if (!schema.oneOf.empty())
        m["oneOf"] = writeSchemaList(schema.oneOf, to);
    if (!schema.anyOf.empty())
        m["anyOf"] = writeSchemaList(schema.anyOf, to);
    if (schema.notSchema)
        m["not"] = writeSchema(*schema.notSchema, to);

    if (schema.discriminator)
        m["discriminator"] = writeDiscriminator(*schema.discriminator, to);
    if (schema.xml)
        m["xml"] = writeXML(*schema.xml, to);
    if (schema.externalDocs)
        m["externalDocs"] = writeExternalDocs(*schema.externalDocs);

    if (schema.example)
        m["example"] = *schema.example;
    if (!schema.examples.empty()) {
        if (isV31Plus(to)) {
            Node::Vec exs;
            for (const auto& e : schema.examples)
                exs.push_back(e);
            m["examples"] = mkVec(std::move(exs));
        } else if (!schema.example) {
            // OAS 3.0 has no schema-level "examples" array - collapse the first entry into
            // "example" instead of dropping the data entirely.
            m["example"] = schema.examples.front();
        }
    }

    // JSON Schema 2020-12 keywords - OAS 3.1+ only, dropped for an OAS 3.0 target (see the
    // Schema::comment/anchor/... comment in schema.h).
    if (isV31Plus(to)) {
        if (schema.comment)
            m["$comment"] = mkStr(*schema.comment);
        if (schema.anchor)
            m["$anchor"] = mkStr(*schema.anchor);
        if (schema.dynamicRef)
            m["$dynamicRef"] = mkStr(*schema.dynamicRef);
        if (schema.dynamicAnchor)
            m["$dynamicAnchor"] = mkStr(*schema.dynamicAnchor);
        if (!schema.defs.empty()) {
            Node::Map defs;
            for (const auto& [name, s] : schema.defs)
                defs[name] = writeSchema(*s, to);
            m["$defs"] = mkMap(std::move(defs));
        }
    }

    if (schema.ref && !isV31Plus(to) && m.size() > 1) {
        // OAS 3.0 doesn't allow $ref siblings - drop them (documented lossy conversion).
        logger.warn("<c2d3e4f5> Dropping $ref sibling keywords for OAS 3.0 output ($ref={})", *schema.ref);
        return mkMap({ { "$ref", m["$ref"] } });
    }
    return mkMap(std::move(m));
}

// ---- Info / Server / Tag / Security ----

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

Node writeLicense(const License& l, OpenApiVersion to)
{
    Node::Map m;
    m["name"] = mkStr(l.name);
    if (l.url)
        m["url"] = mkStr(*l.url);
    if (l.identifier && isV31Plus(to))
        m["identifier"] = mkStr(*l.identifier); // OAS 3.0 has no "identifier" - dropped otherwise
    return mkMap(std::move(m));
}

Node writeInfo(const Info& info, OpenApiVersion to)
{
    Node::Map m;
    m["title"] = mkStr(info.title);
    if (info.summary && isV31Plus(to))
        m["summary"] = mkStr(*info.summary); // OAS 3.0 has no Info.summary - dropped otherwise
    if (info.description)
        m["description"] = mkStr(*info.description);
    if (info.termsOfService)
        m["termsOfService"] = mkStr(*info.termsOfService);
    if (info.contact)
        m["contact"] = writeContact(*info.contact);
    if (info.license)
        m["license"] = writeLicense(*info.license, to);
    m["version"] = mkStr(info.version);
    return mkMap(std::move(m));
}

Node writeServerVariable(const ServerVariable& sv)
{
    Node::Map m;
    if (!sv.enumValues.empty())
        m["enum"] = writeStringList(sv.enumValues);
    m["default"] = mkStr(sv.defaultValue);
    if (sv.description)
        m["description"] = mkStr(*sv.description);
    return mkMap(std::move(m));
}

Node writeServer(const Server& s)
{
    Node::Map m;
    m["url"] = mkStr(s.url);
    if (s.description)
        m["description"] = mkStr(*s.description);
    if (!s.variables.empty()) {
        Node::Map vars;
        for (const auto& [name, v] : s.variables)
            vars[name] = writeServerVariable(v);
        m["variables"] = mkMap(std::move(vars));
    }
    return mkMap(std::move(m));
}

Node writeTag(const Tag& t, OpenApiVersion to)
{
    Node::Map m;
    m["name"] = mkStr(t.name);
    if (t.description)
        m["description"] = mkStr(*t.description);
    if (t.externalDocs)
        m["externalDocs"] = writeExternalDocs(*t.externalDocs);
    if (isV32(to)) {
        if (t.summary)
            m["summary"] = mkStr(*t.summary);
        if (t.parent)
            m["parent"] = mkStr(*t.parent);
        if (t.kind)
            m["kind"] = mkStr(*t.kind);
    }
    return mkMap(std::move(m));
}

Node writeOAuthFlow(const OAuthFlow& f, OpenApiVersion to)
{
    Node::Map m;
    if (f.authorizationUrl)
        m["authorizationUrl"] = mkStr(*f.authorizationUrl);
    if (f.deviceAuthorizationUrl && isV32(to))
        m["deviceAuthorizationUrl"] = mkStr(*f.deviceAuthorizationUrl); // OAS <3.2 has no device flow at all
    if (f.tokenUrl)
        m["tokenUrl"] = mkStr(*f.tokenUrl);
    if (f.refreshUrl)
        m["refreshUrl"] = mkStr(*f.refreshUrl);
    Node::Map scopes;
    for (const auto& [k, v] : f.scopes)
        scopes[k] = mkStr(v);
    m["scopes"] = mkMap(std::move(scopes));
    return mkMap(std::move(m));
}

Node writeOAuthFlows(const OAuthFlows& flows, OpenApiVersion to)
{
    Node::Map m;
    if (flows.implicit_)
        m["implicit"] = writeOAuthFlow(*flows.implicit_, to);
    if (flows.password)
        m["password"] = writeOAuthFlow(*flows.password, to);
    if (flows.clientCredentials)
        m["clientCredentials"] = writeOAuthFlow(*flows.clientCredentials, to);
    if (flows.authorizationCode)
        m["authorizationCode"] = writeOAuthFlow(*flows.authorizationCode, to);
    if (flows.deviceAuthorization && isV32(to))
        // OAS <3.2 has no deviceAuthorization flow at all - dropped, not folded into anything
        // (unlike e.g. Example.dataValue, there's no pre-3.2 flow this one can stand in for).
        m["deviceAuthorization"] = writeOAuthFlow(*flows.deviceAuthorization, to);
    return mkMap(std::move(m));
}

Node writeSecurityScheme(const SecurityScheme& s, OpenApiVersion to)
{
    if (s.ref)
        return mkMap({ { "$ref", mkStr(*s.ref) } });
    Node::Map m;
    m["type"] = mkStr(s.type);
    if (s.description)
        m["description"] = mkStr(*s.description);
    if (s.name)
        m["name"] = mkStr(*s.name);
    if (s.in)
        m["in"] = mkStr(*s.in);
    if (s.scheme)
        m["scheme"] = mkStr(*s.scheme);
    if (s.bearerFormat)
        m["bearerFormat"] = mkStr(*s.bearerFormat);
    if (s.flows)
        m["flows"] = writeOAuthFlows(*s.flows, to);
    if (s.openIdConnectUrl)
        m["openIdConnectUrl"] = mkStr(*s.openIdConnectUrl);
    if (s.oauth2MetadataUrl && isV32(to))
        m["oauth2MetadataUrl"] = mkStr(*s.oauth2MetadataUrl); // OAS <3.2 has no "oauth2MetadataUrl"
    if (s.deprecated) {
        if (isV32(to))
            m["deprecated"] = mkBool(*s.deprecated);
        else if (*s.deprecated)
            // Official pre-3.2 back-compat convention (per the OAI registry) for a security
            // scheme's "deprecated" flag.
            m["x-oai-deprecated"] = mkBool(true);
    }
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

// ---- MediaType / Encoding / Header / Parameter / Link ----

Node writeEncoding(const Encoding& e, OpenApiVersion to)
{
    Node::Map m;
    if (e.contentType)
        m["contentType"] = mkStr(*e.contentType);
    if (!e.headers.empty()) {
        Node::Map headers;
        for (const auto& [name, h] : e.headers)
            headers[name] = writeHeader(*h, to);
        m["headers"] = mkMap(std::move(headers));
    }
    if (e.style)
        m["style"] = mkStr(*e.style);
    if (e.explode)
        m["explode"] = mkBool(*e.explode);
    if (e.allowReserved)
        m["allowReserved"] = mkBool(*e.allowReserved);
    return mkMap(std::move(m));
}

Node writeMediaType(const MediaType& mt, OpenApiVersion to)
{
    Node::Map m;
    if (mt.schema)
        m["schema"] = writeSchema(*mt.schema, to);
    if (mt.itemSchema && isV32(to))
        m["itemSchema"] = writeSchema(*mt.itemSchema, to); // OAS <3.2 has no "itemSchema"
    if (mt.example)
        m["example"] = *mt.example;
    if (!mt.examples.empty())
        m["examples"] = writeExampleMap(mt.examples, to);
    if (!mt.encoding.empty()) {
        Node::Map enc;
        for (const auto& [name, e] : mt.encoding)
            enc[name] = writeEncoding(e, to);
        m["encoding"] = mkMap(std::move(enc));
    }
    return mkMap(std::move(m));
}

Node writeHeader(const Header& h, OpenApiVersion to)
{
    if (h.ref)
        return mkMap({ { "$ref", mkStr(*h.ref) } });
    Node::Map m;
    if (h.description)
        m["description"] = mkStr(*h.description);
    if (h.required)
        m["required"] = mkBool(true);
    if (h.deprecated)
        m["deprecated"] = mkBool(*h.deprecated);
    if (h.allowEmptyValue)
        m["allowEmptyValue"] = mkBool(*h.allowEmptyValue);
    if (h.style)
        m["style"] = mkStr(*h.style);
    if (h.explode)
        m["explode"] = mkBool(*h.explode);
    if (h.allowReserved)
        m["allowReserved"] = mkBool(*h.allowReserved);
    if (h.schema)
        m["schema"] = writeSchema(*h.schema, to);
    if (!h.content.empty())
        m["content"] = writeContentMap(h.content, to);
    if (h.example)
        m["example"] = *h.example;
    if (!h.examples.empty())
        m["examples"] = writeExampleMap(h.examples, to);
    return mkMap(std::move(m));
}

Node writeParameter(const Parameter& p, OpenApiVersion to)
{
    if (p.ref)
        return mkMap({ { "$ref", mkStr(*p.ref) } });
    Node::Map m;
    m["name"] = mkStr(p.name);
    m["in"] = mkStr(p.in);
    if (p.description)
        m["description"] = mkStr(*p.description);
    if (p.required)
        m["required"] = mkBool(true);
    if (p.deprecated)
        m["deprecated"] = mkBool(*p.deprecated);
    if (p.allowEmptyValue)
        m["allowEmptyValue"] = mkBool(*p.allowEmptyValue);
    if (p.style)
        m["style"] = mkStr(*p.style);
    if (p.explode)
        m["explode"] = mkBool(*p.explode);
    if (p.allowReserved)
        m["allowReserved"] = mkBool(*p.allowReserved);
    if (p.schema)
        m["schema"] = writeSchema(*p.schema, to);
    if (!p.content.empty())
        m["content"] = writeContentMap(p.content, to);
    if (p.example)
        m["example"] = *p.example;
    if (!p.examples.empty())
        m["examples"] = writeExampleMap(p.examples, to);
    return mkMap(std::move(m));
}

Node writeParameterList(const vector<ParameterPtr>& params, OpenApiVersion to)
{
    Node::Vec v;
    for (const auto& p : params)
        v.push_back(writeParameter(*p, to));
    return mkVec(std::move(v));
}

Node writeLink(const Link& l)
{
    if (l.ref)
        return mkMap({ { "$ref", mkStr(*l.ref) } });
    Node::Map m;
    if (l.operationRef)
        m["operationRef"] = mkStr(*l.operationRef);
    if (l.operationId)
        m["operationId"] = mkStr(*l.operationId);
    if (!l.parameters.empty()) {
        Node::Map params;
        for (const auto& [name, v] : l.parameters)
            params[name] = v;
        m["parameters"] = mkMap(std::move(params));
    }
    if (l.requestBody)
        m["requestBody"] = *l.requestBody;
    if (l.description)
        m["description"] = mkStr(*l.description);
    if (l.server)
        m["server"] = writeServer(*l.server);
    return mkMap(std::move(m));
}

// ---- RequestBody / Response / Callback / Operation / PathItem ----

Node writeRequestBody(const RequestBody& rb, OpenApiVersion to)
{
    if (rb.ref)
        return mkMap({ { "$ref", mkStr(*rb.ref) } });
    Node::Map m;
    if (rb.description)
        m["description"] = mkStr(*rb.description);
    if (rb.required)
        m["required"] = mkBool(true);
    m["content"] = writeContentMap(rb.content, to);
    return mkMap(std::move(m));
}

Node writeResponse(const Response& r, OpenApiVersion to)
{
    if (r.ref)
        return mkMap({ { "$ref", mkStr(*r.ref) } });
    Node::Map m;
    m["description"] = mkStr(r.description.value_or(""));
    if (!r.headers.empty()) {
        Node::Map headers;
        for (const auto& [name, h] : r.headers)
            headers[name] = writeHeader(*h, to);
        m["headers"] = mkMap(std::move(headers));
    }
    if (!r.content.empty())
        m["content"] = writeContentMap(r.content, to);
    if (!r.links.empty()) {
        Node::Map links;
        for (const auto& [name, l] : r.links)
            links[name] = writeLink(*l);
        m["links"] = mkMap(std::move(links));
    }
    return mkMap(std::move(m));
}

Node writeCallback(const Callback& c, OpenApiVersion to)
{
    if (c.ref)
        return mkMap({ { "$ref", mkStr(*c.ref) } });
    Node::Map m;
    for (const auto& [expr, item] : c.expressions)
        m[expr] = writePathItem(*item, to);
    return mkMap(std::move(m));
}

Node writeOperation(const Operation& op, OpenApiVersion to)
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
    if (!op.parameters.empty())
        m["parameters"] = writeParameterList(op.parameters, to);
    if (op.requestBody)
        m["requestBody"] = writeRequestBody(*op.requestBody, to);
    if (!op.responses.empty()) {
        Node::Map responses;
        for (const auto& [status, r] : op.responses)
            responses[status] = writeResponse(*r, to);
        m["responses"] = mkMap(std::move(responses));
    }
    if (!op.callbacks.empty()) {
        Node::Map callbacks;
        for (const auto& [name, c] : op.callbacks)
            callbacks[name] = writeCallback(*c, to);
        m["callbacks"] = mkMap(std::move(callbacks));
    }
    if (op.deprecated)
        m["deprecated"] = mkBool(*op.deprecated);
    if (op.security)
        m["security"] = writeSecurityRequirements(*op.security);
    if (!op.servers.empty())
        m["servers"] = writeServers(op.servers);
    return mkMap(std::move(m));
}

Node writePathItem(const PathItem& item, OpenApiVersion to)
{
    Node::Map m;
    if (item.ref)
        m["$ref"] = mkStr(*item.ref);
    if (item.summary)
        m["summary"] = mkStr(*item.summary);
    if (item.description)
        m["description"] = mkStr(*item.description);
    if (!item.servers.empty())
        m["servers"] = writeServers(item.servers);
    if (!item.parameters.empty())
        m["parameters"] = writeParameterList(item.parameters, to);
    for (const auto& [method, op] : item.operations)
        m[method] = writeOperation(op, to);
    if (!item.additionalOperations.empty()) {
        if (isV32(to)) {
            Node::Map additional;
            for (const auto& [method, op] : item.additionalOperations)
                additional[method] = writeOperation(op, to);
            m["additionalOperations"] = mkMap(std::move(additional));
        } else
            logger.warn("<f7a8b9c0> Dropping {} additionalOperations entry(ies) for OAS <3.2 output - no equivalent",
                        item.additionalOperations.size());
    }
    return mkMap(std::move(m));
}

Node writePaths(const Paths& paths, OpenApiVersion to)
{
    Node::Map m;
    for (const auto& [path, item] : paths)
        m[path] = writePathItem(item, to);
    return mkMap(std::move(m));
}

Node writeComponents(const Components& c, OpenApiVersion to)
{
    Node::Map m;
    if (!c.schemas.empty()) {
        Node::Map schemas;
        for (const auto& [name, s] : c.schemas)
            schemas[name] = writeSchema(*s, to);
        m["schemas"] = mkMap(std::move(schemas));
    }
    if (!c.responses.empty()) {
        Node::Map responses;
        for (const auto& [name, r] : c.responses)
            responses[name] = writeResponse(*r, to);
        m["responses"] = mkMap(std::move(responses));
    }
    if (!c.parameters.empty()) {
        Node::Map parameters;
        for (const auto& [name, p] : c.parameters)
            parameters[name] = writeParameter(*p, to);
        m["parameters"] = mkMap(std::move(parameters));
    }
    if (!c.examples.empty())
        m["examples"] = writeExampleMap(c.examples, to);
    if (!c.requestBodies.empty()) {
        Node::Map requestBodies;
        for (const auto& [name, rb] : c.requestBodies)
            requestBodies[name] = writeRequestBody(*rb, to);
        m["requestBodies"] = mkMap(std::move(requestBodies));
    }
    if (!c.headers.empty()) {
        Node::Map headers;
        for (const auto& [name, h] : c.headers)
            headers[name] = writeHeader(*h, to);
        m["headers"] = mkMap(std::move(headers));
    }
    if (!c.securitySchemes.empty()) {
        Node::Map schemes;
        for (const auto& [name, s] : c.securitySchemes)
            schemes[name] = writeSecurityScheme(*s, to);
        m["securitySchemes"] = mkMap(std::move(schemes));
    }
    if (!c.links.empty()) {
        Node::Map links;
        for (const auto& [name, l] : c.links)
            links[name] = writeLink(*l);
        m["links"] = mkMap(std::move(links));
    }
    if (!c.callbacks.empty()) {
        Node::Map callbacks;
        for (const auto& [name, cb] : c.callbacks)
            callbacks[name] = writeCallback(*cb, to);
        m["callbacks"] = mkMap(std::move(callbacks));
    }
    if (!c.pathItems.empty()) {
        if (isV31Plus(to))
            m["pathItems"] = writePaths(c.pathItems, to);
        else
            logger.warn("<d3e4f5a6> Dropping components.pathItems ({} entries) for OAS 3.0 output - no equivalent",
                        c.pathItems.size());
    }
    return mkMap(std::move(m));
}

}

Node Write(const Document& doc, OpenApiVersion to)
{
    Node::Map m;
    m["openapi"] = mkStr(string(toVersionString(to)));
    if (doc.self && isV32(to))
        m["$self"] = mkStr(*doc.self); // OAS <3.2 has no "$self"
    m["info"] = writeInfo(doc.info, to);
    if (!doc.servers.empty())
        m["servers"] = writeServers(doc.servers);
    m["paths"] = writePaths(doc.paths, to);
    if (!doc.webhooks.empty()) {
        if (isV31Plus(to))
            m["webhooks"] = writePaths(doc.webhooks, to);
        else
            logger.warn("<e4f5a6b7> Dropping {} webhook(s) for OAS 3.0 output - no equivalent", doc.webhooks.size());
    }
    auto componentsNode = writeComponents(doc.components, to);
    if (!componentsNode.get<Node::Map>().empty())
        m["components"] = componentsNode;
    if (!doc.security.empty())
        m["security"] = writeSecurityRequirements(doc.security);
    if (!doc.tags.empty()) {
        Node::Vec tags;
        for (const auto& t : doc.tags)
            tags.push_back(writeTag(t, to));
        m["tags"] = mkVec(std::move(tags));
    }
    if (doc.externalDocs)
        m["externalDocs"] = writeExternalDocs(*doc.externalDocs);
    return mkMap(std::move(m));
}

}
