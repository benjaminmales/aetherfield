idf_component_register(
    SRCS
        "main.c"
        "radio.c"
        "gfx.c"
        "ui.c"
        "touch.c"
    INCLUDE_DIRS
        "."
        "../../../include"   # shared aura_radio.h at repo root
    REQUIRES
        driver
        esp_lcd
        ieee802154
        esp_timer
)
