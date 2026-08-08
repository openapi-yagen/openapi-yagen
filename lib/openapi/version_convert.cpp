#include "version_convert.h"

#include <format>
#include <stdexcept>

#include "../common/node_walker.h"
#include "v3/reader.h"
#include "v3/writer.h"

using namespace std;

namespace OpenApi {

namespace {
[[noreturn]] void notYetSupported(OpenApiVersion v)
{
    throw runtime_error(
        format("<f6a7b8c9> OpenAPI version {} is not yet supported for conversion", toVersionString(v)));
}
}

Node convertVersion(const Node& doc, OpenApiVersion from, OpenApiVersion to)
{
    if (!isV3(from))
        notYetSupported(from);
    if (!isV3(to))
        notYetSupported(to);

    auto ir = V3::Read(NodeWalker(doc), from);
    return V3::Write(ir, to);
}

}
