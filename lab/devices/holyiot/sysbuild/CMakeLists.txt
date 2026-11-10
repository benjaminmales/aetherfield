# Copyright (c) 2025
# SPDX-License-Identifier: Apache-2.0

# Register the project's boards/ directory so sysbuild can find
# out-of-tree board definitions (e.g. holyiot_25008_nrf54l15).
list(APPEND BOARD_ROOT ${APP_DIR})

find_package(Sysbuild REQUIRED HINTS $ENV{ZEPHYR_BASE})

project(sysbuild LANGUAGES)
