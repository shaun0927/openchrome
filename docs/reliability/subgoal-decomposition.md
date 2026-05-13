# Bounded subgoal decomposition

Subgoal decomposition is an opt-in task-run helper for complex browser objectives. It does not run for simple tasks unless explicitly forced and it does not execute browser actions by itself.

A valid plan contains:

- `objective`
- bounded `subgoals[]`
- per-subgoal `success_criteria`
- per-subgoal `stop_condition`
- per-subgoal `allowed_tools`
- `global_stop_conditions` including auth handoff, CAPTCHA/bot checks, and destructive confirmation requirements

The validator rejects missing success criteria, missing stop conditions, duplicate ids, out-of-scope domains, and destructive-looking subgoals that do not explicitly stop on policy/confirmation.

The conservative builder emits three default subgoals: scope/state verification, target location, and outcome verification. Each is designed to feed a task-level critic/verifier before reporting completion.
