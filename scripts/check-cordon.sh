#!/bin/sh
#
# The cordon: production code never depends on lab/.
#
# Lab may use production (the protocol header, the band layer, the boards) so
# experiments stay current. The reverse is forbidden, because the moment a
# shipping build reaches into lab/, an experiment can break a release and
# nobody can say which code is the product any more.
#
# Checks every production tree for any path that leads into lab/ — CMake
# sources and includes, C #includes, Node require/import, Kconfig, overlays.
# Run by the pre-commit hook and by CI. Exit 1 on any hit.

cd "$(dirname "$0")/.." || exit 2

PROD="include firmware server cloud web tools deploy"
hits=$(grep -rInE '(\.\./)+lab/|[^a-z_-]lab/(devices|gateways|pixel|boards|demos|node|hardware|scripts)' \
         --include='*.c' --include='*.h' --include='*.txt' --include='*.cmake' \
         --include='*.conf' --include='*.overlay' --include='*.dts*' --include='Kconfig*' \
         --include='*.js' --include='*.mjs' --include='*.ts' --include='*.jsx' --include='*.tsx' \
         --include='package.json' \
         --exclude-dir=node_modules --exclude-dir=build --exclude-dir='build-*' \
         $PROD 2>/dev/null)

if [ -n "$hits" ]; then
  echo "BLOCKED: production code references lab/ — the cordon is broken."
  echo
  echo "$hits" | sed 's/^/  /'
  echo
  echo "  Promote what you need out of lab/ into production (with review),"
  echo "  or keep the dependent code in lab/. See CLAUDE.md, 'The cordon'."
  exit 1
fi
echo "cordon ok: no production path reaches into lab/"
