# SPDX-License-Identifier: Apache-2.0

cmake_minimum_required(VERSION 3.20.0)

find_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE})
project(hello_world)

target_sources(app PRIVATE src/main.c)
target_sources(app PRIVATE src/lis2dw_driver.c)
target_sources(app PRIVATE src/lis2dw12_reg.c)
target_sources(app PRIVATE src/acc_int.c)
