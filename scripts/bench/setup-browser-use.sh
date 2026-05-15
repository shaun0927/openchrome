#!/usr/bin/env bash
# Bootstrap a Python venv for the browser-use bridge (#1255).
#
# Usage:
#   ./scripts/bench/setup-browser-use.sh
#
# Creates `.venv-browser-use/` at the repo root and installs the pinned
# browser-use PyPI version (see benchmark/COMPETITORS.md). Subsequent runs
# of the bridge should invoke the venv's Python:
#
#   .venv-browser-use/bin/python tests/benchmark/bridges/browser_use_bridge.py
#
# The adapter's `python` option points the subprocess transport at this
# interpreter — fresh checkouts only need to run this script once.

set -euo pipefail

# Pinned to match the row in benchmark/COMPETITORS.md. Bump together.
BROWSER_USE_VERSION="0.12.6"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VENV_DIR="${ROOT_DIR}/.venv-browser-use"

if ! command -v python3 >/dev/null 2>&1; then
  echo "error: python3 not found on PATH" >&2
  exit 1
fi

PY_VERSION="$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
PY_MAJOR="$(printf '%s' "${PY_VERSION}" | cut -d. -f1)"
PY_MINOR="$(printf '%s' "${PY_VERSION}" | cut -d. -f2)"
if [ "${PY_MAJOR}" -lt 3 ] || { [ "${PY_MAJOR}" -eq 3 ] && [ "${PY_MINOR}" -lt 11 ]; }; then
  echo "error: browser-use ${BROWSER_USE_VERSION} requires Python >= 3.11 (found ${PY_VERSION})" >&2
  exit 1
fi

if [ ! -d "${VENV_DIR}" ]; then
  echo "creating venv at ${VENV_DIR}"
  python3 -m venv "${VENV_DIR}"
fi

# shellcheck source=/dev/null
. "${VENV_DIR}/bin/activate"

python -m pip install --upgrade pip >/dev/null
python -m pip install "browser-use==${BROWSER_USE_VERSION}"

echo "browser-use ${BROWSER_USE_VERSION} installed at ${VENV_DIR}"
echo "next: run \`${VENV_DIR}/bin/python tests/benchmark/bridges/browser_use_bridge.py\` to verify"
