#
# Aetherfield voteband-c6 - 4-option touch voting band
# Target: Waveshare ESP32-C6-Touch-LCD-1.69 (ESP-IDF >= 5.3, tested against 5.5)
#
# NOTE: this project intentionally lives at AURA/voteband-c6 (no spaces in the
# path) because ESP-IDF's build system does not tolerate spaces in project paths.
#
cmake_minimum_required(VERSION 3.16)
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(voteband-c6)
