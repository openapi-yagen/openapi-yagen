#pragma once

#include "base_command.h"

class GenerateCommand : public BaseCommand {
public:
    GenerateCommand();

    void reg(CLI::App& app) override;

private:
    void process();

    std::string specPath;
    std::string outDir;
    std::string overrideDir;
    std::string format;
    std::string generatorPath;
    std::vector<std::string> postProcessTools;
    std::vector<std::string> vars;
    std::vector<std::string> tags;
    bool clearOutDir;
};
