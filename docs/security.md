
### Pilot credential vault (`vault://name`)

When the pilot tier is enabled, `oc_credentials` can store local credentials in `~/.openchrome/vault` and browser input tools can resolve `vault://name` references server-side. The vault is encrypted at rest using the same AES-256-GCM persistence layer as pilot handoff tokens; passphrase mode derives a 32-byte key with argon2id. Tool responses and trace redaction replace resolved vault literals with `<vault:name>` where the server observes them.

Threat-model boundary: this protects OpenChrome traces, audit surfaces, and MCP responses from carrying plaintext credentials. It does not prevent the destination page from reading the field after OpenChrome types the credential into that page; same-origin page JavaScript can still inspect its own form values.
