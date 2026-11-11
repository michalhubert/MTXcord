import { describe, expect, it, vi } from 'vitest'
import { waitForIceGathering } from '@/lib/webrtc'
import { useFakeClock } from '../../helpers/clock'

class FakePc extends EventTarget {
  iceGatheringState: string

  constructor(state = 'gathering') {
    super()
    this.iceGatheringState = state
  }

  finish() {
    this.iceGatheringState = 'complete'
    this.dispatchEvent(new Event('icegatheringstatechange'))
  }

  candidate(type: string | null) {
    const event = new Event('icecandidate') as Event & { candidate: unknown }
    event.candidate = type ? { type } : null
    this.dispatchEvent(event)
  }

  // For asserting that listeners were removed.
  listeners = { icegatheringstatechange: 0, icecandidate: 0 }
  override addEventListener(type: string, cb: EventListenerOrEventListenerObject | null) {
    this.listeners[type as keyof FakePc['listeners']]++
    super.addEventListener(type, cb)
  }
  override removeEventListener(type: string, cb: EventListenerOrEventListenerObject | null) {
    this.listeners[type as keyof FakePc['listeners']]--
    super.removeEventListener(type, cb)
  }
}

function track(promise: Promise<void>) {
  const state = { done: false }
  void promise.then(() => (state.done = true))
  return state
}

async function tick() {
  // Lets promise continuations run; timers are faked, microtasks are not.
  await Promise.resolve()
  await Promise.resolve()
}

describe('waitForIceGathering', () => {
  const asPc = (pc: FakePc) => pc as unknown as RTCPeerConnection

  it('returns at once when gathering is already complete', async () => {
    const pc = new FakePc('complete')
    await expect(waitForIceGathering(asPc(pc))).resolves.toBeUndefined()
    expect(pc.listeners).toEqual({ icegatheringstatechange: 0, icecandidate: 0 })
  })

  it('resolves when gathering completes', async () => {
    useFakeClock()
    const pc = new FakePc()
    const state = track(waitForIceGathering(asPc(pc)))
    await tick()
    expect(state.done).toBe(false)
    pc.finish()
    await tick()
    expect(state.done).toBe(true)
  })

  it('settles shortly after the first server-reflexive candidate', async () => {
    useFakeClock()
    const pc = new FakePc()
    const state = track(waitForIceGathering(asPc(pc), 1000, 100))
    pc.candidate('host')
    pc.candidate(null)
    vi.advanceTimersByTime(500)
    await tick()
    expect(state.done).toBe(false)

    pc.candidate('srflx')
    vi.advanceTimersByTime(99)
    await tick()
    expect(state.done).toBe(false)
    vi.advanceTimersByTime(1)
    await tick()
    expect(state.done).toBe(true)
  })

  it('does not restart the settle timer on a second srflx candidate', async () => {
    useFakeClock()
    const pc = new FakePc()
    const state = track(waitForIceGathering(asPc(pc), 5000, 100))
    pc.candidate('srflx')
    vi.advanceTimersByTime(60)
    pc.candidate('srflx')
    vi.advanceTimersByTime(40)
    await tick()
    expect(state.done).toBe(true)
  })

  it('gives up after the timeout', async () => {
    useFakeClock()
    const pc = new FakePc()
    const state = track(waitForIceGathering(asPc(pc), 1000, 100))
    pc.candidate('host')
    vi.advanceTimersByTime(999)
    await tick()
    expect(state.done).toBe(false)
    vi.advanceTimersByTime(1)
    await tick()
    expect(state.done).toBe(true)
  })

  it('uses a 1 second timeout by default', async () => {
    useFakeClock()
    const pc = new FakePc()
    const state = track(waitForIceGathering(asPc(pc)))
    vi.advanceTimersByTime(999)
    await tick()
    expect(state.done).toBe(false)
    vi.advanceTimersByTime(1)
    await tick()
    expect(state.done).toBe(true)
  })

  it.each([
    ['completes', (pc: FakePc) => pc.finish()],
    ['settles', (pc: FakePc) => pc.candidate('srflx')],
    ['times out', () => {}],
  ])('removes its listeners and timers when it %s', async (_name, act) => {
    useFakeClock()
    const pc = new FakePc()
    const promise = waitForIceGathering(asPc(pc), 1000, 100)
    expect(pc.listeners).toEqual({ icegatheringstatechange: 1, icecandidate: 1 })
    act(pc)
    vi.advanceTimersByTime(1000)
    await promise
    expect(pc.listeners).toEqual({ icegatheringstatechange: 0, icecandidate: 0 })
    expect(vi.getTimerCount()).toBe(0)
  })
})
