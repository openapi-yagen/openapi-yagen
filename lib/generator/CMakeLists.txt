set(TARGET openapi-yagen-lib-generator)

find_package(quickjs REQUIRED)
find_package(nlohmann_json REQUIRED)

set(SOURCES
  external_ref_resolver.cpp
  external_ref_resolver.h
  functions.cpp
  functions.h
  generator_metadata.cpp
  generator_metadata.h
  openapi_generator.cpp
  openapi_generator.h
  openapi_js_bridge.cpp
  openapi_js_bridge.h
  spec_file.cpp
  spec_file.h
)

set(DEPS
  quickjs::quickjs
  nlohmann_json::nlohmann_json
  openapi-yagen-lib-common
  openapi-yagen-lib-fs
  openapi-yagen-lib-js
  openapi-yagen-lib-openapi
  openapi-yagen-lib-templates
)

add_library(${TARGET} ${SOURCES})

target_link_libraries(${TARGET} ${DEPS})
