/// <reference types="jest" />

jest.mock('../../src/cdp/client', () => ({
  getCDPClient: jest.fn(() => ({
    createBrowserContext: jest.fn(async () => ({ close: jest.fn() })),
  })),
}));

import { DEFAULT_TENANT_IDLE_SWEEP_INTERVAL_MS, TenantManager } from '../../src/tenant/manager';
import { getTenantManager, resetTenantManager } from '../../src/tenant/registry';

describe('tenant registry', () => {
  beforeEach(() => {
    resetTenantManager();
    delete process.env.OPENCHROME_TENANT_IDLE_SWEEP_INTERVAL_MS;
    jest.restoreAllMocks();
  });

  afterEach(() => {
    resetTenantManager();
  });

  test('starts the idle sweep when constructing the singleton manager', () => {
    const startSpy = jest
      .spyOn(TenantManager.prototype, 'startIdleSweep')
      .mockImplementation(() => {});

    const mgr = getTenantManager();

    expect(mgr).toBeInstanceOf(TenantManager);
    expect(startSpy).toHaveBeenCalledWith(DEFAULT_TENANT_IDLE_SWEEP_INTERVAL_MS);
  });

  test('resetTenantManager stops the existing singleton idle sweep', () => {
    const startSpy = jest
      .spyOn(TenantManager.prototype, 'startIdleSweep')
      .mockImplementation(() => {});
    const stopSpy = jest
      .spyOn(TenantManager.prototype, 'stopIdleSweep')
      .mockImplementation(() => {});

    getTenantManager();
    expect(startSpy).toHaveBeenCalledTimes(1);

    resetTenantManager();
    expect(stopSpy).toHaveBeenCalledTimes(1);
  });
});
