/**
 * Look (account menu, Settings › Language & look): Dark is the default for a new person (the approved Stage and app
 * look); Light forces light, and Auto follows the device (dark on phones). Each forces or clears `data-theme` on
 * <html>. Remembered on this device only (storage may be unavailable: then the default, Dark).
 */
import { useSyncExternalStore } from 'react';

export type Look = 'auto' | 'light' | 'dark';
/** what a person who never picked a look sees */
export const DEFAULT_LOOK: Look = 'dark';
const KEY = 'pasabot.look';
/** set once this device's look was settled after Dark became the default (see `readLook`) */
const SETTLED = 'pasabot.look.settled';
/** what the app keeps for a signed-in session in this tab (store.ts): a marker that the app was used here */
const SESSION_MARK = 'pasabot.lastSeq';
const listeners = new Set<() => void>();

/** The device already used the app: another `pasabot.*` pref is kept here, or this tab holds a session marker. */
function usedBefore(): boolean {
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith('pasabot.') && k !== KEY && k !== SETTLED) return true;
  }
  try {
    return sessionStorage.getItem(SESSION_MARK) !== null;
  } catch {
    return false;
  }
}

/**
 * The stored look, else the default. Before Dark became the default, picking Auto removed the stored key, and Auto
 * was what everyone who never picked saw: so once, on a device that already used the app but has no stored look,
 * Auto is stored (that person keeps what they had); a truly fresh device is settled on the default, Dark.
 */
export function readLook(): Look {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark' || v === 'auto') return v;
    if (localStorage.getItem(SETTLED) === null) {
      const look: Look | null = usedBefore() ? 'auto' : null;
      if (look) localStorage.setItem(KEY, look);
      localStorage.setItem(SETTLED, '1');
      if (look) return look;
    }
    return DEFAULT_LOOK;
  } catch {
    return DEFAULT_LOOK;
  }
}
let current: Look = typeof window === 'undefined' ? DEFAULT_LOOK : readLook();

export function applyLook(v: Look = current) {
  if (typeof document === 'undefined') return;
  if (v === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', v);
}

export function setLook(v: Look) {
  current = v;
  try {
    // every pick is kept, Auto too: no stored pick means the default (Dark), not Auto
    localStorage.setItem(KEY, v);
  } catch {
    // storage unavailable: this page only
  }
  applyLook(v);
  for (const l of listeners) l();
}

export function useLook(): Look {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
    () => current,
  );
}
