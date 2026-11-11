import { useEffect, useState, type RefObject } from 'react'

export type ConnectionQuality = 'good' | 'fair' | 'poor'

export type ConnectionWarning = {
  id:
    | 'offline'
    | 'stalled'
    | 'packet-loss'
    | 'latency'
    | 'jitter'
    | 'freezes'
    | 'dropped-frames'
  severity: 'warning' | 'critical'
  message: string
}

export type ConnectionStats = {
  packetLossPct: number
  rttMs: number | null
  jitterMs: number | null
  bitrateKbps: number
  fps: number | null
  droppedFramesPct: number
}

export type Sample = {
  at: number
  packetsReceived: number
  packetsLost: number
  bytesReceived: number
  framesDecoded: number
  framesDropped: number
  freezeCount: number
  jitterMs: number | null
  rttMs: number | null
  fps: number | null
}

// Values at which a stat counts as a problem (also highlighted in the stats card).
export const WARN_AT = {
  rttMs: 300,
  jitterMs: 50,
  packetLossPct: 2,
  droppedFramesPct: 10,
}

const SAMPLE_INTERVAL_MS = 1000
// Averaging window, in samples.
const WINDOW_SAMPLES = 5
const STALL_AFTER_MS = 3000
// Consecutive samples before a warning shows / hides, to avoid flicker.
const SHOW_AFTER = 2
const CLEAR_AFTER = 4

export async function takeSample(pc: RTCPeerConnection): Promise<Sample> {
  const report = await pc.getStats()
  const sample: Sample = {
    at: performance.now(),
    packetsReceived: 0,
    packetsLost: 0,
    bytesReceived: 0,
    framesDecoded: 0,
    framesDropped: 0,
    freezeCount: 0,
    jitterMs: null,
    rttMs: null,
    fps: null,
  }

  report.forEach((stat) => {
    if (stat.type === 'inbound-rtp') {
      sample.packetsReceived += stat.packetsReceived ?? 0
      sample.packetsLost += Math.max(stat.packetsLost ?? 0, 0)
      sample.bytesReceived += stat.bytesReceived ?? 0
      if (stat.kind === 'video') {
        sample.framesDecoded += stat.framesDecoded ?? 0
        sample.framesDropped += stat.framesDropped ?? 0
        sample.freezeCount += stat.freezeCount ?? 0
        if (typeof stat.framesPerSecond === 'number')
          sample.fps = stat.framesPerSecond
        if (typeof stat.jitter === 'number')
          sample.jitterMs = stat.jitter * 1000
      }
    } else if (
      stat.type === 'candidate-pair' &&
      stat.state === 'succeeded' &&
      (stat.nominated || stat.selected) &&
      typeof stat.currentRoundTripTime === 'number'
    ) {
      sample.rttMs = stat.currentRoundTripTime * 1000
    }
  })

  return sample
}

export function evaluate(
  window: Sample[],
  stalledForMs: number,
): { stats: ConnectionStats; warnings: ConnectionWarning[] } {
  const first = window[0]
  const last = window[window.length - 1]
  const seconds = Math.max((last.at - first.at) / 1000, 0.001)

  const received = last.packetsReceived - first.packetsReceived
  const lost = Math.max(last.packetsLost - first.packetsLost, 0)
  const packetLossPct =
    received + lost > 0 ? (lost / (received + lost)) * 100 : 0

  const decoded = last.framesDecoded - first.framesDecoded
  const dropped = Math.max(last.framesDropped - first.framesDropped, 0)
  const droppedFramesPct =
    decoded + dropped > 0 ? (dropped / (decoded + dropped)) * 100 : 0

  const stats: ConnectionStats = {
    packetLossPct,
    rttMs: last.rttMs,
    jitterMs: last.jitterMs,
    bitrateKbps:
      ((last.bytesReceived - first.bytesReceived) * 8) / 1000 / seconds,
    fps: last.fps,
    droppedFramesPct,
  }

  const warnings: ConnectionWarning[] = []
  if (stalledForMs >= STALL_AFTER_MS) {
    warnings.push({
      id: 'stalled',
      severity: 'critical',
      message: `No data received for ${Math.round(stalledForMs / 1000)}s - the connection may be stuck`,
    })
  }
  if (window.length > 1 && packetLossPct >= WARN_AT.packetLossPct) {
    warnings.push({
      id: 'packet-loss',
      severity: packetLossPct >= 8 ? 'critical' : 'warning',
      message: `Unstable connection - ${packetLossPct.toFixed(1)}% of packets are being lost`,
    })
  }
  if (stats.rttMs !== null && stats.rttMs >= WARN_AT.rttMs) {
    warnings.push({
      id: 'latency',
      severity: stats.rttMs >= 700 ? 'critical' : 'warning',
      message: `High latency (${Math.round(stats.rttMs)} ms) - the stream may lag behind`,
    })
  }
  if (stats.jitterMs !== null && stats.jitterMs >= WARN_AT.jitterMs) {
    warnings.push({
      id: 'jitter',
      severity: 'warning',
      message: `Connection is jittery (${Math.round(stats.jitterMs)} ms) - expect stutter`,
    })
  }
  if (last.freezeCount > first.freezeCount) {
    warnings.push({
      id: 'freezes',
      severity: 'warning',
      message:
        'Video is freezing - your connection may be too slow for this stream',
    })
  }
  if (decoded + dropped > 20 && droppedFramesPct >= WARN_AT.droppedFramesPct) {
    warnings.push({
      id: 'dropped-frames',
      severity: 'warning',
      message: `Your device is dropping ${Math.round(droppedFramesPct)}% of frames - it may be struggling to decode`,
    })
  }
  return { stats, warnings }
}

export function qualityOf(warnings: ConnectionWarning[]): ConnectionQuality {
  if (warnings.some((w) => w.severity === 'critical')) return 'poor'
  return warnings.length > 0 ? 'fair' : 'good'
}

// Polls WebRTC stats while `active` and turns them into user-facing warnings.
export function useConnectionStats(
  pcRef: RefObject<RTCPeerConnection | null>,
  active: boolean,
) {
  const [stats, setStats] = useState<ConnectionStats | null>(null)
  const [warnings, setWarnings] = useState<ConnectionWarning[]>([])
  const [isOnline, setIsOnline] = useState(true)

  useEffect(() => {
    const update = () => setIsOnline(navigator.onLine)
    update()
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])

  useEffect(() => {
    if (!active) return

    let cancelled = false
    let samples: Sample[] = []
    let samplePc: RTCPeerConnection | null = null
    let lastProgressAt = performance.now()
    const streaks = new Map<ConnectionWarning['id'], number>()
    const shown = new Map<ConnectionWarning['id'], ConnectionWarning>()

    const interval = setInterval(async () => {
      const pc = pcRef.current
      if (!pc) return
      if (pc !== samplePc) {
        // Reconnected: counters restart on a new peer connection.
        samplePc = pc
        samples = []
        lastProgressAt = performance.now()
      }

      let sample: Sample
      try {
        sample = await takeSample(pc)
      } catch {
        return
      }
      if (cancelled || pc !== pcRef.current) return

      const prev = samples[samples.length - 1]
      if (!prev || sample.bytesReceived > prev.bytesReceived) {
        lastProgressAt = sample.at
      }
      samples = [...samples, sample].slice(-(WINDOW_SAMPLES + 1))

      const result = evaluate(samples, sample.at - lastProgressAt)
      const current = new Map(result.warnings.map((w) => [w.id, w]))

      for (const id of new Set([...streaks.keys(), ...current.keys()])) {
        const hit = current.get(id)
        const streak = streaks.get(id) ?? 0
        if (hit) {
          const next = streak > 0 ? streak + 1 : 1
          streaks.set(id, next)
          if (next >= SHOW_AFTER || shown.has(id)) shown.set(id, hit)
        } else {
          const next = streak < 0 ? streak - 1 : -1
          streaks.set(id, next)
          if (-next >= CLEAR_AFTER) {
            shown.delete(id)
            streaks.delete(id)
          }
        }
      }

      setStats(result.stats)
      setWarnings(Array.from(shown.values()))
    }, SAMPLE_INTERVAL_MS)

    return () => {
      cancelled = true
      clearInterval(interval)
      setStats(null)
      setWarnings([])
    }
  }, [pcRef, active])

  const allWarnings: ConnectionWarning[] = isOnline
    ? warnings
    : [
        {
          id: 'offline',
          severity: 'critical',
          message: "You're offline - check your internet connection",
        },
        ...warnings,
      ]

  return { stats, warnings: allWarnings, quality: qualityOf(allWarnings) }
}
