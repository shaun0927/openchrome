import json
import os
import sys


def write(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    try:
        import laya

        device = os.environ.get("LAYA_DEVICE") or None
        router = laya.Router(device=device, max_loaded=1, preload=False)
        write({"type": "ready", "device": device, "model": os.environ.get("LAYA_MODEL", "typed-decisions")})
    except Exception as exc:
        write({
            "type": "fatal",
            "error": {
                "type": type(exc).__name__,
                "message": "local Laya runtime initialization failed",
            },
        })
        return 1

    model = os.environ.get("LAYA_MODEL", "typed-decisions")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request = None
        try:
            request = json.loads(line)
            state = request["state"]
            if not isinstance(state, str):
                state = json.dumps(state, ensure_ascii=False, sort_keys=True)
            state = state.encode("utf-8", "replace").decode("utf-8", "replace")
            result = router.predict(state, request["questions"], model=model)
            write({"id": request.get("id"), "ok": True, "body": result})
        except Exception as exc:
            write({
                "id": request.get("id") if isinstance(request, dict) else None,
                "ok": False,
                "error": {
                    "type": type(exc).__name__,
                    "message": "local prediction failed",
                },
            })
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
