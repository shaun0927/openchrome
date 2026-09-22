const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const puppeteer = require('puppeteer-core');
require('ts-node/register');
const { MCPClient } = require('../tests/e2e/harness/mcp-client');

function foreground(restore) {
  const code = 'using System; using System.Runtime.InteropServices; public class FocusProbe {' +
    '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();' +
    '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); }';
  const script = `Add-Type '${code}'; ${restore ? `[FocusProbe]::SetForegroundWindow([IntPtr]${restore}) | Out-Null;` : ''} [FocusProbe]::GetForegroundWindow().ToInt64()`;
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true }).trim();
}

async function main() {
  assert.equal(process.platform, 'win32');
  assert.ok(process.env.OPENCHROME_TEST_CHROME, 'Set OPENCHROME_TEST_CHROME');
  const originalWindow = foreground();
  assert.notEqual(originalWindow, '0', 'QA requires an interactive Windows desktop');
  const browser = await puppeteer.launch({ executablePath: process.env.OPENCHROME_TEST_CHROME, headless: false, defaultViewport: null });
  const port = new URL(browser.wsEndpoint()).port;
  const client = new MCPClient({ args: ['--port', port, '--launch-mode', 'attach'], env: { OPENCHROME_SKIP_COOKIE_BRIDGE: '1', OPENCHROME_FOCUS_POLICY: 'background-only' } });
  try {
    await client.start();
    assert.equal(foreground(originalWindow), originalWindow, 'Could not restore the previously focused application for QA');
    const rows = [];
    for (const args of [{ url: 'about:blank' }, { url: 'about:blank' }, { url: 'about:blank', isolatedContext: 'focus-qa' }]) {
      const result = await client.callTool('tabs_create', args);
      assert.notEqual(result.raw.isError, true, result.text);
      const after = foreground();
      rows.push({ scenario: args.isolatedContext ? 'isolated-create' : 'default-create', foregroundPreserved: after === originalWindow });
      assert.equal(after, originalWindow, 'Tab creation stole foreground');
      const created = result.raw.structuredContent ?? JSON.parse(result.content[0].text);
      const activation = await client.callTool('tabs_activate', { tabId: created.tabId });
      assert.equal(activation.raw.isError, true, 'background-only policy allowed activation');
      assert.equal(foreground(), originalWindow);
    }
    const info = await client.callTool('oc_get_connection_info', { host: 'openchrome' });
    assert.notEqual(info.raw.isError, true);
    const connection = JSON.parse(info.text).browserConnection;
    assert.equal(connection.status, 'attached');
    assert.equal(connection.authentication, 'unverified');
    console.log(JSON.stringify({ chrome: await browser.version(), transport: 'MCP stdio', rows, connection }, null, 2));
  } finally {
    await client.stop();
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
