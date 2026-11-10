cmake_minimum_required(VERSION 3.20.0)
find_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE})

project(seeedFirmware)

target_include_directories(app PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/src/nrf_edgeai_lib/nrf_edgeai/include
    ${CMAKE_CURRENT_SOURCE_DIR}/src/nrf_edgeai_lib
    ${CMAKE_CURRENT_SOURCE_DIR}/src
    ${CMAKE_CURRENT_SOURCE_DIR}/../../include   # aura_radio.h - protocol truth
    ${CMAKE_CURRENT_SOURCE_DIR}/../common       # aura_band.h  - shared band layer
)

target_link_libraries(app PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/src/nrf_edgeai_lib/nrf_edgeai/lib/libnrf_edgeai_cortex-m33.a
)

target_sources(app PRIVATE src/main.c)
target_sources(app PRIVATE src/inference_postprocessing.c)
target_sources(app PRIVATE src/nrf_edgeai_lib/nrf_edgeai_generated/nrf_edgeai_user_model.c)
target_sources(app PRIVATE src/bsp/sensor/imu/bsp_imu.c)

# Shared v2 band layer: radio, op_mode state machine, animation engine.
target_sources(app PRIVATE ../common/aura_band.c)
