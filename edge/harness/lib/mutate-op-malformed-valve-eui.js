'use strict';
// A stored device key that is not 16 upper-case hex digits. Every Node-RED
// valve radio writer passes the key through dispatch.js normalizeDevice
// (trim, upper-case, /^[0-9A-F]{16}$/) and refuses before its first write;
// the daily scheduler and the encoder upper-case it, and the reservation
// matches UPPER(deveui). Variants: a non-hex first digit, the last digit
// dropped (15 hex), and the key in lower case (a backend that matches the key
// exactly then does less, which the pass logs). The variant carries the key:
// every literal in the step that equals it, later sql steps and later http
// path segments take the same rewrite, so the rows that name the device stay
// joined (lib/mutate-sites.js carriedKey).
const columns = new Set(['devices.deveui', 'valve_schedules.device_eui', 'valve_settings.device_eui',
  'valve_schedule_pushes.device_eui', 'valve_once_dispatch_intents.device_eui']);

module.exports = {
  name: 'malformed-valve-eui',
  columns,
  value: (v, site) => {
    if (site.container !== 'sql' || !columns.has(String(site.column).toLowerCase())
      || typeof v !== 'string' || !/^[0-9A-F]{16}$/i.test(v)) return [];
    const out = [{ label: 'nonhex', value: 'X' + v.slice(1), carry: 'key' },
      { label: 'short', value: v.slice(0, -1), carry: 'key' }];
    if (v.toLowerCase() !== v) out.push({ label: 'lower', value: v.toLowerCase(), carry: 'key' });
    return out;
  },
};
