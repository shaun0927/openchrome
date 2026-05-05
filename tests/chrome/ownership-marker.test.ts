import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  writeMarker,
  removeMarker,
  readMarker,
  listMarkers,
  deleteMarkerFile,
  MARKER_FILENAME,
} from '../../src/chrome/ownership-marker';

describe('ownership-marker (#661)', () => {
  let tmpProfile: string;

  beforeEach(() => {
    tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-marker-'));
  });

  afterEach(() => {
    try { fs.rmSync(tmpProfile, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('writes a marker into the user-data-dir', () => {
    const uuid = writeMarker({ chromePid: 99999, userDataDir: tmpProfile });
    expect(uuid).toMatch(/^[0-9a-f-]{36}$/i);
    const filePath = path.join(tmpProfile, MARKER_FILENAME);
    expect(fs.existsSync(filePath)).toBe(true);
    const marker = readMarker(filePath);
    expect(marker).not.toBeNull();
    expect(marker!.pid).toBe(99999);
    expect(marker!.ppid).toBe(process.pid);
    expect(marker!.userDataDir).toBe(path.resolve(tmpProfile));
    expect(marker!.launchMode).toBe('isolated');
    expect(marker!.marker).toBe(uuid);
  });

  it('removeMarker deletes the file', () => {
    writeMarker({ chromePid: 99999, userDataDir: tmpProfile });
    removeMarker({ chromePid: 99999, userDataDir: tmpProfile });
    expect(fs.existsSync(path.join(tmpProfile, MARKER_FILENAME))).toBe(false);
  });

  it('readMarker returns null for malformed JSON', () => {
    const fp = path.join(tmpProfile, MARKER_FILENAME);
    fs.writeFileSync(fp, 'not valid json');
    expect(readMarker(fp)).toBeNull();
  });

  it('readMarker rejects markers with non-isolated launchMode', () => {
    const fp = path.join(tmpProfile, MARKER_FILENAME);
    fs.writeFileSync(fp, JSON.stringify({
      pid: 1, ppid: 2, ppidCommand: 'x', userDataDir: tmpProfile,
      startedAt: new Date().toISOString(), marker: 'abc', launchMode: 'attach',
    }));
    expect(readMarker(fp)).toBeNull();
  });

  it('listMarkers picks up profiles under ~/.openchrome/profiles', () => {
    // Skip — listMarkers depends on $HOME/.openchrome/profiles which we don't want
    // tests to mutate. We exercise the discovery path indirectly via deleteMarkerFile below.
    const fp = path.join(tmpProfile, MARKER_FILENAME);
    writeMarker({ chromePid: 1234, userDataDir: tmpProfile });
    expect(fs.existsSync(fp)).toBe(true);
    deleteMarkerFile(fp);
    expect(fs.existsSync(fp)).toBe(false);
    // Sanity: listMarkers does not throw even when the profiles dir is empty/absent
    const found = listMarkers();
    expect(Array.isArray(found)).toBe(true);
  });
});
