#include "inja_template_renderer.h"

#include <inja/inja.hpp>

#include "../common/std_tools.h"
#include "../common/yaml_or_json_parser.h"
#include "../filesystem/file_reader.h"
#include "../logger/logger.h"

using namespace std;

namespace Templates {

namespace {
LogFacade::Logger logger("Templates::InjaTemplateRenderer");
}

InjaTemplateRenderer::InjaTemplateRenderer(Opts&& opts)
    : opts(std::move(opts))
{
}

std::string InjaTemplateRenderer::render(const std::string& filePath, const Node& data, const Functions& funcs)
{
    logger.debug("<53daa47f> Render template: {}", filePath);
    auto tmpl = opts.fileReader->read(filePath);
    inja::Environment env;
    env.set_include_callback([&](const std::string& path, const std::string& templateName) {
        logger.debug("<ca44e5c7> Include template: path={}, templateName={}", path, templateName);
        return env.parse(opts.fileReader->read(templateName));
    });
    env.set_search_included_templates_in_files(false);

    for (const auto& func : funcs) {
        env.add_callback(func.name, [func](inja::Arguments& args) {
            auto argNodes = args | mapToVector([](auto arg) { return jsonToNode(*arg); });
            auto res = func.func(argNodes);
            return nodeToJson(res);
        });
    }

    auto jsonData = nodeToJson(data);
    return env.render(tmpl, jsonData);
}

}
