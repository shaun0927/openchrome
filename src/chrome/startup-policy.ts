export type ChromeStartupPolicy = 'disabled' | 'lazy' | 'eager';

export function resolveChromeStartupPolicy(options: {
  autoLaunch: boolean;
  eagerStartup: boolean;
}): ChromeStartupPolicy {
  if (!options.autoLaunch) return 'disabled';
  return options.eagerStartup ? 'eager' : 'lazy';
}

export function ownerHeartbeatRequiresChrome(
  policy: ChromeStartupPolicy,
  browserDemandStarted: boolean,
): boolean {
  if (policy === 'eager') return true;
  if (policy === 'lazy') return browserDemandStarted;
  return false;
}
