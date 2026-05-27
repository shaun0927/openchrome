# Benchmark reliability and fault matrix gates

This document defines the completion gate for #1259, #1303, and #1304. Local
stress scaffolds and deterministic fixtures remain useful regression checks, but
reliability claims require live or recorded-real task completion evidence with
fault injection and browser process accounting.

## Required matrix axes

Every promoted reliability row must identify:

- `task_id`: real-world task completion fixture or recorded-real episode id.
- `adapter`: OpenChrome or competitor, with version/commit.
- `fault`: one of `none`, `cdp_disconnect`, `browser_crash`, `network_stall`,
  `tab_eviction`, `slow_dom`, or a documented custom injector.
- `injection_point`: before navigation, during action, during extraction, or
  during verification.
- `final_postcondition`: PASS/FAIL with machine-readable predicate output.
- `recovered`: true only if the final postcondition passes after the injected
  fault without manual intervention.
- `chrome_process`: pid, RSS start/end/peak, zombie count, and whether the
  process was operator-owned or OpenChrome-managed.
- `artifacts`: JSON trace, stderr/stdout log, screenshot/video when available.

## Promotion rule

A reliability row is headline-eligible only when:

1. The baseline `fault=none` row passes for the same task/adapter/version.
2. At least three repetitions exist for each `(task_id, adapter, fault)` cell.
3. RSS/zombie sampling is present for browser-backed adapters.
4. The final postcondition, not an intermediate retry event, decides success.
5. Any skipped cell has an explicit operator-environment reason.

## Required commands before changing readiness

```bash
npm run bench:realworld:headline
npm run bench:reliability
npm run bench:realworld:stress
npm run bench:readiness
```

If any command cannot run because live Chrome/operator credentials are missing,
keep the row diagnostic and commit the skip reason rather than a headline claim.
