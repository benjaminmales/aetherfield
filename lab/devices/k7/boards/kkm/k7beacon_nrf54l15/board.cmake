# SPDX-License-Identifier: Apache-2.0
#
# K7 has no on-board debug IC; programming is over a SEGGER J-Link wired to
# SWDCLK / SWDIO. J-Link is the default runner.

if(CONFIG_SOC_NRF54L15_CPUAPP)
  board_runner_args(jlink "--device=nRF54L15_M33" "--speed=4000")
endif()

include(${ZEPHYR_BASE}/boards/common/jlink.board.cmake)
include(${ZEPHYR_BASE}/boards/common/nrfutil.board.cmake)
include(${ZEPHYR_BASE}/boards/common/nrfjprog.board.cmake)
