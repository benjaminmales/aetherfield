#include "bsp_imu.h"

#include <zephyr/types.h>
#include <zephyr/device.h>
#include <zephyr/devicetree.h>
#include <zephyr/kernel.h>
#include <zephyr/drivers/sensor.h>
#include <zephyr/sys/printk.h>

//////////////////////////////////////////////////////////////////////////////

static struct
{
    bool initialized;
    bool has_gyro;
    bsp_generic_cb_t data_ready_cb;
    const struct device* dev;
} imu_ctx_ = {0};

//////////////////////////////////////////////////////////////////////////////

static void data_read_timer_handler(struct k_timer *timer)
{
    (void) timer;
    if (imu_ctx_.data_ready_cb)
    {
        imu_ctx_.data_ready_cb();
    }
}

K_TIMER_DEFINE(data_ready_timer_, data_read_timer_handler, NULL);

//////////////////////////////////////////////////////////////////////////////

bsp_status_t bsp_imu_init(const bsp_imu_config_t* p_config,
                            bsp_generic_cb_t data_ready_cb)
{
    BSP_NULL_CHECK(p_config);
 
    if (imu_ctx_.dev == NULL) {
        if (DT_NODE_HAS_STATUS(DT_ALIAS(imu0), okay)) {
            imu_ctx_.dev = DEVICE_DT_GET(DT_ALIAS(imu0));
        } else {
            imu_ctx_.dev = DEVICE_DT_GET_ANY(st_lsm6dso);
            if (imu_ctx_.dev == NULL) {
                imu_ctx_.dev = DEVICE_DT_GET_ANY(st_lsm6dsl);
            }
            if (imu_ctx_.dev == NULL) {
                imu_ctx_.dev = DEVICE_DT_GET_ANY(bosch_bmi270);
            }
            if (imu_ctx_.dev == NULL) {
                imu_ctx_.dev = DEVICE_DT_GET_ANY(st_lis2dh);
            }
        }
    }

    BSP_RETURN_IF(imu_ctx_.dev == NULL, BSP_STATUS_HARDWARE_ERROR);
    if (!device_is_ready(imu_ctx_.dev)) {
        printk("IMU device not ready: %s\n", imu_ctx_.dev->name);
        return BSP_STATUS_HARDWARE_ERROR;
    }
    printk("IMU device: %s\n", imu_ctx_.dev->name);

    int res = 0;
    struct sensor_value full_scale = {0};
    struct sensor_value sampling_freq = {0};
    struct sensor_value oversampling = {0};

    /* Setting scale in G, due to loss of precision if the SI unit m/s^2
	 * is used
	 */
	/* Convert G to m/s^2 as required by sensor API. */
	sensor_g_to_ms2(p_config->accel_fs_g, &full_scale);
	sampling_freq.val1 = p_config->data_rate_hz;       /* Hz. Performance mode */
	sampling_freq.val2 = 0;
	oversampling.val1 = 1;          /* Normal mode */
	oversampling.val2 = 0;

    res = sensor_attr_set(imu_ctx_.dev, SENSOR_CHAN_ACCEL_XYZ, SENSOR_ATTR_FULL_SCALE, &full_scale);
    if (res) {
        printk("IMU accel full-scale set failed: %d\n", res);
    }
    BSP_RETURN_IF(res != 0, BSP_STATUS_HARDWARE_ERROR);

	res = sensor_attr_set(imu_ctx_.dev, SENSOR_CHAN_ACCEL_XYZ, SENSOR_ATTR_OVERSAMPLING, &oversampling);
    if (res && res != -ENOTSUP) {
        printk("IMU accel oversampling set failed: %d\n", res);
        return BSP_STATUS_HARDWARE_ERROR;
    }

    res = sensor_attr_set(imu_ctx_.dev, SENSOR_CHAN_ACCEL_XYZ, SENSOR_ATTR_SAMPLING_FREQUENCY, &sampling_freq);
    if (res) {
        printk("IMU accel sampling freq set failed: %d\n", res);
    }
    BSP_RETURN_IF(res != 0, BSP_STATUS_HARDWARE_ERROR);

    /* Probe for gyro support: -ENOTSUP from full-scale set means accel-only
     * device (e.g. LIS2DH12). In that case we keep the API stable and
     * zero-fill gyro samples in bsp_imu_read.
     */
    sensor_degrees_to_rad(p_config->gyro_fs_dps, &full_scale);
    sampling_freq.val1 = p_config->data_rate_hz;
    sampling_freq.val2 = 0;
    oversampling.val1 = 1;
    oversampling.val2 = 0;

    res = sensor_attr_set(imu_ctx_.dev, SENSOR_CHAN_GYRO_XYZ, SENSOR_ATTR_FULL_SCALE, &full_scale);
    imu_ctx_.has_gyro = (res != -ENOTSUP);
    if (!imu_ctx_.has_gyro) {
        printk("IMU has no gyro (accel-only device); gyro samples will be zero\n");
    } else if (res) {
        printk("IMU gyro full-scale set failed: %d\n", res);
        return BSP_STATUS_HARDWARE_ERROR;
    }

    if (imu_ctx_.has_gyro) {
        res = sensor_attr_set(imu_ctx_.dev, SENSOR_CHAN_GYRO_XYZ, SENSOR_ATTR_OVERSAMPLING, &oversampling);
        if (res && res != -ENOTSUP) {
            printk("IMU gyro oversampling set failed: %d\n", res);
            return BSP_STATUS_HARDWARE_ERROR;
        }
    }

    imu_ctx_.data_ready_cb = data_ready_cb;
    const uint32_t data_ready_timer_period = 1000 / p_config->data_rate_hz;
    k_timer_start(&data_ready_timer_, K_MSEC(data_ready_timer_period), K_MSEC(data_ready_timer_period));

    if (imu_ctx_.has_gyro) {
        /* Set sampling frequency last as this also sets the appropriate
         * power mode. If already sampling, change sampling frequency to
         * 0.0Hz before changing other attributes
         */
        res = sensor_attr_set(imu_ctx_.dev, SENSOR_CHAN_GYRO_XYZ, SENSOR_ATTR_SAMPLING_FREQUENCY, &sampling_freq);
        if (res) {
            printk("IMU gyro sampling freq set failed: %d\n", res);
            return BSP_STATUS_HARDWARE_ERROR;
        }
    }

    return BSP_STATUS_SUCCESS;
}
    
//////////////////////////////////////////////////////////////////////////////

bsp_status_t bsp_imu_read(bsp_imu_data_t* const p_data)
{
    BSP_NULL_CHECK(p_data);
    BSP_RETURN_IF(imu_ctx_.dev == NULL, BSP_STATUS_HARDWARE_ERROR);

    struct sensor_value acc[3];
    struct sensor_value gyr[3] = {0};

    int res = sensor_sample_fetch(imu_ctx_.dev);
    BSP_RETURN_IF(res != 0, BSP_STATUS_HARDWARE_ERROR);

    res = sensor_channel_get(imu_ctx_.dev, SENSOR_CHAN_ACCEL_XYZ, acc);
    BSP_RETURN_IF(res != 0, BSP_STATUS_HARDWARE_ERROR);

    if (imu_ctx_.has_gyro) {
        res = sensor_channel_get(imu_ctx_.dev, SENSOR_CHAN_GYRO_XYZ, gyr);
        BSP_RETURN_IF(res != 0, BSP_STATUS_HARDWARE_ERROR);
    }

    for (int i = 0; i < 3; i++)
    {
        p_data->accel[i].phys = (float)sensor_value_to_double(&acc[i]);
        p_data->accel[i].raw = (p_data->accel[i].phys * 1000);

        p_data->gyro[i].phys = (float)sensor_value_to_double(&gyr[i]);
        p_data->gyro[i].raw = (p_data->gyro[i].phys * 1000);
    }

    return BSP_STATUS_SUCCESS;
}