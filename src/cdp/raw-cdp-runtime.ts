/**
 * Runtime binding for raw-CDP mode.
 *
 * Kept separate from `raw-cdp-mode.ts` so the pure policy module never has
 * to import the global config (which imports plenty of other things and
 * would risk cycles inside the CDP transport).
 */
import { getGlobalConfig } from '../config/global';
import { getRawCdpMode, type RawCdpMode } from './raw-cdp-mode';

export function getActiveRawCdpMode(): RawCdpMode {
  const cfg = getGlobalConfig();
  return getRawCdpMode(
    process.env.OPENCHROME_RAW_CDP_LEVEL,
    cfg.stealth?.rawCdpLevel,
  );
}
