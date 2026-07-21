import { describe, expect, it } from '@jest/globals';
import { createExtractionBackend } from '../../src/extraction/pdf-backend.js';

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe('createExtractionBackend', () => {
  it('reads plain text', async () => {
    const backend = createExtractionBackend();
    const result = await backend.extract({
      bytes: bytes('hello world'),
      contentType: 'text/plain',
    });
    expect(result.status).toBe('ok');
    expect(result.backend).toBe('text');
    expect(result.markdown).toBe('hello world');
  });

  it('strips HTML to text', async () => {
    const backend = createExtractionBackend();
    const result = await backend.extract({
      bytes: bytes('<p>hi <b>there</b> &amp; friends</p>'),
      contentType: 'text/html',
    });
    expect(result.status).toBe('ok');
    expect(result.markdown).toBe('hi there & friends');
  });

  it('turns CSV into a Markdown table', async () => {
    const backend = createExtractionBackend();
    const result = await backend.extract({
      bytes: bytes('name,amount\nAlice,10\n"Bob, Jr.",25'),
      contentType: 'text/csv',
    });
    expect(result.status).toBe('ok');
    const md = result.markdown!;
    expect(md).toContain('| name | amount |');
    expect(md).toContain('| Bob, Jr. | 25 |');
  });

  it('pretty-prints JSON', async () => {
    const backend = createExtractionBackend();
    const result = await backend.extract({
      bytes: bytes('{"a":1,"b":[2,3]}'),
      contentType: 'application/json',
    });
    expect(result.status).toBe('ok');
    expect(result.markdown).toContain('```json');
    expect(result.markdown).toContain('"a": 1');
  });

  it('returns unsupported when PDF has no backend', async () => {
    const backend = createExtractionBackend();
    const result = await backend.extract({
      bytes: bytes('%PDF-1.4'),
      contentType: 'application/pdf',
    });
    expect(result.status).toBe('unsupported');
  });

  it('supports() reports the backend id', () => {
    const backend = createExtractionBackend({ markitdownPath: '/opt/markitdown' });
    expect(backend.supports('application/pdf')).toBe('pdf-markitdown');
    expect(backend.supports('text/html')).toBe('html');
    expect(backend.supports('application/x-tar')).toBe(null);
  });
});
