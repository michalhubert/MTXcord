import { describe, expect, it, vi } from 'vitest'
import { approveAccess, isApproved } from '@/lib/accessRequests'
import { createStreamSession, getStreamSessionByPath } from '@/lib/db'
import { onChanged } from '@/lib/events'
import {
  isStreamOnline,
  refreshStreamStates,
  syncStreamState,
  watchStreamStates,
} from '@/lib/streamState'
import { flushNotifications } from '../../helpers/clock'
import { useFakeMediamtx } from '../../helpers/msw'

describe('syncStreamState', () => {
  it('ignores an empty path', () => {
    syncStreamState('', { ready: true })
    expect(getStreamSessionByPath('')).toBeNull()
  })

  it('creates a session when a stream goes online and clears approvals', () => {
    approveAccess('live', '1.1.1.1', 'viewer')
    syncStreamState('live', { ready: true, readyTime: '2026-01-01T00:00:00.000Z' })

    const session = getStreamSessionByPath('live')
    expect(session?.resource_id).toBe(String(Date.parse('2026-01-01T00:00:00.000Z')))
    expect(isStreamOnline('live')).toBe(true)
    expect(isApproved('live', '1.1.1.1', 'viewer')).toBe(false)
  })

  it('falls back to the current time without a readyTime', () => {
    const before = Date.now()
    syncStreamState('live', { ready: true })
    const id = Number(getStreamSessionByPath('live')?.resource_id)
    expect(id).toBeGreaterThanOrEqual(before)
    expect(id).toBeLessThanOrEqual(Date.now())
  })

  it('is idempotent while online: approvals granted meanwhile survive', () => {
    syncStreamState('live', { ready: true })
    const first = getStreamSessionByPath('live')
    approveAccess('live', '1.1.1.1', 'viewer')
    syncStreamState('live', { ready: true, readyTime: '2030-01-01T00:00:00Z' })
    expect(getStreamSessionByPath('live')).toEqual(first)
    expect(isApproved('live', '1.1.1.1', 'viewer')).toBe(true)
  })

  it('deletes the session and clears approvals when the stream goes offline', () => {
    syncStreamState('live', { ready: true })
    approveAccess('live', '1.1.1.1', 'viewer')
    syncStreamState('live', { ready: false })
    expect(isStreamOnline('live')).toBe(false)
    expect(isApproved('live', '1.1.1.1', 'viewer')).toBe(false)
  })

  it.each([undefined, null, {}])('treats %j as offline', (info) => {
    createStreamSession('live')
    syncStreamState('live', info)
    expect(isStreamOnline('live')).toBe(false)
  })

  it('leaves approvals alone when offline with no session', () => {
    approveAccess('live', '1.1.1.1', 'viewer')
    syncStreamState('live', { ready: false })
    expect(isApproved('live', '1.1.1.1', 'viewer')).toBe(true)
  })

  it('notifies only on real transitions', async () => {
    await flushNotifications()
    const listener = vi.fn()
    onChanged(listener)

    syncStreamState('live', { ready: false })
    await flushNotifications()
    expect(listener).not.toHaveBeenCalled()

    syncStreamState('live', { ready: true })
    await flushNotifications()
    expect(listener).toHaveBeenCalledTimes(1)

    syncStreamState('live', { ready: true })
    await flushNotifications()
    expect(listener).toHaveBeenCalledTimes(1)

    syncStreamState('live', { ready: false })
    await flushNotifications()
    expect(listener).toHaveBeenCalledTimes(2)
  })
})

describe('refreshStreamStates', () => {
  it('reconciles the listed paths with MediaMTX', async () => {
    const fake = useFakeMediamtx()
    fake.setReady('up', true)
    fake.addConfiguredPath('idle')
    createStreamSession('idle')
    createStreamSession('unlisted')

    const paths = await refreshStreamStates()
    expect(paths?.map((p) => p.name).sort()).toEqual(['idle', 'up'])
    expect(isStreamOnline('up')).toBe(true)
    expect(isStreamOnline('idle')).toBe(false)
    // Paths MediaMTX does not mention are not touched.
    expect(isStreamOnline('unlisted')).toBe(true)
  })

  it('returns null and changes nothing while MediaMTX is down', async () => {
    const fake = useFakeMediamtx()
    fake.setReady('up', true)
    fake.setDown(true)
    createStreamSession('other')

    expect(await refreshStreamStates()).toBeNull()
    expect(isStreamOnline('up')).toBe(false)
    expect(isStreamOnline('other')).toBe(true)
  })
})

describe('watchStreamStates', () => {
  function spyTimers() {
    const set = vi.spyOn(globalThis, 'setInterval').mockImplementation((() => 123) as never)
    const clear = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {})
    return { set, clear }
  }

  it('polls every 10 seconds while someone watches', async () => {
    const { set } = spyTimers()
    const fake = useFakeMediamtx()
    fake.setReady('live', true)
    const stop = watchStreamStates()

    expect(set).toHaveBeenCalledTimes(1)
    expect(set.mock.calls[0][1]).toBe(10_000)

    // Fire a tick by hand.
    ;(set.mock.calls[0][0] as () => void)()
    for (let i = 0; i < 50 && !isStreamOnline('live'); i++) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    expect(isStreamOnline('live')).toBe(true)
    stop()
  })

  it('shares one timer between watchers and stops after the last one', () => {
    const { set, clear } = spyTimers()
    const stopA = watchStreamStates()
    const stopB = watchStreamStates()
    expect(set).toHaveBeenCalledTimes(1)

    stopA()
    expect(clear).not.toHaveBeenCalled()
    stopB()
    expect(clear).toHaveBeenCalledTimes(1)
  })

  it('makes stop idempotent', () => {
    const { set, clear } = spyTimers()
    const stopA = watchStreamStates()
    const stopB = watchStreamStates()
    stopA()
    stopA()
    stopA()
    expect(clear).not.toHaveBeenCalled()
    stopB()
    stopB()
    expect(clear).toHaveBeenCalledTimes(1)

    // A later watcher starts a new timer.
    const stopC = watchStreamStates()
    expect(set).toHaveBeenCalledTimes(2)
    stopC()
  })
})
