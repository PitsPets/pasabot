/**
 * Simplify spec 4: the signed-in person's sidebar pins (server-side, follow them across devices), the one-time
 * "we tidied up" card, and the owner's instance-wide "Not using this" list. Writes are optimistic; a failed write
 * rolls back and leaves a short note (`error`) for the shell to show.
 */
import { useSyncExternalStore } from 'react';
import { api } from './api.js';

export interface PrefsState {
  pins: string[];
  tidied: boolean;
  /** the Settings "Technical words" switch (per person, off by default; pref ui.advanced): the technical labels */
  advanced: boolean;
  /** the chats list's "Team talk" group is open (per person, closed by default; pref ui.teamTalk) */
  teamTalk: boolean;
  hidden: string[];
  loaded: boolean;
  /** a write that failed and was rolled back (cleared by `clearPrefsError`) */
  error: boolean;
}
const initial: PrefsState = {
  pins: [],
  tidied: true,
  advanced: false,
  teamTalk: false,
  hidden: [],
  loaded: false,
  error: false,
};
let state = initial;
const listeners = new Set<() => void>();
/**
 * Modules read the Technical words switch from `<html data-advanced>` and the `pasabot:advanced` event (they cannot import
 * this store), to show their technical labels only when it is on.
 */
const ADVANCED_EVENT = 'pasabot:advanced';
const set = (p: Partial<PrefsState>) => {
  const before = state.advanced;
  state = { ...state, ...p };
  for (const l of listeners) l();
  if (typeof document === 'undefined') return;
  if (state.advanced) document.documentElement.dataset.advanced = '1';
  else delete document.documentElement.dataset.advanced;
  if (before !== state.advanced) window.dispatchEvent(new CustomEvent(ADVANCED_EVENT));
};
export const getPrefs = () => state;
export function usePrefs<T>(sel: (s: PrefsState) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => sel(state),
    () => sel(state),
  );
}

type PrefsDTO = {
  prefs: { 'ui.pins': string[]; 'ui.tidied': boolean; 'ui.advanced'?: boolean; 'ui.teamTalk'?: boolean };
};

export async function loadPrefs() {
  const [p, f] = await Promise.all([
    api<PrefsDTO>('/api/v1/me/prefs').catch(() => null),
    api<{ hidden: string[] }>('/api/v1/settings/features').catch(() => null),
  ]);
  confirmedPins = p?.prefs['ui.pins'] ?? [];
  set({
    pins: confirmedPins,
    tidied: p?.prefs['ui.tidied'] ?? true,
    advanced: p?.prefs['ui.advanced'] ?? false,
    teamTalk: p?.prefs['ui.teamTalk'] ?? false,
    hidden: f?.hidden ?? [],
    loaded: true,
  });
}
export const resetPrefs = () => {
  confirmedPins = [];
  set(initial);
};
export const clearPrefsError = () => set({ error: false });

/**
 * Pin writes go one at a time, newest wins: a write that a newer toggle has replaced is skipped, an older answer
 * never lands over a newer optimistic list, and a failure rolls back to what the server last confirmed.
 */
let pinSeq = 0;
let pinQueue: Promise<void> = Promise.resolve();
let confirmedPins: string[] = [];
export function setPins(next: string[]): Promise<void> {
  const seq = ++pinSeq;
  set({ pins: next, error: false });
  pinQueue = pinQueue.then(async () => {
    if (seq !== pinSeq) return;
    try {
      const r = await api<PrefsDTO>('/api/v1/me/prefs/ui.pins', { method: 'PUT', body: { value: next } });
      confirmedPins = r.prefs['ui.pins'];
      if (seq === pinSeq) set({ pins: confirmedPins });
    } catch {
      if (seq === pinSeq) set({ pins: confirmedPins, error: true });
    }
  });
  return pinQueue;
}
export const togglePin = (id: string, on: boolean) =>
  setPins(on ? [...state.pins.filter((x) => x !== id), id] : state.pins.filter((x) => x !== id));
/**
 * Move a pin one place among the pins on screen (`shown`, in order: pins of a feature that is gone or hidden are
 * not drawn); the two swap places in the stored list and every pin that is not drawn keeps its spot.
 */
export function movePin(id: string, by: -1 | 1, shown: readonly string[] = state.pins) {
  const list = shown.filter((x) => state.pins.includes(x));
  const i = list.indexOf(id);
  const j = i + by;
  if (i < 0 || j < 0 || j >= list.length) return;
  const other = list[j]!;
  return setPins(state.pins.map((x) => (x === id ? other : x === other ? id : x)));
}

export async function dismissTidied() {
  set({ tidied: true });
  await api('/api/v1/me/prefs/ui.tidied', { method: 'PUT', body: { value: true } }).catch(() => {});
}

/** The Settings "Technical words" switch (this person only); a failed write rolls back. */
export async function setAdvanced(on: boolean) {
  const before = state.advanced;
  set({ advanced: on, error: false });
  try {
    const r = await api<PrefsDTO>('/api/v1/me/prefs/ui.advanced', { method: 'PUT', body: { value: on } });
    set({ advanced: r.prefs['ui.advanced'] ?? on });
  } catch {
    set({ advanced: before, error: true });
  }
}

/** Open or close the chats list's "Team talk" group (this person only, remembered on every device). */
export async function setTeamTalk(open: boolean) {
  set({ teamTalk: open });
  try {
    await api('/api/v1/me/prefs/ui.teamTalk', { method: 'PUT', body: { value: open } });
  } catch {
    // not saved: the group stays as the person left it here, and opens as saved next time
  }
}

/** Owner only: hide or show a feature for everyone (a UI hide; the module keeps running). */
export async function setHidden(id: string, hide: boolean) {
  const before = state.hidden;
  const pinsAt = pinSeq;
  const next = hide ? [...new Set([...before, id])] : before.filter((x) => x !== id);
  set({ hidden: next, error: false });
  try {
    const r = await api<{ hidden: string[] }>('/api/v1/settings/features', {
      method: 'PUT',
      body: { hidden: next },
    });
    set({ hidden: r.hidden });
    // pins of a hidden feature drop out server-side; read them back
    const p = await api<PrefsDTO>('/api/v1/me/prefs');
    confirmedPins = p.prefs['ui.pins'];
    // a pin toggle sent meanwhile answers for itself
    if (pinSeq === pinsAt) set({ pins: confirmedPins });
  } catch {
    set({ hidden: before, error: true });
  }
}
