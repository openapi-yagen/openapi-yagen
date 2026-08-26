set(TARGET openapi-yagen-lib-fs)

find_package(zip REQUIRED)
find_package(battery-embed REQUIRED)

set(SOURCES
  definitions.h
  dir_file_reader_backend.cpp
  dir_file_reader_backend.h
  dir_file_writer.cpp
  dir_file_writer.h
  embedded_file_reader_backend.cpp
  embedded_file_reader_backend.h
  embedded_generators_registry.h
  embedded_generators_registry_helpers.cpp
  file_post_processor.cpp
  file_post_processor.h
  file_reader.cpp
  file_reader.h
  file_writer.cpp
  file_writer.h
  memory_file_writer.cpp
  memory_file_writer.h
  remote_file_reader_backend.cpp
  remote_file_reader_backend.h
  tools.cpp
  tools.h
  zip_file_reader_backend.cpp
  zip_file_reader_backend.h
)

set(DEPS
  zip::zip
  battery::embed
  openapi-yagen-lib-common
  openapi-yagen-lib-logger
)

add_library(${TARGET} ${SOURCES})

target_link_libraries(${TARGET} ${DEPS})

# Embed the "popular" bundled generators (README's "embed some popular templates" TODO) directly
# into the binary, addressable via `-g builtin:<name>` with no local checkout, zip, or network
# access needed. Each <name> below must match the embedded generator's own generator.yml `name:`
# field (derived automatically from the directory name here; enforced by a test in vfs_test.cpp).
set(EMBEDDED_GENERATOR_DIRS
  kotlin_ktor_client_generator
  kotlin_ktor_server_generator
  typescript_fetch_client_generator
  ruby_faraday_client_generator
  python_tornado_server_generator
)

set(EMBEDDED_GENERATORS_REGISTRATIONS "")
foreach(genDir ${EMBEDDED_GENERATOR_DIRS})
  string(REPLACE "_generator" "" genName "${genDir}")
  set(genSrcDir "${CMAKE_SOURCE_DIR}/generators/${genDir}/src")
  file(GLOB_RECURSE genFilesAbs CONFIGURE_DEPENDS "${genSrcDir}/*")
  foreach(absFile ${genFilesAbs})
    file(RELATIVE_PATH relFile "${genSrcDir}" "${absFile}")
    file(RELATIVE_PATH relFileFromHere "${CMAKE_CURRENT_SOURCE_DIR}" "${absFile}")
    b_embed(${TARGET} "${relFileFromHere}")
    string(APPEND EMBEDDED_GENERATORS_REGISTRATIONS
      "        r[\"${genName}\"][\"${relFile}\"] = b::embed<\"${relFileFromHere}\">().str();\n")
  endforeach()
endforeach()

configure_file(embedded_generators_registry.generated.cpp.in
  ${CMAKE_CURRENT_BINARY_DIR}/embedded_generators_registry.generated.cpp)
target_sources(${TARGET} PRIVATE ${CMAKE_CURRENT_BINARY_DIR}/embedded_generators_registry.generated.cpp)
