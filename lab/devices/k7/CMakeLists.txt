cmake_minimum_required(VERSION 3.20.0)

# The K7 board definition is out-of-tree, shipped inside this project at
# boards/kkm/k7beacon_nrf54l15/. Register it so Zephyr/west can resolve the
# board target k7beacon_nrf54l15/nrf54l15/cpuapp.
list(APPEND BOARD_ROOT ${CMAKE_CURRENT_SOURCE_DIR})

find_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE})

project(k7beacon)

target_sources(app PRIVATE src/main.c)

# Shared Aetherfield 802.15.4 protocol header (repo-root include/ dir).
target_include_directories(app PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/../../include
)
