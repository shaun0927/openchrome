/// <reference types="jest" />

jest.mock('puppeteer-core', () => ({
  __esModule: true,
  default: { connect: jest.fn() },
}));

jest.mock('../../src/chrome/launcher', () => ({
  getChromeLauncher: jest.fn().mockReturnValue({
    ensureChrome: jest.fn(),
    invalidateInstance: jest.fn(),
  }),
}));

jest.mock('../../src/config/global', () => ({
  getGlobalConfig: jest.fn().mockReturnValue({ port: 9222, autoLaunch: false, skipCookieBridge: false }),
}));

import { CDPClient } from '../../src/cdp/client';

type TargetInfo = { targetId: string; type: string; url: string; browserContextId?: string };
type Cookie = { name: string; value: string; domain: string; path: string; expires: number; httpOnly: boolean; secure: boolean; sameSite?: string };

function makeBrowserSession(targets: TargetInfo[], cookiesBySession: Record<string, Cookie[]> = {}) {
  const attachOrder: string[] = [];
  const session = {
    send: jest.fn(async (method: string, params?: { targetId?: string; sessionId?: string }, extra?: { sessionId?: string }) => {
      if (method === 'Target.getTargets') return { targetInfos: targets };
      if (method === 'Target.attachToTarget') {
        attachOrder.push(params?.targetId ?? '');
        return { sessionId: `session-${params?.targetId}` };
      }
      if (method === 'Network.getAllCookies') {
        return { cookies: cookiesBySession[extra?.sessionId ?? ''] ?? [] };
      }
      if (method === 'Target.detachFromTarget') return undefined;
      return undefined;
    }),
    detach: jest.fn(async () => undefined),
    attachOrder,
  };
  return session;
}

function makeDestPage() {
  const destSession = {
    send: jest.fn(async () => undefined),
    detach: jest.fn(async () => undefined),
  };
  return {
    createCDPSession: jest.fn(async () => destSession),
    target: jest.fn(() => ({ _targetId: 'dest-target' })),
    _session: destSession,
  };
}

function connectedClient(browserSession: ReturnType<typeof makeBrowserSession>) {
  const client = new CDPClient({ port: 9222 });
  const browser = {
    isConnected: jest.fn(() => true),
    target: jest.fn(() => ({ createCDPSession: jest.fn(async () => browserSession) })),
    on: jest.fn(),
    pages: jest.fn(async () => []),
    targets: jest.fn(() => []),
  };
  (client as unknown as { browser: unknown }).browser = browser;
  (client as unknown as { connectionState: string }).connectionState = 'connected';
  return client;
}

describe('CDPClient cookie contracts (#687 Wave 4 prereq)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns no_candidates after filtering non-page, internal, blank, and login targets', async () => {
    const session = makeBrowserSession([
      { targetId: 'worker', type: 'service_worker', url: 'https://example.test/sw.js' },
      { targetId: 'chrome', type: 'page', url: 'chrome://settings' },
      { targetId: 'extension', type: 'page', url: 'chrome-extension://abc/options.html' },
      { targetId: 'blank', type: 'page', url: 'about:blank' },
      { targetId: 'login', type: 'page', url: 'https://example.test/login' },
    ]);
    const client = connectedClient(session);

    const result = await client.findAuthenticatedPageTarget('example.test');

    expect(result).toMatchObject({ status: 'no_candidates', targetId: null, scanned: 0, total: 0 });
    expect(session.send).toHaveBeenCalledWith('Target.getTargets');
    expect(session.send).not.toHaveBeenCalledWith('Target.attachToTarget', expect.anything());
    expect(session.detach).toHaveBeenCalled();
  });

  it('returns no_cookies after scanning candidates that have no cookies', async () => {
    const session = makeBrowserSession([
      { targetId: 'candidate-1', type: 'page', url: 'https://app.example.test/dashboard' },
      { targetId: 'candidate-2', type: 'page', url: 'https://docs.example.test/' },
    ]);
    const client = connectedClient(session);

    const result = await client.findAuthenticatedPageTarget('example.test');

    expect(result).toMatchObject({ status: 'no_cookies', targetId: null, scanned: 2, total: 2 });
    expect(session.attachOrder).toEqual(['candidate-1', 'candidate-2']);
    expect(session.send).toHaveBeenCalledWith('Target.detachFromTarget', { sessionId: 'session-candidate-1' });
    expect(session.send).toHaveBeenCalledWith('Target.detachFromTarget', { sessionId: 'session-candidate-2' });
  });

  it('prefers external cookie candidates over localhost when target domain is external', async () => {
    const cookie: Cookie = { name: 'sid', value: 'abc', domain: 'example.test', path: '/', expires: -1, httpOnly: true, secure: true };
    const session = makeBrowserSession(
      [
        { targetId: 'local', type: 'page', url: 'http://localhost:3000/app' },
        { targetId: 'external', type: 'page', url: 'https://app.example.test/dashboard' },
      ],
      { 'session-external': [cookie] },
    );
    const client = connectedClient(session);

    const result = await client.findAuthenticatedPageTarget('example.test');

    expect(result.targetId).toBe('external');
    expect(result.status).toBe('complete');
    expect(session.attachOrder).toEqual(['external']);
  });

  it('copyCookiesViaCDP returns 0 without attaching when the source target is absent', async () => {
    const session = makeBrowserSession([{ targetId: 'other', type: 'page', url: 'https://example.test/' }]);
    const client = connectedClient(session);
    const destPage = makeDestPage();

    await expect(client.copyCookiesViaCDP('missing-source', destPage as never)).resolves.toBe(0);

    expect(session.send).toHaveBeenCalledWith('Target.getTargets');
    expect(session.send).not.toHaveBeenCalledWith('Target.attachToTarget', expect.anything());
    expect(destPage.createCDPSession).not.toHaveBeenCalled();
    expect(session.detach).toHaveBeenCalled();
  });

  it('copyCookiesViaCDP detaches source and destination sessions after setting cookies', async () => {
    const cookie: Cookie = {
      name: 'sid',
      value: 'abc',
      domain: 'example.test',
      path: '/',
      expires: -1,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    };
    const session = makeBrowserSession(
      [{ targetId: 'source', type: 'page', url: 'https://example.test/' }],
      { 'session-source': [cookie] },
    );
    const client = connectedClient(session);
    const destPage = makeDestPage();

    await expect(client.copyCookiesViaCDP('source', destPage as never)).resolves.toBe(1);

    expect(session.send).toHaveBeenCalledWith('Target.detachFromTarget', { sessionId: 'session-source' });
    expect(session.detach).toHaveBeenCalled();
    expect(destPage._session.send).toHaveBeenCalledWith('Network.setCookies', {
      cookies: [expect.objectContaining({ name: 'sid', value: 'abc', sameSite: 'Lax' })],
    });
    expect(destPage._session.detach).toHaveBeenCalled();
  });
});
