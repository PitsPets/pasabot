import { describe, expect, it } from 'vitest';
import { effectiveTrust } from './provider.js';

describe('effectiveTrust', () => {
  it('owner turns run at the lower of agent and sender trust', () => {
    expect(effectiveTrust('trusted', { kind: 'owner', trust: 'trusted' })).toBe('trusted');
    expect(effectiveTrust('trusted', { kind: 'owner', trust: 'standard' })).toBe('standard');
    expect(effectiveTrust('guarded', { kind: 'owner', trust: 'trusted' })).toBe('guarded');
  });
  it('every other sender runs one level lower, never below guarded', () => {
    expect(effectiveTrust('trusted', { kind: 'member', trust: 'trusted' })).toBe('standard');
    expect(effectiveTrust('trusted', { kind: 'external', trust: 'standard' })).toBe('guarded');
    expect(effectiveTrust('trusted', { kind: 'webhook', trust: 'guarded' })).toBe('guarded');
    expect(effectiveTrust('standard', { kind: 'agent', trust: 'trusted' })).toBe('guarded');
  });
});
