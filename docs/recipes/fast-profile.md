# Fast runtime profile

Set `OPENCHROME_PROFILE=fast` to opt into lower-token browser sessions without
changing the default OpenChrome behavior.

```bash
OPENCHROME_PROFILE=fast node dist/cli/index.js serve
```

Detect it with:

```jsonc
oc_get_connection_info({ "host": "openchrome" })
```

The response includes `runtimeProfile.profile: "fast"` and guidance for hosts.

Fast profile behavior in this PR:

- `read_page({ mode: "ax" })` defaults to compact AX output unless the caller
  explicitly passes `compact: false`.
- Security warnings, destructive-action gates, stale-ref guidance, and structured
  errors are not reduced.
- Screenshot tools remain available but are not implicitly enabled by the profile.

Use normal/default profile for visual QA, flaky interaction debugging, security
review, or any task that needs exhaustive page context.
