cmake_minimum_required(VERSION 3.20.0)
find_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE})

project(pixel-gateway)

# aura_radio.h — the source of truth for the wire format. Shared with the
# device firmware so the two cannot drift.
target_include_directories(app PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/../../include)

target_sources(app PRIVATE
  src/main.c
  src/w5500.c
  src/link.c
)
