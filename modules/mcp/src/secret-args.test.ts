import type { ScopedVault } from '@pasabot/core';
import { describe, expect, it } from 'vitest';
import { fillSecretArgs, SecretArgError } from './secret-args.js';

/** a fake agent-scoped vault: only `granted` resolves, everything else fails the way agentScopedVault does */
const vaultOf = (granted: Record<string, string>) => {
  const reads: string[] = [];
  const v: ScopedVault = {
    async resolve(ref) {
      const name = ref.slice('{{secret:'.length, -2);
      reads.push(name);
      if (!(name in granted)) throw new Error(`no secret named "${name}" is granted to this agent`);
      return granted[name]!;
    },
  };
  return { v, reads };
};

describe('fillSecretArgs', () => {
  it('fills placeholders anywhere in nested string arguments and leaves the input untouched', async () => {
    const { v } = vaultOf({ api: 'k3y-value-123', 'h.auth': 'tok-456-xyz' });
    const args = {
      headers: { Authorization: 'Bearer {{secret:h.auth}}' },
      list: ['{{secret:api}}', 7, null, { deep: 'x={{secret:api}}&y={{secret:api}}' }],
      plain: 'no refs here {{ secret:api }}',
    };
    const before = JSON.stringify(args);
    const f = await fillSecretArgs(args, v);
    expect(f.args).toEqual({
      headers: { Authorization: 'Bearer tok-456-xyz' },
      list: ['k3y-value-123', 7, null, { deep: 'x=k3y-value-123&y=k3y-value-123' }],
      plain: 'no refs here {{ secret:api }}',
    });
    expect(JSON.stringify(args)).toBe(before); // approvals/events keep seeing the placeholder
    expect(f.names.sort()).toEqual(['api', 'h.auth']);
  });

  it('redacts the filled values and their encoded forms out of results', async () => {
    const { v } = vaultOf({ api: 'k3y "value" 123' });
    const f = await fillSecretArgs({ q: '{{secret:api}}' }, v);
    const b64 = Buffer.from('k3y "value" 123').toString('base64');
    expect(f.redact(`got k3y "value" 123 / ${b64} / ${encodeURIComponent('k3y "value" 123')}`)).toBe(
      'got [secret:api] / [secret:api] / [secret:api]',
    );
    expect(f.redactDeep({ a: [{ b: 'k3y "value" 123' }] })).toEqual({ a: [{ b: '[secret:api]' }] });
  });

  it('fails closed on a name that is not granted, unknown or malformed, before reading anything else', async () => {
    const { v, reads } = vaultOf({ api: 'k3y-value-123' });
    await expect(fillSecretArgs({ a: '{{secret:other}}' }, v)).rejects.toThrow(
      /no secret named "other" is granted to you.*nothing was sent/,
    );
    await expect(fillSecretArgs({ a: '{{secret:bad name}}' }, v)).rejects.toBeInstanceOf(SecretArgError);
    await expect(fillSecretArgs({ a: '{{secret:1abc}}' }, v)).rejects.toThrow(/not a valid secret name/);
    expect(reads).toEqual(['other']); // malformed names never reach the vault
  });

  it('passes arguments without placeholders through as they are', async () => {
    const { v, reads } = vaultOf({});
    const args = { a: 'hello', n: 1 };
    const f = await fillSecretArgs(args, v);
    expect(f.args).toBe(args);
    expect(f.redact('hello')).toBe('hello');
    expect(reads).toEqual([]);
  });

  it('refuses to fill a value shorter than 8 characters and tells the owner to store a longer one', async () => {
    const { v } = vaultOf({ pin: '1234567', ok: '12345678' });
    const err = await fillSecretArgs({ a: 'x {{secret:pin}}', b: '{{secret:ok}}' }, v).catch((e) => e);
    expect(err).toBeInstanceOf(SecretArgError);
    expect(String(err.message)).toMatch(/"pin" is too short.*store a longer value.*nothing was sent/);
    expect(String(err.message)).not.toContain('1234567');
    await expect(fillSecretArgs({ a: '{{secret:ok}}' }, v)).resolves.toMatchObject({ names: ['ok'] });
  });

  it('redacts every derived form of a filled value, however short the form', async () => {
    // an 8-character value whose forms include short and padded ones
    const value = 'a/b c+d=';
    const { v } = vaultOf({ k: value });
    const f = await fillSecretArgs({ q: '{{secret:k}}' }, v);
    const raw = Buffer.from(value, 'utf8');
    const derived = [
      value,
      JSON.stringify(value).slice(1, -1),
      encodeURIComponent(value),
      raw.toString('base64'),
      raw.toString('base64').replace(/=+$/, ''),
      raw.toString('base64url'),
    ];
    for (const d of derived) expect(f.redact(`[${d}]`)).toBe('[[secret:k]]');
    expect(f.redactDeep({ deep: [{ v: `${value} ${raw.toString('base64url')}` }] })).toEqual({
      deep: [{ v: '[secret:k] [secret:k]' }],
    });
  });
});
