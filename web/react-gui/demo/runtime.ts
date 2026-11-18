import {requestDemoRevalidation, shouldRevalidateDemoResponse} from './revalidation';
import {Simulator} from './model';
import {createDemoAdapter} from './adapter';
import {api} from '../src/services/api';
import {CHANNEL, isHostCommand} from './protocol';
import i18n from './i18n';
import {readDisplayPreferences} from '../src/utils/displayPreferences';
import {setGatewayTimezone} from './timezone-store';
import {createObjectUrlBoundary} from './public-boundary';
import {applyPublicCopy} from './public-copy';
import {installDemoNavigationGuard} from './public-navigation';
import {getAuthSession, subscribeAuthSession} from '../src/services/authSession';
import {getDemoMessages, normalizeDemoLanguage, type DemoLanguage} from './public/messages';

const publicMode = import.meta.env.VITE_PUBLIC_SIMULATOR === 'true';
// Only the separately compiled public artifact may run on a public hostname.
if (!publicMode && !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) throw new Error('Demo requires localhost');
if (publicMode) applyPublicCopy(i18n);
const sim = new Simulator({mode: publicMode ? 'public' : 'presentation'});
document.documentElement.dataset.publicSimulator = publicMode ? 'true' : 'false';
document.getElementById('root')!.dataset.publicSimulator = publicMode ? 'true' : 'false';
const objectUrlBoundary = createObjectUrlBoundary({
  createObjectURL: URL.createObjectURL.bind(URL),
  revokeObjectURL: URL.revokeObjectURL.bind(URL),
});
URL.createObjectURL = ((blob: Blob) => objectUrlBoundary.create(blob)) as typeof URL.createObjectURL;
URL.revokeObjectURL = ((url: string) => objectUrlBoundary.revoke(url)) as typeof URL.revokeObjectURL;
window.addEventListener('pagehide', event => {
  if (!(event as PageTransitionEvent).persisted) objectUrlBoundary.releaseAll();
});
localStorage.setItem('auth_token', publicMode ? 'public-demo-session' : 'inert-demo-session-not-a-jwt');
localStorage.setItem('username', publicMode ? 'Demo farmer' : 'MUARIK · Demo');
localStorage.setItem('osi.display.theme', 'light');
if (!publicMode) localStorage.setItem('osi.modules.environment', 'false');
localStorage.setItem('osi.defaults.timezone', 'Africa/Kampala');
window.addEventListener('osi-display-preferences', () => {
  sim.state.settings.defaultTimezone = readDisplayPreferences().defaultTimezone ?? '';
});

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
    demo_device: 'Use a fictional ID from 00000000000000B0 to 00000000000000CF, select Kiwi, and leave AppKey empty.',
    unsupported_device: 'Milesight UC512 registration is not available in this simulator. No device was added.',
    form_notice: 'Example values only. These entries stay in this browser session and do not contact a server or device.'},
  fr: {unsupported: 'Cette action n’est pas simulée. Aucune commande n’a été envoyée.', protected: 'Les deux zones initiales sont protégées. Créez une zone temporaire pour montrer la suppression.',
    invalid: 'Vérifiez les valeurs saisies.', blocked: 'Le réseau est désactivé dans cette démonstration.', missing: 'Cet élément de démonstration n’existe plus.',
    assigned: 'Cet appareil est déjà affecté à une autre zone.', duplicate: 'Cet appareil de démonstration existe déjà.', busy: 'Annulez d’abord l’ouverture en cours.',
    demo_device: 'Utilisez un identifiant fictif de 00000000000000B0 à 00000000000000CF, choisissez Kiwi et laissez AppKey vide.',
    unsupported_device: 'L’enregistrement du Milesight UC512 n’est pas disponible dans ce simulateur. Aucun appareil n’a été ajouté.',
    form_notice: 'Valeurs d’exemple uniquement. Ces données restent dans cette session du navigateur et ne contactent aucun serveur ni appareil.'},
};
type PublicNoticeKey = 'noticeUnsupported' | 'noticeProtected' | 'noticeInvalid' | 'noticeBlocked' | 'noticeMissing'
  | 'noticeAssigned' | 'noticeDuplicate' | 'noticeBusy' | 'noticeDemoDevice' | 'noticeNoEvent' | 'noticeUnsupportedDevice' | 'formNotice';
const noticeKeys: Record<string, PublicNoticeKey> = {
  unsupported: 'noticeUnsupported', protected: 'noticeProtected', invalid: 'noticeInvalid', blocked: 'noticeBlocked',
  missing: 'noticeMissing', assigned: 'noticeAssigned', duplicate: 'noticeDuplicate', busy: 'noticeBusy', demo_device: 'noticeDemoDevice',
  no_event: 'noticeNoEvent', unsupported_device: 'noticeUnsupportedDevice', form_notice: 'formNotice',
};
function publicLanguage(): DemoLanguage {return normalizeDemoLanguage(i18n.resolvedLanguage ?? i18n.language);}
function noticeText(key: keyof typeof strings.en | 'no_event'): string {
  if (publicMode) return getDemoMessages(publicLanguage())[noticeKeys[key] ?? 'noticeInvalid'];
  if (key === 'no_event') return strings.en.invalid;
  return strings[i18n.language === 'fr' ? 'fr' : 'en'][key];
}
function notice(message: string) {
  const el = document.getElementById('demo-notice');
  if (el && parent === window) {el.textContent = message; el.hidden = !message;}
  parent.postMessage({channel: CHANNEL, type: 'notice', message}, location.origin);
}
function block(): never { const message = noticeText('blocked'); notice(message); throw new Error(message); }
window.fetch = async () => block();
window.XMLHttpRequest = class { constructor() {block();} } as unknown as typeof XMLHttpRequest;
window.WebSocket = class { constructor() {block();} } as unknown as typeof WebSocket;
window.EventSource = class { constructor() {block();} } as unknown as typeof EventSource;
navigator.sendBeacon = () => {block();};
const locationUnavailable = (_success: PositionCallback, error?: PositionErrorCallback | null) => {
  notice(noticeText('unsupported'));
  error?.({code: 2, message: 'Location unavailable', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3});
};
Object.defineProperty(navigator, 'geolocation', {value: {getCurrentPosition: locationUnavailable,
  watchPosition: (success: PositionCallback, error?: PositionErrorCallback | null) => {locationUnavailable(success, error); return 0;}, clearWatch: () => {}}});
// Native mobile bridges must never bypass the browser boundary.
Object.defineProperty(window, 'AndroidBridge', {value: undefined});
Object.defineProperty(window, 'webkit', {value: undefined});

// Guard link/form navigation too: sandbox + CSP are a second independent boundary.
installDemoNavigationGuard(document, () => new URL(location.href), publicMode ? 'public' : 'presentation', objectUrlBoundary,
  () => notice(noticeText('unsupported')));
let formNoticeActive = false;
function syncFormNotice(forceClear = false): void {
  if (!publicMode) return;
  const accountLink = location.hash.includes('/account-link');
  const addDeviceForm = document.querySelector('[role="dialog"] #device-type, [role="dialog"] #zone-device-deveui');
  const active = accountLink || Boolean(addDeviceForm);
  if (active === formNoticeActive) {
    if (forceClear && !active) notice('');
    return;
  }
  formNoticeActive = active;
  notice(active ? noticeText('form_notice') : '');
}
window.addEventListener('hashchange', () => syncFormNotice(true));
new MutationObserver(() => syncFormNotice()).observe(document.body, {childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'aria-hidden']});
document.addEventListener('submit', e => e.preventDefault(), true);
api.defaults.adapter = createDemoAdapter(sim, (code) => {
  const translations = strings[i18n.language === 'fr' ? 'fr' : 'en'];
  const key = code.startsWith('name_') ? 'invalid' : code as keyof typeof strings.en;
  const message = code.startsWith('name_') ? i18n.t(`rename.reason.${code}`, {ns: 'devices', defaultValue: noticeText('invalid')}) : noticeText(key) ?? translations.invalid;
  notice(message);
}, (method, path, wire) => {
  if (shouldRevalidateDemoResponse(method, path, wire.status)) requestDemoRevalidation(['*']);
  if (publicMode && wire.status < 400 && ((method === 'POST' && /^\/api\/valve\/[^/]+(?:\/cancel)?$/.test(path.split('?')[0]!)) ||
    (/^\/api\/valves\/[^/]+\/schedules(?:\/[^/]+)?$/.test(path.split('?')[0]!) && ['POST', 'PUT', 'DELETE'].includes(method)))) {
    const event = sim.nextEventDescriptor();
    parent.postMessage({channel: CHANNEL, type: 'next-event', ...event}, location.origin);
  }
  if (publicMode && path.split('?')[0] === '/api/system/settings' && wire.status < 400 && wire.data && typeof wire.data === 'object') {
    const timezone = (wire.data as {gatewayTimezone?: unknown}).gatewayTimezone;
    if (typeof timezone === 'string') {setGatewayTimezone(timezone); reportSimulatedTime(true); publishNextEvent(true);}
  }
  if (!publicMode && method === 'PUT' && path.endsWith('/schedule') && wire.status < 400) notice(i18n.language === 'fr'
    ? 'Déclencheur enregistré pour la démonstration. L’exécution automatique des déclencheurs n’est pas simulée.'
    : 'Demo trigger saved. Automatic trigger execution is not simulated.');
});

let last = performance.now();
let hostActive = true;
let lastReportedMinute = -1;
let lastNextEvent: string | null = null;
let guideGeneration = 0;
let cancelPendingGuideNavigation: (() => void) | undefined;
const guideInjectedTabIndexes = new Map<HTMLElement, string | null>();
function clearGuideTargets(): void {
  document.querySelectorAll('.demo-guide-target').forEach(element => element.classList.remove('demo-guide-target'));
  for (const [element, tabIndex] of guideInjectedTabIndexes) {
    if (tabIndex === null) element.removeAttribute('tabindex');
    else element.setAttribute('tabindex', tabIndex);
  }
  guideInjectedTabIndexes.clear();
}
function publishNextEvent(force = false): void {
  if (!publicMode) return;
  const descriptor = sim.nextEventDescriptor();
  const key = JSON.stringify(descriptor);
  if (!force && key === lastNextEvent) return;
  lastNextEvent = key;
  parent.postMessage({channel: CHANNEL, type: 'next-event', ...descriptor}, location.origin);
}
function reportSimulatedTime(force = false): void {
  if (!publicMode) return;
  const minute = Math.floor(sim.now / 60_000);
  if (!force && minute === lastReportedMinute) return;
  lastReportedMinute = minute;
  parent.postMessage({channel: CHANNEL, type: 'time', value: sim.now, timeZone: sim.state.settings.gatewayTimezone}, location.origin);
}
function tick() {
  const current = performance.now();
  sim.active = hostActive && !document.hidden;
  const changed = sim.advance(current - last); last = current;
  if (changed) {requestDemoRevalidation(['*']); publishNextEvent();}
  reportSimulatedTime();
}
let timer: number | null = window.setInterval(tick, 100);
function stopTimer(): void {
  if (timer !== null) window.clearInterval(timer);
  timer = null;
}
function startTimer(): void {
  if (timer !== null) return;
  last = performance.now();
  timer = window.setInterval(tick, 100);
}
document.addEventListener('visibilitychange', () => {last = performance.now();});
window.addEventListener('pagehide', stopTimer);
window.addEventListener('pageshow', event => {
  if ((event as PageTransitionEvent).persisted) startTimer();
});
window.addEventListener('message', event => {
  if (event.origin !== location.origin || event.source !== parent || !isHostCommand(event.data)) return;
  tick();
  if (event.data.type === 'active') hostActive = event.data.value;
  else if (event.data.type === 'speed') sim.speed = event.data.value;
  else if (event.data.type === 'clear-guide') {
    guideGeneration += 1;
    cancelPendingGuideNavigation?.();
    cancelPendingGuideNavigation = undefined;
    clearGuideTargets();
  }
  else if (event.data.type === 'guide') {
    const step = event.data.step;
    cancelPendingGuideNavigation?.();
    const currentGuideGeneration = ++guideGeneration;
    const selectors: Record<string, string> = {
      'inspect-plot': '[data-testid="water-today-card"]',
      'explain-advice': '[data-testid="water-action-tile"]',
      history: '[data-testid="history-detail-scroll-root"]',
      'timed-irrigation': '[data-testid="valve-actions"]',
      result: 'section:has(> div h2)',
      schedule: 'button',
    };
    if (step === 'skip-to-result') {
      const skip = parent.document.querySelector<HTMLButtonElement>('#skip-event');
      if (skip && !skip.hidden) {skip.focus(); parent.postMessage({channel: CHANNEL, type: 'guide-result', step, status: 'ready'}, location.origin);}
      else parent.postMessage({channel: CHANNEL, type: 'guide-result', step, status: 'missing'}, location.origin);
      return;
    }
    if (step === 'next-steps') {parent.document.querySelector<HTMLElement>('#guide-links a')?.focus(); parent.postMessage({channel: CHANNEL, type: 'guide-result', step, status: 'ready'}, location.origin); return;}
    if (step === 'history') location.hash = '#/history/zones/1';
    else location.hash = '#/dashboard';
    const findTarget = (): HTMLElement | null => {
      let target = document.querySelector<HTMLElement>(selectors[step] ?? '');
      if (step === 'result') {
        const title = i18n.getFixedT(i18n.language, 'devices')('irrigationOutcomes.title', {defaultValue: 'Recent irrigations'});
        target = [...document.querySelectorAll<HTMLElement>('section')].find(section => section.querySelector('h2')?.textContent?.trim() === title) ?? null;
      }
      if (step === 'schedule') {
        const label = i18n.getFixedT(i18n.language, 'valves')('schedule');
        target = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === label) ?? null;
      }
      return target;
    };
    clearGuideTargets();
    let observer: MutationObserver | null = null;
    let timeout: number | undefined;
    const cancel = () => {
      observer?.disconnect();
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
    cancelPendingGuideNavigation = cancel;
    const finish = (target: HTMLElement | null) => {
      if (currentGuideGeneration !== guideGeneration) return;
      cancel();
      cancelPendingGuideNavigation = undefined;
      if (!target) {parent.postMessage({channel: CHANNEL, type: 'guide-result', step, status: 'missing'}, location.origin); return;}
      target.classList.add('demo-guide-target');
      if (!target.hasAttribute('tabindex')) {guideInjectedTabIndexes.set(target, null); target.tabIndex = -1;}
      target.scrollIntoView({behavior: 'auto', block: 'center'});
      target.focus({preventScroll: true});
      parent.postMessage({channel: CHANNEL, type: 'guide-result', step, status: 'ready'}, location.origin);
    };
    const existing = findTarget();
    if (existing) {
      finish(existing);
    } else {
      observer = new MutationObserver(() => {const target = findTarget(); if (target) finish(target);});
      timeout = window.setTimeout(() => finish(findTarget()), 15_000);
      observer.observe(document.body, {childList: true, subtree: true, attributes: true});
    }
  }
  else if (!sim.jumpToNextEvent()) notice(noticeText('no_event'));
  else {requestDemoRevalidation(['*']); reportSimulatedTime(true); publishNextEvent(true);}
});
window.addEventListener('keydown', e => {
  if (!publicMode && e.key === 'Escape' && e.shiftKey) {e.preventDefault(); parent.postMessage({channel: CHANNEL, type: 'focus'}, location.origin);}
});
// All setup above runs before the application creates its API instance or reads storage.
document.getElementById('demo-notice')!.onclick = () => {document.getElementById('demo-notice')!.hidden = true;};
if (publicMode) subscribeAuthSession(() => sim.setSessionUser(getAuthSession().username));
if (publicMode) {
  const sendLanguage = (value: string) => parent.postMessage({channel: CHANNEL, type: 'language', value: normalizeDemoLanguage(value)}, location.origin);
  sendLanguage(i18n.resolvedLanguage ?? i18n.language);
  i18n.on('languageChanged', sendLanguage);
  reportSimulatedTime(true);
  publishNextEvent(true);
}
try {
  await import('./mount');
  if (!publicMode) parent.postMessage({channel: CHANNEL, type: 'ready'}, location.origin);
} catch {
  // An unmounted application cannot reliably report a failed first chunk.
  // The public host's readiness deadline owns that case; render-time failures
  // after mount are reported by StartupErrorBoundary in mount.tsx.
  if (!publicMode) throw new Error('Demo application failed to start');
}
