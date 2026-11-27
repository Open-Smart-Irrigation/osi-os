import type {DemoResponse} from './core/osi/types';

export interface PhoneStorage {
  local: Map<string, string>;
  session: Map<string, string>;
}

export interface FarmPhonePort {
  storage: PhoneStorage;
  request(method: string, path: string, body: unknown): DemoResponse;
  phoneNow(): number;
  isOpen(): boolean;
  connect(revalidate: (keys: readonly string[]) => void): () => void;
}

export interface PhoneHost {
  raise(): void;
  lower(): void;
  isOpen(): boolean;
  notify(afterSleep?: boolean): void;
  revalidate(keys?: readonly string[]): void;
  dispose(): void;
}

type PhoneSource = Pick<FarmPhonePort, 'request' | 'phoneNow'> & {isPhoneOpen(): boolean};

declare global {
  interface Window {
    farmSimPhone?: FarmPhonePort;
  }
}

/** Reflects the Run's dispatched phone state and refreshes the mounted app. */
export function createPhoneHost(
  slot: HTMLElement,
  source: PhoneSource,
  {language = 'en', storage = {local: new Map(), session: new Map()}}: {
    language?: string;
    storage?: PhoneStorage;
  } = {},
): PhoneHost {
  let open = false;
  let frame: HTMLIFrameElement | undefined;
  let starting: number | undefined;
  let pendingRefresh: number | undefined;
  let lastRefresh = -Infinity;
  let revalidate: ((keys: readonly string[]) => void) | undefined;
  const port: FarmPhonePort = {
    storage,
    // structuredClone here is the parent's function, so the body enters the simulator's realm.
    request: (method, path, body) => source.request(method, path, structuredClone(body)),
    phoneNow: () => source.phoneNow(),
    isOpen: () => source.isPhoneOpen(),
    connect(callback) {
      revalidate = callback;
      refresh();
      return () => { if (revalidate === callback) revalidate = undefined; };
    },
  };

  function mount() {
    starting = undefined;
    window.farmSimPhone = port;
    frame = document.createElement('iframe');
    frame.title = 'OSI OS phone';
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-modals');
    frame.referrerPolicy = 'no-referrer';
    frame.loading = 'lazy';
    const url = new URL('phone/phone.html', document.baseURI);
    url.searchParams.set('lang', language);
    url.hash = '/dashboard';
    frame.src = url.href;
    slot.replaceChildren(frame);
  }

  function refresh(keys: readonly string[] = ['*']) {
    if (!open || !source.isPhoneOpen() || !revalidate) return;
    lastRefresh = performance.now();
    revalidate(keys);
  }

  function lower() {
    open = false;
    window.clearTimeout(starting);
    window.clearTimeout(pendingRefresh);
    starting = undefined;
    pendingRefresh = undefined;
    slot.hidden = true;
    if (frame) {
      frame.inert = true;
      frame.style.visibility = 'hidden';
    }
  }

  slot.hidden = true;
  return {
    raise() {
      if (open || !source.isPhoneOpen()) return;
      open = true;
      slot.hidden = false;
      if (frame) {
        frame.inert = false;
        frame.style.visibility = 'visible';
        refresh();
        return;
      }
      const status = document.createElement('p');
      status.setAttribute('role', 'status');
      status.className = 'phone-starting';
      status.textContent = 'Phone starting…';
      slot.replaceChildren(status);
      starting = window.setTimeout(mount, 1500);
    },
    lower,
    isOpen: () => open,
    /** Call after an event, or after a sleep jump with the throttle bypassed. */
    notify(afterSleep = false) {
      if (!open || !source.isPhoneOpen() || !revalidate) return;
      const remaining = 2000 - (performance.now() - lastRefresh);
      if (afterSleep || remaining <= 0) {
        window.clearTimeout(pendingRefresh);
        pendingRefresh = undefined;
        refresh();
      } else if (pendingRefresh === undefined) {
        pendingRefresh = window.setTimeout(() => {
          pendingRefresh = undefined;
          refresh();
        }, remaining);
      }
    },
    revalidate: refresh,
    dispose() {
      lower();
      if (window.farmSimPhone === port) delete window.farmSimPhone;
      slot.replaceChildren();
      revalidate = undefined;
    },
  };
}
