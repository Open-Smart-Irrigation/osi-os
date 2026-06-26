type NavigatorWithUaData = Navigator & { userAgentData?: { mobile?: boolean } };

const MOBILE_UA = /Android|iPhone|iPad|iPod|Mobile|Tablet|Windows Phone|webOS|BlackBerry/i;

/**
 * True for desktop browsers, false for mobile/tablet. Fails open (true) when
 * detection is impossible so the feature stays reachable.
 */
export function isDesktopBrowser(): boolean {
  if (typeof navigator === 'undefined' || !navigator) return true;
  const uaData = (navigator as NavigatorWithUaData).userAgentData;
  if (uaData && typeof uaData.mobile === 'boolean') return !uaData.mobile;
  const ua = navigator.userAgent ?? '';
  if (!ua) return true;
  return !MOBILE_UA.test(ua);
}
