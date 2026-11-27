#pragma once

#include <vector>

#include "base_command.h"

class BundleCommand : public BaseCommand {
public:
    BundleCommand();

    void reg(CLI::App& app) override;

private:
    void process();

    std::string specPath;
    std::string toVersion;
    std::string outPath;
    std::string outputFormat;
    std::string refRoot;
    std::vector<std::string> tags;
};
