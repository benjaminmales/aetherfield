/*
 * pixel-xiao-nRF54 - single-NeoPixel Aetherfield band, protocol v2
 *
 * XIAO nRF54L15 (non-Sense: no IMU, no mic) + one WS2812B on D4 (P1.10),
 * powered from the 1S LiPo. Design study for the Las Vegas single-pixel
 * form factor.
 *
 * Everything that makes this a band - radio, CMD/SYNC receive, the op_mode
 * state machine, the animation engine, beacons - lives in the shared layer
 * at AURA/common/aura_band.c. All this file does is turn one commanded
 * colour into one WS2812 write.
 *
 * That is the whole point of the v2 capability model. This board advertises
 * AURA_CAPS_PIXEL_XIAO (RGB_LED only), receives exactly the same command
 * frame as a fully-loaded wristband, and acts on the parts it has hardware
 * for. No special case, no separate firmware branch.
 */

/* ------------------------------------------------------------------
 * BISECT STAGE - set this, rebuild, watch the LED.
 *
 * The board is hard-faulting and the console is not reaching us, so the
 * pixel itself is the debug channel. Each stage adds one layer and has its
 * own colour. Whichever stage stops blinking is the layer that faults.
 *
 *   1  WHITE  blink forever. No radio at all - proves the base build,
 *             the WS2812 path and that main() runs.
 *   2  GREEN  blink forever, radio brought up and beaconing, but with
 *             render = NULL so the animation thread never touches SPI.
 *             Survives => radio init and TX are fine.
 *   3  normal operation. The band renders whatever the gateway commands.
 *
 * A stage that faults dies mid-blink: the LED freezes or goes dark and
 * stays there. Note which one and tell me.
 * ------------------------------------------------------------------ */
#define AURA_BAND_STAGE 3

/* ------------------------------------------------------------------
 * PIXEL_DRIVE - does anything ever touch the SPI bus?
 *
 *   0  the strip is never written. CONFIG_SPI, the WS2812 driver and the
 *      SPIM22 instance are all still built and initialised, but no EasyDMA
 *      transfer ever runs. The pixel stays dark - that is expected.
 *   1  normal.
 *
 * This exists to split a hypothesis. The wristband runs the identical
 * aura_band.c perfectly, so the fault is something this project adds. The
 * net_buf pool is already corrupt on the FIRST radio transmit, and the only
 * thing that has run before then is a handful of WS2812 transfers during the
 * boot blink. If PIXEL_DRIVE 0 fixes the radio, the corruption comes from
 * the SPI TRANSFER (EasyDMA), not merely from the driver existing - and that
 * is a completely different bug to chase.
 * ------------------------------------------------------------------ */
#define PIXEL_DRIVE 1

#include <zephyr/kernel.h>
#include <zephyr/device.h>
#include <zephyr/drivers/led_strip.h>
#include <zephyr/drivers/regulator.h>
#include <zephyr/logging/log.h>


#if AURA_BAND_STAGE > 1
#include "aura_band.h"
#endif

LOG_MODULE_REGISTER(pixel, LOG_LEVEL_INF);


#define STRIP_NODE DT_ALIAS(led_strip)
#define STRIP_LEN  DT_PROP(STRIP_NODE, chain_length)

static const struct device *const strip = DEVICE_DT_GET(STRIP_NODE);
static struct led_rgb pixels[STRIP_LEN];
static bool g_have_strip;

/* The one seam. Called at 50 Hz by the shared animation thread.
 *
 * Every pixel gets the same colour: v2 treats a device as ONE light source
 * however many LEDs it carries, so a longer chain here is a devicetree
 * change (chain-length) and nothing else. Spatial modes are reserved at
 * anim_mode 0x10+ for when that stops being true. */
static void pixel_render(uint8_t r, uint8_t g, uint8_t b)
{
	static uint8_t last_r, last_g, last_b;
	static bool primed;

	if (!g_have_strip || !PIXEL_DRIVE) {
		return;
	}

	/* Only touch the bus when the colour actually changes.
	 *
	 * The animation layer runs at 50 Hz, but a STEADY colour or an OFF
	 * pixel produces the same triple every frame. Rewriting it 50 times a
	 * second costs a ~400us SPI burst plus the WS2812 latch delay each
	 * time, for no visible difference - real current on a wearable running
	 * off a cell, and needless bus traffic next to a timing-sensitive
	 * radio. Animations still update every frame, because their colour is
	 * genuinely changing. */
	if (primed && r == last_r && g == last_g && b == last_b) {
		return;
	}
	last_r = r; last_g = g; last_b = b;
	primed = true;

	for (size_t i = 0; i < STRIP_LEN; i++) {
		pixels[i].r = r;
		pixels[i].g = g;
		pixels[i].b = b;
	}
	(void)led_strip_update_rgb(strip, pixels, STRIP_LEN);
}

/* Bring-up trace. One BLUE flash per completed init step, so with no console
 * the LED counts out how far aura_band_init() got. Count the blue flashes:
 *   1 entered  2 address  3 radio device  4 antenna
 *   5 PIB      6 radio started            7 about to start threads
 * Whatever number it stops at is the last step that worked.
 *
 * Nothing may drive the LED after step 7 - from there the animation thread
 * owns it, and a second thread in the same SPI path is a fault. */
#if IS_ENABLED(CONFIG_LOG)
static void init_progress(uint8_t step)
{
	ARG_UNUSED(step);
	pixel_render(0, 0, 120);
	k_msleep(90);
	pixel_render(0, 0, 0);
	k_msleep(260);
}
#endif /* CONFIG_LOG */

/* Blink forever in one colour. Used by the bisect stages: a frozen or dark
 * LED means we faulted, and the colour says how far we got. */
static void blink_forever(uint8_t r, uint8_t g, uint8_t b)
{
	while (1) {
		pixel_render(r, g, b);
		k_msleep(250);
		pixel_render(0, 0, 0);
		k_msleep(750);
	}
}

int main(void)
{
	/* ------------------------------------------------------------------
	 * COLD-BOOT POWER BUDGET
	 *
	 * This board runs on USB, and RUNS on battery if booted on USB first -
	 * but a cold boot on battery can fail entirely. That pattern is
	 * brownout: boot stacks the HFXO start, MPSL radio bring-up, regulator
	 * switching and LED current into the first couple of seconds, and a
	 * cell (plus thin leads) sags under the surge where a USB supply does
	 * not. The nRF hits its reset threshold and loops, looking stone dead.
	 *
	 * So boot is deliberately staggered: settle, then the cheapest visible
	 * "alive" signal, then settle again, then the radio. Total ~1s.
	 * ------------------------------------------------------------------ */

	/* 1. Let the rail recover from the power-on transient before adding
	 *    any load at all. */
	k_msleep(400);

	/* 2. VBAT rail, explicitly - AURA/seeedFirmware does the same and
	 *    notes it is required for battery operation. */
	const struct device *vbat = DEVICE_DT_GET_OR_NULL(DT_NODELABEL(vbat_pwr));

	if (vbat && device_is_ready(vbat)) {
		(void)regulator_enable(vbat);
		k_msleep(100);          /* let it settle */
	}

	g_have_strip = device_is_ready(strip);
	if (!g_have_strip) {
		LOG_ERR("LED strip not ready - check the overlay; running dark");
	}

	/* 3. Latch the pixel dark. A WS2812 sits directly on the BAT rail and
	 *    can wake in a random state; also clears any stale colour after a
	 *    warm reset. One write, tiny load. */
	pixel_render(0, 0, 0);

	/* 4. Alive signal: ONE dim RED blink.
	 *
	 *    Red replaces the old two white blinks deliberately. White drives
	 *    all three dice (~20 mA) at the exact moment the rail is weakest,
	 *    and the green/blue dice have the highest forward voltage - the
	 *    first things to misbehave on a sagging cell. The red die is the
	 *    cheapest and most voltage-tolerant light this board can make. */
	k_msleep(200);
	pixel_render(40, 0, 0);
	k_msleep(120);
	pixel_render(0, 0, 0);

	/* 5. Rail recovery before the radio calibration surge. */
	k_msleep(300);

#if AURA_BAND_STAGE == 1
	/* No radio, and with -DAURA_NO_RADIO=y the band layer is not even
	 * linked and the 802.15.4 stack is not built. This is as close to the
	 * original working hello-world as it gets. If it does not blink white
	 * forever, nothing Aetherfield is involved. */
	blink_forever(60, 60, 60);
	return 0;
}
#else

	struct aura_band_cfg cfg = {
		.caps = AURA_CAPS_PIXEL_XIAO,   /* RGB_LED only */
		.group_mask = 0x02,   /* pixel module. Wristband is 0x01 - see
				       * AURA/seeedFirmware/src/main.c */
#if AURA_BAND_STAGE >= 3
		.render = pixel_render,
#else
		.render = NULL,       /* stage 2: radio only, no SPI from the
				       * animation thread */
#endif
		.battery_pct = NULL,            /* no divider fitted on this rig */
		.antenna_external = false,      /* onboard ceramic - set true only
						 * if a u.FL antenna is fitted */
		/* Bring-up trace only on a build that has a console anyway.
		 * On the battery build it would add ~2.5s of blue flashing
		 * before the band is any use, and the two white boot blinks
		 * already say "alive". */
#if IS_ENABLED(CONFIG_LOG)
		.progress = init_progress,
#else
		.progress = NULL,
#endif
	};

	if (aura_band_init(&cfg) != 0) {
		LOG_ERR("aura_band_init failed");
		blink_forever(120, 0, 0);   /* RED: init returned an error */
	}

	LOG_INF("pixel band v%u up: addr=0x%04X caps=0x%02X pixels=%d",
		AURA_VER, aura_band_addr(), AURA_CAPS_PIXEL_XIAO, STRIP_LEN);

#if AURA_BAND_STAGE == 2
	/* Radio is up and the band is beaconing. If this blinks green forever,
	 * radio init and TX are fine and the fault is in the render path. */
	blink_forever(0, 90, 0);
#endif

	while (1) {
		k_msleep(1000);
	}
	return 0;
}
#endif /* AURA_BAND_STAGE == 1 */
