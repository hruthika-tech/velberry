/**
 * Work that should finish after the HTTP response has been sent (e.g. emails).
 *
 * On a long-running server a dangling promise simply completes. On Vercel the function may be frozen as soon as
 * the response ends, so the promise is registered with the platform's waitUntil() — the same hook the official
 * @vercel/functions package uses (a request-context object Vercel exposes under a well-known global symbol).
 * Every promise is also tracked here so tests and graceful shutdown can wait for them.
 */
const REQUEST_CONTEXT = Symbol.for('@vercel/request-context');
const pending = new Set();

export function runInBackground(promise) {
  const p = Promise.resolve(promise).catch((e) => console.error('[background]', e?.message || e)).finally(() => pending.delete(p));
  pending.add(p);
  try {
    globalThis[REQUEST_CONTEXT]?.get?.()?.waitUntil?.(p);
  } catch { /* not on Vercel */ }
  return p;
}

/** Resolve once all background work started so far has finished. */
export async function settleBackground() {
  while (pending.size) await Promise.allSettled([...pending]);
}
