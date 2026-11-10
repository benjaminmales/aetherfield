cmake_minimum_required(VERSION 3.20.0)

# The K4 board definition is out-of-tree, shipped inside this project at
# boards/kkm/k4beacon_nrf54l15/.
list(APPEND BOARD_ROOT ${CMAKE_CURRENT_SOURCE_DIR})

find_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE})

project(k4hello)

target_include_directories(app PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/../../../include  # aura_radio.h - protocol truth
    ${CMAKE_CURRENT_SOURCE_DIR}/../../common      # aura_band.h  - shared band layer
)

target_sources(app PRIVATE src/main.c)

target_sources_ifdef(CONFIG_K4_APP_SWEEP  app PRIVATE src/pin_sweep.c)
target_sources_ifdef(CONFIG_K4_APP_BEACON   app PRIVATE src/beacon_app.c)
target_sources_ifdef(CONFIG_K4_APP_PINPROBE app PRIVATE src/pin_probe.c)

# Same switch the pixel module uses: the shared band layer needs the 802.15.4
# stack, so key it off the Kconfig rather than a second CMake flag that has to
# agree with it.
if((CONFIG_K4_APP_BEACON OR CONFIG_K4_APP_PINPROBE) AND CONFIG_IEEE802154)
  target_sources(app PRIVATE ../../common/aura_band.c)
endif()
