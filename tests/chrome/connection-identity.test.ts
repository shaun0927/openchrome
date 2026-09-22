jest.unmock('../../src/chrome/launcher');
import { createServer } from 'http';
import { ChromeLauncher } from '../../src/chrome/launcher';

describe('explicit attach identity', () => {
  it('rejects a replacement endpoint even after invalidation', async () => {
    let identity = 'first';
    const server = createServer((_req, res) => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP address');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${address.port}/devtools/browser/${identity}` }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    const launcher = new ChromeLauncher(address.port);
    try {
      expect(await launcher.getConnectionInfo()).toMatchObject({ status: 'not_connected', authentication: 'unverified' });
      await launcher.ensureChrome({ launchMode: 'attach', autoLaunch: false });
      const first = await launcher.getConnectionInfo();
      expect(first).toMatchObject({ status: 'attached', profileType: 'unverified', authentication: 'unverified', replacementAllowed: false });
      expect(first.browserIdentity).toMatch(/^[a-f0-9]{16}$/);
      launcher.invalidateInstance();
      await launcher.ensureChrome({ launchMode: 'attach', autoLaunch: false });
      identity = 'replacement';
      expect(await launcher.getConnectionInfo()).toMatchObject({ status: 'unavailable' });
      launcher.invalidateInstance();
      await expect(launcher.ensureChrome({ launchMode: 'attach', autoLaunch: false })).rejects.toThrow('CHROME_IDENTITY_CHANGED');
      expect(launcher.getInstance()).toBeNull();
    } finally {
      await launcher.close();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
