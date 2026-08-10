#pragma once

#include <string>

#include "base_command.h"

class ExtractCommand : public BaseCommand {
public:
    ExtractCommand();

    void reg(CLI::App& app) override;

private:
    void process();

    std::string name;
    std::string outDir;
};
