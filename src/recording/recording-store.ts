/**
 * Storage management for the Session Recording & Replay subsystem.
 * Handles directory layout, JSONL action files, metadata, and screenshots.
 * Part of #572: Session Recording & Replay.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { RecordingAction, RecordingMetadata, RecordingConfig, DEFAULT_RECORDING_CONFIG } from './types';

/** Default base directory for all recordings */
export const RECORDINGS_DIR = path.join(os.homedir(), '.openchrome', 'recordings');

/** Valid recording ID format: rec-YYYYMMDD-HHMMSS-xxxx (4-6 alphanumeric suffix) */
export const RECORDING_ID_PATTERN = /^rec-\d{8}-\d{6}-[a-z0-9]{4,6}$/;

/** Filename for metadata within a recording directory */
const METADATA_FILE = 'metadata.json';

/** Filename for the actions JSONL log within a recording directory */
const ACTIONS_FILE = 'actions.jsonl';

/**
 * Manages storage of session recordings on disk.
 *
 * Directory layout:
 *   <baseDir>/
 *     rec-YYYYMMDD-HHMMSS-xxxx/
 *       metadata.json
 *       actions.jsonl
 *       screenshot-*.webp  (optional)
 */
export class RecordingStore {
  private readonly baseDir: string;
  private readonly config: RecordingConfig;

  constructor(baseDir?: string, configOverrides?: Partial<RecordingConfig>) {
    this.baseDir = baseDir ?? RECORDINGS_DIR;
    this.config = { ...DEFAULT_RECORDING_CONFIG, ...configOverrides };
  }

  /**
   * Validate that a recording ID matches the expected format (prevents path traversal).
   */
  static validateRecordingId(id: string): void {
    if (!RECORDING_ID_PATTERN.test(id)) {
      throw new Error(`Invalid recording id: ${id}`);
    }
  }

  /**
   * Validate that a filename is a bare name with no path separators.
   */
  private static validateFilename(filename: string): void {
    if (path.basename(filename) !== filename || filename.includes('\0')) {
      throw new Error(`Invalid filename: ${filename}`);
    }
  }

  /**
   * Initialize the recordings base directory.
   * Must be called before using other methods.
   */
  async init(): Promise<void> {
    await fs.promises.mkdir(this.baseDir, { recursive: true });
  }

  /**
   * Get the absolute path to a recording's directory.
   */
  getRecordingDir(id: string): string {
    RecordingStore.validateRecordingId(id);
    return path.join(this.baseDir, id);
  }

  /**
   * Create a new recording directory and write initial metadata.
   */
  async createRecording(metadata: RecordingMetadata): Promise<void> {
    const dir = this.getRecordingDir(metadata.id);
    await fs.promises.mkdir(dir, { recursive: true });
    await this.writeMetadata(metadata);
  }

  /**
   * Append a single action to the recording's JSONL file.
   * Uses async appendFile — JSONL append is atomic at the OS level per line.
   */
  async appendAction(id: string, action: RecordingAction): Promise<void> {
    const filepath = path.join(this.getRecordingDir(id), ACTIONS_FILE);
    await fs.promises.appendFile(filepath, JSON.stringify(action) + '\n');
  }

  /**
   * Write (or overwrite) the metadata JSON file for a recording.
   */
  async writeMetadata(metadata: RecordingMetadata): Promise<void> {
    const filepath = path.join(this.getRecordingDir(metadata.id), METADATA_FILE);
    const tmp = filepath + '.tmp';
    await fs.promises.writeFile(tmp, JSON.stringify(metadata, null, 2));
    await fs.promises.rename(tmp, filepath);
  }

  /**
   * Read metadata for a recording. Returns null if not found.
   */
  async readMetadata(id: string): Promise<RecordingMetadata | null> {
    const filepath = path.join(this.getRecordingDir(id), METADATA_FILE);
    try {
      const content = await fs.promises.readFile(filepath, 'utf-8');
      return JSON.parse(content) as RecordingMetadata;
    } catch {
      return null;
    }
  }

  /**
   * Read all actions from a recording's JSONL file.
   * Skips malformed lines.
   */
  readActions(id: string): RecordingAction[] {
    const filepath = path.join(this.getRecordingDir(id), ACTIONS_FILE);
    try {
      const content = fs.readFileSync(filepath, 'utf-8');
      const actions: RecordingAction[] = [];
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          actions.push(JSON.parse(trimmed) as RecordingAction);
        } catch {
          // Skip malformed lines
        }
      }
      return actions;
    } catch {
      return [];
    }
  }

  /**
   * Save a screenshot buffer to the recording directory.
   */
  async saveScreenshot(id: string, filename: string, buffer: Buffer | Uint8Array): Promise<void> {
    RecordingStore.validateFilename(filename);
    const filepath = path.join(this.getRecordingDir(id), filename);
    await fs.promises.writeFile(filepath, buffer);
  }

  /**
   * Read a screenshot from the recording directory. Returns null if not found.
   */
  async readScreenshot(id: string, filename: string): Promise<Buffer | null> {
    RecordingStore.validateFilename(filename);
    const filepath = path.join(this.getRecordingDir(id), filename);
    try {
      return await fs.promises.readFile(filepath);
    } catch {
      return null;
    }
  }

  /**
   * List all recording IDs, sorted newest first (by directory name).
   */
  async listRecordings(): Promise<string[]> {
    try {
      const entries = await fs.promises.readdir(this.baseDir);
      const recordings = entries
        .filter(name => RECORDING_ID_PATTERN.test(name))
        .sort()
        .reverse();
      return recordings;
    } catch {
      return [];
    }
  }

  /**
   * Delete a recording and all its files.
   */
  async deleteRecording(id: string): Promise<void> {
    const dir = this.getRecordingDir(id);
    await fs.promises.rm(dir, { recursive: true, force: true });
  }

  /**
   * Remove expired recordings (older than retentionDays) and excess recordings
   * (keeping only maxRecordings most recent).
   */
  async cleanup(): Promise<void> {
    try {
      const recordings = await this.listRecordings(); // newest first
      const cutoffMs = Date.now() - this.config.retentionDays * 86400000;

      for (const id of recordings) {
        // Parse date from id: rec-YYYYMMDD-HHMMSS-xxxx
        const dateMs = this.parseDateFromId(id);
        if (dateMs !== null && dateMs < cutoffMs) {
          await this.deleteRecording(id).catch(() => {/* best-effort */});
        }
      }

      // Re-list after expiry deletions, then trim to maxRecordings
      const remaining = await this.listRecordings();
      if (remaining.length > this.config.maxRecordings) {
        const toDelete = remaining.slice(this.config.maxRecordings);
        for (const id of toDelete) {
          await this.deleteRecording(id).catch(() => {/* best-effort */});
        }
      }
    } catch {
      // Best-effort cleanup
    }
  }

  /**
   * Get the total size in bytes of a recording directory.
   * Returns 0 if the directory does not exist.
   */
  async getRecordingSize(id: string): Promise<number> {
    const dir = this.getRecordingDir(id);
    try {
      const files = await fs.promises.readdir(dir);
      let total = 0;
      for (const file of files) {
        try {
          const stat = await fs.promises.stat(path.join(dir, file));
          total += stat.size;
        } catch {
          // Skip unreadable files
        }
      }
      return total;
    } catch {
      return 0;
    }
  }

  /**
   * Parse a Unix ms timestamp from a recording id.
   * Returns null if the id format is unrecognized.
   * id format: rec-YYYYMMDD-HHMMSS-xxxx
   */
  private parseDateFromId(id: string): number | null {
    // rec-20240101-120000-abcd
    const match = id.match(/^rec-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-/);
    if (!match) return null;
    const [, year, month, day, hour, min, sec] = match;
    const d = new Date(`${year}-${month}-${day}T${hour}:${min}:${sec}Z`);
    return isNaN(d.getTime()) ? null : d.getTime();
  }
}

/** Singleton instance */
let instance: RecordingStore | null = null;

/**
 * Get the singleton RecordingStore instance.
 * Reads env vars for configuration overrides:
 *   OPENCHROME_RECORDING_RETENTION_DAYS
 *   OPENCHROME_MAX_RECORDINGS
 */
export function getRecordingStore(): RecordingStore {
  if (!instance) {
    const configOverrides: Partial<RecordingConfig> = {};

    const retentionDays = parseInt(process.env['OPENCHROME_RECORDING_RETENTION_DAYS'] ?? '', 10);
    if (!isNaN(retentionDays) && retentionDays > 0) {
      configOverrides.retentionDays = retentionDays;
    }

    const maxRecordings = parseInt(process.env['OPENCHROME_MAX_RECORDINGS'] ?? '', 10);
    if (!isNaN(maxRecordings) && maxRecordings > 0) {
      configOverrides.maxRecordings = maxRecordings;
    }

    instance = new RecordingStore(undefined, configOverrides);
  }
  return instance;
}
