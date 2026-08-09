#include "document_field_order.h"

using namespace std;

namespace OpenApi {

vector<string> documentFieldOrder(OpenApiVersion version)
{
    if (version == OpenApiVersion::V2_0) {
        return {
            "swagger",
            "info",
            "host",
            "basePath",
            "schemes",
            "consumes",
            "produces",
            "security",
            "securityDefinitions",
            "tags",
            "externalDocs",
            "paths",
            "definitions",
            "parameters",
            "responses",
        };
    }
    return {
        "openapi",
        "$self",
        "info",
        "servers",
        "security",
        "tags",
        "externalDocs",
        "paths",
        "webhooks",
        "components",
    };
}

}
