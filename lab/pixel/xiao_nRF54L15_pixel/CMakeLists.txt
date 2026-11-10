cmake_minimum_required(VERSION 3.20.0)
find_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE})

project(xiao_nRF54L15_pixel)

target_include_directories(app PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}/../../../include   # aura_radio.h — protocol truth
  ${CMAKE_CURRENT_SOURCE_DIR}/../../common       # aura_band.h  — shared band layer
)

target_sources(app PRIVATE
  src/main.c
  ../../common/aura_band.c
)
