#ifndef __LIS2DH_DRIVER__H
#define __LIS2DH_DRIVER__H


#include "acc_common.h"

#define LIS2DW12_ADDR_READ   0x19

bool LIS2DH_init();

uint32_t LIS2DH_StartSelfTest(void) ;

 bool LIS2DH_PosDetectEnable(EAccDecHz decHz);

bool LIS2DH_MotionDetectEnable(uint8_t odr, uint8_t accRange, uint8_t nDuration);

bool LIS2DH_SensorStoped(void);

status_t LIS2DH_GetPosAxesRaw(AxesRaw_t* buff) ;

status_t LIS2DH_GetInt1Src(uint8_t* val);

void LIS2DH_ChangeMotionTHS(uint8_t ths);

bool LIS2DH_Int1Src_Over();

#endif 

