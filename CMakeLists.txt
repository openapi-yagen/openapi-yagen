cmake_minimum_required(VERSION 3.21)

project(openapi-yagen LANGUAGES CXX)

# set(CMAKE_C_STANDARD C99)
# set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

string(TOUPPER "${CMAKE_BUILD_TYPE}" CMAKE_BUILD_TYPE_UPPERCASE)

if(CMAKE_BUILD_TYPE_UPPERCASE MATCHES "(RELEASE|RELWITHDEBINFO|MINSIZEREL)")
    set(RELEASE_MODE ON)
endif()

set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -Wall -Wextra -Wpedantic -Werror -Wno-comment -Wno-reorder \
  -Werror=return-type -Werror=overloaded-virtual -Wno-unused-parameter -Werror=suggest-override \
  -Wno-c99-extensions")
# quickjs.h implements JS_NULL/JS_UNDEFINED/JS_MKPTR/etc. (used throughout lib/js, lib/generator)
# as C99 compound literals - valid, deliberate C API usage, not something our code controls. GCC's
# -Wpedantic doesn't flag it; Apple Clang's does via -Wc99-extensions, turning every call site into
# a -Werror build failure. GCC silently ignores -Wno- flags it doesn't recognize, so this is a
# no-op there.

if(NOT RELEASE_MODE)
    # set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -Wall -Wextra -Wpedantic -Werror -Wno-comment -Wno-reorder -Werror=return-type -Woverloaded-virtual")
else()
endif()

# version from git: exact tag -> "1.2.3", N commits after a tag -> "1.2.3-N-gHASH"
find_package(Git QUIET)
if(GIT_EXECUTABLE)
    execute_process(
        COMMAND ${GIT_EXECUTABLE} describe --tags --always
        WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
        OUTPUT_VARIABLE APP_VERSION
        OUTPUT_STRIP_TRAILING_WHITESPACE
        ERROR_QUIET
    )
endif()
if(NOT APP_VERSION)
    set(APP_VERSION "unknown")
endif()
message(STATUS "App version: " ${APP_VERSION})

include_directories(${CMAKE_SOURCE_DIR})

# battery::embed (lib/filesystem) embeds generator files as static data with no legitimate need for
# its dev-mode hot-reload/file-watcher thread or absolute build-machine paths in the binary - force
# production mode unconditionally rather than only in RELEASE_MODE.
set(B_PRODUCTION_MODE ON CACHE BOOL "Disable battery::embed hot-reload/dev features" FORCE)
set(B_EMBED_SILENCE_DEVMODE_WARNING ON CACHE BOOL "" FORCE)

add_subdirectory(lib)

# The Emscripten build only produces the browser playground's wasm module (see wasm/CMakeLists.txt)
# - it skips cli/ and test/, which depend on CLI11/Catch2 (not installed for the wasm Conan profile,
# and not meaningful in a browser context: no argv, no terminal to run a test binary in).
if(EMSCRIPTEN)
    add_subdirectory(wasm)
else()
    add_subdirectory(cli)
    add_subdirectory(test)
endif()
