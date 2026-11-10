cmake_minimum_required(VERSION 3.20.0)
list(APPEND BOARD_ROOT ${CMAKE_CURRENT_SOURCE_DIR})
find_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE})

project(traitors)

target_sources(app PRIVATE
    src/main.c
    src/bsp/sensor/imu/bsp_imu.c
    src/inference_postprocessing.c
    src/gesture/hand_raise.c
)

target_include_directories(app PRIVATE
    src
    src/nrf_edgeai_lib/nrf_edgeai/include
    src/nrf_edgeai_lib
)

target_sources(app PRIVATE
    src/nrf_edgeai_lib/nrf_edgeai_generated/nrf_edgeai_user_model.c
)

target_link_libraries(app PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/src/nrf_edgeai_lib/nrf_edgeai/lib/libnrf_edgeai_cortex-m33.a
)
