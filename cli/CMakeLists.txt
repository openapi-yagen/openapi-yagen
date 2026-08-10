set(TARGET openapi-yagen)

find_package(CLI11 REQUIRED)

add_link_options(-static -static-libgcc -static-libstdc++)

include_directories(${CMAKE_CURRENT_BINARY_DIR})

if(RELEASE_MODE)
    add_link_options(-s -Os)
endif()

configure_file(config.h.in config.h)

set(SOURCES
    main.cpp
    commands/base_command.h
    commands/convert_command.h
    commands/convert_command.cpp
    commands/extract_command.h
    commands/extract_command.cpp
    commands/generate_command.h
    commands/generate_command.cpp
    commands/info_command.h
    commands/info_command.cpp
    commands/list_generators_command.h
    commands/list_generators_command.cpp
)

add_executable(${TARGET} ${SOURCES})

target_link_libraries(${TARGET}
    CLI11::CLI11
    openapi-yagen-lib-generator
)

include(GNUInstallDirs)
install(TARGETS ${TARGET}
    LIBRARY DESTINATION ${CMAKE_INSTALL_LIBDIR}
    RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR}
)
