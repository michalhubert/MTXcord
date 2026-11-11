import type { StreamVideoCodec as VideoCodec } from '@/lib/streamSettings'

// Sets the Opus target bitrate via SDP munging (no setParameters() equivalent
// for audio), and disables DTX / enables in-band FEC to avoid audio choppiness.
export function applyAudioSdpOptions(sdp: string, kbps: number): string {
  const lines = sdp.split('\r\n')
  const audioIndex = lines.findIndex((l) => l.startsWith('m=audio'))
  if (audioIndex === -1) return sdp

  let opusPayload: string | null = null
  for (const line of lines) {
    const match = line.match(/^a=rtpmap:(\d+) opus\/\d+/i)
    if (match) {
      opusPayload = match[1]
      break
    }
  }
  if (!opusPayload) return sdp

  const extraParams = [
    `maxaveragebitrate=${kbps * 1000}`,
    'usedtx=0',
    'useinbandfec=1',
  ]

  const fmtpIndex = lines.findIndex((l) =>
    l.startsWith(`a=fmtp:${opusPayload} `),
  )
  if (fmtpIndex !== -1) {
    for (const param of extraParams) {
      const [key] = param.split('=')
      if (!new RegExp(`${key}=`).test(lines[fmtpIndex])) {
        lines[fmtpIndex] += `;${param}`
      }
    }
  } else {
    lines.splice(
      audioIndex + 1,
      0,
      `a=fmtp:${opusPayload} ${extraParams.join(';')}`,
    )
  }
  return lines.join('\r\n')
}

export function codecMimeType(codec: VideoCodec): string | null {
  switch (codec) {
    case 'vp9':
      return 'video/VP9'
    case 'vp8':
      return 'video/VP8'
    case 'h264':
      return 'video/H264'
    case 'av1':
      return 'video/AV1'
    default:
      return null
  }
}

// Sorts Baseline-profile H.264 (no B-frames) ahead of Main/High to reduce latency.
export type RTCCodecCapability = NonNullable<
  ReturnType<typeof RTCRtpSender.getCapabilities>
>['codecs'][number]

export function preferBaselineH264(
  codecs: RTCCodecCapability[],
): RTCCodecCapability[] {
  const isBaseline = (c: RTCCodecCapability) =>
    c.mimeType.toLowerCase() === 'video/h264' &&
    /profile-level-id=42/i.test(c.sdpFmtpLine ?? '')
  const isOtherH264 = (c: RTCCodecCapability) =>
    c.mimeType.toLowerCase() === 'video/h264' && !isBaseline(c)

  const baseline = codecs.filter(isBaseline)
  const otherH264 = codecs.filter(isOtherH264)
  const rest = codecs.filter((c) => c.mimeType.toLowerCase() !== 'video/h264')

  return [...baseline, ...rest, ...otherH264]
}

export function roundToHundred(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  const rounded = Math.round(value / 100) * 100
  return Math.min(max, Math.max(min, rounded))
}
