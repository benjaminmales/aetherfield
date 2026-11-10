#ifndef ACC_COMMON_H
#define ACC_COMMON_H
#include <stdint.h>
#include <stdbool.h>

typedef struct {
  int16_t AXIS_X;
  int16_t AXIS_Y;
  int16_t AXIS_Z;
} AxesRaw_t;

typedef struct tag_acc_axis_zip
{
	int32_t accX : 10;
	int32_t accY : 10;
	int32_t accZ : 10;
	int32_t reserve : 2;
}acc_axis_zip;

typedef enum eAccOdrHz
{
    AccOdr1Hz,
    AccOdr10Hz,
    AccOdr25Hz,
    AccOdr50Hz,
    AccOdr100Hz,
    AccOdr0Hz
}EAccDecHz;
#define AccMaxOdr AccOdr100Hz

#define MAX_ACC_SENSITIVITY 126
#define MIN_ACC_SENSITIVITY 1
#define DEFAULT_ACC_SENSITIVITY 2

typedef enum {
    MEMS_SUCCESS				=		0x0,
    MEMS_ERROR				=		0x1	
} status_t;

typedef enum eAccSensorType
{
    ACC_TYPE_UNKNOWN,
    ACC_TYPE_2DH,
    ACC_TYPE_3DH,
    ACC_TYPE_OHM3,
    ACC_TYPE_OHM
}AccSensorType;

typedef uint32_t (*acc_start_self_test_func)(void);

typedef bool (*acc_pos_detect_enable_func)(EAccDecHz decHz);

typedef bool (*acc_motion_detect_enable_func)(uint8_t odr, uint8_t accRange, uint8_t nDuration);

typedef bool (*acc_stop_func)(void);

typedef status_t (*acc_read_axis_raw_func)(AxesRaw_t* buff);

typedef status_t (*acc_get_int_src)(uint8_t* val);

typedef struct tag_acc_context_ctrl
{
    acc_start_self_test_func        func_ptr_acc_self_test;
    acc_pos_detect_enable_func func_ptr_acc_pos_detect;
    acc_motion_detect_enable_func func_ptr_acc_motion_detect;
    acc_stop_func  func_ptr_acc_stop;
    acc_read_axis_raw_func func_ptr_read_axis;
    acc_get_int_src func_ptr_get_src;

    uint8_t sensor_type;
    uint8_t address;
}acc_context_ctrl;

extern acc_context_ctrl gap_acc_context;

#endif
