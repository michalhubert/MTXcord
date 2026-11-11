import { describe, expect, it } from 'vitest'
import { getPathVisibility, setPathVisibility } from '@/lib/db'
import { resetServerState } from '../helpers/state'

describe('harness smoke (unit)', () => {
  it('uses an in-memory DB that resetServerState() wipes', () => {
    expect(process.env.MTXCORD_DB_PATH).toBe(':memory:')
    expect(getPathVisibility('x')).toBe('private')

    setPathVisibility('x', 'public')
    expect(getPathVisibility('x')).toBe('public')

    resetServerState()
    expect(getPathVisibility('x')).toBe('private')
  })

  it('starts each test with a fresh DB', () => {
    expect(getPathVisibility('x')).toBe('private')
  })

  it('blocks requests no handler declared', async () => {
    // example.com resolves, so a rejection here comes from MSW, not from DNS.
    const failure = await fetch('http://example.com/anything').then(
      () => null,
      (err: Error) => err,
    )
    expect(failure).toBeInstanceOf(TypeError)
    expect(String(failure?.cause)).toMatch(/\[MSW\]/)
  })
})
