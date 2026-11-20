#!/usr/bin/env bash
# Runs server test files against a throwaway PostGIS container, removed on exit.
# Each test file gets its own fresh database, as the podman helper in test/helpers/pg.ts does.
# Usage: bash scripts/test-local.sh [test files relative to apps/server, e.g. test/install.test.ts]
set -uo pipefail
NAME="ditest-$$"
PORT="${DITEST_PORT:-55432}"
docker run --rm -d --name "$NAME" -p "$PORT:5432" -e POSTGRES_PASSWORD=test docker.io/postgis/postgis:16-3.4 >/dev/null || exit 1
trap 'docker stop "$NAME" >/dev/null 2>&1 || true' EXIT
# The image restarts Postgres once after its init scripts; wait for the second "ready".
for _ in $(seq 1 120); do
  [ "$(docker logs "$NAME" 2>&1 | grep -c 'ready to accept connections')" -ge 2 ] && break
  sleep 1
done
cd "$(dirname "$0")/../apps/server"
FILES=("$@")
[ "${#FILES[@]}" -eq 0 ] && FILES=(test/*.test.ts)
status=0; i=0
for f in "${FILES[@]}"; do
  i=$((i + 1)); db="t$i"
  docker exec "$NAME" psql -q -U postgres -c "CREATE DATABASE $db" >/dev/null
  TEST_DATABASE_URL="postgres://postgres:test@127.0.0.1:$PORT/$db" node --import tsx --test "$f" || status=1
done
exit $status
