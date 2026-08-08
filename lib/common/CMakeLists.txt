set(TARGET openapi-yagen-lib-common)

find_package(yaml-cpp REQUIRED)
find_package(nlohmann_json REQUIRED)

set(SOURCES
  finalize.h
  function.h
  node.cpp
  node.h
  node_walker.cpp
  node_walker.h
  process_executor.cpp
  process_executor.h
  std_tools.cpp
  std_tools.h
  string_tools.cpp
  string_tools.h
  yaml_or_json_parser.cpp
  yaml_or_json_parser.h
)

set(DEPS
  yaml-cpp::yaml-cpp
  nlohmann_json::nlohmann_json
  openapi-yagen-lib-logger
)

add_library(${TARGET} ${SOURCES})

target_link_libraries(${TARGET} ${DEPS})
