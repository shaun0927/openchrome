# Captcha P7 Audit — Third-Party Credential Isolation

**Scope:** confirm that the CAPTCHA solving subsystem under `src/captcha/`
complies with #1359 §P7 (core boring, pilot experimental) and the explicit
non-goal **"no mandatory third-party credentials at boot."**

## Invariants

The following four invariants are codified by the unit test
`tests/security/p7-captcha-third-party-isolation.test.ts`:

1. **Clean boot without env.** The core boots with **no**
   `OPENCHROME_CAPTCHA_*` environment variable set. Constructing
   `SolverRegistry`, calling `initialize()`, and importing the
   public barrel (`src/captcha/index.ts`) must succeed and must not
   throw.
2. **Configured-false default.** With no env, `isConfigured()` and
   `isAutoSolveEnabled()` both return `false`.
3. **Lazy provider modules.** No module under
   `src/captcha/providers/*.ts` is loaded into the require cache
   until both `OPENCHROME_CAPTCHA_PROVIDER` and
   `OPENCHROME_CAPTCHA_API_KEY` are set AND `initialize()` selects
   that provider. The dynamic `import()` inside the
   `SolverRegistry.initialize()` switch keeps the third-party network
   code dormant during normal core operation. The regression test
   enumerates the providers directory at runtime via `fs.readdirSync`,
   so a future provider file is guarded without changing the test.
4. **Facts-only "no solver" response.** `handleCaptcha()` returns
   `{ solved: false, error: 'No CAPTCHA solver configured' }` when no
   solver is configured. No HTTP request is made and no provider
   module is loaded.

## Auto-solve gate

`isAutoSolveEnabled()` (in `solver-registry.ts`) requires **both**:

- `OPENCHROME_CAPTCHA_AUTO_SOLVE === 'true'`, AND
- a configured solver (`isConfigured() === true`).

`src/tools/navigate.ts` checks this gate before ever calling `handleCaptcha`:

```ts
if (stealthBlocked && blocking?.type === 'captcha' && getSolverRegistry().isAutoSolveEnabled()) {
  const solveResult = await handleCaptcha(page, blocking);
  ...
}
```

The default boot has neither env var set, so the gate is closed and the
solver code path is dead. This is the correct P7 posture: a core
operation (navigation) does not silently invoke a third-party paid
service.

## What this audit does **not** claim

- It does not claim the solver providers are themselves safe — that is
  out of scope. When the operator opts in by setting the env vars, the
  responsibility for cost, latency, and ToS shifts to the operator.
- It does not claim P7 applies to *every* line of the captcha module;
  it claims it applies to the *boot path* and the *default navigation
  path*.

## Future work

The wider **B2** thread (#1359) splits CAPTCHA detection from CAPTCHA
solving entirely:

- **B2-PR1** exposes `oc_gate_inspect` as a fact-only MCP tool that
  wraps `detectCaptcha` without invoking any solver.
- **B2-PR2** extends gate detection to SSO redirect, basic-auth, 2FA,
  paywall.

Once those land, the host agent — not the openchrome core — decides
whether to solve a captcha at all. This audit confirms the core is
already P7-clean in advance of those PRs.

## See also

- `src/captcha/solver-registry.ts`, `src/captcha/handler.ts`,
  `src/captcha/index.ts`
- `src/tools/navigate.ts` (auto-solve gate)
- `src/hints/rules/blocking-page.ts` (hint-surface auto-solve gate)
- `docs/roadmap/portability-harness-contract.md` §"No mandatory
  third-party credentials"
- #1359 §P7, §Explicit non-goals
