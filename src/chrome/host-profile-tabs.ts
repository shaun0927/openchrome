/**
 * Tabs OpenChrome opened inside the user's everyday Chrome (a profile session
 * hosted by a browser OpenChrome did not launch). That browser is never killed
 * on exit, so the fast stdin-EOF shutdown closes these tabs explicitly before
 * the process leaves.
 */

const openTabs = new Map<string, () => Promise<void>>();

export function trackHostProfileTab(targetId: string, close: () => Promise<void>): void {
  openTabs.set(targetId, close);
}

export function untrackHostProfileTab(targetId: string): void {
  openTabs.delete(targetId);
}

/** Close every tracked tab, giving up after `timeoutMs`. Returns how many were asked to close. */
export async function closeHostProfileTabs(timeoutMs = 2000): Promise<number> {
  const closers = Array.from(openTabs.values());
  openTabs.clear();
  if (closers.length === 0) return 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled(closers.map((close) => close())),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
  ]);
  if (timer) clearTimeout(timer);
  return closers.length;
}
