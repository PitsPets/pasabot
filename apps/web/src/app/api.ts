/**
 * REST client: same-origin cookie session, JSON in and out. The session is the HttpOnly cookie alone: the server
 * leaves the token out of response bodies for requests that carry an Origin, so the app never sees it.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export async function api<T = any>(
  path: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const method = init.method ?? (init.body === undefined ? 'GET' : 'POST');
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: init.body === undefined ? {} : { 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init.signal,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) throw new ApiError(res.status, json?.error ?? `http_${res.status}`, json?.message);
  return json as T;
}

export const post = <T = any>(path: string, body: unknown = {}) => api<T>(path, { method: 'POST', body });
