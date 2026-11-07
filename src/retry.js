/**
 * Run an async task, retrying with increasing pauses if it throws.
 * Every failed attempt is logged with the label, so dropped requests show up
 * in the console with enough detail to spot a pattern.
 *
 * @template T
 * @param {() => Promise<T>} task
 * @param {string} label   what is being loaded, e.g. "chunk 3-2-1-0"
 * @param {{ attempts?: number, delayMs?: number }} [opts]
 * @returns {Promise<T>}
 */
export async function withRetry(task, label, { attempts = 3, delayMs = 400 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = await task();
      if (attempt > 1) console.info(`[load] ${label}: succeeded on attempt ${attempt}`);
      return result;
    } catch (err) {
      lastError = err;
      const final = attempt === attempts;
      console[final ? 'error' : 'warn'](
        `[load] ${label}: attempt ${attempt}/${attempts} failed${final ? ', giving up' : ', retrying'}:`,
        err?.message ?? err
      );
      if (!final) await new Promise((r) => setTimeout(r, delayMs * 2 ** (attempt - 1)));
    }
  }
  throw lastError;
}

/** fetch() that treats HTTP errors (404, 500…) as failures too, with retries. */
export function fetchWithRetry(url, label = url) {
  return withRetry(async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res;
  }, label);
}
