#pragma once

#include <string>
#include <vector>

#include "file_writer.h"

namespace FS {

class MemoryFileWriter : public FileWriter {
public:
    struct WrittenFile {
        std::string path;
        std::string content;
    };

    void write(const std::string& fileName, const std::string& content) override;
    void clear() override;

    const std::vector<WrittenFile>& files() const;

private:
    std::vector<WrittenFile> writtenFiles;
};

}
