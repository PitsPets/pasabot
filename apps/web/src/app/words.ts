/**
 * The plain-language glossary (FIRST-TIMER §3) for labels that have a technical name: with "Technical words"
 * switch off (the default, and before sign-in) a label reads its plain words from `plain.<key>`; with it on, the
 * technical label at `<key>` ("Trust level", "Model", "Server fingerprint").
 */
import { useCallback } from 'react';
import { useT } from './i18n.js';
import { usePrefs } from './prefs.js';

export type Words = (key: string, opts?: Record<string, unknown>) => string;

export function useWords(): Words {
  const t = useT();
  const advanced = usePrefs((s) => s.advanced);
  return (key, opts) => t(advanced ? key : `plain.${key}`, opts ?? {}) as string;
}

/**
 * Like `useWords`, for labels that may or may not have a plain wording: with "Technical words" off a key reads
 * `plain.<key>` when it exists ("Skills & tools" -> "Abilities & tools"), else `<key>`; with it on, always `<key>`.
 */
export function usePlainWords(): Words {
  const t = useT();
  const advanced = usePrefs((s) => s.advanced);
  return useCallback(
    (key: string, opts?: Record<string, unknown>) => {
      if (advanced) return t(key, opts ?? {}) as string;
      const MISSING = '\u0000';
      const v = t(plainKey(key), { ...opts, defaultValue: MISSING }) as string;
      return v === MISSING ? (t(key, opts ?? {}) as string) : v;
    },
    [t, advanced],
  );
}

/** `ns:a.b` -> `ns:plain.a.b` (a module's plain wording sits under `plain.` in its own namespace) */
export const plainKey = (key: string): string => {
  const at = key.indexOf(':');
  return at < 0 ? `plain.${key}` : `${key.slice(0, at + 1)}plain.${key.slice(at + 1)}`;
};

type Labelled = { labelKey: string; hintKey?: string; techLabelKey?: string };

/**
 * A Settings feature (a module's nav label and hint) in plain words while "Technical words" is off: its label and hint
 * keys switch to `<ns>:plain.<key>` when the module ships that key ("MCP servers" reads "Apps and tools helpers can
 * use"); with the switch on, or with no plain key, the feature is unchanged.
 */
export function usePlainFeature(): <F extends Labelled>(f: F) => F {
  const t = useT();
  const advanced = usePrefs((s) => s.advanced);
  return useCallback(
    <F extends Labelled>(f: F): F => {
      if (advanced) return f;
      const MISSING = '\u0000';
      const has = (k: string) => t(k, { defaultValue: MISSING }) !== MISSING;
      const label = plainKey(f.labelKey);
      const hint = f.hintKey ? plainKey(f.hintKey) : undefined;
      const plainLabel = has(label);
      const plainHint = hint !== undefined && has(hint);
      if (!plainLabel && !plainHint) return f;
      return {
        ...f,
        ...(plainLabel ? { labelKey: label, techLabelKey: f.labelKey } : {}),
        ...(plainHint ? { hintKey: hint } : {}),
      };
    },
    [t, advanced],
  );
}
