#include "version.h"

#include "../common/node_walker.h"

using namespace std;

namespace OpenApi {

bool isV3(OpenApiVersion v)
{
    return v == OpenApiVersion::V3_0 || v == OpenApiVersion::V3_1 || v == OpenApiVersion::V3_2;
}

namespace {

// Returns just the major.minor prefix of a version string like "3.0.3" or "3.1" -> "3.0"/"3.1".
string majorMinor(const string& s)
{
    auto firstDot = s.find('.');
    if (firstDot == string::npos)
        return s;
    auto secondDot = s.find('.', firstDot + 1);
    return secondDot == string::npos ? s : s.substr(0, secondDot);
}

}

optional<OpenApiVersion> parseVersionString(const string& s)
{
    auto mm = majorMinor(s);
    if (mm == "2.0")
        return OpenApiVersion::V2_0;
    if (mm == "3.0")
        return OpenApiVersion::V3_0;
    if (mm == "3.1")
        return OpenApiVersion::V3_1;
    if (mm == "3.2")
        return OpenApiVersion::V3_2;
    return nullopt;
}

optional<OpenApiVersion> detectVersion(const Node& doc)
{
    NodeWalker w(doc);
    if (auto openapi = w["openapi"].optional<string>())
        return parseVersionString(*openapi);
    if (auto swagger = w["swagger"].optional<string>())
        return parseVersionString(*swagger);
    return nullopt;
}

string_view toVersionString(OpenApiVersion v)
{
    switch (v) {
        case OpenApiVersion::V2_0:
            return "2.0";
        case OpenApiVersion::V3_0:
            return "3.0.0";
        case OpenApiVersion::V3_1:
            return "3.1.0";
        case OpenApiVersion::V3_2:
            return "3.2.0";
    }
    throw runtime_error("<a1b2c3d4> Unreachable: unknown OpenApiVersion");
}

}
