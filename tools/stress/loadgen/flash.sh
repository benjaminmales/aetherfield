#!/usr/bin/env bash
#
# Build and flash one load-generator board.
#
#   ./flash.sh 3            board 3 — addresses 0x11D6..0x1267
#   ./flash.sh 3 --clean    pristine rebuild (needed if you edit Kconfig)
#
# Why a script rather than twenty VS Code build configurations: the fragment
# is the ONLY difference between the twenty images, and clicking through the
# GUI twenty times is twenty chances to flash board 7 with board 6's block.
# Two boards sharing a block emit the same addresses, the server merges them,
# and the fleet silently looks half its true size — which reads as 50% packet
# loss and is not.
#
# Each board gets its own build directory, so after the first pass a reflash
# is seconds rather than a minute.
set -euo pipefail

BOARD="nrf54l15tag/nrf54l15/cpuapp"
N="${1:-}"

if ! [[ "$N" =~ ^[0-9]+$ ]] || (( N < 1 || N > 20 )); then
  echo "usage: $0 <1..20> [--clean]" >&2
  exit 1
fi

TAG=$(printf "tag%02d" "$N")
DIR="build-$TAG"
BLOCK=$(( N - 1 ))
BASE=$(( 0x1000 + BLOCK * 150 ))

PRISTINE=()
[[ "${2:-}" == "--clean" ]] && PRISTINE=(-p always)

printf '%s: block %d, addresses 0x%04X..0x%04X\n' "$TAG" "$BLOCK" "$BASE" $(( BASE + 149 ))

west build -b "$BOARD" . -d "$DIR" "${PRISTINE[@]}" -- -DEXTRA_CONF_FILE="$TAG.conf"
west flash -d "$DIR"

echo
echo "Flashed $TAG. On its console, 'sim stats' should report block $BLOCK."
echo "If it reports a different block you have just flashed the wrong image."
