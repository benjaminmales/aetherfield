#!/bin/sh
# Builds the client download: aetherfield-demo-server-<version>.zip
#
# Self-contained: production dependencies are bundled, so the client needs
# only Node.js, with no `npm install` and no internet. Output goes into the
# wiki's static files, so the download sits behind the wiki login at
#   https://aetherfield.ai/wiki/downloads/aetherfield-demo-server-<version>.zip
#
# Usage (from the repo root):  sh tools/package-demo-server.sh
# Then update the version in the wiki's download links if it changed, and push.
set -e
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./server/package.json').version")
NAME=aetherfield-demo-server
OUT="$PWD/web/wiki/static/downloads"
TMP=$(mktemp -d)
DEST="$TMP/$NAME"
mkdir -p "$DEST/lib" "$OUT"

cp server/server.js server/service.js server/simulate.js server/package-lock.json server/.env.example "$DEST/"
cp -R server/public "$DEST/public"
for f in server/lib/*.js; do case "$f" in *.test.js) ;; *) cp "$f" "$DEST/lib/";; esac; done
cp server/dist-extras/README.md "$DEST/README.md"
cp "server/dist-extras/Start Demo Server.command" "server/dist-extras/Start Demo Server.bat" "$DEST/"
chmod +x "$DEST/Start Demo Server.command"

# package.json without the test script and dev dependencies
node -e "
const p=require('./server/package.json');
delete p.devDependencies; delete p.scripts.test;
require('fs').writeFileSync('$DEST/package.json', JSON.stringify(p,null,2)+'\n');"

(cd "$DEST" && npm install --omit=dev --ignore-scripts --no-audit --no-fund --silent)

rm -f "$OUT/$NAME-$VERSION.zip"
(cd "$TMP" && zip -qr "$OUT/$NAME-$VERSION.zip" "$NAME" -x '*.DS_Store')
rm -rf "$TMP"
ls -lh "$OUT/$NAME-$VERSION.zip"
