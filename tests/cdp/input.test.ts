/// <reference types="jest" />
/**
 * Unit tests for src/cdp/input.ts — dispatchCoordinateClick
 *
 * Pure CDP-mock test: verifies exactly two Input.dispatchMouseEvent calls
 * with correct type/x/y/button/modifiers bitfield.
 */

import { dispatchCoordinateClick } from '../../src/cdp/input';

describe('dispatchCoordinateClick', () => {
  let mockPage: any;
  let mockCDPClient: any;
  let sendCalls: Array<{ method: string; params: Record<string, unknown> }>;

  beforeEach(() => {
    sendCalls = [];
    mockPage = {};
    mockCDPClient = {
      send: jest.fn().mockImplementation((_page: any, method: string, params: Record<string, unknown>) => {
        sendCalls.push({ method, params });
        return Promise.resolve({});
      }),
    };
  });

  test('sends exactly two Input.dispatchMouseEvent calls', async () => {
    await dispatchCoordinateClick(mockCDPClient, mockPage, { x: 100, y: 200 });

    expect(mockCDPClient.send).toHaveBeenCalledTimes(2);
    expect(sendCalls[0].method).toBe('Input.dispatchMouseEvent');
    expect(sendCalls[1].method).toBe('Input.dispatchMouseEvent');
  });

  test('first call is mousePressed, second is mouseReleased', async () => {
    await dispatchCoordinateClick(mockCDPClient, mockPage, { x: 50, y: 75 });

    expect(sendCalls[0].params.type).toBe('mousePressed');
    expect(sendCalls[1].params.type).toBe('mouseReleased');
  });

  test('passes correct x and y to both events', async () => {
    await dispatchCoordinateClick(mockCDPClient, mockPage, { x: 123, y: 456 });

    expect(sendCalls[0].params.x).toBe(123);
    expect(sendCalls[0].params.y).toBe(456);
    expect(sendCalls[1].params.x).toBe(123);
    expect(sendCalls[1].params.y).toBe(456);
  });

  test('uses left button and clickCount 1 by default', async () => {
    await dispatchCoordinateClick(mockCDPClient, mockPage, { x: 10, y: 20 });

    expect(sendCalls[0].params.button).toBe('left');
    expect(sendCalls[0].params.clickCount).toBe(1);
    expect(sendCalls[1].params.button).toBe('left');
    expect(sendCalls[1].params.clickCount).toBe(1);
  });

  test('passes right button when specified', async () => {
    await dispatchCoordinateClick(mockCDPClient, mockPage, { x: 10, y: 20, button: 'right' });

    expect(sendCalls[0].params.button).toBe('right');
    expect(sendCalls[1].params.button).toBe('right');
  });

  test('passes middle button when specified', async () => {
    await dispatchCoordinateClick(mockCDPClient, mockPage, { x: 10, y: 20, button: 'middle' });

    expect(sendCalls[0].params.button).toBe('middle');
    expect(sendCalls[1].params.button).toBe('middle');
  });

  test('passes clickCount to both events', async () => {
    await dispatchCoordinateClick(mockCDPClient, mockPage, { x: 10, y: 20, clickCount: 2 });

    expect(sendCalls[0].params.clickCount).toBe(2);
    expect(sendCalls[1].params.clickCount).toBe(2);
  });

  test('modifiers bitfield: no modifiers → 0', async () => {
    await dispatchCoordinateClick(mockCDPClient, mockPage, { x: 10, y: 20, modifiers: [] });

    expect(sendCalls[0].params.modifiers).toBe(0);
    expect(sendCalls[1].params.modifiers).toBe(0);
  });

  test('modifiers bitfield: alt=1', async () => {
    await dispatchCoordinateClick(mockCDPClient, mockPage, { x: 10, y: 20, modifiers: ['alt'] });

    expect(sendCalls[0].params.modifiers).toBe(1);
    expect(sendCalls[1].params.modifiers).toBe(1);
  });

  test('modifiers bitfield: ctrl=2', async () => {
    await dispatchCoordinateClick(mockCDPClient, mockPage, { x: 10, y: 20, modifiers: ['ctrl'] });

    expect(sendCalls[0].params.modifiers).toBe(2);
    expect(sendCalls[1].params.modifiers).toBe(2);
  });

  test('modifiers bitfield: meta=4', async () => {
    await dispatchCoordinateClick(mockCDPClient, mockPage, { x: 10, y: 20, modifiers: ['meta'] });

    expect(sendCalls[0].params.modifiers).toBe(4);
    expect(sendCalls[1].params.modifiers).toBe(4);
  });

  test('modifiers bitfield: shift=8', async () => {
    await dispatchCoordinateClick(mockCDPClient, mockPage, { x: 10, y: 20, modifiers: ['shift'] });

    expect(sendCalls[0].params.modifiers).toBe(8);
    expect(sendCalls[1].params.modifiers).toBe(8);
  });

  test('modifiers bitfield: ctrl+shift=10', async () => {
    await dispatchCoordinateClick(mockCDPClient, mockPage, { x: 10, y: 20, modifiers: ['ctrl', 'shift'] });

    expect(sendCalls[0].params.modifiers).toBe(10);
    expect(sendCalls[1].params.modifiers).toBe(10);
  });

  test('modifiers bitfield: all four=15', async () => {
    await dispatchCoordinateClick(mockCDPClient, mockPage, {
      x: 10, y: 20,
      modifiers: ['alt', 'ctrl', 'meta', 'shift'],
    });

    expect(sendCalls[0].params.modifiers).toBe(15);
    expect(sendCalls[1].params.modifiers).toBe(15);
  });

  test('passes page reference to cdpClient.send', async () => {
    await dispatchCoordinateClick(mockCDPClient, mockPage, { x: 10, y: 20 });

    expect(mockCDPClient.send.mock.calls[0][0]).toBe(mockPage);
    expect(mockCDPClient.send.mock.calls[1][0]).toBe(mockPage);
  });

  test('default modifiers=0 when not specified', async () => {
    await dispatchCoordinateClick(mockCDPClient, mockPage, { x: 10, y: 20 });

    expect(sendCalls[0].params.modifiers).toBe(0);
  });
});
