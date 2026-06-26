// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { loadWorkspace, saveWorkspace } from '../analysisWorkspaceStorage';
import { createDefaultWorkspace, setLabelOverride, setAxisLabelOverride } from '../workspaceModel';

beforeEach(() => localStorage.clear());

describe('analysisWorkspaceStorage', () => {
  it('returns null when nothing is stored', () => {
    expect(loadWorkspace()).toBeNull();
  });

  it('round-trips a saved workspace', () => {
    const ws = setLabelOverride(createDefaultWorkspace(), 's1', 'Saved');
    saveWorkspace(ws);
    expect(loadWorkspace()?.labelOverrides.s1).toBe('Saved');
  });

  it('returns null on corrupt JSON', () => {
    localStorage.setItem('osi.analysis.workspace.v1', '{not json');
    expect(loadWorkspace()).toBeNull();
  });

  it('preserves axisLabelOverrides through load/save (no migration)', () => {
    const ws = setAxisLabelOverride(createDefaultWorkspace(), 'swt_1', 'Soil tension');
    saveWorkspace(ws);
    expect(loadWorkspace()?.axisLabelOverrides).toEqual({ swt_1: 'Soil tension' });
  });
});
