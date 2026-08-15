set(TARGET openapi-yagen-test)

find_package(Catch2 REQUIRED)

add_definitions(-D__RESOURCES_DIR__=${CMAKE_CURRENT_SOURCE_DIR}/resources -DBUILD_DIR=${CMAKE_BINARY_DIR})

set(SOURCES
    common/main.cpp
    common/tools.cpp
    common/tools.h
    common_test.cpp
    external_ref_resolver_test.cpp
    filter_test.cpp
    generator_test.cpp
    openapi_js_test.cpp
    openapi_test.cpp
    parser_test.cpp
    v2_reader_writer_test.cpp
    v3_reader_writer_test.cpp
    vfs_test.cpp
)

add_executable(${TARGET} ${SOURCES})

target_link_libraries(${TARGET}
  Catch2::Catch2
  openapi-yagen-lib-common
  openapi-yagen-lib-fs
  openapi-yagen-lib-js
  openapi-yagen-lib-generator
  openapi-yagen-lib-openapi
  openapi-yagen-lib-templates
)
