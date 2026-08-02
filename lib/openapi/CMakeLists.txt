set(TARGET openapi-yagen-lib-openapi)

set(SOURCES
  schema.cpp
  schema.h
)

set(DEPS
  openapi-yagen-lib-common
)

add_library(${TARGET} ${SOURCES})

target_link_libraries(${TARGET} ${DEPS})
