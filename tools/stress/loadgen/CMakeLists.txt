cmake_minimum_required(VERSION 3.20.0)
find_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE})

project(aetherfield-loadgen)

# aura_radio.h — the SAME wire-format header the real Pixels and the gateway
# use. The whole point of this app is that the frames it emits are
# indistinguishable from a real device's, so it must never carry its own copy.
target_include_directories(app PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/../../../include)

# The shared band layer — the SAME file the shipping Pixels run. This app is
# production firmware plus a virtual fleet, not a model of it.
target_include_directories(app PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/../../../firmware/common)

target_sources(app PRIVATE
  src/main.c
  ../../../firmware/common/aura_band.c
)
