import { afterEach, describe, expect, it } from 'vitest';
import { candidateFromHash, routeFromHash } from '../../src/routes';

describe('candidate hash parsing', () => {
  afterEach(() => window.history.replaceState(null, '', '#/uplot'));

  it('normalizes an invalid hash to the canonical uplot route', () => {
    window.history.replaceState(null, '', '#/unknown');
    expect(candidateFromHash()).toBe('uplot');
    expect(window.location.hash).toBe('#/uplot');
  });

  it('accepts a valid candidate without rewriting the hash', () => {
    window.history.replaceState(null, '', '#/echarts');
    expect(candidateFromHash()).toBe('echarts');
    expect(window.location.hash).toBe('#/echarts');
  });

  it('keeps pilot hashes separate from candidate fallback', () => {
    window.history.replaceState(null, '', '#/pilot/edge');
    expect(routeFromHash()).toEqual({ kind: 'pilot', platform: 'edge' });
    expect(window.location.hash).toBe('#/pilot/edge');
    window.history.replaceState(null, '', '#/pilot/cloud');
    expect(routeFromHash()).toEqual({ kind: 'pilot', platform: 'cloud' });
  });

  it('returns candidate routes and canonicalizes unknown routes', () => {
    window.history.replaceState(null, '', '#/uplot');
    expect(routeFromHash()).toEqual({ kind: 'candidate', candidate: 'uplot' });
    window.history.replaceState(null, '', '#/wat');
    expect(routeFromHash()).toEqual({ kind: 'candidate', candidate: 'uplot' });
    expect(window.location.hash).toBe('#/uplot');
  });
});
