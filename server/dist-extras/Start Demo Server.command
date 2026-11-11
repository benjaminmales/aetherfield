#!/bin/sh
# Starts the Aetherfield Demo Server. Close this window to stop it.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Get the LTS installer from https://nodejs.org, then try again."
  read -r -p "Press Return to close." _
  exit 1
fi
(sleep 2 && open "http://localhost:3000") &
node server.js
