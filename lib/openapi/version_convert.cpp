#include "version_convert.h"

#include "../common/node_walker.h"
#include "v2/reader.h"
#include "v2/writer.h"
#include "v3/reader.h"
#include "v3/writer.h"

using namespace std;

namespace OpenApi {

namespace {

Document readAny(const Node& doc, OpenApiVersion from)
{
    if (from == OpenApiVersion::V2_0)
        return V2::Read(NodeWalker(doc));
    return V3::Read(NodeWalker(doc), from);
}

Node writeAny(const Document& ir, OpenApiVersion to)
{
    if (to == OpenApiVersion::V2_0)
        return V2::Write(ir);
    return V3::Write(ir, to);
}

}

Node convertVersion(const Node& doc, OpenApiVersion from, OpenApiVersion to)
{
    return writeAny(readAny(doc, from), to);
}

}
