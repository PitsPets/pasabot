/**
 * Hash routing: `#/<path>?<query>`. The first-run setup link already uses the fragment (`#/setup?token=`) so the
 * token never reaches a server log; every other screen follows the same scheme.
 */
import { useSyncExternalStore } from 'react';

export interface Route {
  path: string;
  query: URLSearchParams;
}

function parse(): Route {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path = '/', q = ''] = raw.split('?');
  return { path: path.startsWith('/') ? path : `/${path}`, query: new URLSearchParams(q) };
}

let current = parse();
const listeners = new Set<() => void>();
if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => {
    current = parse();
    for (const l of listeners) l();
  });
}

export function useRoute(): Route {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
    () => current,
  );
}

export function navigate(to: string, replace = false) {
  const hash = `#${to.startsWith('/') ? to : `/${to}`}`;
  if (replace) history.replaceState(null, '', hash);
  else history.pushState(null, '', hash);
  current = parse();
  for (const l of listeners) l();
}

/** `/chats/:id` style matching; returns params or null. */
export function match(pattern: string, path: string): Record<string, string> | null {
  const a = pattern.split('/').filter(Boolean);
  const b = path.split('/').filter(Boolean);
  if (a.length !== b.length) return null;
  const out: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.startsWith(':')) out[a[i]!.slice(1)] = decodeURIComponent(b[i]!);
    else if (a[i] !== b[i]) return null;
  }
  return out;
}
