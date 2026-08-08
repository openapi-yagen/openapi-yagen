#pragma once

#include <map>
#include <optional>
#include <string>
#include <vector>

#include "schema.h"

namespace OpenApi {

struct OAuthFlow {
    OptStr authorizationUrl; // required for implicit/authorizationCode
    OptStr tokenUrl; // required for password/clientCredentials/authorizationCode
    OptStr refreshUrl;
    std::map<Str, Str> scopes; // scope name -> description, required (may be empty)
};

struct OAuthFlows {
    std::optional<OAuthFlow> implicit_; // "implicit" isn't a keyword, named for symmetry with the others
    std::optional<OAuthFlow> password;
    std::optional<OAuthFlow> clientCredentials;
    std::optional<OAuthFlow> authorizationCode;
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

    Node raw;
};
using SecuritySchemePtr = std::shared_ptr<SecurityScheme>;
using SecuritySchemeMap = std::map<Str, SecuritySchemePtr>;

// One entry of the top-level/operation-level `security` list: scheme name -> required scopes
// (empty for non-oauth2/openIdConnect schemes). An empty map (`{}`) means "no authentication
// required" (only meaningful as a whole-list entry, overriding any document-level requirement).
using SecurityRequirement = std::map<Str, std::vector<Str>>;

}
