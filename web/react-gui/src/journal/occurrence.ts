const LOCAL_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;

export type OccurrenceResolutionErrorCode =
  | 'invalid_local_time'
  | 'invalid_timezone'
  | 'invalid_utc_offset'
  | 'nonexistent_local_time'
  | 'ambiguous_local_time';

export class OccurrenceResolutionError extends Error {
  readonly code: OccurrenceResolutionErrorCode;
  readonly availableOffsets: number[];
  readonly cause?: unknown;

  constructor(
    code: OccurrenceResolutionErrorCode,
    message: string,
    availableOffsets: number[] = [],
    cause?: unknown,
  ) {
    super(message);
    this.name = 'OccurrenceResolutionError';
    this.code = code;
    this.availableOffsets = availableOffsets;
    this.cause = cause;
  }
}

export interface ResolvedOccurrence {
  instant: string;
  offsetMinutes: number;
  localDate: string;
}

interface LocalTimestampParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
  naiveEpoch: number;
  localDate: string;
}

interface OccurrenceMatch {
  epoch: number;
  offsetMinutes: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function resolutionError(
  code: OccurrenceResolutionErrorCode,
  message: string,
  availableOffsets: number[] = [],
  cause?: unknown,
): OccurrenceResolutionError {
  return new OccurrenceResolutionError(
    code,
    message,
    availableOffsets,
    cause,
  );
}

function parseLocalTimestamp(raw: string): LocalTimestampParts {
  const match = typeof raw === 'string' ? LOCAL_TIMESTAMP.exec(raw) : null;
  if (!match) {
    throw resolutionError('invalid_local_time', 'Local time must use YYYY-MM-DDTHH:mm');
  }

  const fields = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] || 0),
    millisecond: Number((match[7] || '').padEnd(3, '0')),
  };
  const probe = new Date(0);
  probe.setUTCFullYear(fields.year, fields.month - 1, fields.day);
  probe.setUTCHours(fields.hour, fields.minute, fields.second, fields.millisecond);
  if (
    probe.getUTCFullYear() !== fields.year
    || probe.getUTCMonth() !== fields.month - 1
    || probe.getUTCDate() !== fields.day
    || probe.getUTCHours() !== fields.hour
    || probe.getUTCMinutes() !== fields.minute
    || probe.getUTCSeconds() !== fields.second
  ) {
    throw resolutionError('invalid_local_time', 'Local time contains an invalid calendar value');
  }

  return {
    ...fields,
    naiveEpoch: probe.getTime(),
    localDate: `${match[1]}-${match[2]}-${match[3]}`,
  };
}

function timezoneFormatter(timezone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timezone);
  if (cached) return cached;

  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      calendar: 'iso8601',
      numberingSystem: 'latn',
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timezone, formatter);
    return formatter;
  } catch (cause) {
    throw resolutionError('invalid_timezone', 'Timezone is not supported', [], cause);
  }
}

function wallClockAt(formatter: Intl.DateTimeFormat, epoch: number) {
  const fields: Record<string, number> = {};
  for (const part of formatter.formatToParts(new Date(epoch))) {
    if (part.type !== 'literal') fields[part.type] = Number(part.value);
  }
  return {
    year: fields.year,
    month: fields.month,
    day: fields.day,
    hour: fields.hour,
    minute: fields.minute,
    second: fields.second,
  };
}

function timezoneOffsetAt(formatter: Intl.DateTimeFormat, epoch: number): number {
  const secondEpoch = Math.floor(epoch / 1000) * 1000;
  const wall = wallClockAt(formatter, secondEpoch);
  const wallEpoch = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
  );
  return Math.round((wallEpoch - secondEpoch) / 60_000);
}

function sameWallClock(
  expected: LocalTimestampParts,
  actual: ReturnType<typeof wallClockAt>,
  epoch: number,
): boolean {
  return expected.year === actual.year
    && expected.month === actual.month
    && expected.day === actual.day
    && expected.hour === actual.hour
    && expected.minute === actual.minute
    && expected.second === actual.second
    && new Date(epoch).getUTCMilliseconds() === expected.millisecond;
}

function occurrenceMatches(
  local: LocalTimestampParts,
  formatter: Intl.DateTimeFormat,
): OccurrenceMatch[] {
  const offsets = new Set<number>();
  for (const deltaHours of [-36, 0, 36]) {
    offsets.add(timezoneOffsetAt(formatter, local.naiveEpoch + deltaHours * 60 * 60 * 1000));
  }

  const matches: OccurrenceMatch[] = [];
  for (const offsetMinutes of offsets) {
    const epoch = local.naiveEpoch - offsetMinutes * 60 * 1000;
    if (sameWallClock(local, wallClockAt(formatter, epoch), epoch)) {
      matches.push({ epoch, offsetMinutes });
    }
  }
  return matches;
}

export function resolveOccurrence(
  localTime: string,
  timezone: string,
  preferredOffsetMinutes?: number | null,
): ResolvedOccurrence {
  const local = parseLocalTimestamp(localTime);
  const formatter = timezoneFormatter(timezone);
  const hasPreferredOffset = preferredOffsetMinutes != null;
  if (hasPreferredOffset && !Number.isInteger(preferredOffsetMinutes)) {
    throw resolutionError('invalid_utc_offset', 'UTC offset must be an integer number of minutes');
  }

  const matches = occurrenceMatches(local, formatter);
  const availableOffsets = matches.map((match) => match.offsetMinutes);
  if (matches.length === 0) {
    throw resolutionError(
      'nonexistent_local_time',
      'Local time does not exist in this timezone',
    );
  }

  const selected = hasPreferredOffset
    ? matches.find((match) => match.offsetMinutes === preferredOffsetMinutes)
    : undefined;
  if (hasPreferredOffset && !selected) {
    throw resolutionError(
      'invalid_utc_offset',
      'UTC offset does not match this local time and timezone',
      availableOffsets,
    );
  }
  if (!hasPreferredOffset && matches.length > 1) {
    throw resolutionError(
      'ambiguous_local_time',
      'Local time is ambiguous in this timezone',
      availableOffsets,
    );
  }

  const match = selected ?? matches[0];
  return {
    instant: new Date(match.epoch).toISOString(),
    offsetMinutes: match.offsetMinutes,
    localDate: local.localDate,
  };
}
