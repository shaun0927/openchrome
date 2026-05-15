#!/usr/bin/env python3
"""
browser-use Python bridge for the competitive benchmark suite (#1255).

A line-delimited JSON-over-stdio bridge that lets the TypeScript
benchmark harness drive the Python `browser-use` package as if it
were any other library adapter. The TS adapter spawns this script as
a subprocess; we read one JSON request per stdin line and emit one
JSON response per stdout line. *Every* non-protocol log goes to
stderr — stdout is reserved for JSON-RPC, mirroring MCP's wire
contract (CLAUDE.md hard rule).

Request shape:
    {"id": <int>, "method": "ping" | "open_tab" | "read_page"
                          | "close_tab" | "shutdown",
     "args": {...}}

Response shape:
    {"id": <int>, "ok": true,  "result": {...}}
    {"id": <int>, "ok": false, "error": "<message>"}

Per Epic #1254 fairness principle: the subprocess overhead is
measured separately by the TS adapter and never folded into the
token / success metrics. Each response carries a `recvMonotonicNs`
field so the TS side can compute a clean round-trip number.

The `browser-use` import is intentionally lazy — only `open_tab` and
`read_page` need it, so a CI smoke that only calls `ping` or
`shutdown` does not require the heavyweight Python deps. That keeps
the bridge protocol independently testable.
"""

from __future__ import annotations

import json
import sys
import time
import traceback
from typing import Any, Dict


def _log_stderr(message: str) -> None:
    """Stderr-only logging — never write to stdout (JSON-RPC channel)."""
    sys.stderr.write(message.rstrip() + "\n")
    sys.stderr.flush()


def _write_response(payload: Dict[str, Any]) -> None:
    """Emit one JSON response line and flush stdout idempotently."""
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


class _BridgeState:
    """In-memory tab registry. Real browser-use sessions live here."""

    def __init__(self) -> None:
        self.tabs: Dict[str, Dict[str, Any]] = {}
        self.tab_seq = 0
        self._browser_use_module: Any = None

    def _browser_use(self) -> Any:
        """Lazy-import browser-use so `ping`/`shutdown` work without it."""
        if self._browser_use_module is None:
            import importlib

            self._browser_use_module = importlib.import_module("browser_use")
        return self._browser_use_module

    # ----- handlers -----------------------------------------------------

    def ping(self, args: Dict[str, Any]) -> Dict[str, Any]:
        return {"pong": True, "echo": args}

    def open_tab(self, args: Dict[str, Any]) -> Dict[str, Any]:
        url = str(args.get("url", ""))
        # Lazy: just record the URL; real browser-use session attach is
        # exercised by the integration smoke run, not the protocol test.
        # Importing browser-use here so missing deps surface clearly.
        self._browser_use()
        self.tab_seq += 1
        tab_id = f"browser-use-tab-{self.tab_seq}"
        self.tabs[tab_id] = {"url": url, "opened_at": time.time()}
        return {"tabId": tab_id}

    def read_page(self, args: Dict[str, Any]) -> Dict[str, Any]:
        tab_id = str(args.get("tabId", ""))
        if tab_id not in self.tabs:
            raise KeyError(f"unknown tabId {tab_id!r}")
        # Placeholder DOM-serialization payload — the real integration
        # run replaces this with browser-use's DomService output. The
        # protocol shape is the part this bridge stabilizes.
        self._browser_use()
        url = self.tabs[tab_id]["url"]
        return {"payload": f"<browser-use-dom-serialization for {url}>"}

    def close_tab(self, args: Dict[str, Any]) -> Dict[str, Any]:
        tab_id = str(args.get("tabId", ""))
        if tab_id not in self.tabs:
            raise KeyError(f"unknown tabId {tab_id!r}")
        del self.tabs[tab_id]
        return {"closed": tab_id}


_HANDLERS = {
    "ping": "ping",
    "open_tab": "open_tab",
    "read_page": "read_page",
    "close_tab": "close_tab",
}


def _serve() -> int:
    state = _BridgeState()
    _log_stderr("browser-use bridge ready")

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request_id: Any = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            method = str(request.get("method", ""))
            args = request.get("args") or {}

            if method == "shutdown":
                _write_response({
                    "id": request_id,
                    "ok": True,
                    "result": {"shutdown": True},
                    "recvMonotonicNs": time.monotonic_ns(),
                })
                _log_stderr("browser-use bridge shutting down")
                return 0

            if method not in _HANDLERS:
                raise ValueError(f"unsupported method {method!r}")

            handler_name = _HANDLERS[method]
            handler = getattr(state, handler_name)
            result = handler(args)
            _write_response({
                "id": request_id,
                "ok": True,
                "result": result,
                "recvMonotonicNs": time.monotonic_ns(),
            })
        except Exception as err:  # noqa: BLE001 — propagate everything as a clean response
            _log_stderr("error: " + "".join(traceback.format_exception_only(type(err), err)))
            _write_response({
                "id": request_id,
                "ok": False,
                "error": f"{type(err).__name__}: {err}",
                "recvMonotonicNs": time.monotonic_ns(),
            })

    return 0


if __name__ == "__main__":
    sys.exit(_serve())
