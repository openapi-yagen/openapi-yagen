# Conan 2 cross profile for the browser-playground wasm build (see wasm/CMakeLists.txt,
# Dockerfile.wasm). Used as the *host* profile alongside the auto-detected default *build* profile
# (`conan install ... --profile:host=... --profile:build=default`), the same way any Conan
# cross-compilation setup separates "what we're building for" from "what we're building on".
#
# `os=Emscripten`/`arch=wasm`/`compiler=emcc` are Conan's own built-in settings for this target
# (see settings.yml) - no custom os/arch definitions needed. `tools.cmake.cmaketoolchain:
# user_toolchain` layers Conan's generated conan_toolchain.cmake on top of Emscripten's own
# toolchain file (which sets CMAKE_C/CXX_COMPILER=emcc/em++, sysroot, etc.) - same mechanism
# Conan's own docs use for Android NDK cross-builds. The path below is hardcoded to where the
# `emscripten/emsdk` Docker image (Dockerfile.wasm) installs the SDK - CMake's include() doesn't
# expand shell/env variables, so this can't reference $EMSDK the way a shell command could.

[settings]
os=Emscripten
arch=wasm
build_type=Release
compiler=emcc
compiler.version=3.1.64
compiler.libcxx=libc++
compiler.cppstd=20

[conf]
tools.cmake.cmaketoolchain:user_toolchain=["/emsdk/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake"]
tools.cmake.cmaketoolchain:generator=Ninja
tools.build:compiler_executables={"c": "emcc", "cpp": "em++"}
