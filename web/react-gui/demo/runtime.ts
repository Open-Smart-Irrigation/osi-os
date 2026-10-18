import axios, {AxiosError} from 'axios';
import {requestDemoRevalidation} from './revalidation';
import {Simulator, DemoError} from './model';
import {CHANNEL, isHostCommand} from './protocol';
import i18n from './i18n';

// This entry is emitted only by vite.demo.config.ts. No production switch enables it.
if (!['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) throw new Error('Demo requires localhost');
const sim = new Simulator();
class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() {return this.values.size;}
  clear() {this.values.clear();}
  getItem(key: string) {return this.values.get(String(key)) ?? null;}
  key(index: number) {return [...this.values.keys()][index] ?? null;}
  removeItem(key: string) {this.values.delete(String(key));}
  setItem(key: string, value: string) {this.values.set(String(key), String(value));}
}
Object.defineProperty(window, 'localStorage', {value: new MemoryStorage()});
Object.defineProperty(window, 'sessionStorage', {value: new MemoryStorage()});
localStorage.setItem('auth_token', 'inert-demo-session-not-a-jwt');
localStorage.setItem('username', 'MUARIK · Demo');
localStorage.setItem('osi.display.theme', 'light');
localStorage.setItem('osi.modules.environment', 'false');
localStorage.setItem('osi.defaults.timezone', 'Africa/Kampala');

const NativeDate = Date;
window.Date = new Proxy(NativeDate, {
  construct(target, args) { return Reflect.construct(target, args.length ? args : [sim.now]); },
  apply() { return new NativeDate(sim.now).toString(); },
  get(target, prop) { return prop === 'now' ? () => Math.floor(sim.now) : Reflect.get(target, prop); },
});
const strings = {
  en: {unsupported: 'This action is not simulated. No command was sent.', protected: 'The two starting zones are protected. Create a temporary zone to demonstrate removal.',
    invalid: 'Check the entered values.', blocked: 'Network access is disabled in this demo.', missing: 'This demo record no longer exists.',
    assigned: 'This device is already assigned to another zone.', duplicate: 'This demo device already exists.', busy: 'Cancel the active opening first.',
    demo_device: 'Use a fictional ID from 00000000000000B0 to 00000000000000CF, select Kiwi, and leave AppKey empty.'},
  fr: {unsupported: 'Cette action n’est pas simulée. Aucune commande n’a été envoyée.', protected: 'Les deux zones initiales sont protégées. Créez une zone temporaire pour montrer la suppression.',
    invalid: 'Vérifiez les valeurs saisies.', blocked: 'Le réseau est désactivé dans cette démonstration.', missing: 'Cet élément de démonstration n’existe plus.',
    assigned: 'Cet appareil est déjà affecté à une autre zone.', duplicate: 'Cet appareil de démonstration existe déjà.', busy: 'Annulez d’abord l’ouverture en cours.',
    demo_device: 'Utilisez un identifiant fictif de 00000000000000B0 à 00000000000000CF, choisissez Kiwi et laissez AppKey vide.'},
};
function notice(message: string) {
  const el = document.getElementById('demo-notice');
  if (el && parent === window) {el.textContent = message; el.hidden = !message;}
  parent.postMessage({channel: CHANNEL, type: 'notice', message}, location.origin);
}
function block(): never { const message = strings[i18n.language === 'fr' ? 'fr' : 'en'].blocked; notice(message); throw new Error(message); }
window.fetch = async () => block();
window.XMLHttpRequest = class { constructor() {block();} } as unknown as typeof XMLHttpRequest;
window.WebSocket = class { constructor() {block();} } as unknown as typeof WebSocket;
window.EventSource = class { constructor() {block();} } as unknown as typeof EventSource;
navigator.sendBeacon = () => {block();};
const locationUnavailable = (_success: PositionCallback, error?: PositionErrorCallback | null) => {
  notice(strings[i18n.language === 'fr' ? 'fr' : 'en'].unsupported);
  error?.({code: 2, message: 'Simulated environment: location unavailable', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3});
};
Object.defineProperty(navigator, 'geolocation', {value: {getCurrentPosition: locationUnavailable,
  watchPosition: (success: PositionCallback, error?: PositionErrorCallback | null) => {locationUnavailable(success, error); return 0;}, clearWatch: () => {}}});
// Native mobile bridges must never bypass the browser boundary.
Object.defineProperty(window, 'AndroidBridge', {value: undefined});
Object.defineProperty(window, 'webkit', {value: undefined});

// Guard link/form navigation too: sandbox + CSP are a second independent boundary.
document.addEventListener('click', e => {
  const action = (e.target as Element)?.closest?.('[data-action]')?.getAttribute('data-action');
  if (action === 'logout' || action === 'osi-server') {
    e.preventDefault(); e.stopPropagation();
    notice(strings[i18n.language === 'fr' ? 'fr' : 'en'].unsupported);
    return;
  }
  const anchor = (e.target as Element)?.closest?.('a');
  if (!anchor) return;
  const next = new URL(anchor.href, location.href);
  if (next.origin !== location.origin || next.pathname !== location.pathname) {e.preventDefault(); notice(strings[i18n.language === 'fr' ? 'fr' : 'en'].unsupported);}
}, true);
window.addEventListener('hashchange', () => notice(''));
document.addEventListener('submit', e => e.preventDefault(), true);
axios.defaults.adapter = async config => {
  try {
    const resolved = new URL(config.url ?? '', location.origin);
    if (resolved.origin !== location.origin || (config.baseURL && !['/', location.origin].includes(config.baseURL))) throw new DemoError(403, 'blocked');
    for (const [key, value] of Object.entries(config.params ?? {})) resolved.searchParams.set(key, String(value));
    const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data ?? {};
    const data = sim.request(config.method ?? 'GET', resolved.pathname + resolved.search, body);
    if (config.method?.toUpperCase() === 'PUT' && resolved.pathname.endsWith('/schedule')) notice(i18n.language === 'fr'
      ? 'Déclencheur enregistré pour la démonstration. L’exécution automatique des déclencheurs n’est pas simulée.'
      : 'Demo trigger saved. Automatic trigger execution is not simulated.');
    return {data, status: 200, statusText: 'OK', headers: {}, config};
  } catch (error) {
    const code = error instanceof DemoError ? error.code : 'invalid';
    const translations = strings[i18n.language === 'fr' ? 'fr' : 'en'];
    const message = code.startsWith('name_') ? i18n.t(`rename.reason.${code}`, {ns: 'devices', defaultValue: translations.invalid}) : translations[code as keyof typeof translations] ?? translations.invalid;
    notice(message);
    throw new AxiosError(message, 'ERR_DEMO', config, undefined, {data: {message, reason: code}, status: error instanceof DemoError ? error.status : 422, statusText: 'Demo', headers: {}, config});
  }
};

let last = performance.now();
let hostActive = true;
function tick() {
  const current = performance.now();
  sim.active = hostActive && !document.hidden;
  const changed = sim.advance(current - last); last = current;
  if (changed) requestDemoRevalidation(['/api/devices', '/api/valves', '/api/irrigation/recent-actuations']);
}
const timer = window.setInterval(tick, 100);
document.addEventListener('visibilitychange', () => {last = performance.now();});
window.addEventListener('pagehide', () => clearInterval(timer), {once: true});
window.addEventListener('message', event => {
  if (event.origin !== location.origin || event.source !== parent || !isHostCommand(event.data)) return;
  tick();
  if (event.data.type === 'active') hostActive = event.data.value;
  else sim.speed = event.data.value;
});
window.addEventListener('keydown', e => {
  if (e.key === 'Escape' && e.shiftKey) {e.preventDefault(); parent.postMessage({channel: CHANNEL, type: 'focus'}, location.origin);}
});
// All setup above runs before the application creates its API instance or reads storage.
document.getElementById('demo-notice')!.onclick = () => {document.getElementById('demo-notice')!.hidden = true;};
await import('./mount');
parent.postMessage({channel: CHANNEL, type: 'ready'}, location.origin);
