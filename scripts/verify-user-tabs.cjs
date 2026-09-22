const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const puppeteer = require('puppeteer-core');
require('ts-node/register');
const { MCPClient } = require('../tests/e2e/harness/mcp-client');

function payload(result) { return result.raw.structuredContent ?? JSON.parse(result.content[0].text); }

async function main() {
  assert.ok(process.env.OPENCHROME_TEST_CHROME);
  const server = createServer((_req, res) => { res.end('<title>Local QA</title><main>Signed in test fixture<input id="draft"></main>'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/account`;
  const browser = await puppeteer.launch({ executablePath: process.env.OPENCHROME_TEST_CHROME, headless: false });
  const page = (await browser.pages())[0];
  await page.goto(url);
  const port = new URL(browser.wsEndpoint()).port;
  const client = new MCPClient({ args: ['--port', port, '--launch-mode', 'attach'], env: { OPENCHROME_USER_TABS: '1', OPENCHROME_SKIP_COOKIE_BRIDGE: '1' } });
  try {
    await client.start();
    const discovery = await client.callTool('tabs_context', { scope: 'browser' });
    assert.notEqual(discovery.raw.isError, true, discovery.text);
    const tab = payload(discovery).tabs.find(t => t.url === url);
    assert.ok(tab, 'Existing tab was not discovered');
    const stale = await client.callTool('worker', { action: 'borrow_tab', tabId: tab.tabId, expectedUrl: url + '/wrong' });
    assert.equal(stale.raw.isError, true);
    const borrowed = await client.callTool('worker', { action: 'borrow_tab', tabId: tab.tabId, expectedUrl: url });
    assert.equal(payload(borrowed).borrowed, true);
    await page.$eval('#draft', input => { input.value = 'qa-draft'; });
    const reused = await client.callTool('navigate', { url });
    assert.notEqual(reused.raw.isError, true, reused.text);
    assert.equal(payload(reused).tabId, tab.tabId);
    assert.equal(await page.$eval('#draft', input => input.value), 'qa-draft');
    const concurrent = await Promise.all([client.callTool('navigate', { url: url + '/new' }), client.callTool('navigate', { url: url + '/new' })]);
    for (const result of concurrent) assert.notEqual(result.raw.isError, true, result.text);
    assert.equal(payload(concurrent[0]).tabId, payload(concurrent[1]).tabId);
    const context = await client.callTool('tabs_context', {});
    assert.ok(payload(context).workers.some(w => w.tabs.some(t => t.tabId === tab.tabId)));
    const close = await client.callTool('tabs_close', { tabId: tab.tabId });
    assert.ok(payload(close).failed.includes(tab.tabId));
    assert.equal(page.isClosed(), false);
    const released = await client.callTool('worker', { action: 'release_tab', tabId: tab.tabId });
    assert.equal(payload(released).released, true);
    assert.equal(page.isClosed(), false);
    await client.callTool('worker', { action: 'borrow_tab', tabId: tab.tabId, expectedUrl: url });
    await client.stop();
    assert.equal(page.isClosed(), false, 'User tab closed during server shutdown');
    console.log(JSON.stringify({ discovered: true, staleUrlRejected: true, borrowed: true, draftPreserved: true, concurrentReuse: true, explicitCloseRefused: true, releasedWithoutClose: true, shutdownPreserved: true }));
  } finally {
    await client.stop();
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
