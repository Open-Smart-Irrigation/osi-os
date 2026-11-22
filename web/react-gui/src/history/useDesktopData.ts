import { isDesktopBrowser } from '../utils/isDesktopBrowser';
import { useIsDesktop } from './useIsDesktop';

export function useDesktopData(): boolean {
  const hasDesktopWidth = useIsDesktop();
  return hasDesktopWidth && isDesktopBrowser();
}
