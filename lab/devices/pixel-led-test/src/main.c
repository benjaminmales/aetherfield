/*
 * pixel-led-test — HOLYIOT-25008 V1.0 with the HB blue modification.
 *
 * Heartbeat build. On boot the HB blue pulses in a two-beat rhythm forever.
 *
 * Pin map, per HOLYIOT-25008-V1.0-sch.pdf (net label against U1's pin stub):
 *   LED_B   pin 18   P2.07   GPIO  — onboard RGB blue
 *   LED_R   pin 20   P2.09   GPIO  — onboard RGB red
 *   LED_G   pin 38   P1.10   PWM   — onboard RGB green, pwm20 ch0
 *   KEY     pin 41   P1.13   PWM   — S1 removed, now Q2's gate, pwm20 ch1
 *
 * P2 is MCU-domain and the nRF54L15's PWM peripherals are LP-domain, so red
 * and blue are on/off only. P1 is LP-domain, so green and the HB blue get
 * real brightness control.
 *
 * The HB LED has NO series resistor. Its current is set only by C19's ESR and
 * the cell's internal resistance, so the peak duty is capped. See HB_PEAK
 * below before turning it up.
 *
 * Shell over RTT (SWD, no extra wires):
 *   led heart on|off      the heartbeat
 *   led peak <per-mille>  heartbeat peak brightness
 *   led duty <per-mille>  hold a fixed level
 *   led on | off          full on (coin cell only) / off
 *   led gpio on|off       drive the pin directly, pwm20 bypassed
 *   led info              pin assignments and readiness
 *   rgb red|green|blue|off
 */

#include <zephyr/kernel.h>
#include <zephyr/device.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/drivers/pwm.h>
#include <zephyr/shell/shell.h>
#include <zephyr/sys/printk.h>
#include <stdlib.h>
#include <string.h>

/* ------------------------------------------------------- onboard RGB ---- */
static const struct gpio_dt_spec rgb_r = GPIO_DT_SPEC_GET(DT_ALIAS(led_red), gpios);
static const struct gpio_dt_spec rgb_b = GPIO_DT_SPEC_GET(DT_ALIAS(led_blue), gpios);
static const struct pwm_dt_spec  rgb_g = PWM_DT_SPEC_GET(DT_ALIAS(led_green));

/* ------------------------------------------------- modified HB blue ---- */
static const struct pwm_dt_spec hb = PWM_DT_SPEC_GET(DT_ALIAS(led_hb));

/* Raw GPIO on the same pin, for driving it with pwm20 out of the picture. */
#define HB_PORT  DT_NODELABEL(gpio1)
#define HB_PIN   13
static const struct device *const hb_gpio = DEVICE_DT_GET(HB_PORT);

/*
 * Absolute ceiling, in per-mille. 1000 = DC, which is only safe on a coin
 * cell with no C19 fitted, where the cell's own 10-40 ohm internal resistance
 * limits you to roughly 10 mA. On a bench supply, or once C19 is fitted, set
 * a 100 mA current limit before going anywhere near the top of this range.
 */
#define HB_MAX_PER_MILLE 1000

/*
 * Heartbeat peak, per-mille. 1000 = 100% — the LED is driven flat out at the
 * top of each beat.
 *
 * Safe ON A COIN CELL, and only there. The cell's own 10-40 ohm internal
 * resistance is the current limit, holding the LED to roughly 10 mA — exactly
 * the direct-to-battery test that proved this part. There is no series
 * resistor anywhere in the circuit.
 *
 * From a bench supply or any stiff 3.3V rail, 100% is NOT safe: nothing limits
 * the current but the FET and the LED itself. Set a 100 mA limit, or drop this
 * back to 250, before powering the board any other way.
 *
 * Changeable live over RTT with 'led peak <per-mille>'.
 */
#define HB_PEAK_DEFAULT  1000
static uint32_t hb_peak = HB_PEAK_DEFAULT;

/* Current commanded level, for 'led info'. */
static uint32_t hb_per_mille;

/* Non-zero = the heartbeat owns the LED. Any manual command clears it, so
 * the heartbeat and manual control never fight over the same pin. */
static atomic_t heart = ATOMIC_INIT(1);

static uint32_t hb_ns(uint32_t per_mille)
{
	return (uint32_t)(((uint64_t)hb.period * per_mille) / 1000U);
}

/*
 * Never ask the PWM driver for exactly 100%.
 *
 * At 0% and 100% duty Zephyr's nRF PWM driver takes a shortcut: it stops the
 * peripheral and drives the pin as a constant level, then applies the SLEEP
 * pinctrl state — which this board declares with low-power-enable, i.e. pin
 * disconnected. The result is that asking for full brightness turns the LED
 * OFF, while every value below it works. It looks exactly like a dead LED or a
 * broken modification, and it is neither.
 *
 * 99% is visually indistinguishable from 100% and keeps the peripheral
 * running, so the pin stays driven. The alternative fix is to drop
 * low-power-enable from pwm20_sleep in the overlay; this one is local to the
 * code that causes it.
 */
#define HB_PWM_CEILING_PER_MILLE 990

static void hb_set(uint32_t per_mille)
{
	if (per_mille > HB_MAX_PER_MILLE) {
		per_mille = HB_MAX_PER_MILLE;
	}
	if (per_mille > HB_PWM_CEILING_PER_MILLE) {
		per_mille = HB_PWM_CEILING_PER_MILLE;
	}
	if (pwm_is_ready_dt(&hb)) {
		pwm_set_pulse_dt(&hb, hb_ns(per_mille));
	}
	hb_per_mille = per_mille;
}

/*
 * Perceived brightness is roughly the square root of emitted light, so a
 * linear duty ramp looks top-heavy — it appears to snap on and then crawl.
 * Squaring the ramp position before applying it puts the change back where
 * the eye expects it, which is what makes the decay read as a pulse rather
 * than a fade.
 */
static uint32_t gamma_pm(uint32_t peak, uint32_t num, uint32_t den)
{
	uint64_t f = ((uint64_t)num * num * peak) / ((uint64_t)den * den);

	return (uint32_t)f;
}

/* One beat: fast rise, slower decay to dark. */
static void beat(uint32_t peak, uint32_t rise_ms, uint32_t fall_ms)
{
	const uint32_t step = 8;   /* ms per update, ~125 Hz */
	uint32_t steps;

	steps = rise_ms / step;
	for (uint32_t i = 1; i <= steps; i++) {
		hb_set(gamma_pm(peak, i, steps));
		k_msleep(step);
	}
	steps = fall_ms / step;
	for (uint32_t i = steps; i > 0; i--) {
		hb_set(gamma_pm(peak, i, steps));
		k_msleep(step);
	}
	hb_set(0);
}

/* Drive P1.13 directly, pwm20 bypassed. Active HIGH: the N-FET switches the
 * LED on the low side, so a high gate means light. */
static int hb_gpio_set(int on)
{
	if (!device_is_ready(hb_gpio)) {
		return -ENODEV;
	}
	if (pwm_is_ready_dt(&hb)) {
		pwm_set_pulse_dt(&hb, 0);
	}
	int err = gpio_pin_configure(hb_gpio, HB_PIN, GPIO_OUTPUT);

	if (err) {
		return err;
	}
	return gpio_pin_set_raw(hb_gpio, HB_PIN, on ? 1 : 0);
}

static void rgb_all_off(void)
{
	gpio_pin_set_dt(&rgb_r, 0);
	gpio_pin_set_dt(&rgb_b, 0);
	if (pwm_is_ready_dt(&rgb_g)) {
		pwm_set_pulse_dt(&rgb_g, 0);
	}
}

/* ------------------------------------------------------------- shell ---- */

static int cmd_rgb_blue(const struct shell *sh, size_t argc, char **argv)
{
	ARG_UNUSED(argc); ARG_UNUSED(argv);
	rgb_all_off();
	gpio_pin_set_dt(&rgb_b, 1);
	shell_print(sh, "onboard blue ON (P2.07)");
	return 0;
}

static int cmd_rgb_red(const struct shell *sh, size_t argc, char **argv)
{
	ARG_UNUSED(argc); ARG_UNUSED(argv);
	rgb_all_off();
	gpio_pin_set_dt(&rgb_r, 1);
	shell_print(sh, "onboard red ON (P2.09)");
	return 0;
}

static int cmd_rgb_green(const struct shell *sh, size_t argc, char **argv)
{
	ARG_UNUSED(argc); ARG_UNUSED(argv);
	rgb_all_off();
	if (!pwm_is_ready_dt(&rgb_g)) {
		shell_error(sh, "green PWM not ready");
		return -ENODEV;
	}
	pwm_set_pulse_dt(&rgb_g, rgb_g.period / 2);
	shell_print(sh, "onboard green ON (P1.10, pwm20 ch0, 50%%)");
	return 0;
}

static int cmd_rgb_off(const struct shell *sh, size_t argc, char **argv)
{
	ARG_UNUSED(argc); ARG_UNUSED(argv);
	rgb_all_off();
	shell_print(sh, "onboard RGB off");
	return 0;
}

SHELL_STATIC_SUBCMD_SET_CREATE(sub_rgb,
	SHELL_CMD(blue,  NULL, "Onboard blue solid (P2.07)",  cmd_rgb_blue),
	SHELL_CMD(red,   NULL, "Onboard red solid (P2.09)",   cmd_rgb_red),
	SHELL_CMD(green, NULL, "Onboard green 50%% (P1.10)",  cmd_rgb_green),
	SHELL_CMD(off,   NULL, "All off",                     cmd_rgb_off),
	SHELL_SUBCMD_SET_END
);
SHELL_CMD_REGISTER(rgb, &sub_rgb, "Onboard RGB indicator", NULL);

static int cmd_led_info(const struct shell *sh, size_t argc, char **argv)
{
	ARG_UNUSED(argc); ARG_UNUSED(argv);
	shell_print(sh, "onboard RGB");
	shell_print(sh, "  red   P2.09 gpio,        ready %s",
		    gpio_is_ready_dt(&rgb_r) ? "yes" : "NO");
	shell_print(sh, "  blue  P2.07 gpio,        ready %s",
		    gpio_is_ready_dt(&rgb_b) ? "yes" : "NO");
	shell_print(sh, "  green P1.10 pwm20 ch%u,   ready %s",
		    rgb_g.channel, pwm_is_ready_dt(&rgb_g) ? "yes" : "NO");
	shell_print(sh, "HB blue (modification)");
	shell_print(sh, "  P1.13 pwm20 ch%u,         ready %s", hb.channel,
		    pwm_is_ready_dt(&hb) ? "yes" : "NO");
	shell_print(sh, "  P1.13 raw gpio1 pin %u,   ready %s", HB_PIN,
		    device_is_ready(hb_gpio) ? "yes" : "NO");
	shell_print(sh, "  period %u us (%u Hz)",
		    hb.period / 1000U, 1000000000U / hb.period);
	shell_print(sh, "  heartbeat %s, peak %u.%u%%, level now %u.%u%%",
		    atomic_get(&heart) ? "ON" : "off",
		    hb_peak / 10U, hb_peak % 10U,
		    hb_per_mille / 10U, hb_per_mille % 10U);
	return 0;
}

static int cmd_led_heart(const struct shell *sh, size_t argc, char **argv)
{
	if (argc != 2 || (strcmp(argv[1], "on") && strcmp(argv[1], "off"))) {
		shell_error(sh, "usage: led heart on|off");
		return -EINVAL;
	}
	int on = (strcmp(argv[1], "on") == 0);

	atomic_set(&heart, on);
	if (!on) {
		hb_set(0);
	}
	shell_print(sh, "heartbeat %s", on ? "running" : "stopped");
	return 0;
}

static int cmd_led_peak(const struct shell *sh, size_t argc, char **argv)
{
	if (argc != 2) {
		shell_error(sh, "usage: led peak <per-mille>   (1 = 0.1%%)");
		return -EINVAL;
	}
	char *end;
	long v = strtol(argv[1], &end, 10);

	if (*end != '\0' || v < 1 || v > HB_MAX_PER_MILLE) {
		shell_error(sh, "peak must be 1..%u", HB_MAX_PER_MILLE);
		return -EINVAL;
	}
	hb_peak = (uint32_t)v;
	shell_print(sh, "heartbeat peak %ld.%ld%%", v / 10, v % 10);
	return 0;
}

static int cmd_led_duty(const struct shell *sh, size_t argc, char **argv)
{
	if (argc != 2) {
		shell_error(sh, "usage: led duty <per-mille>   (1 = 0.1%%)");
		return -EINVAL;
	}
	char *end;
	long v = strtol(argv[1], &end, 10);

	if (*end != '\0' || v < 0 || v > HB_MAX_PER_MILLE) {
		shell_error(sh, "duty must be 0..%u", HB_MAX_PER_MILLE);
		return -EINVAL;
	}
	if (!pwm_is_ready_dt(&hb)) {
		shell_error(sh, "HB PWM not ready — try 'led gpio on'");
		return -ENODEV;
	}
	atomic_set(&heart, 0);
	hb_set((uint32_t)v);
	shell_print(sh, "HB held at %ld.%ld%%", v / 10, v % 10);
	return 0;
}

static int cmd_led_on(const struct shell *sh, size_t argc, char **argv)
{
	ARG_UNUSED(argc); ARG_UNUSED(argv);
	if (!pwm_is_ready_dt(&hb)) {
		shell_error(sh, "HB PWM not ready — try 'led gpio on'");
		return -ENODEV;
	}
	atomic_set(&heart, 0);
	hb_set(HB_MAX_PER_MILLE);
	shell_print(sh, "HB 100%% (coin cell only)");
	return 0;
}

static int cmd_led_gpio(const struct shell *sh, size_t argc, char **argv)
{
	if (argc != 2 || (strcmp(argv[1], "on") && strcmp(argv[1], "off"))) {
		shell_error(sh, "usage: led gpio on|off");
		return -EINVAL;
	}
	atomic_set(&heart, 0);
	int on = (strcmp(argv[1], "on") == 0);
	int err = hb_gpio_set(on);

	if (err) {
		shell_error(sh, "gpio drive failed: %d", err);
		return err;
	}
	shell_print(sh, "P1.13 driven %s as raw GPIO — pwm20 bypassed",
		    on ? "HIGH" : "LOW");
	return 0;
}

static int cmd_led_off(const struct shell *sh, size_t argc, char **argv)
{
	ARG_UNUSED(argc); ARG_UNUSED(argv);
	atomic_set(&heart, 0);
	hb_set(0);
	shell_print(sh, "HB off");
	return 0;
}

SHELL_STATIC_SUBCMD_SET_CREATE(sub_led,
	SHELL_CMD(heart, NULL, "Heartbeat on|off",             cmd_led_heart),
	SHELL_CMD(peak,  NULL, "Heartbeat peak, per-mille",    cmd_led_peak),
	SHELL_CMD(duty,  NULL, "Hold a level, per-mille",      cmd_led_duty),
	SHELL_CMD(on,    NULL, "HB 100%% (coin cell only)",    cmd_led_on),
	SHELL_CMD(gpio,  NULL, "Raw GPIO drive: on|off",       cmd_led_gpio),
	SHELL_CMD(off,   NULL, "HB off",                       cmd_led_off),
	SHELL_CMD(info,  NULL, "Pin assignments and state",    cmd_led_info),
	SHELL_SUBCMD_SET_END
);
SHELL_CMD_REGISTER(led, &sub_led, "HB blue LED", NULL);

/* -------------------------------------------------------------- main ---- */

int main(void)
{
	printk("\n=== pixel-led-test : HOLYIOT-25008 : heartbeat ===\n");

	if (gpio_is_ready_dt(&rgb_r) && gpio_is_ready_dt(&rgb_b)) {
		gpio_pin_configure_dt(&rgb_r, GPIO_OUTPUT_INACTIVE);
		gpio_pin_configure_dt(&rgb_b, GPIO_OUTPUT_INACTIVE);
	}

	/*
	 * Park the green explicitly. pwm20 claims P1.10 the moment the driver
	 * initialises, and until something sets a pulse the pin sits LOW —
	 * which on a common-anode LED means lit. Nothing else in this build
	 * touches green, so without this it comes up on and stays on.
	 * Its channel is PWM_POLARITY_INVERTED, so a 0 pulse drives the pin
	 * HIGH, which is dark.
	 */
	rgb_all_off();

	if (!pwm_is_ready_dt(&hb)) {
		printk("HB PWM (P1.13, pwm20 ch1) NOT ready — nothing to beat.\n");
	} else {
		printk("HB blue on P1.13, pwm20 ch1, %u Hz, peak %u.%u%%\n",
		       1000000000U / hb.period, hb_peak / 10U, hb_peak % 10U);
	}
	printk("'led heart off' to stop, 'led peak <per-mille>' to retune.\n\n");

	while (1) {
		if (!atomic_get(&heart)) {
			k_msleep(100);
			continue;
		}

		/* Two beats, the second softer, then a rest — the systole /
		 * diastole shape. A single evenly-spaced pulse reads as a
		 * blinking fault indicator; this reads as alive. */
		beat(hb_peak, 40, 200);
		k_msleep(80);
		beat((hb_peak * 3U) / 4U, 40, 240);
		k_msleep(700);
	}
	return 0;
}
