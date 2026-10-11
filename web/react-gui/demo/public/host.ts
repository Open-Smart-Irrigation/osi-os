import {CHANNEL, isAppMessage, type DemoLanguage, type HostCommand} from '../protocol';
import {getDemoMessages, normalizeDemoLanguage} from './messages';

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Public simulator host markup is missing ${selector}`);
  return element;
}

const frame = required<HTMLIFrameElement>('#app');
const phone = required<HTMLElement>('.phone-frame');
const space = required<HTMLElement>('.phone-space');
const loading = required<HTMLElement>('#loading');
const loadingMessage = required<HTMLElement>('#loading-message');
const retry = required<HTMLButtonElement>('#retry');
const toolsTrigger = required<HTMLButtonElement>('#open-tools');
const toolsDialog = required<HTMLDialogElement>('#tools-dialog');
const speed = required<HTMLSelectElement>('#speed');
const toolsResetNote = required<HTMLElement>('#tools-reset-note');
const toolsLugandaReview = required<HTMLElement>('#tools-luganda-review');
const pause = required<HTMLButtonElement>('#pause');
const viewToggle = required<HTMLButtonElement>('#view-toggle');
const notice = required<HTMLElement>('#host-notice');

let language: DemoLanguage = 'en';
let paused = false;
let expanded = false;
let ready = false;
let generation = 0;
let readinessTimer: number | undefined;

function send(command: HostCommand): void {
  frame.contentWindow?.postMessage(command, location.origin);
}

function updateCopy(nextLanguage: DemoLanguage): void {
  language = nextLanguage;
  const copy = getDemoMessages(language);
  document.documentElement.lang = language;
  document.title = copy.title;
  frame.title = copy.appFrameTitle;
  document.querySelector('.simulator')!.setAttribute('aria-label', copy.simulatorRegion);
  document.querySelector('#brand')!.textContent = copy.brand;
  document.querySelector('#page-title')!.textContent = copy.title;
  document.querySelector('#tagline')!.textContent = copy.tagline;
  document.querySelector('#simulation-label')!.textContent = copy.simulatedData;
  document.querySelector('#reset')!.textContent = copy.reset;
  document.querySelector('#reset-note')!.textContent = copy.resetNote;
  toolsResetNote.textContent = copy.resetNote;
  retry.textContent = copy.retry;
  toolsTrigger.setAttribute('aria-label', copy.openTools);
  toolsTrigger.querySelector('span')!.textContent = copy.openTools;
  document.querySelector('#tools-title')!.textContent = copy.tools;
  document.querySelector('#close-tools')!.textContent = copy.close;
  document.querySelector('#close-tools')!.setAttribute('aria-label', copy.close);
  document.querySelector('#simulated-time-label')!.textContent = copy.simulatedTime;
  document.querySelector('#speed-label')!.textContent = copy.speed;
  document.querySelector('#next-event')!.textContent = copy.nextEvent;
  document.querySelector('#instructions-title')!.textContent = copy.instructionsTitle;
  document.querySelector('#instruction-one')!.textContent = copy.instructionOne;
  document.querySelector('#instruction-two')!.textContent = copy.instructionTwo;
  document.querySelector('#instruction-three')!.textContent = copy.instructionThree;
  const review = document.querySelector<HTMLElement>('#luganda-review')!;
  review.textContent = copy.lugandaReview;
  review.hidden = language !== 'lg';
  toolsLugandaReview.textContent = copy.lugandaReview;
  toolsLugandaReview.hidden = language !== 'lg';
  syncPauseCopy();
  syncViewCopy();
  if (!loading.hidden) loadingMessage.textContent = retry.hidden ? copy.loading : copy.loadFailed;
}

function syncPauseCopy(): void {
  const copy = getDemoMessages(language);
  pause.textContent = paused ? copy.resume : copy.pause;
  pause.setAttribute('aria-pressed', String(paused));
}

function syncViewCopy(): void {
  const copy = getDemoMessages(language);
  viewToggle.textContent = expanded ? copy.compact : copy.expanded;
  viewToggle.setAttribute('aria-pressed', String(expanded));
}

function showNotice(message: string): void {
  notice.textContent = message;
  notice.hidden = !message;
}

function showLoadingError(): void {
  const copy = getDemoMessages(language);
  loadingMessage.textContent = copy.loadFailed;
  retry.hidden = false;
  loading.hidden = false;
}

function startAppDocument(): void {
  if (readinessTimer !== undefined) window.clearTimeout(readinessTimer);
  ready = false;
  paused = false;
  expanded = false;
  document.body.classList.remove('expanded');
  fitPhone();
  speed.value = '1';
  showNotice('');
  syncPauseCopy();
  syncViewCopy();
  loadingMessage.textContent = getDemoMessages(language).loading;
  retry.hidden = true;
  loading.hidden = false;
  readinessTimer = window.setTimeout(showLoadingError, 15_000);
  const session = `${++generation}-${Math.floor(performance.now())}`;
  frame.src = `./app.html?session=${encodeURIComponent(session)}#/dashboard`;
}

function setPaused(next: boolean): void {
  paused = next;
  syncPauseCopy();
  if (ready) send({channel: CHANNEL, type: 'active', value: !paused && !document.hidden});
}

function fitPhone(): void {
  const compact = innerWidth <= 700 || innerHeight <= 500;
  if (compact) {
    space.style.width = '100vw';
    space.style.height = '100%';
    phone.style.transform = 'none';
    return;
  }
  const availableWidth = expanded ? innerWidth - 40 : Math.min(innerWidth * .48, innerWidth - 330);
  const availableHeight = innerHeight - (expanded ? 100 : 164);
  const scale = Math.max(.36, Math.min(expanded ? 1.25 : 1, availableWidth / 402, availableHeight / 856));
  space.style.width = `${402 * scale}px`;
  space.style.height = `${856 * scale}px`;
  phone.style.transform = `scale(${scale})`;
}

toolsTrigger.addEventListener('click', () => toolsDialog.showModal());
document.querySelector<HTMLButtonElement>('#close-tools')!.addEventListener('click', () => toolsDialog.close());
toolsDialog.addEventListener('close', () => toolsTrigger.focus());
document.querySelector<HTMLButtonElement>('#reset')!.addEventListener('click', () => {
  language = 'en';
  updateCopy('en');
  startAppDocument();
});
retry.addEventListener('click', startAppDocument);
speed.addEventListener('change', () => {
  const value = Number(speed.value);
  if (value === 1 || value === 10 || value === 60) send({channel: CHANNEL, type: 'speed', value});
});
pause.addEventListener('click', () => setPaused(!paused));
document.querySelector<HTMLButtonElement>('#next-event')!.addEventListener('click', () => send({channel: CHANNEL, type: 'next-event'}));
viewToggle.addEventListener('click', () => {
  expanded = !expanded;
  document.body.classList.toggle('expanded', expanded);
  syncViewCopy();
  fitPhone();
});
window.addEventListener('resize', fitPhone);
window.addEventListener('orientationchange', fitPhone);
document.addEventListener('visibilitychange', () => {
  if (ready) send({channel: CHANNEL, type: 'active', value: !paused && !document.hidden});
});
frame.addEventListener('load', () => {
  // A document load does not prove that the app rendered. Readiness comes from
  // the mounted React tree's exact-origin message below.
});

window.addEventListener('message', event => {
  if (event.origin !== location.origin || event.source !== frame.contentWindow || !isAppMessage(event.data)) return;
  const data = event.data;
  if (data.type === 'language') {
    updateCopy(normalizeDemoLanguage(data.value));
    return;
  }
  if (data.type === 'notice') {
    showNotice(data.message);
    return;
  }
  if (data.type === 'time') {
    const date = new Date(data.value);
    const formatted = Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(language, {dateStyle: 'medium', timeStyle: 'short'}).format(date) : '—';
    const clock = document.querySelector<HTMLTimeElement>('#simulated-time')!;
    clock.dateTime = Number.isFinite(date.getTime()) ? date.toISOString() : '';
    clock.textContent = formatted;
    return;
  }
  if (data.type === 'startup-error') {
    showLoadingError();
    return;
  }
  if (data.type === 'ready') {
    ready = true;
    if (readinessTimer !== undefined) window.clearTimeout(readinessTimer);
    loading.hidden = true;
    send({channel: CHANNEL, type: 'speed', value: Number(speed.value) as 1 | 10 | 60});
    send({channel: CHANNEL, type: 'active', value: !paused && !document.hidden});
  }
});

updateCopy('en');
fitPhone();
startAppDocument();
