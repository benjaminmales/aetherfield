/* qmi8658.h — QMI8658 6-axis IMU, minimal I2C driver */
#pragma once

#include <stdint.h>
#include "esp_err.h"

typedef struct {
    float ax, ay, az;   /* g        */
    float gx, gy, gz;   /* deg/s    */
} qmi8658_sample_t;

esp_err_t qmi8658_init(void);
esp_err_t qmi8658_read(qmi8658_sample_t *out);
