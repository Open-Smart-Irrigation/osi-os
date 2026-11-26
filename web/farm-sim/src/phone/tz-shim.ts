type ClockRealm = Pick<typeof globalThis, 'Date' | 'Intl'>;

const LOCAL_ISO = /^(?:\d{4}|[+-]\d{6})-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?$/;
const GETTERS = {
  getFullYear: 'getUTCFullYear', getMonth: 'getUTCMonth', getDate: 'getUTCDate', getDay: 'getUTCDay',
  getHours: 'getUTCHours', getMinutes: 'getUTCMinutes', getSeconds: 'getUTCSeconds', getMilliseconds: 'getUTCMilliseconds',
} as const;
const SETTERS = {
  setFullYear: 'setUTCFullYear', setMonth: 'setUTCMonth', setDate: 'setUTCDate', setHours: 'setUTCHours',
  setMinutes: 'setUTCMinutes', setSeconds: 'setUTCSeconds', setMilliseconds: 'setUTCMilliseconds',
} as const;

export function installPhoneTimezone(realm: ClockRealm, timeZone: string): (clock: () => number) => void {
  const fixedOffset = /^Etc\/GMT([+-])(\d{1,2})$/.exec(timeZone);
  if (!fixedOffset) throw new RangeError('The farm time zone must use a fixed Etc/GMT offset');
  const NativeFormat = realm.Intl.DateTimeFormat;
  // Also reject offsets that the platform's IANA zone database does not support.
  new NativeFormat('en', {timeZone});
  const hours = Number(fixedOffset[2]);
  const offset = (fixedOffset[1] === '-' ? hours : -hours) * 3_600_000;
  const gmt = `GMT${offset < 0 ? '-' : '+'}${String(hours).padStart(2, '0')}00`;
  const withZone = (options?: Intl.DateTimeFormatOptions): Intl.DateTimeFormatOptions =>
    options?.timeZone === undefined ? {...options, timeZone} : options;

  realm.Intl.DateTimeFormat = new Proxy(NativeFormat, {
    construct(target, [locales, options], newTarget) {
      return Reflect.construct(target, [locales, withZone(options)], newTarget);
    },
    apply(target, receiver, [locales, options]) {
      return Reflect.apply(target, receiver, [locales, withZone(options)]);
    },
  });

  const NativeDate = realm.Date;
  const proto = NativeDate.prototype;
  const nativeParse = NativeDate.parse;
  let now = NativeDate.now;
  const clock = () => now();
  const parse = (input: string) => {
    const value = `${input}`;
    return LOCAL_ISO.test(value) ? nativeParse(value + 'Z') - offset : nativeParse(value);
  };
  const shifted = (date: Date) => new NativeDate(proto.getTime.call(date) + offset);
  const replace = (name: string, value: unknown) => {
    Object.defineProperty(proto, name, {value, writable: true, configurable: true});
  };
  for (const name of ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString'] as const) {
    const native = proto[name];
    replace(name, function (this: Date, locales?: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions) {
      return native.call(this, locales, withZone(options));
    });
  }
  for (const [local, utc] of Object.entries(GETTERS)) {
    replace(local, function (this: Date) { return shifted(this)[utc](); });
  }
  for (const [local, utc] of Object.entries(SETTERS)) {
    replace(local, function (this: Date, ...args: number[]) {
      const date = shifted(this);
      return proto.setTime.call(this, Reflect.apply(proto[utc], date, args) - offset);
    });
  }
  replace('getYear', function (this: Date) { return shifted(this).getUTCFullYear() - 1900; });
  replace('setYear', function (this: Date, year: number) {
    const integer = Math.trunc(+year);
    return proto.setFullYear.call(this, integer >= 0 && integer <= 99 ? 1900 + integer : integer);
  });
  replace('getTimezoneOffset', function (this: Date) {
    return Number.isNaN(proto.getTime.call(this)) ? NaN : -offset / 60_000;
  });

  function display(date: Date, part: 'date' | 'time' | 'both'): string {
    const local = shifted(date);
    if (Number.isNaN(local.getTime())) return 'Invalid Date';
    const [weekday, day, month, year, clock] = local.toUTCString().split(' ');
    const dateText = `${weekday.slice(0, -1)} ${month} ${day} ${year}`;
    const timeText = `${clock} ${gmt}`;
    if (part === 'date') return dateText;
    if (part === 'time') return timeText;
    return `${dateText} ${timeText}`;
  }
  replace('toDateString', function (this: Date) { return display(this, 'date'); });
  replace('toTimeString', function (this: Date) { return display(this, 'time'); });
  replace('toString', function (this: Date) { return display(this, 'both'); });

  realm.Date = new Proxy(NativeDate, {
    construct(target, args, newTarget) {
      if (args.length === 0) return Reflect.construct(target, [now()], newTarget);
      if (args.length > 1) {
        return Reflect.construct(target, [Reflect.apply(NativeDate.UTC, NativeDate, args) - offset], newTarget);
      }
      if (typeof args[0] === 'string') return Reflect.construct(target, [parse(args[0])], newTarget);
      return Reflect.construct(target, args, newTarget);
    },
    apply() { return new NativeDate(now()).toString(); },
    get(target, property, receiver) {
      if (property === 'now') return clock;
      if (property === 'parse') return parse;
      return Reflect.get(target, property, receiver);
    },
  });
  replace('constructor', realm.Date);
  return readTime => { now = readTime; };
}
