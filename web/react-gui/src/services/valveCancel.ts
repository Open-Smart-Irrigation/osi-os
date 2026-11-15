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

/**
 * The run a cancel names (V9): the expectation id of the active run the gateway reports, in
 * either casing, or null when it reports none. normaliseValveActiveActuation stores a missing
 * id as '', which names nothing.
 */
export function activeRunExpectationId(
  actuation: { expectationId?: string | null; expectation_id?: string | null } | null | undefined,
): string | null {
  for (const id of [actuation?.expectationId, actuation?.expectation_id]) {
    if (typeof id === 'string' && id.trim() !== '') return id;
  }
  return null;
}

/**
 * The gateway's own explanation of a refused cancel (409 without an outcome, such as
 * ambiguous_actuation), or null when the reply carries none. Read valveCancelResultFromError
 * first: a handed-off 409 is shown as its outcome.
 */
export function valveCancelRefusalMessage(error: unknown): string | null {
  const response = (error as { response?: { status?: unknown; data?: unknown } } | null)?.response;
  if (response?.status !== 409 || !response.data || typeof response.data !== 'object') return null;
  const message = (response.data as Record<string, unknown>).message;
  return typeof message === 'string' && message.trim() !== '' ? message : null;
}

/** The collateral items the flush actually took out of the device queue. */
export function removedCollateral(result: ValveCancelResult): ValveCancelCollateralItem[] {
  return result.collateral.filter((item) => item.inQueue === true);
}
