const DEFAULT_MAX_REQUESTS = 1200;

function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export class OutboundDecisionBudget {
  private used = 0;

  constructor(private readonly maxRequests = envPositiveInt('OPENCHROME_DECIDER_MAX_OUTBOUND_PER_SESSION', DEFAULT_MAX_REQUESTS)) {
    if (!Number.isSafeInteger(maxRequests) || maxRequests < 0) throw new RangeError('maxRequests must be a nonnegative integer');
  }

  remaining(): number {
    return Math.max(0, this.maxRequests - this.used);
  }

  totalUsed(): number {
    return this.used;
  }

  tryCharge(count = 1): boolean {
    if (!Number.isSafeInteger(count) || count < 0) throw new RangeError('count must be a nonnegative integer');
    const charge = count;
    if (charge === 0) return true;
    if (this.used + charge > this.maxRequests) return false;
    this.used += charge;
    return true;
  }
}
