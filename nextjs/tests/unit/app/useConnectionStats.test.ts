import { describe, expect, it, vi } from 'vitest'
import {
  evaluate,
  qualityOf,
  takeSample,
  WARN_AT,
  type ConnectionWarning,
  type Sample,
} from '@/app/[path]/hooks/useConnectionStats'

function fakePc(stats: Record<string, unknown>[]): RTCPeerConnection {
  const report = new Map(stats.map((s, i) => [String(i), s]))
  return { getStats: vi.fn(async () => report) } as unknown as RTCPeerConnection
}

describe('takeSample', () => {
  it('sums inbound audio and video, taking fps and jitter from the video', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(1234)
    const sample = await takeSample(
      fakePc([
        {
          type: 'inbound-rtp',
          kind: 'video',
          packetsReceived: 100,
          packetsLost: 4,
          bytesReceived: 50_000,
          framesDecoded: 90,
          framesDropped: 3,
          freezeCount: 1,
          framesPerSecond: 29.5,
          jitter: 0.012,
        },
        {
          type: 'inbound-rtp',
          kind: 'audio',
          packetsReceived: 40,
          packetsLost: 1,
          bytesReceived: 2_000,
          // Audio jitter and frame counters must not leak into the video fields.
          jitter: 0.5,
          framesDecoded: 999,
        },
      ]),
    )
    expect(sample).toEqual({
      at: 1234,
      packetsReceived: 140,
      packetsLost: 5,
      bytesReceived: 52_000,
      framesDecoded: 90,
      framesDropped: 3,
      freezeCount: 1,
      jitterMs: 12,
      rttMs: null,
      fps: 29.5,
    })
  })

  it('clamps negative packetsLost (duplicates) to zero', async () => {
    const sample = await takeSample(
      fakePc([
        { type: 'inbound-rtp', kind: 'video', packetsReceived: 10, packetsLost: -5 },
        { type: 'inbound-rtp', kind: 'audio', packetsReceived: 10, packetsLost: 2 },
      ]),
    )
    expect(sample.packetsLost).toBe(2)
  })

  it('treats missing counters as zero and missing fps/jitter as null', async () => {
    const sample = await takeSample(fakePc([{ type: 'inbound-rtp', kind: 'video' }]))
    expect(sample).toMatchObject({
      packetsReceived: 0,
      packetsLost: 0,
      bytesReceived: 0,
      framesDecoded: 0,
      jitterMs: null,
      fps: null,
    })
  })

  it('reads RTT from a succeeded, nominated candidate pair', async () => {
    const sample = await takeSample(
      fakePc([
        { type: 'candidate-pair', state: 'succeeded', nominated: true, currentRoundTripTime: 0.045 },
      ]),
    )
    expect(sample.rttMs).toBeCloseTo(45)
  })

  it('also accepts a selected pair', async () => {
    const sample = await takeSample(
      fakePc([
        { type: 'candidate-pair', state: 'succeeded', selected: true, currentRoundTripTime: 0.1 },
      ]),
    )
    expect(sample.rttMs).toBeCloseTo(100)
  })

  it.each([
    ['not succeeded', { state: 'in-progress', nominated: true, currentRoundTripTime: 0.1 }],
    ['not nominated or selected', { state: 'succeeded', currentRoundTripTime: 0.1 }],
    ['without an RTT', { state: 'succeeded', nominated: true }],
  ])('ignores a candidate pair that is %s', async (_name, pair) => {
    const sample = await takeSample(fakePc([{ type: 'candidate-pair', ...pair }]))
    expect(sample.rttMs).toBeNull()
  })

  it('ignores unrelated report types and gives zeros for an empty report', async () => {
    const sample = await takeSample(fakePc([{ type: 'transport' }, { type: 'codec' }]))
    expect(sample).toMatchObject({
      packetsReceived: 0,
      rttMs: null,
      fps: null,
      jitterMs: null,
    })
  })
})

const sample = (at: number, over: Partial<Sample> = {}): Sample => ({
  at,
  packetsReceived: 0,
  packetsLost: 0,
  bytesReceived: 0,
  framesDecoded: 0,
  framesDropped: 0,
  freezeCount: 0,
  jitterMs: null,
  rttMs: null,
  fps: null,
  ...over,
})

const ids = (warnings: ConnectionWarning[]) => warnings.map((w) => w.id)

describe('evaluate', () => {
  it('reports no warnings for a healthy connection', () => {
    const { stats, warnings } = evaluate(
      [
        sample(0, { packetsReceived: 0, bytesReceived: 0, framesDecoded: 0 }),
        sample(2000, {
          packetsReceived: 400,
          bytesReceived: 500_000,
          framesDecoded: 60,
          rttMs: 40,
          jitterMs: 5,
          fps: 30,
        }),
      ],
      0,
    )
    expect(warnings).toEqual([])
    expect(stats).toEqual({
      packetLossPct: 0,
      rttMs: 40,
      jitterMs: 5,
      bitrateKbps: 2000, // 500000 B * 8 / 1000 / 2 s
      fps: 30,
      droppedFramesPct: 0,
    })
  })

  it('exposes the thresholds', () => {
    expect(WARN_AT).toEqual({ rttMs: 300, jitterMs: 50, packetLossPct: 2, droppedFramesPct: 10 })
  })

  describe('packet loss', () => {
    const loss = (received: number, lost: number) =>
      evaluate([sample(0), sample(1000, { packetsReceived: received, packetsLost: lost })], 0)

    it('warns from 2% and goes critical from 8%', () => {
      expect(loss(99, 1).warnings).toEqual([])
      expect(loss(98, 2).warnings).toMatchObject([{ id: 'packet-loss', severity: 'warning' }])
      expect(loss(93, 7).warnings[0].severity).toBe('warning')
      expect(loss(92, 8).warnings[0].severity).toBe('critical')
    })

    it('reports the percentage', () => {
      const { stats, warnings } = loss(90, 10)
      expect(stats.packetLossPct).toBeCloseTo(10)
      expect(warnings[0].message).toContain('10.0%')
    })

    it('needs at least two samples', () => {
      const { warnings } = evaluate([sample(0, { packetsReceived: 1, packetsLost: 50 })], 0)
      expect(ids(warnings)).not.toContain('packet-loss')
    })

    it('ignores packets lost before the window started', () => {
      const { stats } = evaluate(
        [
          sample(0, { packetsReceived: 100, packetsLost: 50 }),
          sample(1000, { packetsReceived: 200, packetsLost: 50 }),
        ],
        0,
      )
      expect(stats.packetLossPct).toBe(0)
    })
  })

  describe('latency', () => {
    const rtt = (rttMs: number | null) =>
      evaluate([sample(0), sample(1000, { rttMs })], 0).warnings

    it('warns from 300 ms and goes critical from 700 ms', () => {
      expect(rtt(null)).toEqual([])
      expect(rtt(299)).toEqual([])
      expect(rtt(300)).toMatchObject([{ id: 'latency', severity: 'warning' }])
      expect(rtt(699)[0].severity).toBe('warning')
      expect(rtt(700)).toMatchObject([{ id: 'latency', severity: 'critical' }])
    })

    it('rounds the value in the message', () => {
      expect(rtt(345.6)[0].message).toContain('346 ms')
    })
  })

  describe('jitter', () => {
    const jitter = (jitterMs: number | null) =>
      evaluate([sample(0), sample(1000, { jitterMs })], 0).warnings

    it('warns from 50 ms (never critical)', () => {
      expect(jitter(49.9)).toEqual([])
      expect(jitter(50)).toMatchObject([{ id: 'jitter', severity: 'warning' }])
      expect(jitter(5000)[0].severity).toBe('warning')
    })
  })

  describe('stall', () => {
    it('is critical from 3 seconds without data', () => {
      const window = [sample(0), sample(1000)]
      expect(evaluate(window, 2999).warnings).toEqual([])
      const { warnings } = evaluate(window, 3000)
      expect(warnings).toMatchObject([{ id: 'stalled', severity: 'critical' }])
      expect(evaluate(window, 7400).warnings[0].message).toContain('7s')
    })
  })

  describe('freezes', () => {
    it('warns when the freeze count grew within the window', () => {
      const grew = evaluate([sample(0, { freezeCount: 1 }), sample(1000, { freezeCount: 2 })], 0)
      expect(grew.warnings).toMatchObject([{ id: 'freezes', severity: 'warning' }])
      const same = evaluate([sample(0, { freezeCount: 3 }), sample(1000, { freezeCount: 3 })], 0)
      expect(same.warnings).toEqual([])
    })
  })

  describe('dropped frames', () => {
    const frames = (decoded: number, dropped: number) =>
      evaluate([sample(0), sample(1000, { framesDecoded: decoded, framesDropped: dropped })], 0)

    it('warns from 10% dropped', () => {
      expect(frames(90, 10).warnings).toMatchObject([{ id: 'dropped-frames', severity: 'warning' }])
      expect(frames(91, 9).warnings).toEqual([])
      expect(frames(90, 10).stats.droppedFramesPct).toBeCloseTo(10)
    })

    it('needs more than 20 frames of evidence', () => {
      expect(frames(10, 10).warnings).toEqual([]) // exactly 20
      expect(ids(frames(10, 11).warnings)).toEqual(['dropped-frames'])
    })

    it('mentions the rounded percentage', () => {
      expect(frames(70, 30).warnings[0].message).toContain('30%')
    })
  })

  describe('counter resets (new connection, negative deltas)', () => {
    it('never reports negative loss or drops', () => {
      const { stats, warnings } = evaluate(
        [
          sample(0, { packetsReceived: 1000, packetsLost: 100, framesDecoded: 500, framesDropped: 100 }),
          sample(1000, { packetsReceived: 10, packetsLost: 1, framesDecoded: 5, framesDropped: 0 }),
        ],
        0,
      )
      expect(stats.packetLossPct).toBe(0)
      expect(stats.droppedFramesPct).toBe(0)
      expect(warnings).toEqual([])
    })

    it('does not raise a freeze warning when the counter went down', () => {
      const { warnings } = evaluate([sample(0, { freezeCount: 5 }), sample(1000, { freezeCount: 0 })], 0)
      expect(warnings).toEqual([])
    })
  })

  it('uses only the first and last sample of the window', () => {
    const { stats } = evaluate(
      [
        sample(0, { bytesReceived: 0 }),
        sample(1000, { bytesReceived: 999_999_999 }),
        sample(2000, { bytesReceived: 250_000 }),
      ],
      0,
    )
    expect(stats.bitrateKbps).toBe(1000)
  })

  it('stays finite when all samples share a timestamp', () => {
    const { stats } = evaluate([sample(500), sample(500)], 0)
    expect(Number.isFinite(stats.bitrateKbps)).toBe(true)
    expect(stats.bitrateKbps).toBe(0)
  })

  it('can report several warnings at once', () => {
    const { warnings } = evaluate(
      [sample(0), sample(1000, { packetsReceived: 90, packetsLost: 10, rttMs: 800, jitterMs: 80 })],
      3500,
    )
    expect(ids(warnings)).toEqual(['stalled', 'packet-loss', 'latency', 'jitter'])
  })
})

describe('qualityOf', () => {
  const warning = (severity: ConnectionWarning['severity']): ConnectionWarning => ({
    id: 'jitter',
    severity,
    message: '',
  })

  it('is good without warnings, fair with warnings, poor with a critical one', () => {
    expect(qualityOf([])).toBe('good')
    expect(qualityOf([warning('warning'), warning('warning')])).toBe('fair')
    expect(qualityOf([warning('warning'), warning('critical')])).toBe('poor')
    expect(qualityOf([warning('critical')])).toBe('poor')
  })
})
