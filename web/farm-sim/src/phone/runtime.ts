import i18n from '@osi-demo/i18n';
import {applyPublicCopy} from '@osi-demo/public-copy';
import {createObjectUrlBoundary} from '@osi-demo/public-boundary';
import {installDemoNavigationGuard} from '@osi-demo/public-navigation';
import {getDemoMessages, normalizeDemoLanguage} from '@osi-demo/public/messages';
import {requestDemoRevalidation, shouldRevalidateDemoResponse} from '@osi-demo/revalidation';
import {setGatewayTimezone} from '@osi-demo/timezone-store';
import {FARM_SITE} from '../core/time';
import type {FarmPhonePort} from '../phone-host';
import {applyPhoneCopy, gameNotice} from './copy';
import {installPhoneDomShim} from './dom-shim';
import {wrapPhoneRequest} from './request';

const APP_HANDLES = new Set([
  'phone_asleep', 'no_active_actuation', 'actuation_handed_off', 'transport_uncertain', 'plan_conflict', 'busy',
]);

export async function startPhone({bridge, setClock, token, user}: {
  bridge: FarmPhonePort;
  setClock: (clock: () => number) => void;
  token: string;
  user: string;
}): Promise<void> {
  applyPublicCopy(i18n);
  applyPhoneCopy(i18n);
  const root = document.getElementById('root')!;
  document.documentElement.dataset.publicSimulator = 'true';
  root.dataset.publicSimulator = 'true';

  const urls = createObjectUrlBoundary({
    createObjectURL: URL.createObjectURL.bind(URL),
    revokeObjectURL: URL.revokeObjectURL.bind(URL),
  });
  URL.createObjectURL = urls.create;
  URL.revokeObjectURL = urls.revoke;

  setClock(() => bridge.phoneNow());
  const notice = document.querySelector<HTMLButtonElement>('#phone-notice')!;
  const show = (message: string) => {
    notice.textContent = message;
    notice.hidden = false;
  };
  const language = () => normalizeDemoLanguage(i18n.resolvedLanguage ?? i18n.language);
  const refused = () => gameNotice(i18n, 'game_refused');
  const block = (): never => {
    const message = getDemoMessages(language()).noticeBlocked;
    show(message);
    throw new Error(message);
  };
  window.fetch = async () => block();
  window.XMLHttpRequest = class { constructor() { block(); } } as unknown as typeof XMLHttpRequest;
  window.WebSocket = class { constructor() { block(); } } as unknown as typeof WebSocket;
  window.EventSource = class { constructor() { block(); } } as unknown as typeof EventSource;
  navigator.sendBeacon = () => block();
  const locationUnavailable = (_success: PositionCallback, error?: PositionErrorCallback | null) => {
    const message = refused();
    show(message);
    error?.({code: 2, message, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3});
  };
  Object.defineProperty(navigator, 'geolocation', {value: {
    getCurrentPosition: locationUnavailable,
    watchPosition: (success: PositionCallback, error?: PositionErrorCallback | null) => {
      locationUnavailable(success, error);
      return 0;
    },
    clearWatch: () => {},
  }});
  Object.defineProperty(window, 'AndroidBridge', {value: undefined});
  Object.defineProperty(window, 'webkit', {value: undefined});
  installDemoNavigationGuard(document, () => new URL(location.href), 'public', urls, () => show(refused()));
  document.addEventListener('submit', event => event.preventDefault(), true);

  const [{createDemoAdapter}, {api}, auth] = await Promise.all([
    import('@osi-demo/adapter'),
    import('../../../react-gui/src/services/api'),
    import('../../../react-gui/src/services/authSession'),
  ]);
  api.defaults.adapter = createDemoAdapter({
    requestResponse: wrapPhoneRequest(
      (method, path, body) => bridge.request(method, path, body),
      () => i18n.t('environment.description.weatherConditions', {ns: 'devices'}),
      code => gameNotice(i18n, code),
    ),
  }, code => {
    if (APP_HANDLES.has(code) || code.startsWith('name_')) return;
    if (code === 'game_refused' || code === 'game_tier') {
      show(gameNotice(i18n, code));
    } else if (code === 'unsupported') {
      show(refused());
    } else {
      const messages = getDemoMessages(language());
      show(code === 'blocked' ? messages.noticeBlocked : code === 'missing' ? messages.noticeMissing : messages.noticeInvalid);
    }
  }, (method, path, wire) => {
    if (shouldRevalidateDemoResponse(method, path, wire.status)) requestDemoRevalidation(['*']);
    if (path.split('?')[0] === '/api/system/settings' && wire.status >= 200 && wire.status < 300) {
      const timezone = (wire.data as {gatewayTimezone?: string} | null)?.gatewayTimezone;
      if (timezone === FARM_SITE.timezone) setGatewayTimezone(timezone);
    }
  });
  setGatewayTimezone(FARM_SITE.timezone);

  notice.onclick = () => { notice.hidden = true; };
  document.addEventListener('click', event => {
    if (!(event.target instanceof Element) || !event.target.closest('[data-action="logout"]')) return;
    event.preventDefault();
    event.stopPropagation();
    show(refused());
    document.body.dispatchEvent(new MouseEvent('mousedown', {bubbles: true}));
  }, true);
  auth.subscribeAuthSession(() => {
    if (auth.getAuthSession().token) return;
    console.error('The phone session was unexpectedly cleared');
    auth.beginAuthSession(token, user);
  });

  installPhoneDomShim(root, i18n);
  const syncLanguage = () => {
    document.documentElement.lang = language();
    requestDemoRevalidation(['*']);
  };
  document.documentElement.lang = language();
  i18n.on('languageChanged', syncLanguage);
  const disconnect = bridge.connect(requestDemoRevalidation);
  window.addEventListener('pagehide', event => {
    if (!event.persisted) {
      disconnect();
      urls.releaseAll();
    }
  });
  const {mountPhone} = await import('./mount');
  mountPhone(root, () => bridge.isOpen());
}
