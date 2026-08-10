// clazy:excludeall=non-pod-global-static

#include <filesystem>
#include <fstream>
#include <memory>

#include <catch2/catch_all.hpp>

#include <lib/common/string_tools.h>
#include <lib/filesystem/dir_file_reader_backend.h>
#include <lib/filesystem/dir_file_writer.h>
#include <lib/filesystem/file_post_processor.h>
#include <lib/filesystem/tools.h>
#include <lib/filesystem/zip_file_reader_backend.h>

#include "common/tools.h"

using namespace std;
using namespace std::filesystem;
using namespace FS;

inline string rtrim(const string& s)
{
    auto res = s;
    res.erase(find_if(res.rbegin(), res.rend(), [](unsigned char ch) { return !isspace(ch); }).base(), res.end());
    return res;
}

TEST_CASE("Directory file system backend", "[vfs]")
{
    DirFileReaderBackend fs(getResourcesDir());
    SECTION("Read existing file")
    {
        auto fileContent = fs.read("test_file").value();
        REQUIRE(rtrim(fileContent) == "Hello world!");
    }
    SECTION("Read non existing file") { REQUIRE(!fs.read("non_existent_file").has_value()); }
    SECTION("Reject relative path traversal escaping root dir")
    {
        REQUIRE(!fs.read("../../../../../../../../../../../../etc/passwd").has_value());
    }
    SECTION("Reject absolute path escaping root dir") { REQUIRE(!fs.read("/etc/passwd").has_value()); }
    SECTION("Reject symlink escaping root dir")
    {
        auto tmpRoot = path(temp_directory_path()) / "openapi-yagen-vfs-symlink-root";
        remove_all(tmpRoot);
        create_directories(tmpRoot);
        auto outsideFile = path(temp_directory_path()) / "openapi-yagen-vfs-symlink-outside.txt";
        {
            ofstream f(outsideFile);
            f << "secret";
        }
        create_symlink(outsideFile, tmpRoot / "escape_link");

        DirFileReaderBackend symlinkFs(tmpRoot.string());
        REQUIRE(!symlinkFs.read("escape_link").has_value());

        remove_all(tmpRoot);
        remove(outsideFile);
    }
}

TEST_CASE("Zip file system backend", "[vfs]")
{
    ZipFileReaderBackend fs(path(getResourcesDir()) / "test.zip");
    SECTION("Read existing files")
    {
        auto fileContent = fs.read("test_file").value();
        REQUIRE(rtrim(fileContent) == "Test");
        fileContent = fs.read("another_file").value();
        REQUIRE(fileContent == "This is a another file");
    }
    SECTION("Read non existing file") { REQUIRE(!fs.read("non_existent_file").has_value()); }
}

TEST_CASE("Filesystem with backends", "[vfs]")
{
    FileReader fs(FileReader::Opts {
        .backends = {
            make_shared<DirFileReaderBackend>(getResourcesDir()),
            make_shared<ZipFileReaderBackend>(path(getResourcesDir()) / "test.zip"),
        },
    });
    SECTION("Read existing file from dir") { REQUIRE(rtrim(fs.read("test_file")) == "Hello world!"); }
    SECTION("Read existing file from zip") { REQUIRE(rtrim(fs.read("another_file")) == "This is a another file"); }
    SECTION("Read non existing file") { REQUIRE_THROWS(fs.read("non_existent_file")); }
    SECTION("Reject relative path traversal regardless of which backend would serve it")
    {
        REQUIRE_THROWS(fs.read("../../../../../../../../../../etc/passwd"));
    }
    SECTION("Reject absolute path regardless of which backend would serve it") { REQUIRE_THROWS(fs.read("/etc/passwd")); }
}

TEST_CASE("Directory file writer confines output to outDir", "[vfs]")
{
    auto outDir = path(temp_directory_path()) / "openapi-yagen-vfs-writer-test";
    remove_all(outDir);
    DirFileWriter writer(DirFileWriter::Opts { .outDir = outDir.string(), .filePostProcessor = nullptr });

    SECTION("Writes a normal relative file, including nested directories")
    {
        writer.write("sub/dir/file.txt", "hello");
        REQUIRE(FS::readFile((outDir / "sub" / "dir" / "file.txt").string()) == "hello");
    }
    SECTION("Rejects relative path traversal")
    {
        auto escapeTarget = path(temp_directory_path()) / "openapi-yagen-vfs-writer-escape.txt";
        remove(escapeTarget);
        REQUIRE_THROWS(writer.write("../openapi-yagen-vfs-writer-escape.txt", "evil"));
        REQUIRE(!exists(escapeTarget));
    }
    SECTION("Rejects absolute path")
    {
        auto escapeTarget = path("/tmp/openapi-yagen-vfs-writer-escape-abs.txt");
        remove(escapeTarget);
        REQUIRE_THROWS(writer.write(escapeTarget.string(), "evil"));
        REQUIRE(!exists(escapeTarget));
    }

    remove_all(outDir);
}

TEST_CASE("Post process file", "[vfs]")
{
    SECTION("Substitutes %file% with the (shell-quoted) file path")
    {
        string outFile = "/tmp/out";
        FS::SystemToolsFilePostProcessor pp({ format("h,cpp:echo \"Processed file is: %file%.\">{}", outFile) });
        pp.postProcess("test.h");
        auto outFileContent = FS::readFile(outFile);
        // %file% is shell-quoted before substitution, so a template that already double-quotes it
        // (as this one does) sees the literal quote characters in its output - that's expected.
        REQUIRE((outFileContent | trim()) == "Processed file is: 'test.h'.");
        filesystem::remove(outFile);
    }
    SECTION("A file path containing shell metacharacters cannot inject commands")
    {
        auto markerFile = path(temp_directory_path()) / "openapi-yagen-vfs-postprocess-injection-marker";
        remove(markerFile);
        string outFile = "/tmp/out-injection";
        FS::SystemToolsFilePostProcessor pp({ format("h:echo %file%>{}", outFile) });
        auto maliciousPath = format("`touch {}`.h", markerFile.string());
        pp.postProcess(maliciousPath);
        REQUIRE(!exists(markerFile));
        filesystem::remove(outFile);
    }
}
