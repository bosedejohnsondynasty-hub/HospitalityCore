#!/bin/sh
# Full verification: types, production builds, database integrity and the test suite.
set -eu

echo '==> typecheck (api + web)'
npm run typecheck

echo '==> production build (api + web)'
npm run build

echo '==> database integrity checks'
node scripts/verify-db.mjs

echo '==> automated test suite'
npm test

echo
echo 'Verification complete.'
echo 'Reminder: Docker Compose, backup/restore and TLS termination must still be exercised on the target host.'
