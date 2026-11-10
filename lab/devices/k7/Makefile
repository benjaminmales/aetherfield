# ============================================================================
# K7 Beacon (nRF54L15) — build & flash
#
#   BOARD DEFINITION LIVES HERE:
#     $(BOARD_ROOT)/boards/kkm/k7beacon_nrf54l15/
#   (registered as an out-of-tree board via -DBOARD_ROOT, also appended in
#    CMakeLists.txt and sysbuild/CMakeLists.txt)
#
#   App overlay (auto-applied):
#     boards/k7beacon_nrf54l15_nrf54l15_cpuapp.overlay
#
#   Programming transport: SEGGER J-Link wired to SWDCLK / SWDIO
#   (the K7 has no on-board debug IC).
#
# Usage:
#   source <ncs>/zephyr/zephyr-env.sh   # or activate the nRF Connect toolchain
#   make build      # configure + build (production: logging off, deep sleep)
#   make build DEBUG=1  # bring-up build with RTT console + logging
#   make flash      # flash over J-Link
#   make rebuild    # pristine build
#   make rtt        # view RTT log output over the J-Link (needs a DEBUG build)
#   make flash-erase  # mass-erase then flash (recover a bricked RRAM/UICR)
# ============================================================================

BOARD       ?= k7beacon_nrf54l15/nrf54l15/cpuapp
BOARD_ROOT  ?= $(CURDIR)
BUILD_DIR   ?= build
JLINK_DEVICE ?= nRF54L15_M33
JLINK_SPEED ?= 4000

# DEBUG=1 layers debug.conf (RTT console + logging) on top of prj.conf.
# Default build is the production, low-power config (logging off).
DEBUG ?= 0
ifeq ($(DEBUG),1)
EXTRA_CONF := -DEXTRA_CONF_FILE=debug.conf
endif

CMAKE_ARGS = -DBOARD_ROOT=$(BOARD_ROOT) $(EXTRA_CONF)

.PHONY: build rebuild flash flash-erase rtt menuconfig clean pristine info

build:
	west build -b $(BOARD) --build-dir $(BUILD_DIR) $(CURDIR) -- $(CMAKE_ARGS)

# Pristine (clean) configure + build
rebuild:
	west build -b $(BOARD) -p always --build-dir $(BUILD_DIR) $(CURDIR) -- $(CMAKE_ARGS)

# Flash over J-Link
flash:
	west flash --build-dir $(BUILD_DIR) --runner jlink

# Mass-erase then flash (use if RRAM/UICR is in a bad state)
flash-erase:
	west flash --build-dir $(BUILD_DIR) --runner jlink --erase

# Stream RTT console/log output over the same J-Link
rtt:
	JLinkRTTViewer || JLinkRTTLogger -Device $(JLINK_DEVICE) -If SWD -Speed $(JLINK_SPEED) -RTTChannel 0 /dev/stdout

menuconfig:
	west build --build-dir $(BUILD_DIR) -t menuconfig

clean pristine:
	rm -rf $(BUILD_DIR)

info:
	@echo "BOARD       = $(BOARD)"
	@echo "BOARD_ROOT  = $(BOARD_ROOT)"
	@echo "Board def   = $(BOARD_ROOT)/boards/kkm/k7beacon_nrf54l15/"
	@echo "Overlay     = boards/k7beacon_nrf54l15_nrf54l15_cpuapp.overlay"
	@echo "J-Link      = $(JLINK_DEVICE) @ $(JLINK_SPEED) kHz (SWD)"
