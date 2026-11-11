import { describe, expect, it } from 'vitest'
import {
  applyAudioSdpOptions,
  codecMimeType,
  preferBaselineH264,
  roundToHundred,
  type RTCCodecCapability,
} from '@/app/stream/sdp'

const sdp = (...lines: string[]) => lines.join('\r\n') + '\r\n'

const AUDIO_SDP = sdp(
  'v=0',
  'm=video 9 UDP/TLS/RTP/SAVPF 96',
  'a=rtpmap:96 VP8/90000',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111 63',
  'a=rtpmap:111 opus/48000/2',
  'a=rtpmap:63 red/48000/2',
)

describe('applyAudioSdpOptions', () => {
  it('leaves an SDP without audio unchanged', () => {
    const video = sdp('v=0', 'm=video 9 UDP/TLS/RTP/SAVPF 96', 'a=rtpmap:96 VP8/90000')
    expect(applyAudioSdpOptions(video, 128)).toBe(video)
  })

  it('leaves audio without Opus unchanged', () => {
    const pcmu = sdp('v=0', 'm=audio 9 RTP/AVP 0', 'a=rtpmap:0 PCMU/8000')
    expect(applyAudioSdpOptions(pcmu, 128)).toBe(pcmu)
  })

  it('inserts an fmtp line right after m=audio when there is none', () => {
    const out = applyAudioSdpOptions(AUDIO_SDP, 128)
    const lines = out.split('\r\n')
    const audio = lines.findIndex((l) => l.startsWith('m=audio'))
    expect(lines[audio + 1]).toBe(
      'a=fmtp:111 maxaveragebitrate=128000;usedtx=0;useinbandfec=1',
    )
    expect(lines).toHaveLength(AUDIO_SDP.split('\r\n').length + 1)
  })

  it('converts kbps to bits per second', () => {
    expect(applyAudioSdpOptions(AUDIO_SDP, 64)).toContain('maxaveragebitrate=64000')
    expect(applyAudioSdpOptions(AUDIO_SDP, 510)).toContain('maxaveragebitrate=510000')
  })

  it('appends missing parameters to an existing fmtp line', () => {
    const input = sdp(
      'm=audio 9 UDP/TLS/RTP/SAVPF 111',
      'a=rtpmap:111 opus/48000/2',
      'a=fmtp:111 minptime=10;stereo=1',
    )
    expect(applyAudioSdpOptions(input, 96)).toBe(
      sdp(
        'm=audio 9 UDP/TLS/RTP/SAVPF 111',
        'a=rtpmap:111 opus/48000/2',
        'a=fmtp:111 minptime=10;stereo=1;maxaveragebitrate=96000;usedtx=0;useinbandfec=1',
      ),
    )
  })

  it('keeps parameters that are already present', () => {
    const input = sdp(
      'm=audio 9 UDP/TLS/RTP/SAVPF 111',
      'a=rtpmap:111 opus/48000/2',
      'a=fmtp:111 useinbandfec=0;usedtx=1',
    )
    const line = applyAudioSdpOptions(input, 96)
      .split('\r\n')
      .find((l) => l.startsWith('a=fmtp:111'))
    expect(line).toBe('a=fmtp:111 useinbandfec=0;usedtx=1;maxaveragebitrate=96000')
  })

  it('finds Opus case-insensitively and only edits its own fmtp line', () => {
    const input = sdp(
      'm=audio 9 UDP/TLS/RTP/SAVPF 109 63',
      'a=rtpmap:109 OPUS/48000/2',
      'a=rtpmap:63 red/48000/2',
      'a=fmtp:63 109/109',
    )
    const out = applyAudioSdpOptions(input, 128)
    expect(out).toContain('a=fmtp:63 109/109\r\n')
    expect(out).toContain('a=fmtp:109 maxaveragebitrate=128000;usedtx=0;useinbandfec=1')
  })

  it('is idempotent', () => {
    const once = applyAudioSdpOptions(AUDIO_SDP, 128)
    expect(applyAudioSdpOptions(once, 128)).toBe(once)
  })
})

describe('codecMimeType', () => {
  it('maps codecs to MIME types', () => {
    expect(codecMimeType('vp9')).toBe('video/VP9')
    expect(codecMimeType('vp8')).toBe('video/VP8')
    expect(codecMimeType('h264')).toBe('video/H264')
    expect(codecMimeType('av1')).toBe('video/AV1')
  })

  it('returns null for auto', () => {
    expect(codecMimeType('auto')).toBeNull()
  })
})

describe('preferBaselineH264', () => {
  const codec = (mimeType: string, sdpFmtpLine?: string): RTCCodecCapability => ({
    mimeType,
    clockRate: 90000,
    ...(sdpFmtpLine ? { sdpFmtpLine } : {}),
  })
  const baseline = codec('video/H264', 'profile-level-id=42e01f;packetization-mode=1')
  const baseline2 = codec('video/h264', 'level-asymmetry-allowed=1;profile-level-id=42001f')
  const high = codec('video/H264', 'profile-level-id=640c1f')
  const main = codec('video/H264', 'profile-level-id=4d001f')
  const vp8 = codec('video/VP8')
  const vp9 = codec('video/VP9', 'profile-id=0')

  it('puts Baseline H.264 first and other H.264 last', () => {
    expect(preferBaselineH264([high, vp8, main, baseline, vp9, baseline2])).toEqual([
      baseline,
      baseline2,
      vp8,
      vp9,
      high,
      main,
    ])
  })

  it('keeps the relative order within each group', () => {
    expect(preferBaselineH264([vp9, vp8])).toEqual([vp9, vp8])
    expect(preferBaselineH264([main, high])).toEqual([main, high])
  })

  it('treats H.264 without an fmtp line as non-baseline', () => {
    const bare = codec('video/H264')
    expect(preferBaselineH264([bare, vp8])).toEqual([vp8, bare])
  })

  it('does not reorder the input and handles an empty list', () => {
    const input = [high, baseline]
    preferBaselineH264(input)
    expect(input).toEqual([high, baseline])
    expect(preferBaselineH264([])).toEqual([])
  })
})

describe('roundToHundred', () => {
  it('rounds to the nearest hundred', () => {
    expect(roundToHundred(1234, 0, 10_000)).toBe(1200)
    expect(roundToHundred(1250, 0, 10_000)).toBe(1300)
    expect(roundToHundred(1249.9, 0, 10_000)).toBe(1200)
  })

  it('clamps to the range', () => {
    expect(roundToHundred(50, 500, 8000)).toBe(500)
    expect(roundToHundred(99_999, 500, 8000)).toBe(8000)
    expect(roundToHundred(-300, 500, 8000)).toBe(500)
  })

  it('falls back to the minimum for non-finite values', () => {
    expect(roundToHundred(NaN, 500, 8000)).toBe(500)
    expect(roundToHundred(Infinity, 500, 8000)).toBe(500)
    expect(roundToHundred(-Infinity, 500, 8000)).toBe(500)
  })
})
