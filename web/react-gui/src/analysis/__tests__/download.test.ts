// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { downloadBlob, downloadDataUrl } from '../download';

describe('download helpers', () => {
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    createObjectURL = vi.fn(() => 'blob:abc');
    revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('creates an object URL, clicks a download anchor with the filename, and revokes', () => {
    const click = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(click);

    downloadBlob('out.csv', 'a,b\n1,2', 'text/csv');

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:abc');
  });

  it('downloads a data URL via an anchor without re-encoding it', () => {
    const clicked: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this);
    });

    downloadDataUrl('chart.png', 'data:image/png;base64,Z');

    expect(clicked).toHaveLength(1);
    expect(clicked[0].href).toBe('data:image/png;base64,Z');
    expect(clicked[0].download).toBe('chart.png');
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});
