#pragma once

#include "base_command.h"

class ConvertCommand : public BaseCommand {
public:
    ConvertCommand();

    void reg(CLI::App& app) override;

private:
    void process();

    std::string specPath;
    std::string fromVersion;
    std::string toVersion;
    std::string outPath;
    std::string outputFormat;
};
