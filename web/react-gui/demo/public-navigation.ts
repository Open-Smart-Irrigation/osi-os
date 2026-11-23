import {canNavigate, isPresentationActionBlocked, localPngDownloadFromDataUrl} from './public-boundary';

export interface NavigationObjectUrlBoundary {
  create(blob: Blob): string;
  urls(): ReadonlySet<string>;
}

export function installDemoNavigationGuard(
  document: Document,
  currentUrl: () => URL,
  mode: 'presentation' | 'public',
  objectUrls: NavigationObjectUrlBoundary,
  onBlocked: () => void,
): () => void {
  const handleClick = (event: Event) => {
    const target = event.target as Element | null;
    const action = target?.closest?.('[data-action]')?.getAttribute('data-action');
    if (isPresentationActionBlocked(mode, action ?? null)) {
      event.preventDefault();
      event.stopPropagation();
      onBlocked();
      return;
    }
    const anchor = target?.closest?.('a') as HTMLAnchorElement | null | undefined;
    if (!anchor) return;
    if (mode === 'public' && anchor.href.startsWith('data:')) {
      const png = localPngDownloadFromDataUrl(anchor.href, anchor.download);
      if (!png) {
        event.preventDefault();
        onBlocked();
        return;
      }
      anchor.href = objectUrls.create(png);
    }
    if (!canNavigate(currentUrl(), anchor.href, objectUrls.urls(), anchor.download)) {
      event.preventDefault();
      onBlocked();
    }
  };
  document.addEventListener('click', handleClick, true);
  return () => document.removeEventListener('click', handleClick, true);
}
