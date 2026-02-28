# Security Policy

## Overview

OpenChrome is a browser automation MCP (Model Context Protocol) server that grants AI agents programmatic control of a user's Chrome browser. Because the browser may be authenticated to sensitive accounts, understanding the security model is important for safe deployment.

---

## 1. Trust Model

OpenChrome operates as a local child process launched by an MCP client (e.g., Claude Code). It does not expose any network-accessible service of its own.

**Communication channel**

All communication between the MCP client and OpenChrome occurs over a stdio pipe (JSON-RPC over stdin/stdout). There is no TCP listener, no HTTP server, and no WebSocket endpoint created by OpenChrome itself. The protocol attack surface is therefore limited to the local process boundary.

**Chrome DevTools Protocol (CDP)**

OpenChrome connects to Chrome via the CDP debugging port, which Chrome binds exclusively to `localhost:9222` (or a user-configured port). This is Chrome's own design; OpenChrome does not change that binding.

**Opt-in by design**

Users activate OpenChrome by explicitly adding it to their MCP client's configuration (e.g., `.mcp.json`, `.vscode/mcp.json`, or via `claude mcp add`). There is no ambient or automatic activation.

**Trust chain**

```
User
  └── MCP Client (e.g., Claude Code)
        └── OpenChrome process (stdio pipe)
              └── Chrome via CDP (localhost only)
```

Each link in this chain requires deliberate user action or configuration to establish.

---

## 2. Security Considerations

### Full browser access

Any AI agent connected through an MCP client that has OpenChrome configured gains the ability to interact with the Chrome instance, including all authenticated sessions (banking, email, cloud services, etc.). Users should treat OpenChrome access with the same level of trust they would grant to a human operator sitting at their keyboard.

### Prompt injection

Malicious or adversarial web page content could attempt to manipulate an AI agent's behavior by embedding instructions in visible or hidden page text. Because OpenChrome exposes rich page-reading capabilities (accessibility tree, DOM extraction, screenshot), a compromised page may attempt to redirect the agent's actions.

**Mitigations available in OpenChrome:**

- **Domain blocklist** - A configurable blocklist in the global config file allows users to prevent OpenChrome from loading or interacting with specified domains. Sensitive sites (banking portals, password managers, identity providers) should be added to this list.
- **Audit logging** - When enabled via the `--audit-log` flag or `security.audit_log` config, all tool invocations are logged. Users can review these logs to detect unexpected or unauthorized actions.

---

## 3. What OpenChrome Does Not Protect Against

The following threats are outside OpenChrome's current scope:

- **Prompt injection from visited web pages.** If a page contains adversarial text designed to manipulate an AI agent, OpenChrome has no mechanism to detect or block the injection itself. Defense requires careful agent-side prompt hygiene and domain blocklisting.
- **A compromised MCP client.** If the MCP client process itself is compromised, it can issue arbitrary commands to OpenChrome over the stdio pipe. OpenChrome performs no independent authentication of the client.
- **Other local processes accessing the CDP port.** Chrome binds the CDP port to localhost. Any other process running under the same user account (or a privileged account) can connect to that port independently of OpenChrome.
- **Malicious browser extensions.** Extensions installed in the Chrome profile can interfere with pages or exfiltrate data independently of OpenChrome.

---

## 4. Recommended Practices

**Limit browser scope**
- Use a dedicated Chrome profile for AI-assisted workflows rather than a profile that is logged in to sensitive personal or financial accounts.
- Keep sensitive accounts (banking, password managers, corporate SSO) in a separate profile that is never used with OpenChrome.

**Configure the domain blocklist**
- Add high-risk domains to the global config blocklist before granting agent access.
- Revisit the blocklist periodically as you add sensitive accounts to your browser.

**Do not expose the CDP port**
- Never use `--remote-debugging-address=0.0.0.0` or any other flag that binds Chrome's debugging port to a non-loopback interface.
- Ensure no firewall rules or reverse proxies forward external traffic to `localhost:9222`.

**Review audit logs**
- Enable audit logging first by passing the `--audit-log` flag or setting `security.audit_log` in your config file.
- Periodically review OpenChrome's audit logs to verify that only expected tool calls were made.
- Integrate log review into any team or organizational deployment process.

**Keep dependencies up to date**
- Update OpenChrome and its dependencies regularly to receive security patches.

---

## 5. Responsible Disclosure

We follow a coordinated (responsible) disclosure policy.

**How to report**

If you discover a security vulnerability in OpenChrome, please report it privately before public disclosure:

- **GitHub Security Advisories**: Use the "Report a vulnerability" button on the repository's Security tab.

Please include a clear description of the vulnerability, steps to reproduce, and an assessment of impact. We will acknowledge receipt within 3 business days.

**Disclosure timeline**

| Day | Action |
|-----|--------|
| 0 | Vulnerability reported |
| 1-3 | Acknowledgment sent to reporter |
| 1-14 | Triage and severity assessment |
| 14-60 | Patch developed and tested |
| 60-90 | Patch released; coordinated public disclosure |

We target a maximum of 90 days from initial report to public disclosure. If a critical vulnerability requires faster action, we will accelerate the timeline and notify the reporter. We will not disclose vulnerabilities publicly before a patch is available, except in cases where active exploitation is detected.

**Scope**

This policy covers the OpenChrome MCP server and its published npm package. It does not cover Chrome itself, the MCP protocol specification, or third-party MCP clients.

---

## 6. Version and Maintenance

This security policy applies to the current stable release of OpenChrome. Older versions may not receive security backports. Users are encouraged to run the latest release.
