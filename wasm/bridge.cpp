// Embind entry points for the browser playground - see docs/playground.mdx and
// website/src/components/GeneratorPlayground/. Deliberately narrow: only what the playground UI
// needs (built-in + uploaded-zip generator sources, no remote-URL generators - see AGENTS.md/the
// plan this was built from for why). Every exported function returns a plain result struct with an
// `ok`/`error` pair instead of throwing across the Embind boundary, so the calling JS/worker code
// never has to reason about how a C++ exception surfaces on the JS side.

#include <format>
#include <fstream>
#include <memory>
#include <stdexcept>
#include <vector>

#include <emscripten/bind.h>
#include <emscripten/val.h>

#include <lib/common/node_walker.h>
#include <lib/common/yaml_or_json_parser.h>
#include <lib/filesystem/embedded_file_reader_backend.h>
#include <lib/filesystem/embedded_generators_registry.h>
#include <lib/filesystem/file_reader.h>
#include <lib/filesystem/memory_file_writer.h>
#include <lib/filesystem/zip_file_reader_backend.h>
#include <lib/generator/generator_metadata.h>
#include <lib/generator/openapi_generator.h>
#include <lib/generator/spec_file.h>
#include <lib/js/executor.h>
#include <lib/logger/logger.h>
#include <lib/openapi/document_field_order.h>
#include <lib/openapi/version.h>
#include <lib/openapi/version_convert.h>
#include <lib/templates/inja_template_renderer.h>

using namespace std;
using namespace emscripten;

namespace {

// Fixed MEMFS paths the spec/generator-zip are staged at before running the (otherwise disk-path-
// oriented) generation pipeline unchanged - see readSpecFile/ZipFileReaderBackend, both of which
// take a filesystem path, not spec/zip content directly.
constexpr const char* SPEC_PATH = "/openapi.yaml";
constexpr const char* GENERATOR_ZIP_PATH = "/generator.zip";

struct VariableInfo {
    string name;
    string description;
    string defaultValue;
    bool required;
};

struct GeneratorInfoResult {
    bool ok = false;
    string error;
    string name;
    string description;
    string openApiVersion;
    vector<VariableInfo> variables;
};

struct BuiltinGeneratorSummary {
    string name;
    string description;
    string openApiVersion;
};

struct GeneratedFile {
    string path;
    string content;
};

struct LogEntry {
    string level;
    string name;
    string message;
};

struct GenerateResult {
    bool ok = false;
    string error;
    vector<GeneratedFile> files;
    vector<LogEntry> logs;
};

struct ConvertResult {
    bool ok = false;
    string error;
    string text;
    vector<LogEntry> logs;
};

// A LoggerBackend that buffers entries in memory instead of writing to stdout - the wasm build has
// no console the user can see, so log lines are surfaced through GenerateResult/ConvertResult
// instead and rendered by the playground UI's collapsible log panel.
const char* logLevelName(LogFacade::LogLevel level)
{
    switch (level) {
        case LogFacade::LogLevel::TRACE:
            return "TRACE";
        case LogFacade::LogLevel::DEBUG:
            return "DEBUG";
        case LogFacade::LogLevel::INFO:
            return "INFO";
        case LogFacade::LogLevel::WARN:
            return "WARN";
        case LogFacade::LogLevel::ERROR:
            return "ERROR";
    }
    return "";
}

vector<LogEntry> g_logBuffer;

class MemoryLoggerBackend : public LogFacade::LoggerBackend {
public:
    void write(LogFacade::LogLevel level, const string& name, const string& message) override
    {
        g_logBuffer.push_back(LogEntry { .level = logLevelName(level), .name = name, .message = message });
    }
};

MemoryLoggerBackend g_loggerBackend;

struct LoggerInstaller {
    LoggerInstaller()
    {
        LogFacade::setLogBackend(&g_loggerBackend);
        LogFacade::setLogLevel(LogFacade::LogLevel::INFO);
    }
} g_loggerInstaller;

void clearLogs() { g_logBuffer.clear(); }

bool setLogLevel(const string& level)
{
    try {
        LogFacade::setLogLevel(LogFacade::strToLogLevel(level));
        return true;
    } catch (const exception&) {
        return false;
    }
}

void writeMemFile(const string& path, const string& content)
{
    ofstream f(path, ios::binary | ios::trunc);
    f << content;
    if (f.fail() || f.bad())
        throw runtime_error(format("<a1e6c9d4> Cannot stage \"{}\" in the in-browser filesystem", path));
}

void writeMemFile(const string& path, const val& bytes)
{
    auto vec = convertJSArrayToNumberVector<uint8_t>(bytes);
    ofstream f(path, ios::binary | ios::trunc);
    f.write(reinterpret_cast<const char*>(vec.data()), static_cast<streamsize>(vec.size()));
    if (f.fail() || f.bad())
        throw runtime_error(format("<b3f7d0e5> Cannot stage \"{}\" in the in-browser filesystem", path));
}

GeneratorMetadata readMetadata(FS::FileReader& fileReader)
{
    auto metadataNode = parseYamlOrJsonToNode(fileReader.read("generator.yml"));
    return parseGeneratorMetadata(NodeWalker(metadataNode));
}

GeneratorInfoResult toGeneratorInfoResult(const GeneratorMetadata& m)
{
    GeneratorInfoResult r;
    r.ok = true;
    r.name = m.name;
    r.description = m.description.value_or("");
    r.openApiVersion = m.openApiVersion.value_or("3.0");
    for (const auto& v : m.variables) {
        r.variables.push_back(VariableInfo {
            .name = v.name,
            .description = v.description.value_or(""),
            .defaultValue = v.defaultValue.value_or(""),
            .required = v.required,
        });
    }
    return r;
}

// Builds the same pipeline cli/commands/generate_command.cpp builds - FileReader over the given
// backend(s), JS::Executor, Inja template renderer, Generator::OpenApiGenerator - but with a
// MemoryFileWriter instead of DirFileWriter, and no post-processing step at all (there's no
// subprocess/formatter tooling available in a browser sandbox; see MemoryFileWriter's lack of a
// FilePostProcessor hook).
GenerateResult runGenerate(const string& specText, const vector<FS::FileReaderBackendPtr>& backends,
    const vector<string>& vars)
{
    GenerateResult result;
    clearLogs();
    try {
        writeMemFile(SPEC_PATH, specText);

        auto fileReader = make_shared<FS::FileReader>(FS::FileReader::Opts { backends });
        auto templateRenderer = make_shared<Templates::InjaTemplateRenderer>(
            Templates::InjaTemplateRenderer::Opts { .fileReader = fileReader });
        auto fileWriter = make_shared<FS::MemoryFileWriter>();
        auto jsExecutor = make_shared<JS::Executor>(JS::Executor::Opts { .fileReader = fileReader });

        Generator::OpenApiGenerator g(Generator::OpenApiGenerator::Opts {
            .fileReader = fileReader,
            .fileWriter = fileWriter,
            .jsExecutor = jsExecutor,
            .templateRenderer = templateRenderer,
            .defaultMainSciptPath = "main.js",
            .metadataPath = "generator.yml",
            .clearOutDir = false,
            .vars = vars,
        });
        g.generate(SPEC_PATH);

        result.ok = true;
        for (const auto& f : fileWriter->files())
            result.files.push_back(GeneratedFile { .path = f.path, .content = f.content });
    } catch (const exception& e) {
        result.error = e.what();
    }
    result.logs = g_logBuffer;
    return result;
}

GeneratorInfoResult runGetGeneratorInfo(const vector<FS::FileReaderBackendPtr>& backends)
{
    GeneratorInfoResult result;
    try {
        FS::FileReader fileReader(FS::FileReader::Opts { backends });
        result = toGeneratorInfoResult(readMetadata(fileReader));
    } catch (const exception& e) {
        result.error = e.what();
    }
    return result;
}

vector<FS::FileReaderBackendPtr> builtinBackends(const string& name)
{
    return { make_shared<FS::EmbeddedFileReaderBackend>(name) };
}

vector<FS::FileReaderBackendPtr> zipBackendsFromBytes(const val& zipBytes)
{
    writeMemFile(GENERATOR_ZIP_PATH, zipBytes);
    return { make_shared<FS::ZipFileReaderBackend>(GENERATOR_ZIP_PATH) };
}

vector<BuiltinGeneratorSummary> listBuiltinGenerators()
{
    vector<BuiltinGeneratorSummary> result;
    for (const auto& [name, files] : FS::Embedded::registry()) {
        auto it = files.find("generator.yml");
        if (it == files.end())
            continue; // shouldn't happen for a real embedded generator, but don't let one bad entry break the list
        try {
            auto metadata = parseGeneratorMetadata(NodeWalker(parseYamlOrJsonToNode(it->second)));
            result.push_back(BuiltinGeneratorSummary {
                .name = name,
                .description = metadata.description.value_or(""),
                .openApiVersion = metadata.openApiVersion.value_or("3.0"),
            });
        } catch (const exception&) {
            // Same reasoning as above - skip rather than fail the whole listing.
            continue;
        }
    }
    return result;
}

GeneratorInfoResult getBuiltinGeneratorInfo(const string& name)
{
    return runGetGeneratorInfo(builtinBackends(name));
}

GeneratorInfoResult getZipGeneratorInfo(const val& zipBytes)
{
    GeneratorInfoResult result;
    try {
        return runGetGeneratorInfo(zipBackendsFromBytes(zipBytes));
    } catch (const exception& e) {
        result.error = e.what();
        return result;
    }
}

GenerateResult generateFromBuiltin(const string& specText, const string& name, const vector<string>& vars)
{
    return runGenerate(specText, builtinBackends(name), vars);
}

GenerateResult generateFromZip(const string& specText, const val& zipBytes, const vector<string>& vars)
{
    clearLogs();
    try {
        return runGenerate(specText, zipBackendsFromBytes(zipBytes), vars);
    } catch (const exception& e) {
        GenerateResult result;
        result.error = e.what();
        result.logs = g_logBuffer;
        return result;
    }
}

// Near-identical port of ConvertCommand::process() (cli/commands/convert_command.cpp), returning
// converted text instead of writing a file. `fromVersion` empty means auto-detect, matching the
// CLI's own --from default.
ConvertResult convertSpec(const string& specText, const string& fromVersion, const string& toVersion,
    const string& outputFormat)
{
    ConvertResult result;
    clearLogs();
    try {
        writeMemFile(SPEC_PATH, specText);
        auto specNode = readSpecFile(SPEC_PATH);

        OpenApi::OpenApiVersion from;
        if (!fromVersion.empty()) {
            auto parsed = OpenApi::parseVersionString(fromVersion);
            if (!parsed)
                throw runtime_error(format("Unrecognized source version \"{}\"", fromVersion));
            from = *parsed;
        } else {
            auto detected = OpenApi::detectVersion(specNode);
            if (!detected)
                throw runtime_error("Cannot determine the spec's OpenAPI version - expected a top-level "
                                     "\"openapi\" (3.x) or \"swagger\" (2.0) field with a recognized value");
            from = *detected;
        }

        auto to = OpenApi::parseVersionString(toVersion);
        if (!to)
            throw runtime_error(format("Unrecognized target version \"{}\"", toVersion));

        auto converted = OpenApi::convertVersion(specNode, from, *to);
        auto fieldOrder = OpenApi::documentFieldOrder(*to);
        bool asJson = outputFormat == "json";
        result.text = asJson ? nodeToJsonText(converted, fieldOrder) : nodeToYamlText(converted, fieldOrder);
        result.ok = true;
    } catch (const exception& e) {
        result.error = e.what();
    }
    result.logs = g_logBuffer;
    return result;
}

}

EMSCRIPTEN_BINDINGS(openapi_yagen_playground)
{
    value_object<VariableInfo>("VariableInfo")
        .field("name", &VariableInfo::name)
        .field("description", &VariableInfo::description)
        .field("defaultValue", &VariableInfo::defaultValue)
        .field("required", &VariableInfo::required);

    value_object<GeneratorInfoResult>("GeneratorInfoResult")
        .field("ok", &GeneratorInfoResult::ok)
        .field("error", &GeneratorInfoResult::error)
        .field("name", &GeneratorInfoResult::name)
        .field("description", &GeneratorInfoResult::description)
        .field("openApiVersion", &GeneratorInfoResult::openApiVersion)
        .field("variables", &GeneratorInfoResult::variables);

    value_object<BuiltinGeneratorSummary>("BuiltinGeneratorSummary")
        .field("name", &BuiltinGeneratorSummary::name)
        .field("description", &BuiltinGeneratorSummary::description)
        .field("openApiVersion", &BuiltinGeneratorSummary::openApiVersion);

    value_object<GeneratedFile>("GeneratedFile")
        .field("path", &GeneratedFile::path)
        .field("content", &GeneratedFile::content);

    value_object<LogEntry>("LogEntry")
        .field("level", &LogEntry::level)
        .field("name", &LogEntry::name)
        .field("message", &LogEntry::message);

    value_object<GenerateResult>("GenerateResult")
        .field("ok", &GenerateResult::ok)
        .field("error", &GenerateResult::error)
        .field("files", &GenerateResult::files)
        .field("logs", &GenerateResult::logs);

    value_object<ConvertResult>("ConvertResult")
        .field("ok", &ConvertResult::ok)
        .field("error", &ConvertResult::error)
        .field("text", &ConvertResult::text)
        .field("logs", &ConvertResult::logs);

    register_vector<VariableInfo>("VariableInfoVector");
    register_vector<BuiltinGeneratorSummary>("BuiltinGeneratorSummaryVector");
    register_vector<GeneratedFile>("GeneratedFileVector");
    register_vector<LogEntry>("LogEntryVector");
    register_vector<string>("StringVector");

    emscripten::function("listBuiltinGenerators", &listBuiltinGenerators);
    emscripten::function("getBuiltinGeneratorInfo", &getBuiltinGeneratorInfo);
    emscripten::function("getZipGeneratorInfo", &getZipGeneratorInfo);
    emscripten::function("generateFromBuiltin", &generateFromBuiltin);
    emscripten::function("generateFromZip", &generateFromZip);
    emscripten::function("convertSpec", &convertSpec);
    emscripten::function("setLogLevel", &setLogLevel);
}
