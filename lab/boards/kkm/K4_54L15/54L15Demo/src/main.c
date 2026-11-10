/*
 * Copyright (c) 2012-2014 Wind River Systems, Inc.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#include <stdio.h>
#include <zephyr/kernel.h>
#include "lis2dw_driver.h"

int main(void)
{
	printf("Hello World! %s\n", CONFIG_BOARD_TARGET);
    
    LIS2DH_init();
    
    LIS2DH_PosDetectEnable(AccOdr10Hz);

    while (true)
    {
        AxesRaw_t axis;
        
        LIS2DH_GetPosAxesRaw(&axis);
        printf("read x:%d, y:%d, z:%d\n", axis.AXIS_X, axis.AXIS_Y, axis.AXIS_Z);

        k_msleep(1000);
    }

	return 0;
}
