#include "external_ref_resolver.h"

#include <algorithm>
#include <chrono>
#include <filesystem>
#include <format>
#include <map>
#include <set>
#include <stdexcept>
#include <variant>
#include <vector>

#include "../common/string_tools.h"
#include "../common/yaml_or_json_parser.h"
#include "../filesystem/tools.h"
#include "../logger/logger.h"

using namespace std;

namespace {

LogFacade::Logger logger("ExternalRefResolver");

// A large multi-file spec (DigitalOcean's public API, e.g., is ~2900 files/~8000 $refs) can take
// tens of seconds to fully resolve - this heartbeat gives a visible sign of life at plain DEBUG
// level (not just TRACE) every this-many files, so a slow spec doesn't look like a hang.
constexpr size_t heartbeatEvery = 200;

bool externalRefTarget(const Node::Map& m, string& target)
{
    auto it = m.find("$ref");
    if (it == m.end())
        return false;
    auto s = it->second.getIf<Node::String>();
    if (!s || s->starts_with("#"))
        return false;
    target = *s;
    return true;
}

// A bare "#/..." ref - only meaningful (and only handled by this resolver) while `localRoot` is
// set, i.e. while we're inside a freshly-loaded external file's own content: per JSON Reference
// semantics, "#" means "root of the CURRENT document", which for a loaded file is that file's own
// root, not the overall spec's. This is what lets a shared utility file (e.g. DigitalOcean's
// shared/pages.yml) cross-reference its own sibling top-level keys internally.
bool localRefTarget(const Node::Map& m, string& pointer)
{
    auto it = m.find("$ref");
    if (it == m.end())
        return false;
    auto s = it->second.getIf<Node::String>();
    if (!s || !s->starts_with("#"))
        return false;
    pointer = s->substr(1); // drop the leading '#', keep the '/...' pointer part (possibly empty)
    return true;
}

// Best-effort JSON-Pointer navigation ("/a/b/0") - Map by key, Vec by index. Not full RFC 6901
// (no ~0/~1 unescaping - not needed for any real spec seen so far); returns Node{} (absent) on
// any missing/mismatched segment rather than throwing, consistent with this whole mechanism's
// "best effort, never crash" contract.
Node navigatePointer(const Node& doc, const string& pointer)
{
    const Node* cur = &doc;
    for (const auto& seg : pointer | split("/")) {
        if (seg.empty())
            continue;
        if (auto m = cur->getIf<Node::Map>()) {
            auto it = m->find(string(seg));
            if (it == m->end())
                return Node {};
            cur = &it->second;
        } else if (auto v = cur->getIf<Node::Vec>()) {
            try {
                auto idx = string(seg) | toNumber<unsigned long>();
                if (idx >= v->size())
                    return Node {};
                cur = &v->at(idx);
            } catch (const exception&) {
                return Node {};
            }
        } else {
            return Node {};
        }
    }
    return *cur;
}

// Resolves `relPath` (as given in a $ref) against `currentDir`, then re-confirms the canonical
// result still lives inside `sandboxRoot` (FS::confineToRoot) - returns nullopt if it doesn't, or
// the target doesn't exist. This is what lets nested files reference each other with their own
// relative paths while never escaping the original spec's own directory tree.
optional<filesystem::path> resolveSandboxed(const string& sandboxRoot, const string& currentDir, const string& relPath)
{
    error_code ec;
    auto absoluteTarget = filesystem::weakly_canonical(filesystem::path(currentDir) / relPath, ec);
    if (ec)
        return nullopt;
    auto relFromRoot = filesystem::relative(absoluteTarget, sandboxRoot, ec);
    if (ec)
        return nullopt;
    return FS::confineToRoot(sandboxRoot, relFromRoot.string(), true);
}

string lastPointerSegment(const string& pointer)
{
    auto pos = pointer.find_last_of('/');
    auto seg = pos == string::npos ? pointer : pointer.substr(pos + 1);
    return seg.empty() ? string("Schema") : seg;
}

// Picks `base` if it's not already taken, otherwise `base_2`, `base_3`, ... - and reserves
// whichever name it returns, so two different hoisted fragments never collide (e.g. two different
// shared files each happening to define their own top-level "apiAgent" key).
string reserveUniqueName(set<string>& usedNames, const string& base)
{
    if (usedNames.insert(base).second)
        return base;
    for (int i = 2;; i++) {
        auto candidate = format("{}_{}", base, i);
        if (usedNames.insert(candidate).second)
            return candidate;
    }
}

struct Ctx {
    const string& sandboxRoot;
    string currentDir;

    // Set once we're inside a freshly-loaded external file's own content (see localRefTarget);
    // `localRootFile` is that file's canonical path, used as part of the hoist-memoization key
    // below so the same pointer text from two different files never collides.
    const Node* localRoot = nullptr;
    string localRootFile;

    // Canonical path of every external file currently being loaded, root-to-here (pushed/popped
    // around each load) - catches a real file-level cycle (A.yml -> B.yml -> A.yml) by exact
    // ancestry, not by an arbitrary total-count cap that a large-but-acyclic spec (thousands of
    // distinct resource files, as in DigitalOcean's own multi-file source) would trip just as
    // easily as a genuine cycle.
    vector<string>& loadStack;

    // Where hoisted local refs end up - the root document's own components.schemas map, created
    // up front by resolveExternalRefs. Reusing this (rather than inlining local refs by value)
    // means a self-referential schema found inside an externally-loaded file (DigitalOcean's
    // apiAgent, whose own child_agents contains more apiAgent items) becomes a normal named
    // "#/components/schemas/<Name>" ref - already handled cycle-safely, by shared_ptr identity,
    // by the existing typed reader + resolveAllRefs (lib/openapi/resolve.h). Naively inlining by
    // value can't represent that cycle at all (it's infinite once flattened).
    Node::Map& schemaRegistry;

    // "<file>#<pointer>" -> already-assigned schema name. Populated BEFORE recursing into a
    // hoisted fragment's own content (not after), so a self-reference encountered while resolving
    // that very fragment finds its own name already reserved and just emits the ref, instead of
    // recursing forever - this is what makes hoisting cycle-safe with no separate cycle-guard
    // needed for local refs (unlike external file loads, which still use `loadStack` above).
    map<string, string>& hoistedNames;
    set<string>& usedNames;

    size_t& filesLoaded; // total external files read so far, for the heartbeat/summary logs below
};

void resolveNode(Node& n, Ctx ctx)
{
    if (auto m = get_if<Node::Map>(&n.value)) {
        string target;
        if (externalRefTarget(*m, target)) {
            auto hashPos = target.find('#');
            auto filePath = target.substr(0, hashPos);
            auto pointer = hashPos == string::npos ? string() : target.substr(hashPos + 1);

            auto resolved = resolveSandboxed(ctx.sandboxRoot, ctx.currentDir, filePath);
            if (!resolved) {
                logger.warn(
                    "<b5e8d2a3> Ignoring external $ref \"{}\" - file not found or outside the spec's directory", target);
                n = Node {};
                return;
            }

            auto resolvedStr = resolved->string();
            if (find(ctx.loadStack.begin(), ctx.loadStack.end(), resolvedStr) != ctx.loadStack.end())
                throw runtime_error(format("<a4f7c9e1> Cyclic external $ref detected: {}", resolvedStr));

            logger.trace("<d1e2f3a4> Reading external $ref target: {}", resolvedStr);

            // Resolve the WHOLE loaded file's own content first (external + local refs alike,
            // against its own root - see Ctx::localRoot above), then extract the requested
            // pointer fragment (if any) only once that's done, so a pointer target that itself
            // relies on sibling keys elsewhere in the same file is already fully resolved by then.
            Node fileRoot = parseYamlOrJsonToNode(FS::readFile(resolvedStr));
            n = fileRoot;

            if (++ctx.filesLoaded % heartbeatEvery == 0)
                logger.debug("<ad2ce86e> Still resolving external $refs: {} file(s) loaded so far...", ctx.filesLoaded);

            Ctx childCtx = ctx;
            childCtx.currentDir = resolved->parent_path().string();
            childCtx.localRoot = &fileRoot;
            childCtx.localRootFile = resolvedStr;

            ctx.loadStack.push_back(resolvedStr);
            resolveNode(n, childCtx);
            ctx.loadStack.pop_back();

            if (!pointer.empty())
                n = navigatePointer(n, pointer);
            return;
        }

        string pointer;
        if (ctx.localRoot && localRefTarget(*m, pointer)) {
            auto key = format("{}#{}", ctx.localRootFile, pointer);
            auto memoIt = ctx.hoistedNames.find(key);
            if (memoIt == ctx.hoistedNames.end()) {
                auto name = reserveUniqueName(ctx.usedNames, lastPointerSegment(pointer));
                memoIt = ctx.hoistedNames.emplace(key, name).first;

                auto fragment = navigatePointer(*ctx.localRoot, pointer);
                resolveNode(fragment, ctx); // same localRoot/localRootFile - further local refs in this fragment resolve against the same file
                ctx.schemaRegistry[name] = fragment;
            }
            n = Node { Node::Map { { "$ref", Node { string("#/components/schemas/") + memoIt->second } } } };
            return;
        }

        for (auto& [key, value] : *m)
            resolveNode(value, ctx);
    } else if (auto v = get_if<Node::Vec>(&n.value)) {
        for (auto& item : *v)
            resolveNode(item, ctx);
    }
}

}

void resolveExternalRefs(Node& root, const string& specDir)
{
    auto dir = specDir.empty() ? string(".") : specDir;

    if (!holds_alternative<Node::Map>(root.value))
        root.value = Node::Map();
    auto& rootMap = get<Node::Map>(root.value);
    auto& componentsNode = rootMap["components"];
    if (!holds_alternative<Node::Map>(componentsNode.value))
        componentsNode.value = Node::Map();
    auto& componentsMap = get<Node::Map>(componentsNode.value);
    auto& schemasNode = componentsMap["schemas"];
    if (!holds_alternative<Node::Map>(schemasNode.value))
        schemasNode.value = Node::Map();
    auto& schemaRegistry = get<Node::Map>(schemasNode.value);

    set<string> usedNames;
    for (const auto& [name, _] : schemaRegistry)
        usedNames.insert(name);

    logger.debug("<f1a2b3c4> Resolving external $refs for spec directory: {}", dir);
    auto startTime = chrono::high_resolution_clock::now();

    vector<string> loadStack;
    map<string, string> hoistedNames;
    size_t filesLoaded = 0;
    resolveNode(root, Ctx {
                          .sandboxRoot = dir,
                          .currentDir = dir,
                          .localRoot = nullptr,
                          .localRootFile = string(),
                          .loadStack = loadStack,
                          .schemaRegistry = schemaRegistry,
                          .hoistedNames = hoistedNames,
                          .usedNames = usedNames,
                          .filesLoaded = filesLoaded,
                      });

    auto elapsedMs = chrono::duration<double, milli>(chrono::high_resolution_clock::now() - startTime).count();
    logger.debug("<ad82135a> External $ref resolution complete: {} file(s) loaded, {} schema(s) hoisted, {} msec",
                 filesLoaded, hoistedNames.size(), elapsedMs);
}
