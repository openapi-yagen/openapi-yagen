#pragma once

#include <map>
#include <optional>
#include <string>
#include <vector>

#include "schema.h"

namespace OpenApi {

struct OAuthFlow {
    OptStr authorizationUrl; // required for implicit/authorizationCode
    OptStr deviceAuthorizationUrl; // OAS 3.2+, required for the deviceAuthorization flow instead
    OptStr tokenUrl; // required for password/clientCredentials/authorizationCode/deviceAuthorization
    OptStr refreshUrl;
    std::map<Str, Str> scopes; // scope name -> description, required (may be empty)
};

struct OAuthFlows {
    std::optional<OAuthFlow> implicit_; // "implicit" isn't a keyword, named for symmetry with the others
    std::optional<OAuthFlow> password;
    std::optional<OAuthFlow> clientCredentials;
    std::optional<OAuthFlow> authorizationCode;
    std::optional<OAuthFlow> deviceAuthorization; // OAS 3.2+ (RFC 8628 device flow)
};

// Security Scheme Object. `type` is one of "apiKey" | "http" | "oauth2" | "openIdConnect" |
// "mutualTLS" (OAS 3.1+) - which of the other fields are meaningful depends on it, per spec; kept
// as a plain string rather than an enum since generators branch on it directly.
struct SecurityScheme {
    OptStr ref;

    Str type;
    OptStr description;
    OptStr name; // apiKey
    OptStr in; // apiKey: "query" | "header" | "cookie"
    OptStr scheme; // http
    OptStr bearerFormat; // http, informational only
    std::optional<OAuthFlows> flows; // oauth2
    OptStr openIdConnectUrl; // openIdConnect
    OptStr oauth2MetadataUrl; // OAS 3.2+, oauth2: RFC 8414 authorization server metadata URL
    std::optional<bool> deprecated; // OAS 3.2+ (see writer.cpp for the <3.2 x-oai-deprecated fallback)

    Node raw;
};
using SecuritySchemePtr = std::shared_ptr<SecurityScheme>;
using SecuritySchemeMap = std::map<Str, SecuritySchemePtr>;

// One entry of the top-level/operation-level `security` list: scheme name -> required scopes
// (empty for non-oauth2/openIdConnect schemes). An empty map (`{}`) means "no authentication
// required" (only meaningful as a whole-list entry, overriding any document-level requirement).
using SecurityRequirement = std::map<Str, std::vector<Str>>;

}
