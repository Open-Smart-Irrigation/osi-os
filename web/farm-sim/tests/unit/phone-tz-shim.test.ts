import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runInNewContext} from 'node:vm';
import {installPhoneTimezone} from '../../src/phone/tz-shim';

const zone = 'Etc/GMT-3';
const makeRealm = () => runInNewContext('({Date, Intl})') as Pick<typeof globalThis, 'Date' | 'Intl'>;

test('phone time follows the bridge across farm midnight without changing the host', () => {
  const phone = makeRealm();
  const hostFormat = Intl.DateTimeFormat;
  let now = Date.UTC(2027, 0, 10, 20, 59);
  installPhoneTimezone(phone, zone)(() => now);
  assert.equal(phone.Date.now(), now);
  assert.equal(new phone.Date().getDate(), 10);
  now += 60_000;
  const date = new phone.Date();
  assert.deepEqual([date.getFullYear(), date.getMonth(), date.getDate(), date.getDay(), date.getHours()], [2027, 0, 11, 1, 0]);
  assert.deepEqual([date.getUTCDate(), date.getUTCHours(), date.getTimezoneOffset()], [10, 21, -180]);
  assert.equal(phone.Date(), 'Mon Jan 11 2027 00:00:00 GMT+0300');
  assert.equal(date.toDateString(), 'Mon Jan 11 2027');
  assert.equal(date.toTimeString(), '00:00:00 GMT+0300');
  assert.equal(Intl.DateTimeFormat, hostFormat);
  assert.equal(new Date(now).toISOString(), '2027-01-10T21:00:00.000Z');
});

test('Intl and Date locale defaults use the farm time zone and respect an explicit zone', () => {
  const phone = makeRealm();
  installPhoneTimezone(phone, zone);
  const date = new phone.Date('2027-01-10T21:30:00Z');
  const options = {hour: '2-digit', minute: '2-digit', hourCycle: 'h23'} as const;
  assert.equal(phone.Intl.DateTimeFormat().resolvedOptions().timeZone, zone);
  const formatter = new phone.Intl.DateTimeFormat('en-GB', options);
  assert.ok(formatter instanceof phone.Intl.DateTimeFormat);
  assert.equal(formatter.format(date), '00:30');
  assert.equal(date.toLocaleTimeString('en-GB', options), '00:30');
  assert.equal(date.toLocaleDateString('en-GB'), '11/01/2027');
  assert.equal(date.toLocaleDateString('en-GB', {timeZone: 'UTC'}), '10/01/2027');
  assert.equal(date.toLocaleString('en-GB', {...options, timeZone: 'UTC'}), '21:30');
});

test('offset-less constructors, parsing, and setters use the same fixed calendar', () => {
  const phone = makeRealm();
  installPhoneTimezone(phone, zone);
  const {Date: PhoneDate} = phone;
  const local = '2027-01-11T00:30:12.345';
  const stamp = Date.UTC(2027, 0, 10, 21, 30, 12, 345);
  assert.equal(new PhoneDate(2027, 0, 11, 0, 30, 12, 345).getTime(), stamp);
  assert.equal(new PhoneDate(local).getTime(), stamp);
  assert.equal(PhoneDate.parse(local), stamp);
  assert.equal(PhoneDate.parse(local + '+03:00'), stamp);
  assert.equal(PhoneDate.parse('2027-01-11'), Date.UTC(2027, 0, 11));
  assert.equal(PhoneDate.UTC(2027, 0, 11), Date.UTC(2027, 0, 11));
  const date = new PhoneDate(local);
  date.setDate(date.getDate() + 1);
  date.setHours(1, 2, 3, 4);
  assert.equal(date.toISOString(), '2027-01-11T22:02:03.004Z');
  assert.equal(date.getMinutes(), 2);
  assert.equal(date.getSeconds(), 3);
  assert.equal(date.getMilliseconds(), 4);
  date.setMonth(1);
  date.setFullYear(2028);
  date.setMinutes(60);
  assert.equal(date.toISOString(), '2028-02-11T23:00:03.004Z');
  assert.ok(Number.isNaN(new PhoneDate(NaN).getTimezoneOffset()));
  assert.equal(new PhoneDate(NaN).toString(), 'Invalid Date');
});

test('the shim rejects daylight-saving zones and unsupported offsets', () => {
  assert.throws(() => installPhoneTimezone(makeRealm(), 'UTC'), /fixed Etc\/GMT offset/);
  assert.throws(() => installPhoneTimezone(makeRealm(), 'Etc/GMT-99'), {name: 'RangeError'});
});
