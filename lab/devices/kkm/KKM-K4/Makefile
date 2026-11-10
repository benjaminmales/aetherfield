# ============================================================================
# K4 Beacon (nRF54L15) -- hello world. CLI equivalents of the VS Code build
# configurations described in README.md. Use whichever you prefer.
# ============================================================================

BOARD       ?= k4beacon_nrf54l15/nrf54l15/cpuapp
BOARD_ROOT  ?= $(CURDIR)
BUILD_DIR   ?= build
JLINK_DEVICE ?= nRF54L15_M33
JLINK_SPEED ?= 4000

# Optional extras, e.g.
#   make build CONF=sweep.conf OVERLAY=overlays/sweep.overlay
#   make build OVERLAY=overlays/hfxo-external.overlay
OVERLAY ?=
CONF    ?=
ifneq ($(OVERLAY),)
EXTRA_DTC := -DEXTRA_DTC_OVERLAY_FILE=$(OVERLAY)
endif
ifneq ($(CONF),)
EXTRA_CONF := -DEXTRA_CONF_FILE=$(CONF)
endif

CMAKE_ARGS = -DBOARD_ROOT=$(BOARD_ROOT) $(EXTRA_DTC) $(EXTRA_CONF)

.PHONY: build rebuild flash flash-erase rtt menuconfig clean pristine info

build:
	west build -b $(BOARD) --build-dir $(BUILD_DIR) $(CURDIR) -- $(CMAKE_ARGS)

rebuild:
	west build -b $(BOARD) -p always --build-dir $(BUILD_DIR) $(CURDIR) -- $(CMAKE_ARGS)

flash:
	west flash --build-dir $(BUILD_DIR) --runner jlink

# Mass-erase then flash. Needed the first time if the KKM factory image left
# RRAM/UICR protected.
flash-erase:
	west flash --build-dir $(BUILD_DIR) --runner jlink --erase

# No working RTT on this board -- kept only in case a probe change fixes it.
rtt:
	JLinkRTTViewer || JLinkRTTLogger -Device $(JLINK_DEVICE) -If SWD -Speed $(JLINK_SPEED) -RTTChannel 0 /dev/stdout

menuconfig:
	west build --build-dir $(BUILD_DIR) -t menuconfig

clean pristine:
	rm -rf $(BUILD_DIR)

info:
	@echo "BOARD       = $(BOARD)"
	@echo "BOARD_ROOT  = $(BOARD_ROOT)"
	@echo "Board def   = $(BOARD_ROOT)/boards/kkm/k4beacon_nrf54l15/"
	@echo "Overlay     = $(if $(OVERLAY),$(OVERLAY),(none))"
	@echo "Conf        = $(if $(CONF),$(CONF),(none -> beacon))"
	@echo "J-Link      = $(JLINK_DEVICE) @ $(JLINK_SPEED) kHz (SWD)"
