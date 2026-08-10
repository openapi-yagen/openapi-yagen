#pragma once

#include <string>

#include "base_command.h"

class InfoCommand : public BaseCommand {
public:
    InfoCommand();

    void reg(CLI::App& app) override;

private:
    void process();

    std::string generatorPath;
};
