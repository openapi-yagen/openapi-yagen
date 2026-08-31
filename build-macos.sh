#!/bin/bash
set -euo pipefail
set -x

# Builds a native macOS universal (x86_64 + arm64) binary of the CLI. Unlike build-musl.sh/
# build-uclibc.sh, this doesn't run inside Docker: it's meant for a macOS host (e.g. the
# macos-latest GitHub Actions runner), where Apple's own toolchain cross-compiles for either
# arch from either host arch with no emulation needed - Conan is just told which `arch` to target
# for each of the two builds, then `lipo` glues the two single-arch binaries into one.
#
# Requires: cmake, ninja, conan, and Xcode's command line tools (clang, lipo) on PATH.

APP_NAME=openapi-yagen
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

conan profile detect --force

build_arch() {
    local conan_arch=$1
    local build_dir="$REPO_ROOT/build-macos-${conan_arch}"

    mkdir -p "$build_dir"
    conan install "$REPO_ROOT" -s compiler.cppstd=20 -s arch="$conan_arch" \
        --output-folder="$build_dir" --build=missing
    cmake -S "$REPO_ROOT" -B "$build_dir" \
        -DCMAKE_TOOLCHAIN_FILE="$build_dir/conan_toolchain.cmake" -DCMAKE_BUILD_TYPE=Release -G Ninja
    cmake --build "$build_dir" --target ${APP_NAME}
}

# Conan's Apple arch names: x86_64 for Intel, armv8 for Apple Silicon (arm64).
build_arch x86_64
build_arch armv8

mkdir -p dist
lipo -create -output "dist/${APP_NAME}-macos" \
    "build-macos-x86_64/cli/${APP_NAME}" \
    "build-macos-armv8/cli/${APP_NAME}"
lipo -info "dist/${APP_NAME}-macos"
