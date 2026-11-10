/**
 * @file bsp_common.h
 * @brief Board Support Package common definitions
 */

#ifndef BSP_COMMON_H__
#define BSP_COMMON_H__

#include <stdint.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * @brief Generic callback function type
 */
typedef void (*bsp_generic_cb_t)(void);

/**
 * @brief BSP operation status codes
 */
typedef enum {
    BSP_STATUS_SUCCESS = 0,
    BSP_STATUS_HARDWARE_ERROR = -1,
    BSP_STATUS_INVALID_PARAM = -2,
    BSP_STATUS_NOT_INITIALIZED = -3,
} bsp_status_t;

/**
 * @brief Check if pointer is NULL and return error if so
 */
#define BSP_NULL_CHECK(ptr) \
    do { \
        if ((ptr) == NULL) { \
            return BSP_STATUS_INVALID_PARAM; \
        } \
    } while (0)

/**
 * @brief Return early if condition is true
 */
#define BSP_RETURN_IF(condition, return_value) \
    do { \
        if (condition) { \
            return (return_value); \
        } \
    } while (0)

#ifdef __cplusplus
}
#endif

#endif /* BSP_COMMON_H__ */
