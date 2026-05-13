export type OpenChromeRuntimeProfile = 'default' | 'fast';

export interface RuntimeProfileInfo {
  profile: OpenChromeRuntimeProfile;
  source: 'env' | 'default';
  fast: boolean;
  guidance: string[];
}

export function getRuntimeProfile(): RuntimeProfileInfo {
  const raw = (process.env.OPENCHROME_PROFILE || '').trim().toLowerCase();
  const fast = raw === 'fast';
  return {
    profile: fast ? 'fast' : 'default',
    source: raw ? 'env' : 'default',
    fast,
    guidance: fast
      ? [
        'Prefer inspect/query_dom/extract_data over full read_page output.',
        'read_page AX defaults to compact unless compact=false is explicit.',
        'Screenshots remain explicit; safety and recovery warnings are not reduced.',
      ]
      : [],
  };
}

export function isFastProfile(): boolean {
  return getRuntimeProfile().fast;
}
