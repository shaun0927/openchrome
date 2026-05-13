# Semantic query plan flow

This recipe shows how a compiled plan can connect `oc_query` results to
deterministic actions and an `oc_assert` postcondition without adding a new
planner runtime.

## Goal

Resolve semantic page targets once, reuse their refs in later plan steps, and
settle with evidence-backed success or bounded failure.

## Inputs

- A local login fixture or application page.
- A compiled plan registered in the plan registry.
- Runtime credentials supplied by the host through `params`.

## Plan

```json
{
  "id": "semantic-login-flow",
  "version": "1.0.0",
  "description": "Resolve login fields semantically, act on refs, then assert outcome.",
  "parameters": {
    "email": { "source": "runtime" },
    "password": { "source": "runtime" }
  },
  "steps": [
    {
      "order": 1,
      "tool": "oc_query",
      "args": {
        "query": "login form with email, password, and submit button",
        "purpose": "interaction",
        "debug": false
      },
      "timeout": 10000,
      "parseResult": { "format": "json", "storeAs": "login" }
    },
    {
      "order": 2,
      "tool": "fill_form",
      "args": {
        "ref": "${login.matches.login_form.email_box.ref}",
        "value": "${email}"
      },
      "timeout": 10000
    },
    {
      "order": 3,
      "tool": "fill_form",
      "args": {
        "ref": "${login.matches.login_form.password_box.ref}",
        "value": "${password}"
      },
      "timeout": 10000
    },
    {
      "order": 4,
      "tool": "interact",
      "args": {
        "ref": "${login.matches.login_form.submit_btn.ref}",
        "action": "click"
      },
      "timeout": 10000
    },
    {
      "order": 5,
      "tool": "oc_assert",
      "args": {
        "assertion": { "kind": "dom_text", "contains": "Welcome" }
      },
      "timeout": 10000,
      "parseResult": { "format": "json", "storeAs": "postcondition" }
    }
  ],
  "errorHandlers": [
    {
      "condition": "step1_empty_result",
      "action": "capture-query-debug",
      "steps": [
        {
          "order": 1,
          "tool": "oc_query",
          "args": {
            "query": "login form with email, password, and submit button",
            "purpose": "interaction",
            "debug": true
          },
          "timeout": 10000,
          "parseResult": { "format": "json", "storeAs": "queryDebug" }
        },
        {
          "order": 2,
          "tool": "oc_evidence_bundle",
          "args": { "includeScreenshot": false, "includeDom": true },
          "timeout": 10000,
          "parseResult": { "format": "json", "storeAs": "evidenceBundle" }
        }
      ]
    }
  ],
  "successCriteria": {
    "requiredFields": ["login", "postcondition"]
  }
}
```

## Path binding

Plan templates support dotted params such as
`${login.matches.login_form.submit_btn.ref}`. Missing paths are left unchanged
so the downstream tool can fail with its normal bounded error instead of the
executor evaluating arbitrary expressions.

`parseResult.extractField` also accepts dotted paths when a plan wants to store
only one semantic query ref:

```json
{
  "parseResult": {
    "format": "json",
    "extractField": "matches.login_form.submit_btn.ref",
    "storeAs": "submitRef"
  }
}
```

## Verification

Use `execute_plan` against the fixture and assert:

- `success === true`
- `stepsExecuted === totalSteps`
- `data.login` contains the semantic query result
- `data.postcondition.verdict` is `pass`
- any failure path records `queryDebug` or `evidenceBundle` before settling
