/// <reference types="jest" />

import * as http from 'http';
import {
  generateFixtureHtml,
  startStaticFixtureServer,
  PAGE_WEIGHTS,
  StaticFixtureServer,
} from './static-server';

function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on('error', reject);
  });
}

describe('static fixture server', () => {
  describe('generateFixtureHtml', () => {
    test('is deterministic — byte-identical for a given weight', () => {
      for (const weight of PAGE_WEIGHTS) {
        expect(generateFixtureHtml(weight)).toBe(generateFixtureHtml(weight));
      }
    });

    test('weights are strictly ordered by size', () => {
      const small = generateFixtureHtml('small').length;
      const medium = generateFixtureHtml('medium').length;
      const large = generateFixtureHtml('large').length;
      expect(small).toBeLessThan(medium);
      expect(medium).toBeLessThan(large);
    });

    test('produces valid-looking HTML documents', () => {
      const html = generateFixtureHtml('small');
      expect(html).toContain('<!doctype html>');
      expect(html).toContain('</html>');
      expect(html).toContain('<article class="item"');
    });
  });

  describe('server lifecycle', () => {
    let server: StaticFixtureServer;

    beforeAll(async () => {
      server = await startStaticFixtureServer();
    });

    afterAll(async () => {
      await server.close();
    });

    test('listens on an ephemeral loopback port', () => {
      expect(server.port).toBeGreaterThan(0);
      expect(server.url('small')).toBe(`http://127.0.0.1:${server.port}/small`);
    });

    test('serves each page weight with matching deterministic body', async () => {
      for (const weight of PAGE_WEIGHTS) {
        const res = await get(server.url(weight));
        expect(res.status).toBe(200);
        expect(res.body).toBe(generateFixtureHtml(weight));
      }
    });

    test('returns identical bytes on repeated requests — no per-request variance', async () => {
      const a = await get(server.url('medium'));
      const b = await get(server.url('medium'));
      expect(a.body).toBe(b.body);
    });

    test('404s unknown routes', async () => {
      const res = await get(`http://127.0.0.1:${server.port}/not-a-fixture`);
      expect(res.status).toBe(404);
    });

    test('close() is idempotent', async () => {
      const temp = await startStaticFixtureServer();
      await temp.close();
      await expect(temp.close()).resolves.toBeUndefined();
    });
  });
});
