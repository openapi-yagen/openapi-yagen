#include "memory_file_writer.h"

#include <format>
#include <stdexcept>

#include "tools.h"

using namespace std;

namespace FS {

void MemoryFileWriter::write(const std::string& fileName, const std::string& content)
{
    if (!isPathTraversalSafe(fileName))
        throw runtime_error(format("<f2cd6aa7> Refusing to write outside output directory: \"{}\"", fileName));

    writtenFiles.push_back(WrittenFile { .path = fileName, .content = content });
}

void MemoryFileWriter::clear()
{
    writtenFiles.clear();
}

const std::vector<MemoryFileWriter::WrittenFile>& MemoryFileWriter::files() const
{
    return writtenFiles;
}

}
