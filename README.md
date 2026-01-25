# Claude Chrome Parallel

> **Run multiple Claude Code browser sessions in parallel - no more "Detached" errors.**

[![npm version](https://badge.fury.io/js/claude-chrome-parallel.svg)](https://www.npmjs.com/package/claude-chrome-parallel)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## The Power of Authenticated Browser Sessions

Unlike traditional web scraping or automation tools, Claude Chrome Parallel operates within **your already logged-in Chrome browser**. This means:

- **Access authenticated services** - Gmail, Salesforce, LinkedIn, banking portals, admin dashboards
- **No credential management** - Session cookies and OAuth tokens are already active
- **Bypass bot detection** - Uses your real browser profile, not headless automation
- **Access personalized data** - Dashboards, account settings, member-only content

**This is not just a development tool.** While the parallel session feature solves a technical problem for developers, the real power lies in automating *any* web task that requires authentication - tasks that were previously impossible to automate without building complex auth flows.

---

## Why This Exists

[Claude Chrome](https://claude.ai/chrome) lets you debug **production environments while logged in**. But when you try to run multiple Claude Code sessions with browser automation simultaneously:

```
Error: Detached while handling command
```

This happens because the Chrome extension uses **shared internal state**. When Session A takes a screenshot, Session B's connection gets "detached."

**Claude Chrome Parallel** solves this by creating **independent CDP connections** for each session:

```
Claude Code 1 ──► Process 1 ──► CDP Connection 1 ──┐
                                                    ├──► Chrome (port 9222)
Claude Code 2 ──► Process 2 ──► CDP Connection 2 ──┘
```

Each session gets isolated browser control. No shared state = No conflicts.

---

## Use Cases

### Beyond Development: Real-World Automation

The combination of **authenticated sessions** + **natural language control** + **parallel execution** enables automation scenarios that were previously impractical:

---

### 1. Business Process Automation

#### ERP/SaaS Dashboard Data Collection
Extract reports from login-required services (Salesforce, HubSpot, Zendesk):

```
You: Navigate to our Salesforce dashboard and extract this month's sales pipeline data

Claude: [Navigates to authenticated Salesforce, parses tables, extracts structured data]
```

#### Invoice & Receipt Collection
Automatically download monthly invoices from multiple services:

```
You: Go to AWS billing console and download last month's invoice PDF

Claude: [Navigates to authenticated AWS console, finds invoice, triggers download]
```

#### Repetitive Admin Tasks
Process approvals, submit forms, update records:

```
You: Go to our HR portal and approve all pending time-off requests from my team

Claude: [Navigates to HR system, finds pending items, processes each approval]
```

---

### 2. Research & Data Collection

#### Competitive Analysis (Login-Required Platforms)
Gather intelligence from premium platforms:

```
You: Search LinkedIn Sales Navigator for CTOs at fintech startups in NYC and list their profiles

Claude: [Uses your LinkedIn Premium session to search and extract profile data]
```

#### Academic Database Research
Access institutional databases that require authentication:

```
You: Search IEEE Xplore for papers on "transformer architecture" from 2023 and list titles with citations

Claude: [Uses your university library login to search and extract paper metadata]
```

#### Financial & Real Estate Data
Access member-only pricing and transaction data:

```
You: Check my Schwab portfolio and summarize today's gains/losses by sector

Claude: [Navigates authenticated brokerage account, extracts and analyzes positions]
```

---

### 3. Social Media Management

#### Multi-Account Content Publishing
Post content across platforms:

```
You: Post this announcement to our company LinkedIn, Twitter, and Facebook pages

Claude: [Navigates to each platform with saved sessions, composes and publishes posts]
```

#### Message & Inquiry Management
Handle customer messages with templates:

```
You: Check our Instagram business inbox and reply to product inquiries with our standard response

Claude: [Reads DMs, identifies product questions, sends templated responses]
```

#### Analytics Collection
Gather engagement metrics across platforms:

```
You: Get our Twitter analytics for the past week and summarize engagement trends

Claude: [Accesses Twitter Analytics dashboard, extracts metrics, provides summary]
```

---

### 4. E-Commerce Automation

#### Member Price Monitoring
Track prices that require membership login:

```
You: Check the member price for this Costco item and compare with last week

Claude: [Logs into Costco account, finds item, extracts member-only pricing]
```

#### Inventory & Order Management
Manage seller accounts across marketplaces:

```
You: Check our Amazon Seller Central for any new orders and list items running low on inventory

Claude: [Navigates seller dashboard, extracts order and inventory data]
```

#### Review Management
Respond to customer reviews at scale:

```
You: Find all unanswered 4-star reviews on our Shopify store and draft personalized thank-you responses

Claude: [Navigates store admin, identifies reviews, generates contextual responses]
```

---

### 5. Personal Productivity

#### Email Organization
Manage your inbox intelligently:

```
You: In Gmail, find all newsletters from the past month and add the "Newsletters" label

Claude: [Searches Gmail, selects matching emails, applies labels]
```

#### Calendar Management
Bulk calendar operations:

```
You: Add these 5 meetings to my Google Calendar with the details from this spreadsheet

Claude: [Creates each calendar event with proper dates, times, and descriptions]
```

#### Bookmark & Archive Management
Organize saved content:

```
You: Save this article to my Notion reading list with its title and summary

Claude: [Extracts metadata, navigates to Notion, creates database entry]
```

---

### 6. QA & Testing

#### Multi-Session QA Testing
Run parallel test scenarios against production:

```bash
# Terminal 1: Test user login flow
claude -p "Test the login flow on https://myapp.com/login"

# Terminal 2: Test checkout process (simultaneously!)
claude -p "Test the checkout flow on https://myapp.com/cart"

# Terminal 3: Monitor admin dashboard
claude -p "Take screenshots of https://myapp.com/admin every 30 seconds"
```

#### Network Condition Testing
Test performance under various network conditions:

```
You: Simulate 3G network and test if our checkout page loads within 5 seconds

Claude: [Applies network throttling, measures load time, reports results]
```

#### Accessibility Auditing
Analyze page accessibility via the accessibility tree:

```
You: Check the accessibility tree of our signup form and identify any missing labels

Claude: [Parses full accessibility tree, identifies WCAG compliance issues]
```

---

### 7. Security & Compliance

#### Personal Data Audit
Check what data services have stored:

```
You: Navigate to my Google Account privacy settings and list all third-party apps with access

Claude: [Navigates account settings, extracts connected app list]
```

#### Session Verification
Verify active sessions across services:

```
You: Check my GitHub security settings and list all active sessions

Claude: [Navigates GitHub settings, extracts session information]
```

---

## Core Features

### Isolated Workers (Parallel Browser Contexts)

The killer feature of Claude Chrome Parallel is **worker isolation**. Each worker has:

- **Separate browser context** with its own cookies, localStorage, and sessionStorage
- **Independent tab management** - tabs are scoped to their worker
- **Complete state isolation** - one worker's login doesn't affect another

```
You: Create a worker named "google-shopping"

Claude: [Creates isolated browser context]
        Worker: google-shopping
        Context: Isolated (separate cookies/storage)

You: In google-shopping worker, search for laptops

Claude: [Opens tab in google-shopping worker context]
        Any login, preferences, or state is isolated to this worker
```

**Why This Matters:**
- Log into different accounts simultaneously (e.g., multiple Gmail accounts)
- Run parallel price comparisons without cookie conflicts
- Test multi-user scenarios with complete isolation

### Automatic Task Distribution

When you have multiple tabs open, operations are automatically distributed:

```
You: Take screenshots of all open tabs

Claude: [Parallel execution across all tabs]
        Tab 1: Screenshot taken (500ms)
        Tab 2: Screenshot taken (480ms)
        Tab 3: Screenshot taken (520ms)
        Total: ~500ms (parallel) vs ~1500ms (sequential)
```

### Workflow Orchestration

For complex multi-site operations, use the orchestration tools:

```typescript
// Initialize a parallel workflow
workflow_init({
  name: "Price Comparison",
  workers: [
    { name: "amazon", url: "https://amazon.com", task: "Search iPhone 15 price" },
    { name: "ebay", url: "https://ebay.com", task: "Search iPhone 15 price" },
    { name: "walmart", url: "https://walmart.com", task: "Search iPhone 15 price" }
  ]
})

// Each worker executes in parallel with isolated contexts
// Results are collected via workflow_collect
```

---

## Available MCP Tools

### Browser Automation Tools

| Tool | Description | Key Use Cases |
|------|-------------|---------------|
| `navigate` | Navigate to URL, back/forward history | Multi-page workflows |
| `computer` | Screenshots, mouse clicks, keyboard, scrolling | Non-standard UI interaction |
| `read_page` | Parse page via accessibility tree | Dynamic content extraction |
| `find` | Find elements by natural language | "search box", "submit button" |
| `form_input` | Set form values directly | Fast data entry |
| `javascript_tool` | Execute arbitrary JavaScript | Complex DOM operations |
| `network` | Simulate network conditions | Performance testing |

### Tab & Worker Management Tools

| Tool | Description | Key Use Cases |
|------|-------------|---------------|
| `tabs_context_mcp` | Get available tabs by worker | Session overview |
| `tabs_create_mcp` | Create new tab in worker | Parallel tab operations |
| `worker_create` | Create isolated browser context | Multi-account scenarios |
| `worker_list` | List all workers and their tabs | Session management |
| `worker_delete` | Delete worker and close its tabs | Cleanup |

### Orchestration Tools

| Tool | Description | Key Use Cases |
|------|-------------|---------------|
| `workflow_init` | Initialize multi-worker workflow | Parallel site operations |
| `workflow_status` | Get orchestration progress | Monitoring |
| `workflow_collect` | Collect results from workers | Data aggregation |
| `workflow_cleanup` | Clean up workflow resources | Session cleanup |
| `worker_update` | Update worker progress | Progress tracking |
| `worker_complete` | Mark worker as complete | Workflow completion |

---

## Tested Concurrency

| Sessions | Success Rate |
|----------|-------------|
| 5 | 100% |
| 10 | 100% |
| 15 | 100% |
| 20 | 100% |

---

## Installation

```bash
# From npm
npm install -g claude-chrome-parallel

# Or from GitHub
npm install -g github:shaun0927/claude-chrome-parallel
```

### Configure Claude Code

Add to your Claude Code MCP settings (`~/.claude.json`):

```json
{
  "mcpServers": {
    "chrome-parallel": {
      "command": "ccp",
      "args": ["serve"]
    }
  }
}
```

> **Note:** `ccp` is a shorthand alias. You can also use the full name `claude-chrome-parallel`.

Restart Claude Code for changes to take effect.

---

## Usage

### Basic Usage

Once configured, browser automation works in any Claude Code session:

```
You: Take a screenshot of https://github.com

Claude: [Uses chrome-parallel tools automatically]
```

### Multiple Parallel Sessions

Run multiple Claude Code terminals simultaneously:

```bash
# Terminal 1
claude
> Navigate to myapp.com/dashboard and take a screenshot

# Terminal 2 (at the same time!)
claude
> Fill out the form on myapp.com/contact and submit

# Terminal 3 (also at the same time!)
claude
> Monitor network requests on myapp.com/api
```

All sessions work without conflicts!

### Network Simulation

Test how your app behaves under different network conditions:

```
You: Simulate 3G network and navigate to myapp.com

Claude: [Applies 3G throttling: 1.5Mbps down, 750Kbps up, 100ms latency]
```

Available presets: `offline`, `slow-2g`, `2g`, `3g`, `4g`, `fast-wifi`, `custom`, `clear`

---

## How It Works

### The Problem: Shared Extension State

The official Chrome extension maintains a single shared state:

```
Claude Code 1 ─┐
               ├─► Chrome Extension (shared state) ─► Chrome
Claude Code 2 ─┘
                    ↑
              State conflicts here!
```

### The Solution: Independent CDP Connections

Chrome's DevTools Protocol natively supports multiple simultaneous connections:

```
Claude Code 1 ─► Process 1 ─► CDP Connection 1 ─┐
                                                 ├─► Chrome (port 9222)
Claude Code 2 ─► Process 2 ─► CDP Connection 2 ─┘

Independent connections, no shared state!
```

Each Claude Code session spawns its own MCP server process with a dedicated CDP connection.

---

## CLI Commands

> **Tip:** Use `ccp` as a shorthand for `claude-chrome-parallel` in all commands below.

```bash
# Start MCP server (used by Claude Code automatically)
ccp serve

# Check Chrome connection status
ccp check

# Use custom Chrome debugging port
ccp serve --port 9223

# Check installation health
ccp doctor

# View session status and statistics
ccp status

# View status as JSON (for automation)
ccp status --json

# Clean up stale sessions and old backups
ccp cleanup --max-age 24 --keep-backups 10
```

---

## Chrome Configuration

By default, connects to Chrome on port 9222.

**Auto-launch**: If Chrome isn't running with debugging enabled, the package will start it automatically.

**Manual start** (if needed):

```bash
# Windows
chrome.exe --remote-debugging-port=9222

# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222

# Linux
google-chrome --remote-debugging-port=9222
```

---

## Additional Features

### Session Isolation (Bonus)

When running multiple Claude Code instances, they can corrupt `~/.claude.json` due to race conditions. Use the `launch` command to run Claude with isolated config:

```bash
# Run Claude Code with isolated config directory
ccp launch

# Pass any claude flags
ccp launch --dangerously-skip-permissions
ccp launch -p "Your prompt"
```

### Config Recovery

If your `.claude.json` gets corrupted:

```bash
# Auto-recover corrupted config
ccp recover

# List available backups
ccp recover --list-backups
```

---

## Comparison

| Feature | Claude in Chrome (Extension) | Claude Chrome Parallel |
|---------|------------------------------|----------------------|
| Multiple sessions | ❌ Detached errors | ✅ Works perfectly |
| Parallel QA testing | ❌ | ✅ |
| Connection type | Shared extension state | Independent CDP |
| Max concurrent sessions | 1 | 20+ tested |
| Auto Chrome launch | ❌ | ✅ |
| Network simulation | ❌ | ✅ 3G/4G/offline presets |
| Session auto-cleanup | ❌ | ✅ TTL-based |
| Connection pooling | ❌ | ✅ Pre-warmed pages |

---

## Considerations

### Strengths
- **Authenticated access** - Automate any login-required service
- **Natural language element finding** - Resilient to DOM changes
- **JavaScript execution** - Handle complex SPAs
- **Visual verification** - Screenshots for evidence/debugging

### Limitations
- CAPTCHA/bot detection on some services
- 2FA re-authentication may require manual intervention
- For high-volume tasks, native APIs are more efficient when available
- Rate limiting applies to automated interactions

### Recommended Patterns
1. **Small/critical tasks** → Use this MCP
2. **High-volume tasks** → Prefer native APIs when available
3. **Services without APIs** → This MCP is often the only option

---

## Troubleshooting

### Chrome not connecting

```bash
# Check status
ccp check

# Manually start Chrome with debugging
chrome --remote-debugging-port=9222
```

### Tools not appearing in Claude Code

1. Check MCP config in `~/.claude.json`
2. Restart Claude Code
3. Run `/mcp` to verify `chrome-parallel` is listed

---

## Development

```bash
git clone https://github.com/shaun0927/claude-chrome-parallel.git
cd claude-chrome-parallel

npm install
npm run build

# Test locally
npm install -g .
```

---

## License

MIT License - see [LICENSE](LICENSE) for details.

## Disclaimer

> **This is an unofficial, community-maintained project.**
> Not affiliated with or endorsed by Anthropic.
>
> "Claude" is a trademark of Anthropic. This project provides
> tooling to enhance the Claude Code experience but is not
> an official Anthropic product.

## Acknowledgments

- [Anthropic](https://anthropic.com) for Claude and the MCP protocol
- [Claude Code](https://github.com/anthropics/claude-code) for the CLI
- [Puppeteer](https://pptr.dev/) for browser automation
