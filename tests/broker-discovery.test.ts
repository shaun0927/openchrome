import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildBrokerMetadata,
  getBrokerMetadataPath,
  publishBrokerMetadata,
  readBrokerMetadata,
  removeBrokerMetadata,
  resolveLiveBrokerMetadata,
} from '../src/broker/discovery';

describe('broker discovery metadata', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchrome-broker-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('builds a loopback broker endpoint and normalized profile identity', () => {
    const metadata = buildBrokerMetadata({
      port: 9222,
      userDataDir: './profile',
      httpHost: '0.0.0.0',
      httpPort: 3100,
      pid: 123,
      startedAt: '2026-01-01T00:00:00.000Z',
      version: 'test',
    });

    expect(metadata).toMatchObject({
      schemaVersion: 1,
      pid: 123,
      version: 'test',
      port: 9222,
      endpoint: 'http://127.0.0.1:3100/mcp',
    });
    expect(path.isAbsolute(metadata.userDataDir)).toBe(true);
  });

  test('publishes, reads, and removes broker metadata by port/profile', () => {
    const profile = path.join(tmpDir, 'profile');
    const metadata = publishBrokerMetadata({ port: 9222, userDataDir: profile, httpHost: '127.0.0.1', httpPort: 3101 }, tmpDir);
    const filePath = getBrokerMetadataPath(9222, profile, tmpDir);

    expect(fs.existsSync(filePath)).toBe(true);
    expect(readBrokerMetadata(9222, profile, tmpDir)).toEqual(metadata);

    removeBrokerMetadata(9222, profile, process.pid, tmpDir);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  test('does not remove another broker owner metadata', () => {
    const profile = path.join(tmpDir, 'profile');
    publishBrokerMetadata({ port: 9222, userDataDir: profile, httpHost: '127.0.0.1', httpPort: 3101, pid: 999999 }, tmpDir);

    removeBrokerMetadata(9222, profile, process.pid, tmpDir);

    expect(readBrokerMetadata(9222, profile, tmpDir)?.pid).toBe(999999);
  });

  test('live resolver removes metadata for a dead owner pid', async () => {
    const profile = path.join(tmpDir, 'profile');
    publishBrokerMetadata({ port: 9222, userDataDir: profile, httpHost: '127.0.0.1', httpPort: 3101, pid: 999999 }, tmpDir);

    const resolved = await resolveLiveBrokerMetadata(9222, profile, {
      rootDir: tmpDir,
      isPidAliveImpl: () => false,
      fetchImpl: jest.fn() as unknown as typeof fetch,
    });

    expect(resolved).toBeNull();
    expect(readBrokerMetadata(9222, profile, tmpDir)).toBeNull();
  });

  test('live resolver preserves live-pid metadata when the endpoint has a transient failure', async () => {
    const profile = path.join(tmpDir, 'profile');
    const metadata = publishBrokerMetadata({ port: 9222, userDataDir: profile, httpHost: '127.0.0.1', httpPort: 3101, pid: 123 }, tmpDir);

    const resolved = await resolveLiveBrokerMetadata(9222, profile, {
      rootDir: tmpDir,
      isPidAliveImpl: () => true,
      fetchImpl: jest.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch,
    });

    expect(resolved).toBeNull();
    expect(readBrokerMetadata(9222, profile, tmpDir)).toEqual(metadata);
  });

  test('live resolver removes metadata when the endpoint is a non-broker HTTP service', async () => {
    const profile = path.join(tmpDir, 'profile');
    publishBrokerMetadata({ port: 9222, userDataDir: profile, httpHost: '127.0.0.1', httpPort: 3101, pid: 123 }, tmpDir);

    const resolved = await resolveLiveBrokerMetadata(9222, profile, {
      rootDir: tmpDir,
      isPidAliveImpl: () => true,
      fetchImpl: jest.fn(async () => ({
        status: 404,
        json: async () => ({ error: 'not found' }),
      } as Response)) as unknown as typeof fetch,
    });

    expect(resolved).toBeNull();
    expect(readBrokerMetadata(9222, profile, tmpDir)).toBeNull();
  });

  test('live resolver requires OpenChrome health response and preserves auth token env hints', async () => {
    const profile = path.join(tmpDir, 'profile');
    const metadata = publishBrokerMetadata({
      port: 9222,
      userDataDir: profile,
      httpHost: '127.0.0.1',
      httpPort: 3101,
      pid: 123,
      authTokenEnv: 'OPENCHROME_AUTH_TOKEN',
    }, tmpDir);

    const resolved = await resolveLiveBrokerMetadata(9222, profile, {
      rootDir: tmpDir,
      isPidAliveImpl: () => true,
      fetchImpl: jest.fn(async () => ({
        status: 200,
        json: async () => ({ status: 'ok', transport: 'http' }),
      } as Response)) as unknown as typeof fetch,
    });

    expect(resolved).toEqual(metadata);
    expect(resolved?.authTokenEnv).toBe('OPENCHROME_AUTH_TOKEN');
  });
});
