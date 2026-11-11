// Reads `data: {json}` frames from a Server-Sent-Events Response (lib/sse.ts).
// The padding comment, `retry:` and heartbeat comments are skipped.
//
// To end a stream, either abort the AbortController whose signal you passed to
// nextRequest() (the route's cleanup runs), or call close() / use readSseEvents.

// Real timers, captured before any test installs fake ones, so timeouts still fire.
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout

export type SseWaitOptions = { timeoutMs?: number }

export type SseReader<T = Record<string, unknown>> = {
  /** Every event received so far. */
  readonly events: T[]
  /**
   * Waits until `until(event, allEventsSoFar)` is true for an event not yet
   * consumed by an earlier waitFor(). Resolves with the events received up to
   * and including the match. Throws on timeout or stream end, listing the
   * events seen.
   */
  waitFor(
    until: (event: T, all: T[]) => boolean,
    opts?: SseWaitOptions,
  ): Promise<T[]>
  /** Cancels the stream (triggers the route's cleanup). */
  close(): Promise<void>
}

export function openSse<T = Record<string, unknown>>(
  res: Response,
): SseReader<T> {
  if (!res.body) throw new Error('openSse: response has no body')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const events: T[] = []
  let cursor = 0
  let buffer = ''
  let ended = false
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null

  function parseFrames() {
    let idx: number
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      const data = frame
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).replace(/^ /, ''))
        .join('\n')
      if (data) events.push(JSON.parse(data) as T)
    }
  }

  const describe = () => JSON.stringify(events)

  return {
    events,
    async waitFor(until, { timeoutMs = 2000 } = {}) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        while (cursor < events.length) {
          const event = events[cursor++]
          if (until(event, events)) return events.slice(0, cursor)
        }
        if (ended) {
          throw new Error(
            `SSE stream ended before the condition was met. Events: ${describe()}`,
          )
        }
        pending ??= reader.read()
        let timer: ReturnType<typeof setTimeout> | undefined
        const remaining = Math.max(deadline - Date.now(), 0)
        const result = await Promise.race([
          pending,
          new Promise<'timeout'>((resolve) => {
            timer = realSetTimeout(() => resolve('timeout'), remaining)
          }),
        ])
        realClearTimeout(timer)
        if (result === 'timeout') {
          // The unfinished read stays in `pending` for the next waitFor().
          throw new Error(
            `Timed out after ${timeoutMs}ms waiting for an SSE event. Events: ${describe()}`,
          )
        }
        pending = null
        if (result.done) ended = true
        else {
          buffer += decoder.decode(result.value, { stream: true })
          parseFrames()
        }
      }
    },
    async close() {
      ended = true
      await reader.cancel().catch(() => {})
    },
  }
}

/**
 * One-shot: reads until `until` matches, then cancels the stream. Returns all
 * events seen. Throws (with the events seen so far) on timeout.
 */
export async function readSseEvents<T = Record<string, unknown>>(
  res: Response,
  until: (event: T, all: T[]) => boolean,
  opts: SseWaitOptions = {},
): Promise<T[]> {
  const sse = openSse<T>(res)
  try {
    await sse.waitFor(until, opts)
    return [...sse.events]
  } finally {
    await sse.close()
  }
}
