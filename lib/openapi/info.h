#pragma once

#include <map>
#include <optional>
#include <string>
#include <vector>

#include "schema.h"

namespace OpenApi {

struct Contact {
    OptStr name;
    OptStr url;
    OptStr email;
};

// `url` and `identifier` (OAS 3.1+, an SPDX license identifier) are mutually exclusive per spec -
// a reader keeps whichever the source document set (at most one); a writer targeting OAS 3.0
// drops `identifier` (3.0 has no such field) and keeps `url` if both were somehow set.
struct License {
    Str name;
    OptStr url;
    OptStr identifier;
};

struct Info {
    Str title;
    OptStr summary; // OAS 3.1+
    OptStr description;
    OptStr termsOfService;
    std::optional<Contact> contact;
    std::optional<License> license;
    Str version; // the API's own version, unrelated to the OpenAPI spec version
};

struct ServerVariable {
    std::vector<Str> enumValues; // "enum" is a C++ keyword
    Str defaultValue; // "default" is a C++ keyword
    OptStr description;
};

struct Server {
    Str url;
    OptStr description;
    std::map<Str, ServerVariable> variables;
};

struct Tag {
    Str name;
    OptStr description;
    std::optional<ExternalDocs> externalDocs;
    // OAS 3.2+.
    OptStr summary;
    OptStr parent; // name of the tag this one nests under
    OptStr kind; // free-form category (conventional values: "nav", "badge", "audience", ...)
};

}
