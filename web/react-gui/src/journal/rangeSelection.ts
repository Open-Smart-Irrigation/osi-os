export type RangeParseResult =
  | { ok: true; values: number[] }
  | {
      ok: false;
      code: 'empty' | 'malformed' | 'duplicate' | 'out_of_station'
        | 'reversed' | 'non_integer' | 'non_positive';
      token: string;
    };

export type RangeParseFailure = Extract<RangeParseResult, { ok: false }>;

const MAX_RANGE_INPUT_LENGTH = 1024;
const INTEGER_TOKEN = /^-?\d+$/;
const RANGE_TOKEN = /^(\d+)-(\d+)$/;
const NON_INTEGER_TOKEN = /^[+-]?(?:(?:\d+(?:\.\d*)?|\.\d+)[eE][+-]?\d+|\d+\.\d*|\.\d+)$/;

function failure(
  code: RangeParseFailure['code'],
  token: string,
): RangeParseFailure {
  return { ok: false, code, token };
}

export function parseStationRange(
  input: string,
  availableNumbers: ReadonlySet<number>,
): RangeParseResult {
  if (input.length > MAX_RANGE_INPUT_LENGTH) return failure('malformed', input);
  if (input.trim() === '') return failure('empty', '');

  const values = new Set<number>();
  for (const rawToken of input.split(',')) {
    const token = rawToken.trim();
    if (token === '') return failure('empty', '');

    const normalized = token.replace(/\s*-\s*/, '-');
    const rangeMatch = RANGE_TOKEN.exec(normalized);
    let expanded: number[];

    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
        return failure('non_integer', token);
      }
      if (start <= 0 || end <= 0) return failure('non_positive', token);
      if (start > end) return failure('reversed', token);
      const rangeSize = end - start + 1;
      const lastValueToCheck = Math.min(end, start + availableNumbers.size);
      expanded = [];
      for (let value = start; value <= lastValueToCheck; value += 1) {
        if (!availableNumbers.has(value)) return failure('out_of_station', token);
        if (values.has(value)) return failure('duplicate', token);
        expanded.push(value);
      }
      if (rangeSize > availableNumbers.size) return failure('out_of_station', token);
    } else if (INTEGER_TOKEN.test(normalized)) {
      const value = Number(normalized);
      if (!Number.isSafeInteger(value)) return failure('non_integer', token);
      if (value <= 0) return failure('non_positive', token);
      expanded = [value];
    } else if (NON_INTEGER_TOKEN.test(normalized)) {
      return failure('non_integer', token);
    } else {
      return failure('malformed', token);
    }

    for (const value of expanded) {
      if (!availableNumbers.has(value)) return failure('out_of_station', token);
      if (values.has(value)) return failure('duplicate', token);
      values.add(value);
    }
  }

  return { ok: true, values: [...values].sort((left, right) => left - right) };
}

export function formatStationRange(values: readonly number[]): string {
  const sorted = [...new Set(values)].sort((left, right) => left - right);
  const runs: string[] = [];

  for (let index = 0; index < sorted.length; index += 1) {
    const start = sorted[index];
    let end = start;
    while (index + 1 < sorted.length && sorted[index + 1] === end + 1) {
      index += 1;
      end = sorted[index];
    }
    runs.push(start === end ? String(start) : `${start}-${end}`);
  }

  return runs.join(', ');
}
