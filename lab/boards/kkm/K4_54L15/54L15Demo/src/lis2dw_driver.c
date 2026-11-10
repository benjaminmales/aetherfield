#include "lis2dw_driver.h"
#include "acc_common.h"
#include "lis2dw12_reg.h"
#include <stdlib.h>
#include <zephyr/device.h>
#include <zephyr/drivers/i2c.h>
#include <zephyr/drivers/sensor.h>
#include <zephyr/kernel.h>
#include <stdio.h>
#include <zephyr/device.h>
#include <stdint.h>
#include "acc_int.h"
#include <string.h>
#include <zephyr/device.h>
#include <zephyr/logging/log.h>

LOG_MODULE_REGISTER(lis2dw, 3);

#define    BOOT_TIME            20 //ms
#define MAX_TX_BUFF_LEN 8

const struct device *gap_acc_sensor ;
static stmdev_ctx_t dev_ctx;
static uint8_t whoamI, rst;
static int16_t data_raw_acceleration[3];
static lis2dw12_reg_t int_route;

static int32_t platform_read(void *ptr, uint8_t addr, uint8_t *buf, uint16_t len)
{
    int32_t err_code = 0;
    uint8_t* p_buffer = buf;

    for (int i = 0; i < len; i++)
    {
        err_code = i2c_write(gap_acc_sensor, &addr, sizeof(addr), LIS2DW12_ADDR_READ);

        err_code = i2c_read(gap_acc_sensor, p_buffer, 1, LIS2DW12_ADDR_READ);

        p_buffer++;
        addr++;
    }

    return err_code;
}


static int32_t platform_write(void *ptr, uint8_t addr, const uint8_t *buf, uint16_t len)
{
    uint8_t txBuf[MAX_TX_BUFF_LEN];

    txBuf[0] = addr;
    for (int i = 0; i < len; i++)
    {
        txBuf[i+1] = buf[i];
    }

    int32_t err_code = i2c_write(gap_acc_sensor, txBuf, len+1, LIS2DW12_ADDR_READ);

    return err_code;
}



static void platform_delay(uint32_t millisec)
{
    k_msleep(millisec);
}

bool LIS2DH_init()
{
	gap_acc_sensor = DEVICE_DT_GET(DT_ALIAS(acci2c));
	if(!device_is_ready(gap_acc_sensor))
	{
		printk("i2c acc failed\n");
		return false;
	}

    /* Initialize mems driver interface */
    dev_ctx.write_reg = platform_write;
    dev_ctx.read_reg = platform_read;
    dev_ctx.mdelay = platform_delay;

    /* Wait sensor boot time */
    platform_delay(BOOT_TIME);

    /* Check device ID */
    lis2dw12_device_id_get(&dev_ctx, &whoamI);

    if (whoamI != LIS2DW12_ID)
    {
        return false;
    }

    /* Restore default configuration */
    lis2dw12_reset_set(&dev_ctx, PROPERTY_ENABLE);
    do
    {
        lis2dw12_reset_get(&dev_ctx, &rst);
    }
    while (rst);

    return true;
}

uint32_t LIS2DH_StartSelfTest(void)
{
    if (whoamI != LIS2DW12_ID)
    {
        return 0;
    }

    LIS2DH_PosDetectEnable(AccOdr50Hz);

    platform_delay(100);

    AxesRaw_t raw;
    LIS2DH_GetPosAxesRaw(&raw);
    uint32_t result = abs(raw.AXIS_X) + abs(raw.AXIS_Y) + abs(raw.AXIS_Z);
    if (result < 100)
    {
        return 0;
    }
    
    return result;
}

void LIS2DH_SetODR(EAccDecHz odr)
{
    if (odr == AccOdr1Hz)
    {
        lis2dw12_data_rate_set(&dev_ctx, LIS2DW12_XL_ODR_1Hz6_LP_ONLY);
    }
    else if (odr == AccOdr10Hz)
    {
        lis2dw12_data_rate_set(&dev_ctx, LIS2DW12_XL_ODR_12Hz5);
    }
    else if (odr == AccOdr25Hz)
    {
        lis2dw12_data_rate_set(&dev_ctx, LIS2DW12_XL_ODR_25Hz);
    }
    else if(odr == AccOdr50Hz)
    {
        lis2dw12_data_rate_set(&dev_ctx, LIS2DW12_XL_ODR_50Hz);
    }
    else
    {
        lis2dw12_data_rate_set(&dev_ctx, LIS2DW12_XL_ODR_100Hz);
    }
}

bool LIS2DH_PosDetectEnable(EAccDecHz decHz)
{
    lis2dw12_block_data_update_set(&dev_ctx, PROPERTY_ENABLE);

    //set scale
    lis2dw12_full_scale_set(&dev_ctx, LIS2DW12_2g);

    //Configure filtering chain Accelerometer - filter path / bandwidth
    lis2dw12_filter_path_set(&dev_ctx, LIS2DW12_LPF_ON_OUT);
    
    lis2dw12_filter_bandwidth_set(&dev_ctx, LIS2DW12_ODR_DIV_4);

    //Configure power mode
    lis2dw12_power_mode_set(&dev_ctx, LIS2DW12_CONT_LOW_PWR_2);

    // Set Output Data Rate
    LIS2DH_SetODR(decHz);

    LOG_INF("lis2dw pos poll enable");

    return true;
}

bool LIS2DH_MotionDetectEnable(uint8_t odr, uint8_t accRange, uint8_t nDuration)
{
    //lis2dw12_block_data_update_set(&dev_ctx, PROPERTY_ENABLE);

    /* Set full scale */
    lis2dw12_full_scale_set(&dev_ctx, LIS2DW12_2g);

    /* Configure power mode */
    lis2dw12_power_mode_set(&dev_ctx, LIS2DW12_CONT_LOW_PWR_2);

    /* Set Output Data Rate */
    LIS2DH_SetODR(odr);

    /* Apply high-pass digital filter on Wake-Up function */
    lis2dw12_filter_path_set(&dev_ctx, LIS2DW12_LPF_ON_OUT);

    lis2dw12_wkup_dur_set(&dev_ctx, nDuration);
    
    /* Set wake-up threshold
    * Set Wake-Up threshold: 1 LSb corresponds to FS_XL/2^6
    */
    if (accRange < 1)
    {
        accRange = 1;
    }
    if (accRange >= 64)
    {
    	accRange = 63;
    }
    lis2dw12_wkup_threshold_set(&dev_ctx, accRange);

    /* Enable interrupt generation on Wake-Up INT1 pin */
    lis2dw12_pin_int1_route_get(&dev_ctx, &int_route.ctrl4_int1_pad_ctrl);
    int_route.ctrl4_int1_pad_ctrl.int1_wu = PROPERTY_ENABLE;

    lis2dw12_pin_int1_route_set(&dev_ctx, &int_route.ctrl4_int1_pad_ctrl);

    LIS2DH_GetInt1Src(NULL);

    LOG_INF("motion enable");

    return true;
}

bool LIS2DH_SensorStoped(void)
{
    //reset all configuration
    lis2dw12_reset_set(&dev_ctx, PROPERTY_ENABLE);
    do
    {
        lis2dw12_reset_get(&dev_ctx, &rst);
    }
    while (rst);

    LOG_INF("lis 2dw power off");

    return true;
}

status_t LIS2DH_GetPosAxesRaw(AxesRaw_t* buff)
{
    uint8_t reg;

    /* Read output only if new value is available */
    lis2dw12_flag_data_ready_get(&dev_ctx, &reg);

    if (reg)
    {
        memset(data_raw_acceleration, 0x00, 3 * sizeof(int16_t));
        lis2dw12_acceleration_raw_get(&dev_ctx, data_raw_acceleration);
    }

    buff->AXIS_X = lis2dw12_from_fs2_to_mg(data_raw_acceleration[0]);
    buff->AXIS_Y = lis2dw12_from_fs2_to_mg(data_raw_acceleration[1]);
    buff->AXIS_Z = lis2dw12_from_fs2_to_mg(data_raw_acceleration[2]);
    //float temperature = LIS2DH_GetTemperature();
    //LOG_INF("acc temperature:%d", (int)(temperature * 10));


    return MEMS_SUCCESS;
}

void LIS2DH_ChangeMotionTHS(uint8_t ths)
{
	lis2dw12_wkup_threshold_set(&dev_ctx, ths);
}

status_t LIS2DH_GetInt1Src(uint8_t* val)
{
    lis2dw12_all_sources_t all_source;

    /* Check Wake-Up events */
    lis2dw12_all_sources_get(&dev_ctx, &all_source);

    return MEMS_SUCCESS;
}

bool LIS2DH_Int1Src_Over()
{
     lis2dw12_all_sources_t all_source;

    /* Check Wake-Up events */
    lis2dw12_all_sources_get(&dev_ctx, &all_source);
    
    return  all_source.all_int_src.wu_ia ; 
}

