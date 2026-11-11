import { vi } from 'vitest'

// Fakes Date and the timer functions only. setImmediate must stay real:
// lib/events.ts batches notifyChanged() on it, and faking it would wedge the
// change hub. queueMicrotask/nextTick stay real too. Undone after each test
// (tests/setup/common.ts calls vi.useRealTimers()).
export function useFakeClock(
  now: number | Date = new Date('2026-01-01T12:00:00Z'),
): void {
  vi.useFakeTimers({
    toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    now,
  })
}

// Lets the change hub (setImmediate) deliver pending notifyChanged() calls to
// listeners. Two turns, so listeners that trigger further notifications settle.
export async function flushNotifications(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
  await new Promise<void>((resolve) => setImmediate(resolve))
}
