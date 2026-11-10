#include <zephyr/kernel.h>
#include <zephyr/device.h>
#include <stdint.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/logging/log.h>
#include "acc_int.h"


static const struct gpio_dt_spec gap_acc_int1 = GPIO_DT_SPEC_GET(DT_ALIAS(accint0), gpios);
static struct gpio_callback gap_acc_cb_data;
static acc_interrupt_evt gap_acc_func_callback = NULL;
static struct k_work gap_acc_int_event_timer;

static void acc_gpio_callback(const struct device *dev, struct gpio_callback *cb, uint32_t pins)
{
    if (BIT(gap_acc_int1.pin) == pins)
    {
		k_work_submit(&gap_acc_int_event_timer);
    }
}

static void acc_event_work_callback(struct k_work *work)
{
	if (gap_acc_func_callback != NULL)
	{
		gap_acc_func_callback(0);
	}
}

int Acc_interrupt_init(acc_interrupt_evt accEvtCallback)
{
    int ret = 0;

    uint32_t acc_bit_mask = 0;
    gap_acc_func_callback = accEvtCallback;
    if (!device_is_ready(gap_acc_int1.port))
    {
        // LOG_ERR("Error: button device %s is not ready",  (gap_acc_int1.port->name));
        return -1;
    }
    ret = gpio_pin_configure_dt(&gap_acc_int1, GPIO_INPUT);
    if (ret != 0)
    {
        // LOG_ERR("Error %d: failed to configure %s pin %d", ret,  (gap_acc_int1.port->name), gap_acc_int1.pin);
        return ret;
    }
    ret = gpio_pin_interrupt_configure_dt(&gap_acc_int1, GPIO_INT_EDGE_TO_ACTIVE);
    if (ret != 0)
    {
        // LOG_ERR("Error %d: failed to configure interrupt on %s pin %d", ret,  (gap_acc_int1.port->name), gap_acc_int1.pin);
        return ret;
    }
	acc_bit_mask = acc_bit_mask | BIT(gap_acc_int1.pin);

	//init callback
    gpio_init_callback(&gap_acc_cb_data, acc_gpio_callback, acc_bit_mask);
	gpio_add_callback(gap_acc_int1.port, &gap_acc_cb_data);

	//init work thd
    k_work_init(&gap_acc_int_event_timer, acc_event_work_callback);
    return 0;
}

