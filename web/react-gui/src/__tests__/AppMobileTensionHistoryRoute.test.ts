import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8');

describe('mobile tension history app route', () => {
  it('keeps the lazy import inside the exact build gate and redirects when disabled', () => {
    expect(source).toContain("import.meta.env.VITE_MOBILE_HISTORY_INTERNAL === 'true'");
    expect(source).toContain("lazy(() => import('./pages/MobileTensionHistoryRoute')");
    expect(source).toContain('<Navigate to="/history" replace />');
    expect(source).toContain('path="/internal/mobile-history/zones/:zoneId"');
  });
});
