#include "file_post_processor.h"

#include <array>
#include <cstdio>
#include <filesystem>
#include <format>
#include <iostream>
#include <memory>
#include <regex>
#include <set>
#include <stdexcept>
#include <string>

#include "../common/process_executor.h"
#include "../common/std_tools.h"
#include "../common/string_tools.h"

using namespace std;

namespace FS {

struct Tool {
    set<string> fileExt;
    string commandTemplate;
};

Tool parseToolString(const std::string& s)
{
    auto pos = s.find(":");
    Tool res;
    if (pos != string::npos) {
        res.fileExt = s.substr(0, pos) | split(",") | mapToSet([](const auto& v) { return string(v) | ltrim('.'); });
        res.commandTemplate = s.substr(pos + 1, s.size() - pos - 1);
    } else {
        res.commandTemplate = s;
    }
    return res;
}

FilePostProcessor::~FilePostProcessor() { }

SystemToolsFilePostProcessor::SystemToolsFilePostProcessor(const Tools& tools)
    : tools(tools)
{
}

static string filePlaceholder = "%file%";

void SystemToolsFilePostProcessor::postProcess(const std::string& filePath)
{
    for (const auto& s : tools) {
        auto tool = parseToolString(s);
        if (!tool.fileExt.empty()) {
            // skip tool if file ext not matched to tool's supported extensions
            auto ext = filesystem::path(filePath).extension() | ltrim('.');
            if (tool.fileExt.find(ext) == tool.fileExt.end())
                continue;
        }
        auto command = tool.commandTemplate;
        auto pos = command.find(filePlaceholder);
        if (pos != string::npos) {
            command.replace(pos, filePlaceholder.size(), shellSingleQuote(filePath));
        }
        ProcessExecutor::executeAndCheckResult(command);
    }
}
}
