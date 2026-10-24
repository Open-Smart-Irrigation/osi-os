// Valve cancel replies (owner decisions D04 and D19/Q01 = (a)). With a ChirpStack transport a
// gateway cancel is a whole-queue flush: the reply names the outcome for the cancelled open and
// lists every other queued item the flush touched (collateral). A handed-off or uncertain
// outcome arrives as an HTTP error (409 or 503) whose body has the same shape.

export type ValveCancelOutcome = 'cancelled' | 'handed_off' | 'already_running' | 'uncertain';

export interface ValveCancelCollateralItem {
  ownerType: string;
  ownerId: string;
  purpose: string | null;
  weekday: number | null;
  fport: number | null;
  /** true: the flush removed it from the queue; false: it had already left; null: unknown. */
  inQueue: boolean | null;
}

export interface ValveCancelResult {
  outcome: ValveCancelOutcome;
  collateral: ValveCancelCollateralItem[];
}

const OUTCOMES: readonly ValveCancelOutcome[] = ['cancelled', 'handed_off', 'already_running', 'uncertain'];

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseCollateral(value: unknown): ValveCancelCollateralItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map((item) => ({
      ownerType: String(item.owner_type ?? ''),
      ownerId: String(item.owner_id ?? ''),
      purpose: typeof item.purpose === 'string' ? item.purpose : null,
      weekday: numberOrNull(item.weekday),
      fport: numberOrNull(item.fport),
      inQueue: typeof item.in_queue === 'boolean' ? item.in_queue : null,
    }));
}

export function parseValveCancelResult(data: unknown): ValveCancelResult | null {
  if (!data || typeof data !== 'object') return null;
  const body = data as Record<string, unknown>;
  const outcome = OUTCOMES.find((value) => value === body.outcome)
    // A gateway from before the outcome contract answers only status: 'cancelled'.
    ?? (body.status === 'cancelled' ? 'cancelled' : undefined);
  if (!outcome) return null;
  return { outcome, collateral: parseCollateral(body.collateral) };
}

export function valveCancelResultFromError(error: unknown): ValveCancelResult | null {
  const data = (error as { response?: { data?: unknown } } | null)?.response?.data;
  if (!data || typeof data !== 'object' || !('outcome' in data)) return null;
  return parseValveCancelResult(data);
}

/** The collateral items the flush actually took out of the device queue. */
export function removedCollateral(result: ValveCancelResult): ValveCancelCollateralItem[] {
  return result.collateral.filter((item) => item.inQueue === true);
}
