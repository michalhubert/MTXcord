import { describe, expect, it, vi } from 'vitest'
import { eventStream, type EventStream } from '@/lib/sse'
import { useFakeClock } from '../../helpers/clock'

function request(signal?: AbortSignal): Request {
  return new Request('http://localhost/api/events', { signal })
}

async function readText(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const { value, done } = await reader.read()
  return { text: value ? new TextDecoder().decode(value) : '', done }
}

describe('eventStream', () => {
  it('returns an SSE response with proxy-friendly headers', () => {
    const res = eventStream(request(), () => {})
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('no-cache, no-transform')
    expect(res.headers.get('x-accel-buffering')).toBe('no')
    void res.body?.cancel()
  })

  it('starts with 2048 bytes of padding and a retry hint', async () => {
    const res = eventStream(request(), () => {})
    const reader = res.body!.getReader()
    const { text } = await readText(reader)
    expect(text).toBe(`:${' '.repeat(2048)}\n\nretry: 1000\n\n`)
    await reader.cancel()
  })

  it('writes sent events as data frames', async () => {
    let stream!: EventStream
    const res = eventStream(request(), (s) => {
      stream = s
    })
    const reader = res.body!.getReader()
    await readText(reader) // preamble
    stream.send({ type: 'hello', n: 1 })
    stream.send({ type: 'bye' })
    expect((await readText(reader)).text).toBe('data: {"type":"hello","n":1}\n\n')
    expect((await readText(reader)).text).toBe('data: {"type":"bye"}\n\n')
    await reader.cancel()
  })

  it('can send events while starting up, after the preamble', async () => {
    const res = eventStream(request(), (s) => s.send({ type: 'first' }))
    const reader = res.body!.getReader()
    expect((await readText(reader)).text).toMatch(/^: +\n\nretry: 1000\n\n$/)
    expect((await readText(reader)).text).toBe('data: {"type":"first"}\n\n')
    await reader.cancel()
  })

  it('pings and calls the heartbeat handler every 10 seconds', async () => {
    useFakeClock()
    const heartbeat = vi.fn()
    const res = eventStream(request(), () => ({ heartbeat }))
    const reader = res.body!.getReader()
    await readText(reader)

    vi.advanceTimersByTime(9_999)
    expect(heartbeat).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(heartbeat).toHaveBeenCalledTimes(1)
    expect((await readText(reader)).text).toBe(': ping\n\n')

    vi.advanceTimersByTime(10_000)
    expect(heartbeat).toHaveBeenCalledTimes(2)
    await reader.cancel()
  })

  it('runs cleanup once when the request aborts, and stops heartbeats', async () => {
    useFakeClock()
    const close = vi.fn()
    const heartbeat = vi.fn()
    const controller = new AbortController()
    const res = eventStream(request(controller.signal), () => ({ close, heartbeat }))
    const reader = res.body!.getReader()
    await readText(reader)

    controller.abort()
    expect(close).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(30_000)
    expect(heartbeat).not.toHaveBeenCalled()
    expect((await readText(reader)).done).toBe(true)
  })

  it('runs cleanup once when the client cancels', async () => {
    const close = vi.fn()
    const res = eventStream(request(), () => ({ close }))
    const reader = res.body!.getReader()
    await readText(reader)
    await reader.cancel()
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('runs cleanup once when the server closes the stream itself', async () => {
    const close = vi.fn()
    let stream!: EventStream
    const res = eventStream(request(), (s) => {
      stream = s
      return { close }
    })
    const reader = res.body!.getReader()
    await readText(reader)
    stream.close()
    stream.close()
    expect(close).toHaveBeenCalledTimes(1)
    expect((await readText(reader)).done).toBe(true)
  })

  it('does not run cleanup twice for abort followed by cancel', async () => {
    const close = vi.fn()
    const controller = new AbortController()
    const res = eventStream(request(controller.signal), () => ({ close }))
    const reader = res.body!.getReader()
    await readText(reader)
    controller.abort()
    await reader.cancel().catch(() => {})
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('cleans up immediately for an already-aborted request', async () => {
    const close = vi.fn()
    const res = eventStream(request(AbortSignal.abort()), () => ({ close }))
    expect(close).toHaveBeenCalledTimes(1)
    const reader = res.body!.getReader()
    await readText(reader)
    expect((await readText(reader)).done).toBe(true)
  })

  it('survives a throwing close handler', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const controller = new AbortController()
    const res = eventStream(request(controller.signal), () => ({
      close: () => {
        throw new Error('boom')
      },
    }))
    const reader = res.body!.getReader()
    await readText(reader)
    expect(() => controller.abort()).not.toThrow()
    expect(error).toHaveBeenCalled()
    expect((await readText(reader)).done).toBe(true)
  })

  it('ignores sends after close', async () => {
    let stream!: EventStream
    const res = eventStream(request(), (s) => {
      stream = s
    })
    const reader = res.body!.getReader()
    await readText(reader)
    stream.close()
    expect(() => stream.send({ late: true })).not.toThrow()
    expect((await readText(reader)).done).toBe(true)
  })
})
