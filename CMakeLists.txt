cmake_minimum_required(VERSION 3.5)

project(openapi-yagen LANGUAGES CXX)

# set(CMAKE_C_STANDARD C99)
# set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

string(TOUPPER "${CMAKE_BUILD_TYPE}" CMAKE_BUILD_TYPE_UPPERCASE)

if(CMAKE_BUILD_TYPE_UPPERCASE MATCHES "(RELEASE|RELWITHDEBINFO|MINSIZEREL)")
    set(RELEASE_MODE ON)
endif()

set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -Wall -Wextra -Wpedantic -Werror -Wno-comment -Wno-reorder \
  -Werror=return-type -Werror=overloaded-virtual -Wno-unused-parameter -Werror=suggest-override")

if(NOT RELEASE_MODE)
    # set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -Wall -Wextra -Wpedantic -Werror -Wno-comment -Wno-reorder -Werror=return-type -Woverloaded-virtual")
else()
endif()

# version from git: exact tag -> "1.2.3", N commits after a tag -> "1.2.3-N-gHASH"
find_package(Git QUIET)
if(GIT_EXECUTABLE)
    execute_process(
        COMMAND ${GIT_EXECUTABLE} describe --tags --always
        WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
        OUTPUT_VARIABLE APP_VERSION
        OUTPUT_STRIP_TRAILING_WHITESPACE
        ERROR_QUIET
    )
endif()
if(NOT APP_VERSION)
    set(APP_VERSION "unknown")
endif()
message(STATUS "App version: " ${APP_VERSION})

include_directories(${CMAKE_SOURCE_DIR})

add_subdirectory(cli)
add_subdirectory(lib)
add_subdirectory(test)
