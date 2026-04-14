export const AUTH_EXPIRED_EVENT = 'osi-os:auth-expired';

let authExpiryDispatched = false;

export function notifyAuthExpired(): void {
  if (authExpiryDispatched) {
    return;
  }
  authExpiryDispatched = true;
  window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
}

export function resetAuthExpiredSignal(): void {
  authExpiryDispatched = false;
}
