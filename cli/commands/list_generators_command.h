#pragma once

#include "base_command.h"

class ListGeneratorsCommand : public BaseCommand {
public:
    ListGeneratorsCommand();

    void reg(CLI::App& app) override;

private:
    void process();
};
