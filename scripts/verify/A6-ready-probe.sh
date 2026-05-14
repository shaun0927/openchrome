#!/usr/bin/env bash
# Verify the #862 /ready probe and signal-forwarding contract against a built tree.
#
# This script is intentionally opt-in because it launches a local OpenChrome
# daemon and, when available, Chrome. It uses only loopback ports.
#
# Usage:
#   npm run build
#   scripts/verify/A6-ready-probe.sh
#
# Optional env:
#   OC_READY_PORT=3100          # MCP HTTP port
#   OC_READY_HEALTH_PORT=3101   # /health and /ready probe port
#   OC_READY_TOKEN=testtoken
#   OC_READY_TIMEOUT_SECONDS=45

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

PORT="${OC_READY_PORT:-3100}"
HEALTH_PORT="${OC_READY_HEALTH_PORT:-3101}"
TOKEN="${OC_READY_TOKEN:-testtoken}"
TIMEOUT_SECONDS="${OC_READY_TIMEOUT_SECONDS:-45}"
STDERR_LOG="${TMPDIR:-/tmp}/openchrome-ready-probe-${PORT}.stderr.log"
STDOUT_LOG="${TMPDIR:-/tmp}/openchrome-ready-probe-${PORT}.stdout.log"
PID=""

cleanup() {
  if [[ -n "${PID}" ]] && kill -0 "${PID}" 2>/dev/null; then
    kill -TERM "${PID}" 2>/dev/null || true
    for _ in {1..30}; do
      kill -0 "${PID}" 2>/dev/null || break
      sleep 0.2
    done
    kill -KILL "${PID}" 2>/dev/null || true
    wait "${PID}" 2>/dev/null || true
  fi
}
trap cleanup EXIT

fail() {
  echo "[A6-ready] FAIL: $*" >&2
  echo "[A6-ready] stderr log: ${STDERR_LOG}" >&2
  tail -80 "${STDERR_LOG}" >&2 2>/dev/null || true
  exit 1
}

if [[ ! -f dist/index.js ]]; then
  fail "dist/index.js is missing; run npm run build first"
fi

if command -v lsof >/dev/null 2>&1; then
  if lsof -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
    fail "MCP port ${PORT} is already in use"
  fi
  if lsof -iTCP:"${HEALTH_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
    fail "health port ${HEALTH_PORT} is already in use"
  fi
fi

rm -f "${STDERR_LOG}" "${STDOUT_LOG}"

echo "[A6-ready] starting OpenChrome on 127.0.0.1:${PORT}; probes on 127.0.0.1:${HEALTH_PORT}"
OPENCHROME_DEV_HOOKS=1 \
OPENCHROME_FAKE_SLOW_START=2000 \
OPENCHROME_HEALTH_PORT="${HEALTH_PORT}" \
node dist/index.js serve --auto-launch --http "${PORT}" --auth-token "${TOKEN}" --idle-timeout 90s \
  >"${STDOUT_LOG}" 2>"${STDERR_LOG}" &
PID="$!"

saw_503=0
ready_payload=""
deadline=$((SECONDS + TIMEOUT_SECONDS))
while (( SECONDS < deadline )); do
  if ! kill -0 "${PID}" 2>/dev/null; then
    fail "daemon exited before becoming ready"
  fi

  response="$(curl -s -w $'\n%{http_code}' "http://127.0.0.1:${HEALTH_PORT}/ready" || true)"
  code="${response##*$'\n'}"
  body="${response%$'\n'*}"

  if [[ "${code}" == "503" ]]; then
    saw_503=1
    echo "[A6-ready] observed startup 503: ${body}"
  elif [[ "${code}" == "200" ]]; then
    ready_payload="${body}"
    echo "[A6-ready] observed ready 200: ${ready_payload}"
    break
  fi
  sleep 0.25
done

[[ "${saw_503}" == "1" ]] || fail "did not observe a startup /ready 503; fake slow hook may not be wired"
[[ -n "${ready_payload}" ]] || fail "daemon did not return /ready 200 within ${TIMEOUT_SECONDS}s"

node -e '
const payload = JSON.parse(process.argv[1]);
if (payload.ready !== true) throw new Error("ready was not true");
for (const name of ["chrome", "tools", "watchdogs"]) {
  if (payload.components?.[name] !== "ok") throw new Error(`${name} was not ok`);
}
' "${ready_payload}" || fail "ready payload did not match the #862 contract"

health_code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${HEALTH_PORT}/health")"
[[ "${health_code}" == "200" ]] || fail "/health returned ${health_code}, expected 200"
echo "[A6-ready] /health remained 200"

kill -TERM "${PID}"
set +e
wait "${PID}"
exit_code="$?"
set -e
PID=""
[[ "${exit_code}" == "0" ]] || fail "SIGTERM exit code was ${exit_code}, expected 0"
echo "[A6-ready] SIGTERM exited cleanly with code 0"

echo "[A6-ready] OK"
