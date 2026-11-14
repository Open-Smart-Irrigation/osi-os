import {CHANNEL, isAppMessage, type DemoLanguage, type HostCommand} from '../protocol';
import {getDemoMessages, normalizeDemoLanguage} from './messages';
import {formatFarmTime} from './datetime';
import {PUBLIC_LINKS} from './links';

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
const toolsLugandaReview = required<HTMLElement>('#tools-luganda-review');
const pause = required<HTMLButtonElement>('#pause');
const viewToggle = required<HTMLButtonElement>('#view-toggle');
const notice = required<HTMLElement>('#host-notice');
const mobileLugandaReview = required<HTMLElement>('#mobile-luganda-review');
const guideTrigger = required<HTMLButtonElement>('#guide-start');
const guidePanel = required<HTMLElement>('#guide-panel');
const resetDialog = required<HTMLDialogElement>('#reset-dialog');
const guideCopy = required<HTMLElement>('#guide-step-copy');
const guideNext = required<HTMLButtonElement>('#guide-next');
const skipEvent = required<HTMLButtonElement>('#skip-event');
const guideSteps = ['inspect-plot', 'explain-advice', 'history', 'timed-irrigation', 'skip-to-result', 'result', 'schedule', 'next-steps'] as const;
const stepCopy = ['stepInspect', 'stepAdvice', 'stepHistory', 'stepIrrigation', 'stepSkip', 'stepResult', 'stepSchedule', 'stepNext'] as const;

let language: DemoLanguage = 'en';
let paused = false;
let expanded = false;
let ready = false;
let generation = 0;
let readinessTimer: number | undefined;
let guideIndex = -1;
let guideRetrying = false;
let guideTimer: number | undefined;
let guideTargetStep: typeof guideSteps[number] | undefined;
let currentEvent: {at: number; kind: 'valve-close' | 'schedule-start' | 'report'} | null = null;
const eventRow = required<HTMLElement>('#event-row');
function send(command: HostCommand): void {
  frame.contentWindow?.postMessage(command, location.origin);
}

function updateCopy(nextLanguage: DemoLanguage): void {
  language = nextLanguage;
  const copy = getDemoMessages(language);
  document.documentElement.lang = language;
  document.title = copy.title;
  frame.title = copy.appFrameTitle;
  document.querySelector('.simulator')!.setAttribute('aria-label', copy.appRegion);
  document.querySelector('#brand')!.textContent = copy.brand;
  document.querySelector('#page-title')!.textContent = copy.title;
  document.querySelector('#reset')!.textContent = copy.reset;
  retry.textContent = copy.retry;
  toolsTrigger.setAttribute('aria-label', copy.openTools);
  toolsTrigger.querySelector('span')!.textContent = copy.openTools;
  document.querySelector('#tools-title')!.textContent = copy.tools;
  document.querySelector('#close-tools')!.textContent = copy.close;
  document.querySelector('#close-tools')!.setAttribute('aria-label', copy.close);
  document.querySelector('#time-label')!.textContent = copy.time;
  document.querySelector('#speed-label')!.textContent = copy.speed;
  document.querySelector('#next-event')!.textContent = copy.nextEvent;
  document.querySelector('#farm-safety')!.textContent = copy.safeFarm;
  const linkLabels = {home: copy.linkHome, visitor: copy.linkVisitor, installer: copy.linkInstaller, developer: copy.linkDeveloper} as const;
  document.querySelectorAll<HTMLAnchorElement>('[data-public-link]').forEach(anchor => {
    const role = anchor.dataset.publicLink as keyof typeof PUBLIC_LINKS;
    const link = PUBLIC_LINKS[role];
    if (!link) return;
    anchor.href = link.href;
    anchor.textContent = linkLabels[role];
    if (link.href.startsWith('https://')) anchor.rel = 'noopener';
  });
  document.querySelector('#guide-start')!.textContent = copy.guide;
  document.querySelector('#guide-title')!.textContent = copy.guideTitle;
  document.querySelector('#guide-intro')!.textContent = copy.guideIntro;
  document.querySelector('#guide-close')!.textContent = copy.guideClose;
  if (guideRetrying) guideNext.textContent = copy.guideRetry;
  document.querySelector<HTMLElement>('#guide-links')!.hidden = guideIndex < guideSteps.length - 1;
  document.querySelector('#reset-title')!.textContent = copy.resetTitle;
  document.querySelector('#reset-detail')!.textContent = copy.resetDetail;
  document.querySelector('#reset-confirm')!.textContent = copy.resetConfirm;
  document.querySelector('#reset-cancel')!.textContent = copy.resetCancel;
  document.querySelector('#instructions-title')!.textContent = copy.instructionsTitle;
  document.querySelector('#features-title')!.textContent = copy.featuresTitle;
  document.querySelector('#feature-one-title')!.textContent = copy.featureOneTitle;
  document.querySelector('#feature-one-copy')!.textContent = copy.featureOneCopy;
  document.querySelector('#feature-two-title')!.textContent = copy.featureTwoTitle;
  document.querySelector('#feature-two-copy')!.textContent = copy.featureTwoCopy;
  document.querySelector('#feature-three-title')!.textContent = copy.featureThreeTitle;
  document.querySelector('#feature-three-copy')!.textContent = copy.featureThreeCopy;
  document.querySelector('#feature-four-title')!.textContent = copy.featureFourTitle;
  document.querySelector('#feature-four-copy')!.textContent = copy.featureFourCopy;
  document.querySelector('#feature-five-title')!.textContent = copy.featureFiveTitle;
  document.querySelector('#feature-five-copy')!.textContent = copy.featureFiveCopy;
  document.querySelector('#feature-six-title')!.textContent = copy.featureSixTitle;
  document.querySelector('#feature-six-copy')!.textContent = copy.featureSixCopy;
  document.querySelector('#instruction-one')!.textContent = copy.instructionOne;
  document.querySelector('#instruction-two')!.textContent = copy.instructionTwo;
  document.querySelector('#instruction-three')!.textContent = copy.instructionThree;
  const review = document.querySelector<HTMLElement>('#luganda-review')!;
  review.textContent = copy.lugandaReview;
  review.hidden = language !== 'lg';
  mobileLugandaReview.textContent = copy.lugandaReview;
  mobileLugandaReview.hidden = language !== 'lg';
  toolsLugandaReview.textContent = copy.lugandaReview;
  toolsLugandaReview.hidden = language !== 'lg';
  syncPauseCopy();
  syncViewCopy();
  if (!loading.hidden) loadingMessage.textContent = retry.hidden ? copy.loading : copy.loadFailed;
  if (currentEvent) renderNextEvent();
  if (!guidePanel.hidden && guideIndex >= 0) updateGuideStep();
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
  guideTrigger.disabled = true;
  currentEvent = null;
  eventRow.hidden = true;
  renderNextEvent();
  guidePanel.hidden = true;
  document.body.classList.remove('guide-active');
  send({channel: CHANNEL, type: 'clear-guide'});
  guideIndex = -1;
  const session = `${++generation}-${Math.floor(performance.now())}`;
  frame.src = `./app.html?lang=${encodeURIComponent(language)}&session=${encodeURIComponent(session)}#/dashboard`;
}

function updateGuideStep(): void {
  const copy = getDemoMessages(language);
  if (guideTimer !== undefined) window.clearTimeout(guideTimer);
  guideRetrying = false;
  guideTargetStep = undefined;
  guideNext.disabled = false;
  if (guideIndex < 0) {guideCopy.textContent = ''; guideCopy.hidden = true; guideNext.textContent = copy.guideStart; document.querySelector<HTMLElement>('#guide-intro')!.hidden = false; document.querySelector<HTMLElement>('#guide-links')!.hidden = true; return;}
  document.querySelector<HTMLElement>('#guide-intro')!.hidden = true;
  guideCopy.hidden = false;
  if (guideIndex >= guideSteps.length) {guideCopy.textContent = copy.guideDone; guideNext.textContent = copy.guideDone; guideNext.disabled = true; return;}
  const step = guideSteps[guideIndex]!;
  guideTargetStep = step;
  guideNext.disabled = true;
  guideCopy.textContent = copy[stepCopy[guideIndex]!];
  guideNext.textContent = guideIndex === guideSteps.length - 1 ? copy.guideDone : copy.guideNext;
  document.querySelector<HTMLElement>('#guide-links')!.hidden = step !== 'next-steps';
  guideTimer = window.setTimeout(() => {
    if (guideTargetStep !== step) return;
    guideNext.disabled = false;
    guideRetrying = true;
    guideNext.textContent = copy.guideRetry;
    guideCopy.textContent = copy.noticeUnsupported;
  }, 10_000);
  send({channel: CHANNEL, type: 'guide', step});
}

function renderNextEvent(): void {
  if (!currentEvent) {skipEvent.hidden = true; delete skipEvent.dataset.eventAt; delete skipEvent.dataset.eventKind; return;}
  skipEvent.dataset.eventAt = String(currentEvent.at);
  skipEvent.dataset.eventKind = currentEvent.kind;
  const formatted = formatFarmTime(currentEvent.at, language, farmTimezone, 'short');
  skipEvent.querySelector<HTMLElement>('[data-skip-label]')!.textContent = getDemoMessages(language).skipEvent;
  skipEvent.querySelector<HTMLElement>('[data-skip-time]')!.textContent = `${formatted} ${getDemoMessages(language).farmTime}`;
  skipEvent.hidden = false;
  eventRow.hidden = false;
}

function showNextEvent(data: {at: number | null; kind: 'valve-close' | 'schedule-start' | 'report' | null}): void {
  currentEvent = data.at === null || data.kind === null ? null : {at: data.at, kind: data.kind};
  if (!currentEvent) eventRow.hidden = true;
  renderNextEvent();
}

let farmTimezone = 'Africa/Kampala';

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
    viewToggle.hidden = true;
    phone.style.transform = 'none';
    phone.style.width = '100%';
    phone.style.height = '100%';
    return;
  }
  viewToggle.hidden = false;
  const availableHeight = Math.max(390, innerHeight - (expanded ? 112 : 154));
  const availableWidth = expanded ? Math.min(innerWidth - 48, 1180) : 402;
  const width = Math.max(390, availableWidth);
  space.style.width = `${width}px`;
  space.style.height = `${availableHeight}px`;
  phone.style.transform = 'none';
  phone.style.width = `${width}px`;
  phone.style.height = `${availableHeight}px`;
}

toolsTrigger.addEventListener('click', () => toolsDialog.showModal());
guideTrigger.addEventListener('click', () => {
  expanded = false;
  document.body.classList.remove('expanded');
  syncViewCopy();
  fitPhone();
  guideIndex = -1;
  guidePanel.hidden = false;
  document.body.classList.add('guide-active');
  updateGuideStep();
  guideNext.focus();
});
document.querySelector<HTMLButtonElement>('#guide-close')!.addEventListener('click', () => {
  if (guideTimer !== undefined) window.clearTimeout(guideTimer);
  guideTargetStep = undefined;
  guidePanel.hidden = true;
  document.body.classList.remove('guide-active');
  send({channel: CHANNEL, type: 'clear-guide'});
  guideTrigger.focus();
});
guideNext.addEventListener('click', () => {if (guideRetrying) {updateGuideStep(); return;} guideIndex += 1; updateGuideStep();});
document.querySelector<HTMLButtonElement>('#reset')!.addEventListener('click', () => resetDialog.showModal());
document.querySelector<HTMLButtonElement>('#reset-cancel')!.addEventListener('click', () => resetDialog.close());
document.querySelector<HTMLButtonElement>('#reset-confirm')!.addEventListener('click', () => {resetDialog.close(); startAppDocument();});
skipEvent.addEventListener('click', () => send({channel: CHANNEL, type: 'next-event'}));
document.querySelector<HTMLButtonElement>('#close-tools')!.addEventListener('click', () => toolsDialog.close());
toolsDialog.addEventListener('close', () => toolsTrigger.focus());
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
  try {
    const appDocument = frame.contentDocument;
    if (!appDocument) return;
    const syncTheme = () => {
      const theme = appDocument.documentElement.dataset.theme;
      if (theme === 'dark' || theme === 'light') document.documentElement.dataset.theme = theme;
      else delete document.documentElement.dataset.theme;
    };
    syncTheme();
    new MutationObserver(syncTheme).observe(appDocument.documentElement, {attributes: true, attributeFilter: ['data-theme']});
  } catch { /* Cross-origin readiness is still governed by the exact-origin message. */ }
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
    farmTimezone = data.timeZone;
    const date = new Date(data.value);
    const formatted = Number.isFinite(date.getTime()) ? formatFarmTime(data.value, language, farmTimezone) : '—';
    const clock = document.querySelector<HTMLTimeElement>('#simulated-time')!;
    clock.dateTime = Number.isFinite(date.getTime()) ? date.toISOString() : '';
    clock.textContent = formatted;
    if (currentEvent && currentEvent.at <= data.value) {currentEvent = null; eventRow.hidden = true;}
    renderNextEvent();
    return;
  }
  if (data.type === 'next-event') {showNextEvent(data); return;}
  if (data.type === 'startup-error') {
    showLoadingError();
    return;
  }
  if (data.type === 'guide-result') {
    if (data.step !== guideTargetStep) return;
    if (guideTimer !== undefined) window.clearTimeout(guideTimer);
    guideTargetStep = undefined;
    guideNext.disabled = false;
    if (data.status === 'missing') {guideRetrying = true; guideNext.textContent = getDemoMessages(language).guideRetry; guideCopy.textContent = getDemoMessages(language).noticeUnsupported;}
    return;
  }
  if (data.type === 'ready') {
    ready = true;
    guideTrigger.disabled = false;
    if (readinessTimer !== undefined) window.clearTimeout(readinessTimer);
    loading.hidden = true;
    send({channel: CHANNEL, type: 'speed', value: Number(speed.value) as 1 | 10 | 60});
    send({channel: CHANNEL, type: 'active', value: !paused && !document.hidden});
  }
});

updateCopy('en');
fitPhone();
startAppDocument();
