/**
 * Tests for the list_profiles MCP tool
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ProfileManager } from '../../src/chrome/profile-manager';

describe('list_profiles tool', () => {
  describe('ProfileManager.listProfiles', () => {
    it('should parse Local State and return sorted profile info', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-list-profiles-'));
      const localState = {
        profile: {
          info_cache: {
            'Profile 2': { name: 'Side Project' },
            'Default': { name: 'Personal', user_name: 'user@gmail.com' },
            'Profile 1': { name: 'Work', user_name: 'work@company.com' },
          },
          last_used: 'Profile 1',
        },
      };
      fs.writeFileSync(path.join(tmpDir, 'Local State'), JSON.stringify(localState));

      const pm = new ProfileManager();
      const profiles = pm.listProfiles(tmpDir);

      expect(profiles).toHaveLength(3);
      // Should be sorted by directory name
      expect(profiles[0].directory).toBe('Default');
      expect(profiles[0].name).toBe('Personal');
      expect(profiles[0].userName).toBe('user@gmail.com');
      expect(profiles[0].isActive).toBeUndefined();

      expect(profiles[1].directory).toBe('Profile 1');
      expect(profiles[1].name).toBe('Work');
      expect(profiles[1].isActive).toBe(true);

      expect(profiles[2].directory).toBe('Profile 2');
      expect(profiles[2].name).toBe('Side Project');
      expect(profiles[2].userName).toBeUndefined();

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should return empty array for missing Local State', () => {
      const pm = new ProfileManager();
      expect(pm.listProfiles('/nonexistent/dir')).toEqual([]);
    });

    it('should return empty array for malformed Local State', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-list-profiles-'));
      fs.writeFileSync(path.join(tmpDir, 'Local State'), 'not json');

      const pm = new ProfileManager();
      expect(pm.listProfiles(tmpDir)).toEqual([]);

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should return empty array when info_cache is missing', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-list-profiles-'));
      fs.writeFileSync(path.join(tmpDir, 'Local State'), JSON.stringify({ profile: {} }));

      const pm = new ProfileManager();
      expect(pm.listProfiles(tmpDir)).toEqual([]);

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should handle profiles without name field', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-list-profiles-'));
      fs.writeFileSync(path.join(tmpDir, 'Local State'), JSON.stringify({
        profile: {
          info_cache: {
            'Default': {},
            'Profile 1': { name: 'Named' },
          },
        },
      }));

      const pm = new ProfileManager();
      const profiles = pm.listProfiles(tmpDir);

      expect(profiles[0].name).toBe('Default'); // Falls back to directory name
      expect(profiles[1].name).toBe('Named');

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });
});
