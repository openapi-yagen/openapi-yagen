set(TARGET openapi-yagen-wasm)

add_executable(${TARGET} bridge.cpp)

target_link_libraries(${TARGET}
    openapi-yagen-lib-generator
)

# Compiled and instantiated only inside a dedicated Web Worker (see
# website/src/components/GeneratorPlayground/yagen.worker.ts) - never on the page's main thread -
# so ENVIRONMENT=worker lets Emscripten drop the web-main-thread-only code paths from the glue JS.
# No -pthread: a threaded build needs SharedArrayBuffer + COOP/COEP response headers, which GitHub
# Pages (this site's host) cannot set.
target_compile_options(${TARGET} PRIVATE -fexceptions)
target_link_options(${TARGET} PRIVATE
    --bind
    -sMODULARIZE=1
    -sEXPORT_ES6=1
    -sEXPORT_NAME=createYagenModule
    -sALLOW_MEMORY_GROWTH=1
    -sENVIRONMENT=worker
    -fexceptions
)

if(RELEASE_MODE)
    target_compile_options(${TARGET} PRIVATE -Os)
    target_link_options(${TARGET} PRIVATE -Os)
endif()

set_target_properties(${TARGET} PROPERTIES OUTPUT_NAME "openapi-yagen")

include(GNUInstallDirs)
install(FILES
    "${CMAKE_CURRENT_BINARY_DIR}/openapi-yagen.js"
    "${CMAKE_CURRENT_BINARY_DIR}/openapi-yagen.wasm"
    DESTINATION ${CMAKE_INSTALL_BINDIR}
)
