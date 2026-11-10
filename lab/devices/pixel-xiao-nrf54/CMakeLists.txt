cmake_minimum_required(VERSION 3.20.0)
find_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE})

project(pixel_xiao_nrf54)

target_include_directories(app PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/../../include   # aura_radio.h - protocol truth
    ${CMAKE_CURRENT_SOURCE_DIR}/../common       # aura_band.h  - shared band layer
)

target_sources(app PRIVATE src/main.c)

# The shared band layer needs the 802.15.4 stack, so key it off the Kconfig
# rather than a separate CMake flag - one switch instead of two that have to
# agree. noradio.conf turns CONFIG_IEEE802154 off and the band layer drops
# out of the build with it.
if(CONFIG_IEEE802154)
  target_sources(app PRIVATE ../common/aura_band.c)
else()
  message(STATUS "aura_band: CONFIG_IEEE802154=n - shared band layer excluded")
endif()
