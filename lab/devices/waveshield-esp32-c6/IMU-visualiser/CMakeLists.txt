#
# AURA IMU-visualiser — organic gradient-orb visual driven by the QMI8658 IMU
# Target: Waveshare ESP32-C6-Touch-AMOLED-2.06 (ESP-IDF >= 5.3)
#
# NOTE: ESP-IDF does not tolerate spaces in project paths and this folder's
# parent ("Waveshield ESP32-C6") contains one. Build via a space-free symlink:
#   ln -s "$PWD" /tmp/imu-visualiser && cd /tmp/imu-visualiser && idf.py build
#
cmake_minimum_required(VERSION 3.16)
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(imu-visualiser)
