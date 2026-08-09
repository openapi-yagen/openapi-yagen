set(TARGET openapi-yagen-lib-openapi)

set(SOURCES
  document.cpp
  document.h
  info.h
  ref.h
  resolve.cpp
  resolve.h
  schema.cpp
  schema.h
  security.h
  version.cpp
  version.h
  version_convert.cpp
  version_convert.h
  v3/reader.cpp
  v3/reader.h
  v3/writer.cpp
  v3/writer.h
  v2/reader.cpp
  v2/reader.h
  v2/writer.cpp
  v2/writer.h
)

set(DEPS
  openapi-yagen-lib-common
  openapi-yagen-lib-logger
)

add_library(${TARGET} ${SOURCES})

target_link_libraries(${TARGET} ${DEPS})
