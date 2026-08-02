set(TARGET openapi-yagen-lib-openapi)

set(SOURCES
  document.cpp
  document.h
  ref.h
  schema.cpp
  schema.h
)

set(DEPS
  openapi-yagen-lib-common
)

add_library(${TARGET} ${SOURCES})

target_link_libraries(${TARGET} ${DEPS})
