cmake_minimum_required(VERSION 3.20.0)

# Reuse the board definition that already lives under AURA/holyiot rather than
# copying it. One source of truth: fix the board once, every app that points
# here gets the fix.
get_filename_component(AURA_DIR "${CMAKE_CURRENT_SOURCE_DIR}/.." ABSOLUTE)
list(APPEND BOARD_ROOT "${AURA_DIR}/holyiot")

find_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE})

project(pixel_led_test)

target_sources(app PRIVATE src/main.c)
