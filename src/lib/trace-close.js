/**
 * What Escape, back or the popup asking to close does to Ask Trace
 * (TraceApps/notetrace#35):
 *   'stop'  Trace is working: stop the request (at the provider too) and close.
 *   'keep'  the "Discard Trace's answer?" question is showing: keep the answer.
 *   'ask'   an answer isn't used yet: ask before discarding it.
 *   'close' nothing to lose.
 */
export function closeStep({ busy = false, waiting = false, asking = false } = {}) {
  if (busy) return 'stop';
  if (asking) return 'keep';
  if (waiting) return 'ask';
  return 'close';
}

/**
 * One Ask Trace request at a time. `run` gives { reply }, { error }, or
 * { cancelled } when it was stopped or a newer one took its place: a late
 * reply is never shown. `stop` cancels what's running.
 */
export function createAsk(ask) {
  let current = null;
  return {
    async run(args) {
      current?.abort();
      const mine = current = new AbortController();
      const gone = () => mine.signal.aborted || current !== mine;
      try {
        const reply = await ask({ ...args, signal: mine.signal });
        return gone() ? { cancelled: true } : { reply };
      } catch (error) {
        return gone() ? { cancelled: true } : { error };
      } finally {
        if (current === mine) current = null;
      }
    },
    stop() {
      current?.abort();
      current = null;
    },
  };
}
