#include "external_ref_resolver.h"

#include <algorithm>
#include <array>
#include <chrono>
#include <filesystem>
#include <format>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <stdexcept>
#include <variant>
#include <vector>

#include "../common/yaml_or_json_parser.h"
#include "../filesystem/tools.h"
#include "../logger/logger.h"

using namespace std;
namespace fs = std::filesystem;

namespace {

LogFacade::Logger logger("ExternalRefResolver");

// A large multi-file spec (DigitalOcean's public API, e.g., is ~2900 files/~8000 $refs) can take
// tens of seconds to fully resolve - this heartbeat gives a visible sign of life at plain DEBUG
// level (not just TRACE) every this-many files, so a slow spec doesn't look like a hang.
constexpr size_t heartbeatEvery = 200;

constexpr array<string_view, 10> componentSections
    = { "schemas",         "parameters", "responses", "requestBodies", "headers",
        "securitySchemes", "examples",   "links",     "callbacks",     "pathItems" };

using Pointer = vector<string>;

// What an OpenAPI document expects at a given position - only as much as bundling needs to know.
enum class Kind {
    Other,
    Document,
    Components,
    ComponentSection,
    PathItemMap,
    PathItem,
    OperationMap,
    Operation,
    CallbackMap,
    Callback,
};

struct Slot {
    Kind kind = Kind::Other;
    string section; // for ComponentSection only
};

Slot componentSlot(const string& section)
{
    if (section == "pathItems")
        return { Kind::PathItem, { } };
    if (section == "callbacks")
        return { Kind::Callback, { } };
    return { };
}

Slot childSlot(const Slot& parent, const string& key, bool swaggerRoot)
{
    bool extension = key.starts_with("x-");
    switch (parent.kind) {
        case Kind::Document:
            if (key == "paths" || key == "webhooks")
                return { Kind::PathItemMap, { } };
            if (!swaggerRoot && key == "components")
                return { Kind::Components, { } };
            if (swaggerRoot) {
                if (key == "definitions")
                    return { Kind::ComponentSection, "schemas" };
                if (key == "parameters" || key == "responses")
                    return { Kind::ComponentSection, key };
                if (key == "securityDefinitions")
                    return { Kind::ComponentSection, "securitySchemes" };
            }
            return { };
        case Kind::Components:
            if (ranges::find(componentSections, key) != componentSections.end())
                return { Kind::ComponentSection, key };
            return { };
        case Kind::ComponentSection:
            return componentSlot(parent.section);
        case Kind::PathItemMap:
            return extension ? Slot { } : Slot { Kind::PathItem, { } };
        case Kind::PathItem:
            if (key == "get" || key == "put" || key == "post" || key == "delete" || key == "options" || key == "head"
                || key == "patch" || key == "trace" || key == "query")
                return { Kind::Operation, { } };
            if (key == "additionalOperations")
                return { Kind::OperationMap, { } };
            return { };
        case Kind::OperationMap:
            return { Kind::Operation, { } };
        case Kind::Operation:
            if (key == "callbacks")
                return { Kind::CallbackMap, { } };
            return { };
        case Kind::CallbackMap:
            return { Kind::Callback, { } };
        case Kind::Callback:
            return extension ? Slot { } : Slot { Kind::PathItem, { } };
        case Kind::Other:
            return { };
    }
    return { };
}

string escapeSegment(const string& s)
{
    string result;
    for (char ch : s) {
        if (ch == '~')
            result += "~0";
        else if (ch == '/')
            result += "~1";
        else
            result += ch;
    }
    return result;
}

string pointerToString(const Pointer& pointer)
{
    string result = "#";
    for (const auto& seg : pointer)
        result += "/" + escapeSegment(seg);
    return result;
}

// JSON Pointer (RFC 6901) as it appears in a URI fragment: percent-encoded, then ~1 -> '/' and
// ~0 -> '~' within each segment. Empty segments (a leading or doubled '/') are skipped.
Pointer parsePointer(const string& fragment)
{
    auto hexValue = [](char ch) -> int {
        if (ch >= '0' && ch <= '9')
            return ch - '0';
        if (ch >= 'a' && ch <= 'f')
            return ch - 'a' + 10;
        if (ch >= 'A' && ch <= 'F')
            return ch - 'A' + 10;
        return -1;
    };

    string decoded;
    for (size_t i = 0; i < fragment.size(); i++) {
        if (fragment[i] == '%' && i + 2 < fragment.size() && hexValue(fragment[i + 1]) >= 0
            && hexValue(fragment[i + 2]) >= 0) {
            decoded += static_cast<char>(hexValue(fragment[i + 1]) * 16 + hexValue(fragment[i + 2]));
            i += 2;
        } else {
            decoded += fragment[i];
        }
    }

    Pointer result;
    string seg;
    auto flush = [&] {
        if (!seg.empty())
            result.push_back(std::move(seg));
        seg.clear();
    };
    for (size_t i = 0; i < decoded.size(); i++) {
        if (decoded[i] == '/') {
            flush();
        } else if (decoded[i] == '~' && i + 1 < decoded.size() && (decoded[i + 1] == '0' || decoded[i + 1] == '1')) {
            seg += decoded[++i] == '1' ? '/' : '~';
        } else {
            seg += decoded[i];
        }
    }
    flush();
    return result;
}

// Map by key, Vec by index; nullptr if any segment is missing.
const Node* navigate(const Node& doc, const Pointer& pointer)
{
    const Node* cur = &doc;
    for (const auto& seg : pointer) {
        if (auto m = cur->getIf<Node::Map>()) {
            auto it = m->find(seg);
            if (it == m->end())
                return nullptr;
            cur = &it->second;
        } else if (auto v = cur->getIf<Node::Vec>()) {
            if (seg.empty() || seg.size() > 9 || !ranges::all_of(seg, [](char ch) { return ch >= '0' && ch <= '9'; }))
                return nullptr;
            auto idx = stoul(seg);
            if (idx >= v->size())
                return nullptr;
            cur = &(*v)[idx];
        } else {
            return nullptr;
        }
    }
    return cur;
}

const Node* mapValue(const Node& n, const string& key) { return navigate(n, Pointer { key }); }

const string* refOf(const Node& n)
{
    auto m = n.getIf<Node::Map>();
    if (!m)
        return nullptr;
    auto it = m->find("$ref");
    return it == m->end() ? nullptr : it->second.getIf<Node::String>();
}

// A { $ref: ... } node with nothing next to it, i.e. a plain alias of its target.
const string* pureRefOf(const Node& n)
{
    auto ref = refOf(n);
    return ref && n.get<Node::Map>().size() == 1 ? ref : nullptr;
}

struct SourceFile {
    string path; // canonical
    string displayPath;
    Node content;
    bool swagger = false;
    bool completeDocument = false; // has its own top-level "openapi"/"swagger"
};

struct Context {
    const SourceFile* file = nullptr; // the file the node being processed is written in
    // The nearest complete OpenAPI document (other than the root spec) the processed content was
    // reached through - whose authorization its operations keep. nullptr for the root spec's own.
    const SourceFile* owner = nullptr;
};

struct Target {
    const SourceFile* file = nullptr;
    Pointer pointer;
    const Node* node = nullptr;

    string source() const { return file->path + pointerToString(pointer); }
    string describe() const { return file->displayPath + pointerToString(pointer); }
};

struct ComponentName {
    string section;
    string name;

    auto operator<=>(const ComponentName&) const = default;
};

optional<ComponentName> componentOf(const Target& t)
{
    const auto& p = t.pointer;
    if (p.size() == 3 && p[0] == "components" && ranges::find(componentSections, p[1]) != componentSections.end())
        return ComponentName { p[1], p[2] };
    if (p.size() == 2) {
        if (p[0] == "definitions")
            return ComponentName { "schemas", p[1] };
        if (t.file->swagger) {
            if (p[0] == "parameters" || p[0] == "responses")
                return ComponentName { p[0], p[1] };
            if (p[0] == "securityDefinitions")
                return ComponentName { "securitySchemes", p[1] };
        }
    }
    return nullopt;
}

class Resolver {
public:
    Resolver(Node& root, const string& specPath, const string& refRoot)
        : root(root)
    {
        fs::path spec(specPath);
        auto specDir = spec.parent_path().empty() ? fs::path(".") : spec.parent_path();
        rootDir = refRoot.empty() ? specDir.string() : refRoot;

        error_code ec;
        if (!fs::is_directory(rootDir, ec))
            throw runtime_error(format("<ef8a6bb5> The ref root \"{}\" is not a directory", rootDir));
        auto canonicalSpec = fs::weakly_canonical(spec, ec);
        if (ec)
            canonicalSpec = spec;
        if (!refRoot.empty() && !insideRoot(canonicalSpec))
            throw runtime_error(
                format("<c609081f> The spec file \"{}\" is outside the ref root \"{}\"", specPath, rootDir));

        // A copy of the document as read: refs from other files back into the root spec are
        // answered from it, while `root` itself is rewritten in place.
        auto file = make_unique<SourceFile>(makeSourceFile(canonicalSpec.string(), specPath, root));
        rootFile = file.get();
        files.emplace(rootFile->path, std::move(file));
    }

    void run()
    {
        registerRootComponents();
        walk(root, Slot { Kind::Document, { } }, Context { rootFile, nullptr });
        addHoistedComponents();
        addTags();
        verifyDuplicates();
        inlineRootPathItems();
    }

    size_t filesLoaded() const { return files.size() - 1; }
    size_t componentsHoisted() const { return hoisted.size(); }

private:
    struct Duplicate {
        ComponentName component;
        string source;
        string otherSource;
        Node content;
    };

    static SourceFile makeSourceFile(string path, string displayPath, Node content)
    {
        SourceFile f { .path = std::move(path), .displayPath = std::move(displayPath), .content = std::move(content) };
        f.swagger = mapValue(f.content, "swagger") != nullptr;
        f.completeDocument = f.swagger || mapValue(f.content, "openapi") != nullptr;
        return f;
    }

    bool insideRoot(const fs::path& canonicalPath) const
    {
        error_code ec;
        auto canonicalRoot = fs::weakly_canonical(rootDir, ec);
        if (ec)
            return false;
        auto relative = canonicalPath.lexically_relative(canonicalRoot);
        return !relative.empty() && FS::isPathTraversalSafe(relative.string());
    }

    [[noreturn]] void fail(const string& ref, const Context& ctx, const string& reason) const
    {
        throw runtime_error(format("<a433a41f> Cannot resolve $ref \"{}\" (in {} at {}): {}", ref,
                                   ctx.file->displayPath, pointerToString(location), reason));
    }

    const SourceFile& loadFile(const string& ref, const Context& ctx, const string& relPath)
    {
        if (relPath.find("://") != string::npos)
            fail(ref, ctx, "remote references are not supported");

        error_code ec;
        auto currentDir = fs::path(ctx.file->path).parent_path();
        auto path = fs::weakly_canonical(currentDir / relPath, ec);
        if (ec)
            fail(ref, ctx, format("file not found: {}", (currentDir / relPath).string()));
        if (!insideRoot(path))
            fail(ref, ctx, format("\"{}\" is outside the ref root \"{}\"", path.string(), rootDir));

        auto it = files.find(path.string());
        if (it != files.end())
            return *it->second;

        if (!fs::is_regular_file(path, ec))
            fail(ref, ctx, format("file not found: {}", path.string()));

        logger.trace("<d1e2f3a4> Reading external $ref target: {}", path.string());
        Node content;
        try {
            content = parseYamlOrJsonToNode(FS::readFile(path.string()));
        } catch (const exception& e) {
            fail(ref, ctx, format("cannot read \"{}\": {}", path.string(), e.what()));
        }
        auto file = make_unique<SourceFile>(makeSourceFile(path.string(), path.string(), std::move(content)));
        if (files.size() % heartbeatEvery == 0)
            logger.debug("<ad2ce86e> Still resolving external $refs: {} file(s) loaded so far...", files.size());
        return *files.emplace(path.string(), std::move(file)).first->second;
    }

    Target locate(const string& ref, const Context& ctx)
    {
        auto hashPos = ref.find('#');
        auto filePath = ref.substr(0, hashPos);
        Target t;
        t.file = filePath.empty() ? ctx.file : &loadFile(ref, ctx, filePath);
        if (hashPos != string::npos)
            t.pointer = parsePointer(ref.substr(hashPos + 1));
        t.node = navigate(t.file->content, t.pointer);
        if (!t.node)
            fail(ref, ctx, format("fragment \"{}\" not found in \"{}\"", ref.substr(hashPos + 1), t.file->displayPath));
        return t;
    }

    Context contextFor(const SourceFile& file, const Context& from) const
    {
        if (&file == rootFile)
            return { &file, nullptr };
        return { &file, file.completeDocument ? &file : from.owner };
    }

    // While `target` is itself nothing but a $ref, moves on to what that one points at: always when
    // defining a root component, otherwise only through re-exports of the same component (so that
    // `Item: {$ref: "other.yaml#/components/schemas/Item"}` isn't seen as a second, different Item).
    Target followAliases(Target target, const Context& ctx, bool definition, set<string>* chain = nullptr)
    {
        set<string> visited;
        auto aliasCtx = ctx;
        while (target.file != rootFile) {
            visited.insert(target.source());
            auto ref = pureRefOf(*target.node);
            if (!ref)
                break;
            aliasCtx = contextFor(*target.file, aliasCtx);
            auto savedLocation = std::exchange(location, target.pointer);
            auto next = locate(*ref, aliasCtx);
            if (visited.contains(next.source()))
                fail(*ref, aliasCtx, "cyclic $ref");
            location = std::move(savedLocation);
            if (definition) {
                if (next.file == rootFile)
                    break;
            } else {
                auto current = componentOf(target);
                if (!current || componentOf(next) != current)
                    break;
            }
            target = std::move(next);
        }
        if (chain)
            *chain = std::move(visited);
        return target;
    }

    string refString(const ComponentName& c) const
    {
        string prefix = "#/components/" + c.section + "/";
        if (rootFile->swagger)
            prefix = "#/" + swaggerSection(c.section) + "/";
        return prefix + escapeSegment(c.name);
    }

    string swaggerSection(const string& section) const
    {
        if (section == "schemas")
            return "definitions";
        if (section == "securitySchemes")
            return "securityDefinitions";
        if (section == "parameters" || section == "responses")
            return section;
        throw runtime_error(format("<9288daf0> Swagger 2.0 has no place for \"{}\" components", section));
    }

    Pointer rootSectionPointer(const string& section) const
    {
        if (rootFile->swagger)
            return { swaggerSection(section) };
        return { "components", section };
    }

    // Reserves the names of the root spec's own components before anything else is processed, so
    // that the result doesn't depend on the order refs are met in.
    void registerRootComponents()
    {
        for (const auto& section : componentSections) {
            string name(section);
            if (rootFile->swagger && name != "schemas" && name != "parameters" && name != "responses"
                && name != "securitySchemes")
                continue;
            auto sectionPointer = rootSectionPointer(name);
            auto sectionNode = navigate(rootFile->content, sectionPointer);
            auto entries = sectionNode ? sectionNode->getIf<Node::Map>() : nullptr;
            if (!entries)
                continue;
            for (const auto& [componentName, value] : *entries) {
                ComponentName component { name, componentName };
                auto pointer = sectionPointer;
                pointer.push_back(componentName);
                auto description = rootFile->displayPath + pointerToString(pointer);

                auto ref = refOf(value);
                if (ref && !ref->starts_with("#")) {
                    location = pointer;
                    Context ctx { rootFile, nullptr };
                    auto target = locate(*ref, ctx);
                    if (target.file != rootFile) {
                        set<string> chain;
                        target = followAliases(std::move(target), ctx, true, &chain);
                        for (const auto& source : chain)
                            definitions.emplace(source, component);
                        description = format("{} (referenced by {})", target.describe(), description);
                    }
                    location.clear();
                }
                registry.emplace(component, description);
            }
        }
    }

    // Copies a component of another file into the root spec (once), returning where it ends up.
    ComponentName hoist(const ComponentName& component, const Target& target, const Context& ctx)
    {
        auto key = pair { component.section, target.source() };
        auto memo = hoisted.find(key);
        if (memo != hoisted.end())
            return memo->second;
        if (rootFile->swagger)
            swaggerSection(component.section); // throws if there is no such section
        hoisted.emplace(key, component);

        // Registered (and memoized) before processing the content, so that a self-referencing
        // component finds its own name instead of recursing forever.
        auto [entry, isNew] = registry.emplace(component, target.describe());
        auto otherSource = entry->second;

        Node content = *target.node;
        auto savedLocation = std::exchange(location, target.pointer);
        auto savedStack = std::exchange(inlineStack, { });
        walk(content, componentSlot(component.section), contextFor(*target.file, ctx));
        inlineStack = std::move(savedStack);
        location = std::move(savedLocation);

        if (isNew)
            additions[component] = std::move(content);
        else
            duplicates.push_back({ component, target.describe(), otherSource, std::move(content) });
        return component;
    }

    // Replaces `n` with the (processed) content `target` points at.
    void inlineTarget(Node& n, const string& ref, const Target& target, const Slot& slot, const Context& ctx)
    {
        auto source = target.source();
        if (ranges::find(inlineStack, source) != inlineStack.end())
            fail(ref, ctx, "cyclic $ref");

        Node content = *target.node;
        auto savedLocation = std::exchange(location, target.pointer);
        inlineStack.push_back(source);
        walk(content, slot, contextFor(*target.file, ctx));
        inlineStack.pop_back();
        location = std::move(savedLocation);
        n = std::move(content);
    }

    // A ref from anywhere into the root spec stays a local ref where OpenAPI can express that.
    static bool pointsAtRootComponent(const Target& t, const Slot& slot)
    {
        return slot.kind != Kind::PathItem && slot.kind != Kind::Operation && componentOf(t).has_value();
    }

    // Returns the "#/..." ref to use for `ref`, or nullopt if the target has to be inlined.
    optional<string> localRefFor(const string& ref, const Target& target, const Slot& slot, const Context& ctx)
    {
        if (target.file == rootFile) {
            if (pointsAtRootComponent(target, slot))
                return pointerToString(target.pointer);
            return nullopt;
        }
        if (slot.kind == Kind::PathItem || slot.kind == Kind::Operation)
            return nullopt;

        auto definition = definitions.find(target.source());
        if (definition != definitions.end())
            return refString(definition->second);
        if (auto component = componentOf(target))
            return refString(hoist(*component, target, ctx));
        if (ref.starts_with("#")) {
            auto name = target.pointer.empty() ? fs::path(target.file->path).stem().string() : target.pointer.back();
            return refString(hoist({ "schemas", name }, target, ctx));
        }
        return nullopt;
    }

    void resolveRef(Node& n, const string ref, const Slot& slot, const optional<ComponentName>& definition,
                    const Context& ctx)
    {
        auto target = locate(ref, ctx);

        if (definition && target.file != rootFile) {
            target = followAliases(std::move(target), ctx, true);
            inlineTarget(n, ref, target, slot, ctx);
            return;
        }
        target = followAliases(std::move(target), ctx, false);

        auto siblings = n.get<Node::Map>();
        siblings.erase("$ref");

        if (auto localRef = localRefFor(ref, target, slot, ctx)) {
            if (definition && *localRef == refString(*definition))
                fail(ref, ctx, "cyclic $ref");
            walkEntries(siblings, slot, ctx);
            siblings["$ref"] = Node { *localRef };
            n = Node { std::move(siblings) };
            return;
        }

        // Keys next to a Path Item's $ref (summary, extra parameters, ...) extend the target.
        if (slot.kind == Kind::PathItem)
            walkEntries(siblings, slot, ctx);
        inlineTarget(n, ref, target, slot, ctx);
        if (slot.kind == Kind::PathItem) {
            if (auto m = get_if<Node::Map>(&n.value)) {
                for (auto& [key, value] : siblings)
                    (*m)[key] = std::move(value);
            }
        }
    }

    void walk(Node& n, const Slot& slot, const Context& ctx, const optional<ComponentName>& definition = nullopt)
    {
        if (auto m = get_if<Node::Map>(&n.value)) {
            auto ref = refOf(n);
            // "#/..." written in the root spec is the standard in-document ref - not ours to touch.
            if (ref && !(ctx.file == rootFile && ref->starts_with("#"))) {
                resolveRef(n, *ref, slot, definition, ctx);
                return;
            }
            walkEntries(*m, slot, ctx);
            if (slot.kind == Kind::Operation && ctx.owner)
                keepOwnerSettings(*m, *ctx.owner, ctx);
        } else if (auto v = get_if<Node::Vec>(&n.value)) {
            for (size_t i = 0; i < v->size(); i++) {
                location.push_back(to_string(i));
                walk((*v)[i], Slot { }, ctx);
                location.pop_back();
            }
        }
    }

    void walkEntries(Node::Map& m, const Slot& slot, const Context& ctx)
    {
        // Before the other keys ("discriminator" has to claim its targets' component names before
        // "oneOf"/"anyOf" refer to the same ones).
        auto discriminator = m.find("discriminator");
        if (discriminator != m.end()) {
            location.push_back("discriminator");
            walkDiscriminator(discriminator->second, ctx);
            location.pop_back();
        }

        for (auto& [key, value] : m) {
            if (key == "discriminator")
                continue;
            optional<ComponentName> definition;
            if (slot.kind == Kind::ComponentSection && ctx.file == rootFile && inlineStack.empty())
                definition = ComponentName { slot.section, key };
            location.push_back(key);
            walk(value, childSlot(slot, key, rootFile->swagger), ctx, definition);
            location.pop_back();
        }
    }

    // `discriminator.mapping` values are refs too, just not spelled as {$ref: ...}.
    void walkDiscriminator(Node& n, const Context& ctx)
    {
        auto m = get_if<Node::Map>(&n.value);
        if (!m || !m->contains("propertyName")) {
            walk(n, Slot { }, ctx);
            return;
        }
        for (auto& [key, value] : *m) {
            location.push_back(key);
            if (key == "mapping") {
                if (auto mapping = get_if<Node::Map>(&value.value)) {
                    for (auto& [name, target] : *mapping) {
                        location.push_back(name);
                        resolveMappingValue(target, ctx);
                        location.pop_back();
                    }
                }
            } else if (key == "defaultMapping") {
                resolveMappingValue(value, ctx);
            } else {
                walk(value, Slot { }, ctx);
            }
            location.pop_back();
        }
    }

    void resolveMappingValue(Node& n, const Context& ctx)
    {
        auto value = n.getIf<Node::String>();
        if (!value)
            return;
        auto ref = *value;
        bool looksLikePath = ref.find('/') != string::npos || ref.find('#') != string::npos || ref.ends_with(".yaml")
            || ref.ends_with(".yml") || ref.ends_with(".json");
        if (ctx.file == rootFile) {
            if (ref.starts_with("#") || !looksLikePath)
                return;
        } else if (!looksLikePath) {
            // A bare schema name - meaning that file's own component, which may be referenced
            // from nowhere else.
            Pointer pointer { "components", "schemas", ref };
            if (ctx.file->swagger)
                pointer = { "definitions", ref };
            if (!navigate(ctx.file->content, pointer))
                return;
            ref = pointerToString(pointer);
        }

        auto target = followAliases(locate(ref, ctx), ctx, false);
        if (target.file == rootFile) {
            n = Node { pointerToString(target.pointer) };
            return;
        }
        auto definition = definitions.find(target.source());
        if (definition != definitions.end()) {
            n = Node { refString(definition->second) };
            return;
        }
        auto component = componentOf(target);
        if (!component) {
            auto name = target.pointer.empty() ? fs::path(target.file->path).stem().string() : target.pointer.back();
            component = ComponentName { "schemas", name };
            // So that {$ref: ...} to the same target gets this name instead of an inline copy.
            definitions.emplace(target.source(), *component);
        }
        n = Node { refString(hoist(*component, target, ctx)) };
    }

    // An operation taken from another complete document keeps what that document says about it.
    void keepOwnerSettings(Node::Map& operation, const SourceFile& owner, const Context& ctx)
    {
        if (!operation.contains("security")) {
            auto global = mapValue(owner.content, "security");
            operation["security"] = global ? *global : Node { Node::Vec { } };
        }
        if (auto requirements = operation["security"].getIf<Node::Vec>()) {
            for (const auto& requirement : *requirements) {
                auto schemes = requirement.getIf<Node::Map>();
                if (!schemes)
                    continue;
                for (const auto& [schemeName, scopes] : *schemes) {
                    Pointer pointer { "components", "securitySchemes", schemeName };
                    if (owner.swagger)
                        pointer = { "securityDefinitions", schemeName };
                    Context ownerCtx { &owner, &owner };
                    auto savedLocation = std::exchange(location, Pointer { "security" });
                    auto target = followAliases(locate(pointerToString(pointer), ownerCtx), ownerCtx, false);
                    location = std::move(savedLocation);
                    // Under the same name, whatever else refers to it: requirements name it.
                    hoist({ "securitySchemes", schemeName }, target, ownerCtx);
                }
            }
        }

        auto tags = operation.find("tags");
        auto tagNames = tags == operation.end() ? nullptr : tags->second.getIf<Node::Vec>();
        auto ownerTags = mapValue(owner.content, "tags");
        auto ownerTagList = ownerTags ? ownerTags->getIf<Node::Vec>() : nullptr;
        if (!tagNames || !ownerTagList)
            return;
        for (const auto& tagName : *tagNames) {
            auto name = tagName.getIf<Node::String>();
            if (!name)
                continue;
            for (size_t i = 0; i < ownerTagList->size(); i++) {
                auto declaredName = mapValue((*ownerTagList)[i], "name");
                if (!declaredName || !declaredName->getIf<Node::String>() || declaredName->get<Node::String>() != *name)
                    continue;
                if (!addedTagNames.insert(*name).second)
                    break;
                Node tag = (*ownerTagList)[i];
                auto savedLocation = std::exchange(location, Pointer { "tags", to_string(i) });
                walk(tag, Slot { }, Context { &owner, &owner });
                location = std::move(savedLocation);
                addedTags.emplace_back(*name, std::move(tag));
                break;
            }
        }
    }

    static Node::Map& asMap(Node& n)
    {
        if (!holds_alternative<Node::Map>(n.value))
            n.value = Node::Map();
        return get<Node::Map>(n.value);
    }

    void addHoistedComponents()
    {
        for (auto& [component, content] : additions) {
            auto* map = &asMap(root);
            for (const auto& seg : rootSectionPointer(component.section))
                map = &asMap((*map)[seg]);
            auto [it, isNew] = map->try_emplace(component.name, content);
            // Only possible when a whole section was itself pulled in through a $ref.
            if (!isNew)
                duplicates.push_back({ component, registry.at(component), "the root spec", std::move(content) });
        }
    }

    void addTags()
    {
        if (addedTags.empty())
            return;
        auto& tagsNode = asMap(root)["tags"];
        if (!holds_alternative<Node::Vec>(tagsNode.value))
            tagsNode.value = Node::Vec();
        auto& tags = get<Node::Vec>(tagsNode.value);

        set<string> existing;
        for (const auto& tag : tags) {
            auto name = mapValue(tag, "name");
            if (name && name->getIf<Node::String>())
                existing.insert(name->get<Node::String>());
        }
        for (auto& [name, tag] : addedTags) {
            if (!existing.contains(name))
                tags.push_back(std::move(tag));
        }
    }

    // Compared only now: a component's content isn't final while refs inside it are being resolved.
    void verifyDuplicates() const
    {
        for (const auto& duplicate : duplicates) {
            auto pointer = rootSectionPointer(duplicate.component.section);
            pointer.push_back(duplicate.component.name);
            auto existing = navigate(root, pointer);
            if (!existing || *existing != duplicate.content)
                throw runtime_error(format("<410c4f84> Conflicting definitions of component \"{}\": {} and {} "
                                           "differ. Rename one of them",
                                           pointerToString(pointer), duplicate.otherSource, duplicate.source));
        }
    }

    // Generators read operations from the path items themselves, so a local ref to a shared one is
    // replaced by its content.
    void inlineRootPathItems()
    {
        for (const auto& mapName : { "paths", "webhooks" }) {
            auto rootMap = get_if<Node::Map>(&root.value);
            if (!rootMap)
                return;
            auto it = rootMap->find(mapName);
            if (it == rootMap->end())
                continue;
            auto items = get_if<Node::Map>(&it->second.value);
            if (!items)
                continue;
            for (auto& [path, item] : *items)
                inlinePathItem(item, Pointer { mapName, path });
        }
    }

    void inlinePathItem(Node& item, const Pointer& itemLocation)
    {
        set<string> visited;
        while (auto ref = refOf(item)) {
            if (!ref->starts_with("#/components/pathItems/"))
                return;
            location = itemLocation;
            Context ctx { rootFile, nullptr };
            if (!visited.insert(*ref).second)
                fail(*ref, ctx, "cyclic $ref");
            auto target = navigate(root, parsePointer(ref->substr(1)));
            if (!target)
                fail(*ref, ctx, format("fragment \"{}\" not found in \"{}\"", ref->substr(1), rootFile->displayPath));
            Node content = *target;
            auto siblings = item.get<Node::Map>();
            siblings.erase("$ref");
            if (auto m = get_if<Node::Map>(&content.value)) {
                for (auto& [key, value] : siblings)
                    (*m)[key] = std::move(value);
            }
            item = std::move(content);
        }
    }

    Node& root;
    string rootDir;
    const SourceFile* rootFile = nullptr;
    map<string, unique_ptr<SourceFile>> files; // by canonical path; parsed once, never modified

    Pointer location; // where in the current file processing is, for error messages
    vector<string> inlineStack; // "<file>#<pointer>" of everything currently being inlined

    map<ComponentName, string> registry; // root component name -> description of where it came from
    map<string, ComponentName> definitions; // source -> the root component defined by it
    map<pair<string, string>, ComponentName> hoisted; // (section, source) -> root component
    map<ComponentName, Node> additions;
    vector<Duplicate> duplicates;
    vector<pair<string, Node>> addedTags;
    set<string> addedTagNames;
};

}

void resolveExternalRefs(Node& root, const string& specPath, const string& refRoot)
{
    logger.debug("<f1a2b3c4> Resolving external $refs of spec: {}", specPath);
    auto startTime = chrono::high_resolution_clock::now();

    Resolver resolver(root, specPath, refRoot);
    resolver.run();

    auto elapsedMs = chrono::duration<double, milli>(chrono::high_resolution_clock::now() - startTime).count();
    logger.debug("<ad82135a> External $ref resolution complete: {} file(s) loaded, {} component(s) hoisted, {} msec",
                 resolver.filesLoaded(), resolver.componentsHoisted(), elapsedMs);
}
