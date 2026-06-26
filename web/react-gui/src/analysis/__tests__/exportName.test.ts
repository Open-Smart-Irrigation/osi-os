import { describe, expect, it } from 'vitest';
import { exportFileName } from '../exportName';

describe('exportFileName', () => {
  it('uses username, minute timestamp and per-minute collision suffixes', () => {
    const minute = new Date(2026, 5, 20, 14, 30, 15);
    const nextMinute = new Date(2026, 5, 20, 14, 31, 0);

    expect(exportFileName('admin', 'csv', minute)).toBe('admin_data_export_2026-06-20_14-30.csv');
    expect(exportFileName('admin', 'csv', minute)).toBe('admin_data_export_2026-06-20_14-30_2.csv');
    expect(exportFileName('admin', 'csv', nextMinute)).toBe('admin_data_export_2026-06-20_14-31.csv');
    expect(exportFileName(null, 'png', minute)).toBe('user_data_export_2026-06-20_14-30.png');
    expect(exportFileName('farm admin/one', 'csv', minute)).toBe('farm_admin_one_data_export_2026-06-20_14-30.csv');
  });
});
