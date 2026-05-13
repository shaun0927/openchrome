/** Ownership information for a browser target tracked by SessionManager. */
export interface TargetOwnerInfo {
  sessionId: string;
  workerId: string;
}

/**
 * Tracks target ownership independently from SessionManager orchestration.
 *
 * The public methods intentionally mirror the Map operations SessionManager
 * already used so Wave 3 can move ownership storage behind a small internal
 * service without changing caller-visible behavior.
 */
export class TargetOwnershipRegistry {
  private readonly owners = new Map<string, TargetOwnerInfo>();

  get(targetId: string): TargetOwnerInfo | undefined {
    return this.owners.get(targetId);
  }

  set(targetId: string, owner: TargetOwnerInfo): void {
    this.owners.set(targetId, owner);
  }

  delete(targetId: string): boolean {
    return this.owners.delete(targetId);
  }

  has(targetId: string): boolean {
    return this.owners.has(targetId);
  }

  keys(): IterableIterator<string> {
    return this.owners.keys();
  }

  values(): IterableIterator<TargetOwnerInfo> {
    return this.owners.values();
  }
}
