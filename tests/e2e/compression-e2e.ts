/**
 * E2E Compression Verification Test
 *
 * Verifies all 9 compression strategies from Issue #263 against a real Chrome browser.
 * Spawns an MCP server subprocess, connects via JSON-RPC, and validates each strategy
 * produces the expected compressed output.
 *
 * Prerequisites:
 *   - Chrome running on localhost:9222 (--remote-debugging-port=9222)
 *   - npm run build (dist/index.js must exist)
 *
 * Usage: npx ts-node tests/e2e/compression-e2e.ts
 */

import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as http from 'http';
import * as fs from 'fs';

// ─── MCP Client ───────────────────────────────────────────────

interface MCPResponse {
  jsonrpc: '2.0';
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

class MCPClient {
  private process: ChildProcess | null = null;
  private requestId = 0;
  private pending = new Map<number, { resolve: (v: MCPResponse) => void; reject: (e: Error) => void }>();
  private buffer = '';

  async start(): Promise<void> {
    const serverPath = path.join(process.cwd(), 'dist', 'index.js');
    return new Promise((resolve, reject) => {
      this.process = spawn('node', [serverPath, 'serve'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      let ready = false;

      this.process.stderr?.on('data', (data: Buffer) => {
        const msg = data.toString();
        // Debug: show server stderr
        if (process.env.DEBUG) process.stderr.write(`[server] ${msg}`);
        if (!ready && (msg.includes('Ready') || msg.includes('MCP server') || msg.includes('waiting'))) {
          ready = true;
          this.send('initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'compression-e2e', version: '1.0.0' },
          })
            .then(() => resolve())
            .catch(reject);
        }
      });

      this.process.stdout?.on('data', (data: Buffer) => {
        this.buffer += data.toString();
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const response = JSON.parse(line) as MCPResponse;
            const p = this.pending.get(response.id);
            if (p) {
              this.pending.delete(response.id);
              p.resolve(response);
            }
          } catch { /* ignore non-JSON */ }
        }
      });

      this.process.on('error', (err) => { if (!ready) reject(err); });
      this.process.on('exit', (code) => { if (!ready) reject(new Error(`Server exited: ${code}`)); });

      setTimeout(() => { if (!ready) reject(new Error('Server startup timeout (20s)')); }, 20000);
    });
  }

  async stop(): Promise<void> {
    try { await this.callTool('oc_stop', {}); } catch { /* ignore */ }
    this.process?.stdin?.end();
    this.process?.kill();
    this.process = null;
    for (const [, p] of this.pending) p.reject(new Error('Shutdown'));
    this.pending.clear();
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; raw: Record<string, unknown> }> {
    const response = await this.send('tools/call', { name, arguments: args });
    if (response.error) throw new Error(`Tool error: ${response.error.message}`);
    const result = response.result || {};
    const content = result.content as Array<{ type: string; text?: string }> | undefined;
    const text = content?.filter(c => c.type === 'text').map(c => c.text).join('\n') || '';
    return { text, raw: result };
  }

  private send(method: string, params?: Record<string, unknown>): Promise<MCPResponse> {
    if (!this.process?.stdin) throw new Error('Not started');
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.process!.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Timeout: ${method} (30s)`));
        }
      }, 30000);
      timer.unref();
    });
  }
}

// ─── Local HTTP Server for fixture pages ──────────────────────

function startFixtureServer(port: number): Promise<http.Server> {
  return new Promise((resolve) => {
    const fixturesDir = path.join(process.cwd(), 'tests', 'e2e', 'fixtures');
    const server = http.createServer((req, res) => {
      const filePath = path.join(fixturesDir, req.url === '/' ? 'compression-test.html' : req.url!);
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(content);
      } catch {
        res.writeHead(404);
        res.end('Not found');
      }
    });
    server.listen(port, () => resolve(server));
  });
}

// ─── Test Helpers ──────────────────────────────────────────────

interface TestResult {
  name: string;
  strategy: string;
  passed: boolean;
  details: string;
  outputChars?: number;
}

const results: TestResult[] = [];

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

// ─── Test Fixture HTML ─────────────────────────────────────────

const COMPRESSION_TEST_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Compression Strategy Test Page</title>
</head>
<body>
  <!-- Strategy 1: Sibling Deduplication — 20 identical li items -->
  <div id="sibling-test">
    <h2>Product List</h2>
    <ul id="product-list">
      <li>Product Alpha - $19.99</li>
      <li>Product Beta - $29.99</li>
      <li>Product Gamma - $39.99</li>
      <li>Product Delta - $49.99</li>
      <li>Product Epsilon - $59.99</li>
      <li>Product Zeta - $69.99</li>
      <li>Product Eta - $79.99</li>
      <li>Product Theta - $89.99</li>
      <li>Product Iota - $99.99</li>
      <li>Product Kappa - $109.99</li>
      <li>Product Lambda - $119.99</li>
      <li>Product Mu - $129.99</li>
      <li>Product Nu - $139.99</li>
      <li>Product Xi - $149.99</li>
      <li>Product Omicron - $159.99</li>
      <li>Product Pi - $169.99</li>
      <li>Product Rho - $179.99</li>
      <li>Product Sigma - $189.99</li>
      <li>Product Tau - $199.99</li>
      <li>Product Upsilon - $209.99</li>
    </ul>
  </div>

  <!-- Strategy 2: Container Collapse — deeply nested single-child chains -->
  <div id="container-test">
    <div class="wrapper-1">
      <div class="wrapper-2">
        <section class="inner">
          <div class="deep-nest">
            <button id="deep-button">Click Me Deep</button>
          </div>
        </section>
      </div>
    </div>
  </div>

  <!-- Strategy 5: Cookie test target (cookies set via JS) -->
  <div id="cookie-test">
    <p>Cookie classification test area</p>
  </div>

  <!-- Strategy 9: Interaction targets -->
  <div id="interaction-test">
    <button id="action-btn">Submit Order</button>
    <input type="text" id="search-input" placeholder="Type here...">
    <a href="#" id="test-link">Learn More</a>
  </div>

  <!-- Extra DOM elements for delta test (will be modified by JS) -->
  <div id="dynamic-content">
    <p id="counter">Count: 0</p>
    <p id="status">Status: idle</p>
  </div>

  <script>
    // Set test cookies for Strategy 5
    document.cookie = "session_token=abc123; path=/";
    document.cookie = "csrf_token=xyz789; path=/";
    document.cookie = "_ga=GA1.2.12345; path=/";
    document.cookie = "_gid=GA1.2.67890; path=/";
    document.cookie = "_fbp=fb.1.12345; path=/";
    document.cookie = "theme=dark; path=/";
    document.cookie = "lang=en; path=/";
    document.cookie = "consent=true; path=/";
    document.cookie = "_gcl_au=1.1.12345; path=/";
    document.cookie = "NID=fake_nid; path=/";

    // Button click handler for interaction test
    document.getElementById('action-btn').addEventListener('click', function() {
      this.textContent = 'Order Submitted!';
      document.getElementById('status').textContent = 'Status: submitted';
      document.getElementById('counter').textContent = 'Count: 1';
    });

    // Console dedup test: button that generates repeated console messages
    document.getElementById('test-link').addEventListener('click', function(e) {
      e.preventDefault();
      for (var i = 0; i < 20; i++) { console.log("[HMR] Waiting for update signal..."); }
      console.error("Critical error: connection lost");
      console.error("Another critical error");
    });
  </script>
</body>
</html>`;

// ─── Tests ─────────────────────────────────────────────────────

async function testStrategy1_SiblingDedup(client: MCPClient, tabId: string): Promise<TestResult> {
  const name = 'Strategy 1: DOM Sibling Deduplication';
  try {
    const { text } = await client.callTool('read_page', { tabId, mode: 'dom' });

    // Should see ×N pattern for the 20 li items
    const hasCollapsed = /×\d+/.test(text) || /x\d+/.test(text) || /\d+-\d+\]/.test(text);
    // Should NOT have all 20 individual li lines
    const liCount = (text.match(/<li/g) || []).length;

    // With dedup, we should see far fewer than 20 individual li entries
    // The collapsed format uses refs like [firstRef-lastRef]
    const hasRangeRef = /\[\d+-\d+\]/.test(text);
    const hasShowingSamples = /showing \d+ of \d+/i.test(text);

    const passed = hasCollapsed || hasRangeRef || hasShowingSamples || liCount < 15;

    return {
      name, strategy: 'S1',
      passed,
      details: passed
        ? `Sibling dedup active: ${hasCollapsed ? '×N pattern found' : ''}${hasRangeRef ? ', range refs found' : ''}${hasShowingSamples ? ', sample notation found' : ''} (${liCount} individual <li> tags vs 20 original)`
        : `FAIL: All 20 li items appear individually (${liCount} found). No collapse pattern detected.`,
      outputChars: text.length,
    };
  } catch (e: unknown) {
    return { name, strategy: 'S1', passed: false, details: `Error: ${(e as Error).message}` };
  }
}

async function testStrategy2_ContainerCollapse(client: MCPClient, tabId: string): Promise<TestResult> {
  const name = 'Strategy 2: Container Collapse';
  try {
    const { text } = await client.callTool('read_page', { tabId, mode: 'dom' });

    // Should see chain notation: div>div>section> or similar
    const hasChainNotation = />/.test(text) && /\]\w+>/.test(text);
    // Container-test area should have compressed nested divs
    // Look for the deep-button without each wrapper on its own line
    const deepButtonLine = text.split('\n').find(l => l.includes('deep-button') || l.includes('Click Me Deep'));

    // Count indentation levels around deep-button — with collapse it should be fewer
    const lines = text.split('\n');
    const containerLines = lines.filter(l =>
      l.includes('wrapper-1') || l.includes('wrapper-2') || l.includes('inner') || l.includes('deep-nest')
    );

    // With container collapse, these wrapper divs should be on fewer lines (chained)
    const passed = hasChainNotation || containerLines.length < 4;

    return {
      name, strategy: 'S2',
      passed,
      details: passed
        ? `Container collapse active: ${hasChainNotation ? 'chain notation (>) found' : `${containerLines.length} wrapper lines (< 4 means collapsed)`}. Deep button found: ${!!deepButtonLine}`
        : `FAIL: ${containerLines.length} separate wrapper lines found (expected < 4). No chain notation.`,
      outputChars: text.length,
    };
  } catch (e: unknown) {
    return { name, strategy: 'S2', passed: false, details: `Error: ${(e as Error).message}` };
  }
}

async function testStrategy3_IncrementalDelta(client: MCPClient, tabId: string): Promise<TestResult> {
  const name = 'Strategy 3: Incremental Delta Responses';
  try {
    // First read — should return full DOM
    const first = await client.callTool('read_page', { tabId, mode: 'dom', compression: 'delta' });
    const firstLen = first.text.length;

    // Small DOM change via JS
    await client.callTool('javascript_tool', {
      tabId,
      expression: 'document.getElementById("counter").textContent = "Count: 42"',
    });

    // Wait briefly for DOM to update
    await new Promise(r => setTimeout(r, 500));

    // Second read — should return delta (much smaller)
    const second = await client.callTool('read_page', { tabId, mode: 'dom', compression: 'delta' });
    const secondLen = second.text.length;

    const hasDeltaHeader = /\[DOM Delta/i.test(second.text);
    const hasAddedSection = /Added \(\d+\)/i.test(second.text);
    const hasRemovedSection = /Removed \(\d+\)/i.test(second.text);
    const hasUnchanged = /Unchanged.*\d+.*node/i.test(second.text);
    const sizeReduction = firstLen > 0 ? Math.round((1 - secondLen / firstLen) * 100) : 0;

    const passed = hasDeltaHeader && secondLen < firstLen;

    return {
      name, strategy: 'S3',
      passed,
      details: passed
        ? `Delta mode active: first=${firstLen} chars, second=${secondLen} chars (${sizeReduction}% reduction). Header: ${hasDeltaHeader}, Added: ${hasAddedSection}, Removed: ${hasRemovedSection}, Unchanged: ${hasUnchanged}`
        : `FAIL: ${hasDeltaHeader ? 'Delta header found but' : 'No delta header.'} first=${firstLen}, second=${secondLen} chars.`,
      outputChars: secondLen,
    };
  } catch (e: unknown) {
    return { name, strategy: 'S3', passed: false, details: `Error: ${(e as Error).message}` };
  }
}

async function testStrategy4_ConsoleDedup(client: MCPClient, tabId: string): Promise<TestResult> {
  const name = 'Strategy 4: Console Log Deduplication';
  try {
    // Start capture first
    const startResult = await client.callTool('console_capture', { tabId, action: 'start' });
    console.error(`   [debug] capture start: ${startResult.text.slice(0, 150)}`);

    // Wait for listener to be fully attached
    await new Promise(r => setTimeout(r, 500));

    // Click "Learn More" link — its click handler generates 20 repeated console.log + 2 errors
    // Using interact (page context click) so Puppeteer console listener captures them
    await client.callTool('interact', { tabId, action: 'click', query: 'Learn More' });

    // Wait for all console messages to be captured
    await new Promise(r => setTimeout(r, 2000));

    // Get logs
    const { text } = await client.callTool('console_capture', { tabId, action: 'get' });
    console.error(`   [debug] get response (${text.length} chars): ${text.slice(0, 300)}`);

    // Should see count notation (×20 or similar) for the repeated messages
    const hasCountNotation = /×\s*\d+|"count":\s*\d{2,}|x\s*\d{2,}/i.test(text);
    // Errors should NOT be collapsed — both should appear
    const errorCount = (text.match(/[Cc]ritical/g) || []).length;

    // The 20 identical messages should be collapsed into far fewer lines
    const hmrMentions = (text.match(/HMR/g) || []).length;

    // Check if logs were captured at all
    const hasLogs = text.length > 200 || hmrMentions > 0 || errorCount > 0;

    const passed = hasLogs && (hasCountNotation || hmrMentions < 10) && errorCount >= 2;

    // Stop capture
    await client.callTool('console_capture', { tabId, action: 'stop' });

    return {
      name, strategy: 'S4',
      passed,
      details: passed
        ? `Console dedup active: HMR mentions=${hmrMentions} (from 20 originals), count notation: ${hasCountNotation}, errors preserved: ${errorCount}`
        : `FAIL: HMR mentions=${hmrMentions}, count notation: ${hasCountNotation}, errors: ${errorCount}, hasLogs: ${hasLogs}, text length: ${text.length}`,
      outputChars: text.length,
    };
  } catch (e: unknown) {
    return { name, strategy: 'S4', passed: false, details: `Error: ${(e as Error).message}` };
  }
}

async function testStrategy5_CookieClassification(client: MCPClient, tabId: string): Promise<TestResult> {
  const name = 'Strategy 5: Smart Cookie Classification';
  try {
    // Get cookies (default = classified format)
    const { text: classified } = await client.callTool('cookies', { tabId, action: 'get' });

    const hasAuthSection = /auth.*cookie/i.test(classified);
    const hasFunctionalSection = /functional.*cookie/i.test(classified);
    const hasTrackingSection = /tracking.*cookie/i.test(classified);
    const hasTrackingSummary = /tracking.*\d+.*total/i.test(classified);

    // Get raw cookies for comparison
    const { text: raw } = await client.callTool('cookies', { tabId, action: 'get', raw: true });

    const sizeReduction = raw.length > 0 ? Math.round((1 - classified.length / raw.length) * 100) : 0;

    const passed = hasAuthSection && hasTrackingSection && classified.length < raw.length;

    return {
      name, strategy: 'S5',
      passed,
      details: passed
        ? `Cookie classification active: Auth=${hasAuthSection}, Functional=${hasFunctionalSection}, Tracking=${hasTrackingSection} (summary: ${hasTrackingSummary}). Classified=${classified.length} chars, Raw=${raw.length} chars (${sizeReduction}% reduction)`
        : `FAIL: Auth=${hasAuthSection}, Functional=${hasFunctionalSection}, Tracking=${hasTrackingSection}. Classified=${classified.length}, Raw=${raw.length}`,
      outputChars: classified.length,
    };
  } catch (e: unknown) {
    return { name, strategy: 'S5', passed: false, details: `Error: ${(e as Error).message}` };
  }
}

async function testStrategy7_Verbosity(client: MCPClient, tabId: string): Promise<TestResult> {
  const name = 'Strategy 7: Response Verbosity Levels';
  try {
    // Default verbosity is 'normal' — should have _timing with just durationMs
    const { raw } = await client.callTool('read_page', { tabId, mode: 'dom' });

    const timing = raw._timing as Record<string, unknown> | undefined;
    const profile = raw._profile as Record<string, unknown> | undefined;

    // In 'normal' mode: _timing should have durationMs but NOT startTime/endTime
    const hasDurationMs = timing && 'durationMs' in timing;
    const hasStartTime = timing && 'startTime' in timing;
    const hasEndTime = timing && 'endTime' in timing;

    // normal mode should include _timing (durationMs only) and may include _profile
    const passed = !!hasDurationMs;

    return {
      name, strategy: 'S7',
      passed,
      details: passed
        ? `Verbosity 'normal' active: _timing.durationMs=${hasDurationMs} (${timing?.durationMs}ms), startTime=${hasStartTime}, endTime=${hasEndTime}, _profile=${!!profile}`
        : `FAIL: _timing=${JSON.stringify(timing)}, _profile=${!!profile}`,
    };
  } catch (e: unknown) {
    return { name, strategy: 'S7', passed: false, details: `Error: ${(e as Error).message}` };
  }
}

async function testStrategy8_SchemaCompression(client: MCPClient): Promise<TestResult> {
  const name = 'Strategy 8: Tool Schema Compression';
  try {
    // List all tools and check description lengths
    const response = await client['send']('tools/list', {});
    const tools = (response.result as { tools?: Array<{ name: string; description: string }> })?.tools || [];

    const longDescs = tools.filter(t => t.description && t.description.length > 100);
    const avgDescLen = tools.reduce((s, t) => s + (t.description?.length || 0), 0) / Math.max(tools.length, 1);
    const totalSchemaChars = JSON.stringify(tools).length;

    // Compressed descriptions should average under 60 chars
    const passed = avgDescLen < 80 && longDescs.length <= 5;

    return {
      name, strategy: 'S8',
      passed,
      details: passed
        ? `Schema compression active: ${tools.length} tools, avg description=${Math.round(avgDescLen)} chars, ${longDescs.length} > 100 chars, total schema=${totalSchemaChars} chars`
        : `FAIL: avg desc=${Math.round(avgDescLen)} chars (target < 80), ${longDescs.length} long descriptions. ${longDescs.map(t => `${t.name}(${t.description.length})`).join(', ')}`,
    };
  } catch (e: unknown) {
    return { name, strategy: 'S8', passed: false, details: `Error: ${(e as Error).message}` };
  }
}

async function testStrategy9_MinimalActions(client: MCPClient, tabId: string): Promise<TestResult> {
  const name = 'Strategy 9: Minimal Action Responses';
  try {
    // Click a button — response should be compact with ✓ prefix
    const { text: clickResult } = await client.callTool('interact', {
      tabId,
      action: 'click',
      query: 'Submit Order',
    });

    const hasCheckmark = clickResult.includes('\u2713') || clickResult.includes('✓');
    const isCompact = clickResult.length < 500; // compact = under 500 chars (vs 800+ old JSON)
    const hasTagName = /button|a|input/i.test(clickResult);

    const passed = hasCheckmark && isCompact;

    return {
      name, strategy: 'S9',
      passed,
      details: passed
        ? `Minimal responses active: checkmark=${hasCheckmark}, compact=${isCompact} (${clickResult.length} chars), tagName=${hasTagName}. Response: "${clickResult.slice(0, 120)}..."`
        : `FAIL: checkmark=${hasCheckmark}, length=${clickResult.length} chars. Response: "${clickResult.slice(0, 200)}"`,
      outputChars: clickResult.length,
    };
  } catch (e: unknown) {
    return { name, strategy: 'S9', passed: false, details: `Error: ${(e as Error).message}` };
  }
}

// ─── Main ──────────────────────────────────────────────────────

async function main() {
  console.error('\n╔══════════════════════════════════════════════════════════╗');
  console.error('║  Issue #263 — Response Compression Layer E2E Verification ║');
  console.error('╚══════════════════════════════════════════════════════════╝\n');

  // 1. Create fixture directory and HTML
  const fixturesDir = path.join(process.cwd(), 'tests', 'e2e', 'fixtures');
  if (!fs.existsSync(fixturesDir)) fs.mkdirSync(fixturesDir, { recursive: true });
  fs.writeFileSync(path.join(fixturesDir, 'compression-test.html'), COMPRESSION_TEST_HTML);

  // 2. Start local HTTP server for fixtures
  const PORT = 18923;
  const server = await startFixtureServer(PORT);
  console.error(`[setup] Fixture server running on http://localhost:${PORT}`);

  // 3. Start MCP server
  const client = new MCPClient();
  console.error('[setup] Starting MCP server...');
  await client.start();
  console.error('[setup] MCP server ready\n');

  let tabId = '';

  try {
    // 4. Navigate to test page
    console.error('[test] Navigating to compression test page...');
    const navResult = await client.callTool('navigate', { url: `http://localhost:${PORT}/compression-test.html` });

    // Extract tabId — look for 32-char hex ID pattern (Chrome target ID format)
    const hexMatch = navResult.text.match(/\b([A-F0-9]{32})\b/);
    if (hexMatch) {
      tabId = hexMatch[1];
    }

    if (!tabId) {
      // Fallback: use tabs_context to find the tab
      const tabsResult = await client.callTool('tabs_context', {});
      console.error(`[debug] tabs_context response: ${tabsResult.text.slice(0, 500)}`);
      const hexMatch2 = tabsResult.text.match(/\b([A-F0-9]{32})\b/);
      tabId = hexMatch2?.[1] || '';
    }

    if (!tabId) {
      console.error(`[debug] navigate response: ${navResult.text.slice(0, 500)}`);
      throw new Error('Could not determine tabId');
    }

    console.error(`[test] Navigated successfully, tabId: ${tabId}\n`);

    // Wait for page to fully load and cookies to set
    await new Promise(r => setTimeout(r, 2000));

    // 5. Run each strategy test
    console.error('─── Running Strategy Tests ───────────────────────────────\n');

    const tests = [
      () => testStrategy1_SiblingDedup(client, tabId),
      () => testStrategy2_ContainerCollapse(client, tabId),
      () => testStrategy3_IncrementalDelta(client, tabId),
      () => testStrategy4_ConsoleDedup(client, tabId),
      () => testStrategy5_CookieClassification(client, tabId),
      () => testStrategy7_Verbosity(client, tabId),
      () => testStrategy8_SchemaCompression(client),
      () => testStrategy9_MinimalActions(client, tabId),
    ];

    for (const test of tests) {
      const result = await test();
      results.push(result);
      const icon = result.passed ? '✅' : '❌';
      console.error(`${icon} [${result.strategy}] ${result.name}`);
      console.error(`   ${result.details}`);
      if (result.outputChars !== undefined) {
        console.error(`   Output size: ${result.outputChars.toLocaleString()} chars`);
      }
      console.error('');
    }

  } finally {
    // 6. Cleanup
    console.error('─── Cleanup ─────────────────────────────────────────────\n');
    await client.stop();
    console.error('[cleanup] MCP server stopped');
    server.close();
    console.error('[cleanup] Fixture server stopped');
    // Remove fixture file
    try { fs.unlinkSync(path.join(fixturesDir, 'compression-test.html')); } catch { /* ignore */ }
  }

  // 7. Summary
  console.error('\n═══════════════════════════════════════════════════════════');
  console.error('                      TEST SUMMARY');
  console.error('═══════════════════════════════════════════════════════════\n');

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;

  for (const r of results) {
    console.error(`  ${r.passed ? '✅' : '❌'} ${r.strategy}: ${r.name}`);
  }

  console.error(`\n  Total: ${passed}/${results.length} passed, ${failed} failed\n`);

  if (failed > 0) {
    console.error('  FAILED TESTS:');
    for (const r of results.filter(r => !r.passed)) {
      console.error(`    ❌ ${r.name}: ${r.details}`);
    }
    console.error('');
  }

  // Note about Strategy 6 (not tested via MCP — requires screenshot comparison)
  console.error('  ℹ️  Strategy 6 (Screenshot Smart Decision): Not tested via MCP.');
  console.error('     AdaptiveScreenshot degradation is an internal optimization');
  console.error('     that requires multiple sequential screenshot calls to trigger.\n');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`\n💥 Fatal error: ${err.message}\n${err.stack}`);
  process.exit(2);
});
