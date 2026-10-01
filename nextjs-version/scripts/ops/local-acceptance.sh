#!/usr/bin/env bash
# Disposable local SQL/service acceptance only; never loads .env or hosted values.
set -euo pipefail
umask 077
cd "$(dirname "$0")/../.."
pg_bin="${T0_POSTGRES_BIN:-/opt/homebrew/opt/postgresql@16/bin}"
port="${T0_POSTGRES_PORT:-56435}"
if [[ ! "$port" =~ ^[0-9]+$ ]] || ((port < 1024 || port > 65535)); then
  echo 'T0_POSTGRES_PORT must be an unprivileged TCP port.' >&2; exit 1
fi
for tool in initdb pg_ctl pg_dump pg_restore psql; do
  [[ -x "$pg_bin/$tool" ]] || { echo "Missing PostgreSQL tool: $tool" >&2; exit 1; }
done
command -v node >/dev/null
[[ -d node_modules ]] || { echo 'Run pnpm install --frozen-lockfile first.' >&2; exit 1; }
root="$(mktemp -d "/tmp/fundlane-t0.XXXXXX")"
startup_attempted=false
cleanup() {
  result=$?
  trap - EXIT INT TERM
  if [[ "$startup_attempted" == true ]]; then
    if ! env -i LC_ALL=C PATH="$PATH" "$pg_bin/pg_ctl" -D "$root/pg" -m fast -w stop >/dev/null; then
      echo "Cluster shutdown failed; retained task data at $root" >&2
      exit 1
    fi
  fi
  rm -rf "$root"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# Empty environment prevents PG*, Supabase, provider, app or encryption secrets leaking in.
env -i LC_ALL=C PATH="$PATH" "$pg_bin/initdb" -D "$root/pg" -A trust -U postgres > "$root/init.log"
# An occupied port fails startup; it never attaches to another task's cluster.
startup_attempted=true
if ! env -i LC_ALL=C PATH="$PATH" "$pg_bin/pg_ctl" -D "$root/pg" -l "$root/postgres.log" -o "-p $port -h 127.0.0.1 -k $root" -w start >/dev/null; then
  [[ ! -f "$root/postgres.log" ]] || cat "$root/postgres.log" >&2
  echo 'Task cluster did not start; choose an unused T0_POSTGRES_PORT.' >&2
  exit 1
fi
printf 'T0 acceptance: disposable loopback PostgreSQL, port %s; synthetic fixtures only\n' "$port"
env -i LC_ALL=C PATH="$pg_bin:$PATH" TMPDIR="$root" \
  MCA_TEST_DATABASE_ADMIN_URL="postgresql://postgres@127.0.0.1:$port/postgres" \
  node --experimental-test-module-mocks --conditions=react-server --import tsx \
    --test --test-concurrency=1 \
    tests/acceptance-foundation.test.ts tests/documents-core.test.ts \
    tests/jobs-worker.test.ts tests/foundation-core.test.ts tests/ops-backup-safety.test.ts \
    tests/local-acceptance.test.mjs
