import { beforeEach, describe, expect, it, vi } from 'vitest'
import { affectsPath, ALL_PATHS, notifyChanged, onChanged } from '@/lib/events'
import { flushNotifications } from '../../helpers/clock'

// Earlier tests may have left a flush scheduled (resetServerState does not
// cancel setImmediate callbacks), so drain it before counting calls.
beforeEach(async () => {
  await flushNotifications()
})

describe('notifyChanged / onChanged', () => {
  it('does not call listeners synchronously', async () => {
    const listener = vi.fn()
    onChanged(listener)
    notifyChanged('a')
    expect(listener).not.toHaveBeenCalled()
    await flushNotifications()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('batches notifications from one tick into a single call', async () => {
    const listener = vi.fn()
    onChanged(listener)
    notifyChanged('a')
    notifyChanged('b')
    notifyChanged('a')
    await flushNotifications()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0][0]).toEqual(new Set(['a', 'b']))
  })

  it('delivers to every listener', async () => {
    const one = vi.fn()
    const two = vi.fn()
    onChanged(one)
    onChanged(two)
    notifyChanged('a')
    await flushNotifications()
    expect(one).toHaveBeenCalledOnce()
    expect(two).toHaveBeenCalledOnce()
  })

  it('starts a new batch after a flush', async () => {
    const listener = vi.fn()
    onChanged(listener)
    notifyChanged('a')
    await flushNotifications()
    notifyChanged('b')
    await flushNotifications()
    expect(listener.mock.calls.map((c) => [...c[0]])).toEqual([['a'], ['b']])
  })

  it('stops calling a listener after unsubscribing', async () => {
    const listener = vi.fn()
    const off = onChanged(listener)
    off()
    notifyChanged('a')
    await flushNotifications()
    expect(listener).not.toHaveBeenCalled()
  })

  it('isolates a throwing listener from the others', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const bad = vi.fn(() => {
      throw new Error('boom')
    })
    const good = vi.fn()
    onChanged(bad)
    onChanged(good)
    notifyChanged('a')
    await flushNotifications()
    expect(bad).toHaveBeenCalledOnce()
    expect(good).toHaveBeenCalledOnce()
    expect(error).toHaveBeenCalled()
  })

  it('delivers notifications raised by a listener in a later batch', async () => {
    const seen: string[][] = []
    onChanged((paths) => {
      seen.push([...paths])
      if (paths.has('a')) notifyChanged('b')
    })
    notifyChanged('a')
    await flushNotifications()
    expect(seen).toEqual([['a'], ['b']])
  })
})

describe('affectsPath', () => {
  it('matches the path itself', () => {
    expect(affectsPath(new Set(['a']), 'a')).toBe(true)
    expect(affectsPath(new Set(['a']), 'b')).toBe(false)
    expect(affectsPath(new Set(), 'a')).toBe(false)
  })

  it('matches every path for ALL_PATHS', () => {
    expect(affectsPath(new Set([ALL_PATHS]), 'anything')).toBe(true)
  })
})
