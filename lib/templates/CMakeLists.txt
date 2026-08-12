set(TARGET openapi-yagen-lib-templates)

find_package(nlohmann_json REQUIRED)

set(SOURCES
  definitions.h
  inja_template_renderer.cpp
  inja_template_renderer.h
  template_renderer.cpp
  template_renderer.h
)

set(DEPS
  openapi-yagen-lib-3rdparty-inja
  nlohmann_json::nlohmann_json
  openapi-yagen-lib-fs
  openapi-yagen-lib-logger
)

add_library(${TARGET} ${SOURCES})

target_link_libraries(${TARGET} ${DEPS})
