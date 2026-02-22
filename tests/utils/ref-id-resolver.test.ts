/// <reference types="jest" />
import { RefIdManager } from '../../src/utils/ref-id-manager';

describe('RefIdManager.resolveToBackendNodeId', () => {
  let manager: RefIdManager;
  const SESSION = 'session-A';
  const TARGET = 'target-1';

  beforeEach(() => {
    manager = new RefIdManager();
    // Populate a few refs: ref_1 → 100, ref_2 → 200, ref_3 → 300
    manager.generateRef(SESSION, TARGET, 100, 'button', 'Submit');
    manager.generateRef(SESSION, TARGET, 200, 'input', 'Name');
    manager.generateRef(SESSION, TARGET, 300, 'link', 'Home');
  });

  // 1. ref_N format - resolves existing refs to correct backendDOMNodeId
  it('resolves ref_1 to backendDOMNodeId 100', () => {
    expect(manager.resolveToBackendNodeId(SESSION, TARGET, 'ref_1')).toBe(100);
  });

  it('resolves ref_2 to backendDOMNodeId 200', () => {
    expect(manager.resolveToBackendNodeId(SESSION, TARGET, 'ref_2')).toBe(200);
  });

  it('resolves ref_3 to backendDOMNodeId 300', () => {
    expect(manager.resolveToBackendNodeId(SESSION, TARGET, 'ref_3')).toBe(300);
  });

  // 2. ref_N not found - returns undefined for non-existent ref
  it('returns undefined for non-existent ref_999', () => {
    expect(manager.resolveToBackendNodeId(SESSION, TARGET, 'ref_999')).toBeUndefined();
  });

  // 3. Raw integer "142" - returns 142 as number
  it('resolves raw integer string "142" to 142', () => {
    expect(manager.resolveToBackendNodeId(SESSION, TARGET, '142')).toBe(142);
  });

  // 4. Raw integer "1" - boundary case
  it('resolves raw integer string "1" to 1', () => {
    expect(manager.resolveToBackendNodeId(SESSION, TARGET, '1')).toBe(1);
  });

  // 5. node_142 format - returns 142
  it('resolves "node_142" to 142', () => {
    expect(manager.resolveToBackendNodeId(SESSION, TARGET, 'node_142')).toBe(142);
  });

  // 6. node_1 format - boundary case
  it('resolves "node_1" to 1', () => {
    expect(manager.resolveToBackendNodeId(SESSION, TARGET, 'node_1')).toBe(1);
  });

  // 7. Invalid inputs - returns undefined
  it('returns undefined for incomplete ref "ref_"', () => {
    expect(manager.resolveToBackendNodeId(SESSION, TARGET, 'ref_')).toBeUndefined();
  });

  it('returns undefined for "0" (zero not valid)', () => {
    expect(manager.resolveToBackendNodeId(SESSION, TARGET, '0')).toBeUndefined();
  });

  it('returns undefined for "-1" (negative)', () => {
    expect(manager.resolveToBackendNodeId(SESSION, TARGET, '-1')).toBeUndefined();
  });

  it('returns undefined for "abc" (non-numeric)', () => {
    expect(manager.resolveToBackendNodeId(SESSION, TARGET, 'abc')).toBeUndefined();
  });

  it('returns undefined for empty string ""', () => {
    expect(manager.resolveToBackendNodeId(SESSION, TARGET, '')).toBeUndefined();
  });

  it('returns undefined for incomplete node prefix "node_"', () => {
    expect(manager.resolveToBackendNodeId(SESSION, TARGET, 'node_')).toBeUndefined();
  });

  it('returns undefined for "node_0" (zero not valid)', () => {
    expect(manager.resolveToBackendNodeId(SESSION, TARGET, 'node_0')).toBeUndefined();
  });

  it('returns undefined for "node_-1" (negative)', () => {
    expect(manager.resolveToBackendNodeId(SESSION, TARGET, 'node_-1')).toBeUndefined();
  });

  // 8. ref_N takes priority: "ref_3" resolves via ref lookup, "3" resolves as raw integer
  it('resolves "ref_3" via ref lookup to 300', () => {
    expect(manager.resolveToBackendNodeId(SESSION, TARGET, 'ref_3')).toBe(300);
  });

  it('resolves raw "3" as integer 3, not via ref_3 lookup', () => {
    // "3" is a raw integer, so it should return 3, not 300 (ref_3's backendDOMNodeId)
    expect(manager.resolveToBackendNodeId(SESSION, TARGET, '3')).toBe(3);
  });

  // 9. Cross-session isolation
  it('isolates refs across sessions', () => {
    const SESSION_B = 'session-B';
    manager.generateRef(SESSION_B, TARGET, 999, 'div', 'Container');
    // ref_1 in session B should be 999, not 100
    expect(manager.resolveToBackendNodeId(SESSION_B, TARGET, 'ref_1')).toBe(999);
    // ref_1 in session A should still be 100
    expect(manager.resolveToBackendNodeId(SESSION, TARGET, 'ref_1')).toBe(100);
  });

  it('returns undefined for ref_1 in session B when session B has no refs', () => {
    const SESSION_C = 'session-C';
    expect(manager.resolveToBackendNodeId(SESSION_C, TARGET, 'ref_1')).toBeUndefined();
  });

  // 10. Strict integer validation: reject floats and oversized values
  it('rejects float "3.5" as raw integer (returns undefined)', () => {
    expect(manager.resolveToBackendNodeId(SESSION, TARGET, '3.5')).toBeUndefined();
  });

  it('rejects oversized integer beyond 32-bit range', () => {
    expect(manager.resolveToBackendNodeId(SESSION, TARGET, '99999999999999999999')).toBeUndefined();
  });

  it('rejects "node_3.5" (float in node_ prefix)', () => {
    expect(manager.resolveToBackendNodeId(SESSION, TARGET, 'node_3.5')).toBeUndefined();
  });

  it('rejects "node_99999999999999999999" (oversized node_ prefix)', () => {
    expect(manager.resolveToBackendNodeId(SESSION, TARGET, 'node_99999999999999999999')).toBeUndefined();
  });

  it('still resolves valid raw integer "42"', () => {
    expect(manager.resolveToBackendNodeId(SESSION, TARGET, '42')).toBe(42);
  });

  it('still resolves valid "node_42"', () => {
    expect(manager.resolveToBackendNodeId(SESSION, TARGET, 'node_42')).toBe(42);
  });
});
