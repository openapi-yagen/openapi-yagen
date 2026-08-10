#include <exception>
#include <format>

#include <CLI/CLI.hpp>
#include <termcolor/termcolor.hpp>

#include <lib/common/std_tools.h>
#include <lib/logger/console_logger.h>
#include <lib/logger/logger.h>

#include "commands/convert_command.h"
#include "commands/extract_command.h"
#include "commands/generate_command.h"
#include "commands/list_generators_command.h"
#include "config.h"

using namespace std;
using namespace LogFacade;

using Commands = vector<CommandPtr>;
namespace tc = termcolor;

int main(int argc, char** argv)
{
    ConsoleLogger consoleLogger;
    setLogBackend(&consoleLogger);
    setLogLevel(LogLevel::INFO);

    Logger log("main");
    try {
        Commands commands = {
            make_shared<GenerateCommand>(),
            make_shared<ConvertCommand>(),
            make_shared<ListGeneratorsCommand>(),
            make_shared<ExtractCommand>(),
        };

        CLI::App app { format("OpenAPI Yet Another Generator (v{})", APP_VERSION) };
        app.set_version_flag("-v,--version", string(APP_VERSION), "Print version and exit");
        for (const auto& cmd : commands) {
            cmd->reg(app);
        }
        app.require_subcommand();
        app.add_option(
               "-l, --log-level",
               [](const auto& v) {
                   setLogLevel(LogFacade::strToLogLevel(v | firstOrThrow()));
                   return true;
               },
               "Set log level. Supported values: TRACE, DEBUG, INFO, WARN, ERROR")
            ->default_val("INFO");

        try {
            app.parse(argc, argv);
        } catch (const CLI::ParseError& e) {
            auto res = (app).exit(e);
            return res;
        }

        return 0;
    } catch (const exception& e) {
        log.error("<88489c35> Error: {}", e.what());
        return 1;
    }
}
