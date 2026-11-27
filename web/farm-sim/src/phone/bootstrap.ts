import {FARM_SITE} from '../core/time';
import type {FarmPhonePort} from '../phone-host';
import {installPhoneTimezone} from './tz-shim';

const TIMEZONE_KEY = 'osi.defaults.timezone';
const SESSION_TOKEN = 'public-demo-session';
const SESSION_USER = 'Demo farmer';

class MemoryStorage implements Storage {
  constructor(private readonly values: Map<string, string>, private readonly pinTimezone = false) {}

  get length() { return this.values.size; }
  clear() {
    this.values.clear();
    if (this.pinTimezone) this.setItem(TIMEZONE_KEY, FARM_SITE.timezone);
  }
  getItem(key: string) { return this.values.get(String(key)) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) {
    if (this.pinTimezone && String(key) === TIMEZONE_KEY) return;
    this.values.delete(String(key));
  }
  setItem(key: string, value: string) {
    this.values.set(String(key), this.pinTimezone && String(key) === TIMEZONE_KEY ? FARM_SITE.timezone : String(value));
  }
}

function parentPort(): FarmPhonePort | undefined {
  if (parent === window) return undefined;
  try {
    if (parent.location.origin === location.origin) return parent.farmSimPhone;
  } catch {
    // A cross-origin embedder cannot supply the phone bridge.
  }
  return undefined;
}

const bridge = parentPort();
const root = document.getElementById('root')!;
if (bridge) {
  const local = new MemoryStorage(bridge.storage.local, true);
  Object.defineProperty(window, 'localStorage', {value: local});
  Object.defineProperty(window, 'sessionStorage', {value: new MemoryStorage(bridge.storage.session)});
  for (const [key, value] of [
    ['auth_token', SESSION_TOKEN], ['username', SESSION_USER], ['osi.display.theme', 'light'],
  ]) {
    if (local.getItem(key) === null) local.setItem(key, value);
  }
  local.setItem(TIMEZONE_KEY, FARM_SITE.timezone);
  const setClock = installPhoneTimezone(window, FARM_SITE.timezone);
  void import('./runtime').then(({startPhone}) => startPhone({bridge, setClock, token: SESSION_TOKEN, user: SESSION_USER}))
    .catch(error => {
      root.textContent = 'OSI OS could not start.';
      console.error(error);
    });
} else {
  root.textContent = 'Open the phone from OSI Farm Sim.';
}
