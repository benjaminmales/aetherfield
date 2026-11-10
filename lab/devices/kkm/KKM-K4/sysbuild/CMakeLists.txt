# Copyright (c) 2026
# SPDX-License-Identifier: Apache-2.0

# Register the project's boards/ directory so sysbuild can find the
# out-of-tree K4 board definition (k4beacon_nrf54l15).
list(APPEND BOARD_ROOT ${APP_DIR})

find_package(Sysbuild REQUIRED HINTS $ENV{ZEPHYR_BASE})

project(sysbuild LANGUAGES)
