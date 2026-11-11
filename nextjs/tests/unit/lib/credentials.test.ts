import { describe, expect, it, vi } from 'vitest'
import { safeEqual, throttledLogin } from '@/lib/credentials'
import { useFakeClock } from '../../helpers/clock'

describe('safeEqual', () => {
  it('compares strings', () => {
    expect(safeEqual('secret', 'secret')).toBe(true)
    expect(safeEqual('secret', 'secreT')).toBe(false)
    expect(safeEqual('secret', 'secret2')).toBe(false)
    expect(safeEqual('', 'x')).toBe(false)
    expect(safeEqual('', '')).toBe(true)
  })

  it('compares utf-8 by bytes', () => {
    expect(safeEqual('pässwörd', 'pässwörd')).toBe(true)
    expect(safeEqual('ä', 'a')).toBe(false)
  })
})

describe('throttledLogin', () => {
  const fail = () => false

  it('returns the check result and runs the check', () => {
    const check = vi.fn(() => true)
    expect(throttledLogin('1.1.1.1', check)).toBe(true)
    expect(check).toHaveBeenCalledOnce()
    expect(throttledLogin('1.1.1.1', fail)).toBe(false)
  })

  it('locks an IP after 10 failures without running the check', () => {
    for (let i = 0; i < 10; i++) expect(throttledLogin('2.2.2.2', fail)).toBe(false)
    const check = vi.fn(() => true)
    expect(throttledLogin('2.2.2.2', check)).toBe(false)
    expect(check).not.toHaveBeenCalled()
  })

  it('still allows the 10th attempt to succeed after 9 failures', () => {
    for (let i = 0; i < 9; i++) throttledLogin('3.3.3.3', fail)
    expect(throttledLogin('3.3.3.3', () => true)).toBe(true)
  })

  it('does not reset the failure count on success', () => {
    for (let i = 0; i < 5; i++) throttledLogin('4.4.4.4', fail)
    expect(throttledLogin('4.4.4.4', () => true)).toBe(true)
    for (let i = 0; i < 5; i++) throttledLogin('4.4.4.4', fail)
    const check = vi.fn(() => true)
    expect(throttledLogin('4.4.4.4', check)).toBe(false)
    expect(check).not.toHaveBeenCalled()
  })

  it('tracks IPs independently', () => {
    for (let i = 0; i < 10; i++) throttledLogin('5.5.5.5', fail)
    expect(throttledLogin('5.5.5.5', () => true)).toBe(false)
    expect(throttledLogin('6.6.6.6', () => true)).toBe(true)
  })

  it('lifts the lockout 15 minutes after the first failure', () => {
    useFakeClock()
    for (let i = 0; i < 10; i++) {
      throttledLogin('7.7.7.7', fail)
      vi.advanceTimersByTime(60_000)
    }
    // 10 minutes in; the window started at the first failure.
    expect(throttledLogin('7.7.7.7', () => true)).toBe(false)
    vi.advanceTimersByTime(4 * 60_000)
    expect(throttledLogin('7.7.7.7', () => true)).toBe(false)
    vi.advanceTimersByTime(60_000 + 1000)
    expect(throttledLogin('7.7.7.7', () => true)).toBe(true)
  })

  it('starts counting afresh after the window expires', () => {
    useFakeClock()
    for (let i = 0; i < 9; i++) throttledLogin('8.8.8.8', fail)
    vi.advanceTimersByTime(15 * 60_000 + 1000)
    for (let i = 0; i < 9; i++) throttledLogin('8.8.8.8', fail)
    expect(throttledLogin('8.8.8.8', () => true)).toBe(true)
  })
})
