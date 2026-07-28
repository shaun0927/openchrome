/// <reference types="jest" />

jest.mock('child_process', () => ({ execSync: jest.fn() }));
jest.mock('os', () => ({ platform: jest.fn() }));

import { execSync } from 'child_process';
import * as os from 'os';
import { ChromeController } from './chrome-controller';

const mockExecSync = execSync as jest.MockedFunction<typeof execSync>;
const mockPlatform = os.platform as jest.MockedFunction<typeof os.platform>;

describe('ChromeController PID discovery', () => {
  beforeEach(() => {
    mockExecSync.mockReset();
    mockPlatform.mockReset();
  });

  test.each(['darwin', 'linux'] as const)(
    'selects only the TCP listener on %s',
    async (platform) => {
      mockPlatform.mockReturnValue(platform);
      mockExecSync.mockReturnValue('3043\n' as never);

      const controller = new ChromeController();
      await expect(controller.discoverPid(9222)).resolves.toBe(3043);
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining('-sTCP:LISTEN'),
        { encoding: 'utf-8' },
      );
    },
  );

  test('parses the listening PID on Windows', async () => {
    mockPlatform.mockReturnValue('win32');
    mockExecSync.mockReturnValue('TCP 127.0.0.1:9222 0.0.0.0:0 LISTENING 4120' as never);

    const controller = new ChromeController();
    await expect(controller.discoverPid(9222)).resolves.toBe(4120);
  });

  test('rejects when no listener owns the debug port', async () => {
    mockPlatform.mockReturnValue('linux');
    mockExecSync.mockReturnValue('' as never);

    const controller = new ChromeController();
    await expect(controller.discoverPid(9222)).rejects.toThrow('No process found on port 9222');
  });
});
