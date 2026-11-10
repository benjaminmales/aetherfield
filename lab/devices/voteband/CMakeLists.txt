#
# Aetherfield voteband - minimal 802.15.4 voting beacon for Seeed XIAO nRF52840
#
cmake_minimum_required(VERSION 3.20.0)
find_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE})

project(voteband)

# Shared Aetherfield radio protocol (aura_radio.h lives at repo-root/include)
target_include_directories(app PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/../../include
)

target_sources(app PRIVATE src/main.c)
