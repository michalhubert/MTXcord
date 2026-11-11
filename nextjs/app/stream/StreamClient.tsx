'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Checkbox from '@mui/material/Checkbox'
import Chip from '@mui/material/Chip'
import FormControlLabel from '@mui/material/FormControlLabel'
import MenuItem from '@mui/material/MenuItem'
import Paper from '@mui/material/Paper'
import Slider from '@mui/material/Slider'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { Monitor, Radio, RefreshCw, Save, Square } from 'lucide-react'
import DockClient from '../dock/DockClient'
import { useMediamtxPaths } from '../hooks/useMediamtxPaths'
import { waitForIceGathering } from '@/lib/webrtc'
import {
  applyAudioSdpOptions,
  codecMimeType,
  preferBaselineH264,
  roundToHundred,
} from './sdp'
import {
  DEFAULT_STREAM_SETTINGS as DEFAULT_SETTINGS,
  type StreamContentHint as ContentHint,
  type StreamDegradationPreference as DegradationPreference,
  type StreamSettings,
  type StreamSourceType as SourceType,
  type StreamVideoCodec as VideoCodec,
} from '@/lib/streamSettings'

type Status = 'idle' | 'starting' | 'live' | 'error'

const STATUS_LABELS: Record<Status, string> = {
  idle: 'Idle',
  starting: 'Starting…',
  live: 'Live',
  error: 'Error',
}

export default function StreamClient() {
  const [settings, setSettings] = useState<StreamSettings>(DEFAULT_SETTINGS)
  const [loadingSettings, setLoadingSettings] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [status, setStatus] = useState<Status>('idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [changingSource, setChangingSource] = useState(false)
  const availablePaths = useMediamtxPaths()

  const videoRef = useRef<HTMLVideoElement>(null)
  const pcRef = useRef<RTCPeerConnection | null>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const whipResourceIdRef = useRef<string | null>(null)
  const videoSenderRef = useRef<RTCRtpSender | null>(null)
  const audioSenderRef = useRef<RTCRtpSender | null>(null)
  const whipPathRef = useRef<string>(DEFAULT_SETTINGS.path)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/stream/settings')
        if (res.ok) {
          const data = await res.json()
          if (!cancelled) setSettings((prev) => ({ ...prev, ...data }))
        }
      } catch (err) {
        console.error('Failed to load stream settings:', err)
      } finally {
        if (!cancelled) setLoadingSettings(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (availablePaths.length > 0 && !settings.path) {
    setSettings((prev) => ({ ...prev, path: availablePaths[0] }))
  }

  const stopStream = useCallback(async () => {
    const pc = pcRef.current
    pcRef.current = null

    mediaStreamRef.current?.getTracks().forEach((t) => t.stop())
    mediaStreamRef.current = null
    videoSenderRef.current = null
    audioSenderRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null

    pc?.close()

    const resourceId = whipResourceIdRef.current
    whipResourceIdRef.current = null
    if (resourceId) {
      try {
        await fetch(
          `/api/whip/${whipPathRef.current}?id=${encodeURIComponent(resourceId)}`,
          {
            method: 'DELETE',
          },
        )
      } catch (err) {
        console.error('Failed to tear down WHIP session:', err)
      }
    }

    setStatus('idle')
  }, [])

  useEffect(() => {
    return () => {
      stopStream()
    }
  }, [stopStream])

  // Browsers can't fully block leaving: closing still works after their
  // "Leave site?" prompt. Reload shortcuts are swallowed outright.
  const isStreaming = status === 'starting' || status === 'live'
  useEffect(() => {
    if (!isStreaming) return
    function handleBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault()
      e.returnValue = ''
    }
    function handleKeyDown(e: KeyboardEvent) {
      const reload =
        e.key === 'F5' ||
        ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r')
      if (reload) e.preventDefault()
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [isStreaming])

  function buildVideoConstraints(): MediaTrackConstraints {
    const videoConstraints: MediaTrackConstraints & {
      displaySurface?: string
    } = {
      frameRate: { ideal: settings.fps },
    }
    if (settings.sourceType !== 'browser') {
      videoConstraints.displaySurface = settings.sourceType
    }
    if (settings.fixedResolution) {
      videoConstraints.width = { ideal: settings.width }
      videoConstraints.height = { ideal: settings.height }
    }
    return videoConstraints as MediaTrackConstraints
  }

  // Falls back to video-only if the browser can't provide the requested audio track.
  async function captureDisplayMedia(): Promise<MediaStream> {
    const videoConstraints = buildVideoConstraints()
    if (!settings.includeAudio) {
      return navigator.mediaDevices.getDisplayMedia({
        video: videoConstraints,
        audio: false,
      })
    }
    const audioConstraints: MediaTrackConstraints = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    }
    // Chrome-only hints: for a window, capture only its own audio (not full
    // system audio); for a screen, only offer system audio there.
    const displayMediaOptions: DisplayMediaStreamOptions & {
      systemAudio?: 'include' | 'exclude'
      windowAudio?: 'exclude' | 'window' | 'system'
    } = {
      video: videoConstraints,
      audio: audioConstraints,
      systemAudio: settings.sourceType === 'monitor' ? 'include' : 'exclude',
      windowAudio: settings.sourceType === 'window' ? 'window' : undefined,
    }
    try {
      return await navigator.mediaDevices.getDisplayMedia(displayMediaOptions)
    } catch (err) {
      const name = err instanceof Error ? err.name : 'UnknownError'
      const message = err instanceof Error ? err.message : String(err)
      console.error(
        `Failed to capture with audio (${name}: ${message}), retrying video-only:`,
        err,
      )
      setErrorMessage(
        `Couldn't capture audio (${name}: ${message}). Audio support for a single window depends on your browser/OS (Chrome hints at window-only audio, but may ignore it); "Entire desktop" or a "Browser tab" are more reliable, and you must tick "Share audio" in the picker. If you have a virtual surround sound effect enabled on your headphones/audio device, try disabling it — it's a known cause of this error. Continuing with video only.`,
      )
      return navigator.mediaDevices.getDisplayMedia({
        video: videoConstraints,
        audio: false,
      })
    }
  }

  async function startStream() {
    setErrorMessage(null)

    if (!availablePaths.includes(settings.path)) {
      setErrorMessage(
        'Invalid path: pick one of the paths configured in paths.yml.',
      )
      return
    }

    setStatus('starting')

    try {
      const displayStream = await captureDisplayMedia()
      mediaStreamRef.current = displayStream

      if (videoRef.current) {
        videoRef.current.srcObject = displayStream
        videoRef.current.muted = true
        videoRef.current.play().catch(() => {})
      }

      const pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
        bundlePolicy: 'max-bundle',
        iceCandidatePoolSize: 4,
      })
      pcRef.current = pc

      const videoTrack = displayStream.getVideoTracks()[0]
      const audioTrack = displayStream.getAudioTracks()[0]

      if (settings.contentHint !== 'none') {
        videoTrack.contentHint = settings.contentHint
      }

      videoTrack.addEventListener('ended', () => {
        stopStream()
      })

      const videoTransceiver = pc.addTransceiver(videoTrack, {
        direction: 'sendonly',
      })
      videoSenderRef.current = videoTransceiver.sender
      const mimeType = codecMimeType(settings.videoCodec)
      if ('setCodecPreferences' in videoTransceiver) {
        try {
          const capabilities = RTCRtpSender.getCapabilities('video')
          let codecs = preferBaselineH264(capabilities?.codecs ?? [])
          if (mimeType) {
            const preferred = codecs.filter((c) => c.mimeType === mimeType)
            const rest = codecs.filter((c) => c.mimeType !== mimeType)
            if (preferred.length > 0) codecs = [...preferred, ...rest]
          }
          if (codecs.length > 0) {
            videoTransceiver.setCodecPreferences(codecs)
          }
        } catch (err) {
          console.error('Failed to set codec preferences:', err)
        }
      }

      try {
        const params = videoTransceiver.sender.getParameters()
        if (!params.encodings || params.encodings.length === 0) {
          params.encodings = [{}]
        }
        const encoding = params.encodings[0] as RTCRtpEncodingParameters & {
          priority?: string
          networkPriority?: string
        }
        encoding.maxBitrate = settings.videoBitrateKbps * 1000
        encoding.maxFramerate = settings.fps
        encoding.priority = 'high'
        encoding.networkPriority = 'high'
        params.degradationPreference = settings.degradationPreference
        await videoTransceiver.sender.setParameters(params)
      } catch (err) {
        console.error('Failed to apply video encoding parameters:', err)
      }

      if (settings.includeAudio && audioTrack) {
        const audioTransceiver = pc.addTransceiver(audioTrack, {
          direction: 'sendonly',
        })
        audioSenderRef.current = audioTransceiver.sender
      }

      pc.onconnectionstatechange = () => {
        if (pcRef.current !== pc) return
        const state = pc.connectionState
        if (state === 'connected') {
          setStatus('live')
        } else if (state === 'failed' || state === 'closed') {
          setStatus((prev) => (prev === 'idle' ? prev : 'error'))
        }
      }

      const offer = await pc.createOffer()
      let sdp = offer.sdp ?? ''
      if (settings.includeAudio && audioTrack) {
        sdp = applyAudioSdpOptions(sdp, settings.audioBitrateKbps)
      }
      await pc.setLocalDescription({ type: 'offer', sdp })

      await waitForIceGathering(pc)

      whipPathRef.current = settings.path || DEFAULT_SETTINGS.path
      const res = await fetch(
        `/api/whip/${encodeURIComponent(whipPathRef.current)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/sdp' },
          body: pc.localDescription?.sdp ?? sdp,
        },
      )

      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(
          `WHIP publish failed (${res.status})${body ? `: ${body.slice(0, 200)}` : ''}`,
        )
      }

      const resourceId =
        res.headers.get('id') ||
        res.headers.get('location')?.split('/').filter(Boolean).pop()
      whipResourceIdRef.current = resourceId ?? null

      const answerSdp = await res.text()
      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp })
    } catch (err) {
      console.error('Failed to start stream:', err)
      const message =
        err instanceof Error ? err.message : 'Failed to start stream'
      setErrorMessage(message)
      await stopStream()
      setStatus('error')
    }
  }

  async function changeSource() {
    if (!pcRef.current || !videoSenderRef.current) return

    setChangingSource(true)
    setErrorMessage(null)
    try {
      const newDisplayStream = await captureDisplayMedia()

      const newVideoTrack = newDisplayStream.getVideoTracks()[0]
      const newAudioTrack = newDisplayStream.getAudioTracks()[0]
      if (settings.contentHint !== 'none') {
        newVideoTrack.contentHint = settings.contentHint
      }

      const oldStream = mediaStreamRef.current
      const oldVideoTrack = oldStream?.getVideoTracks()[0]
      const oldAudioTrack = oldStream?.getAudioTracks()[0]

      await videoSenderRef.current.replaceTrack(newVideoTrack)

      let previewAudioTrack = oldAudioTrack ?? null
      if (newAudioTrack && audioSenderRef.current) {
        await audioSenderRef.current.replaceTrack(newAudioTrack)
        previewAudioTrack = newAudioTrack
        oldAudioTrack?.stop()
      } else if (newAudioTrack) {
        // No pre-existing audio sender, so the new source's audio can't be added without renegotiation.
        newAudioTrack.stop()
      }

      oldVideoTrack?.stop()

      newVideoTrack.addEventListener('ended', () => {
        stopStream()
      })

      const previewStream = new MediaStream(
        [newVideoTrack, previewAudioTrack].filter((t): t is MediaStreamTrack =>
          Boolean(t),
        ),
      )
      mediaStreamRef.current = previewStream
      if (videoRef.current) {
        videoRef.current.srcObject = previewStream
        videoRef.current.muted = true
        videoRef.current.play().catch(() => {})
      }
    } catch (err) {
      console.error('Failed to change source:', err)
    } finally {
      setChangingSource(false)
    }
  }

  async function saveSettings() {
    setSaving(true)
    setSaved(false)
    try {
      const res = await fetch('/api/stream/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      })
      if (res.ok) {
        const data = await res.json()
        setSettings((prev) => ({ ...prev, ...data }))
        setSaved(true)
        setTimeout(() => setSaved(false), 1500)
      }
    } catch (err) {
      console.error('Failed to save stream settings:', err)
    } finally {
      setSaving(false)
    }
  }

  function update<K extends keyof StreamSettings>(
    key: K,
    value: StreamSettings[K],
  ) {
    setSettings((prev) => ({ ...prev, [key]: value }))
  }

  const isLive = status === 'live' || status === 'starting'

  return (
    <Box sx={{ minHeight: '100vh', p: 3 }}>
      <Box
        sx={{
          maxWidth: 1152,
          mx: 'auto',
          display: 'flex',
          flexDirection: { xs: 'column', lg: 'row' },
          gap: 3,
          alignItems: 'flex-start',
        }}
      >
        <Box sx={{ maxWidth: 768, width: '100%', mx: { xs: 'auto', lg: 0 } }}>
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              mb: 3,
            }}
          >
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              <Box sx={{ display: 'flex', color: 'primary.main' }}>
                <Radio size={20} />
              </Box>
              <Typography variant="h6" component="h1" sx={{ fontWeight: 600 }}>
                Browser Stream
              </Typography>
            </Stack>
            <Chip
              size="small"
              label={STATUS_LABELS[status]}
              icon={
                <Box
                  component="span"
                  sx={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    bgcolor: 'currentColor',
                    boxShadow: status === 'live' ? '0 0 6px currentColor' : 'none',
                  }}
                />
              }
              sx={{
                fontWeight: 600,
                fontSize: 12,
                textTransform: 'uppercase',
                bgcolor:
                  status === 'live'
                    ? 'rgb(34 197 94 / 0.15)'
                    : 'rgba(255, 255, 255, 0.06)',
                color: status === 'live' ? 'success.main' : 'text.secondary',
                '& .MuiChip-icon': { color: 'inherit', ml: 1.25 },
              }}
            />
          </Box>

          <Paper
            variant="outlined"
            sx={{
              position: 'relative',
              bgcolor: 'common.black',
              borderRadius: 3,
              overflow: 'hidden',
              aspectRatio: '16 / 9',
              mb: 3,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Box
              component="video"
              ref={videoRef}
              autoPlay
              playsInline
              sx={{ width: '100%', height: '100%', objectFit: 'contain' }}
            />
            {status === 'idle' && (
              <Stack
                spacing={1}
                sx={{ position: 'absolute', alignItems: 'center', color: 'text.disabled' }}
              >
                <Monitor size={32} />
                <Typography variant="body2">No source selected</Typography>
              </Stack>
            )}
          </Paper>

          {errorMessage && (
            <Alert severity="error" variant="outlined" sx={{ mb: 2 }}>
              {errorMessage}
            </Alert>
          )}

          <Stack direction="row" spacing={1.5} sx={{ mb: 4 }}>
            {!isLive ? (
              <Button
                fullWidth
                variant="contained"
                size="large"
                onClick={startStream}
                startIcon={<Radio size={16} />}
              >
                Start Streaming
              </Button>
            ) : (
              <>
                <Button
                  fullWidth
                  variant="outlined"
                  color="inherit"
                  size="large"
                  onClick={changeSource}
                  disabled={status === 'starting'}
                  loading={changingSource}
                  loadingPosition="start"
                  title="Pick a different desktop, window, or tab to share, without interrupting the stream"
                  startIcon={<RefreshCw size={16} />}
                  sx={{ borderColor: 'divider' }}
                >
                  Change Source
                </Button>
                <Button
                  fullWidth
                  variant="outlined"
                  color="inherit"
                  size="large"
                  onClick={() => stopStream()}
                  loading={status === 'starting'}
                  loadingPosition="start"
                  startIcon={<Square size={16} />}
                  sx={{ borderColor: 'divider' }}
                >
                  Stop Streaming
                </Button>
              </>
            )}
          </Stack>

          <Paper variant="outlined" sx={{ borderRadius: 3, p: 2.5 }}>
            <Typography
              variant="overline"
              component="h2"
              sx={{ display: 'block', mb: 2, fontSize: 13 }}
            >
              Settings
            </Typography>

            {loadingSettings ? (
              <Typography variant="body2" color="text.secondary">
                Loading settings…
              </Typography>
            ) : (
              <Stack spacing={2.5}>
                <TextField
                  select
                  label="Path"
                  value={settings.path}
                  onChange={(e) => update('path', e.target.value)}
                  disabled={isLive || availablePaths.length === 0}
                  error={availablePaths.length > 0 && !availablePaths.includes(settings.path)}
                  helperText={
                    availablePaths.length === 0
                      ? 'Loading paths from MediaMTX…'
                      : availablePaths.includes(settings.path)
                        ? `Publishes to MediaMTX at "${settings.path}" — viewers watch it at /${settings.path}. Only paths declared in paths.yml can be used.`
                        : `"${settings.path}" isn't declared in paths.yml — pick one of the paths listed above.`
                  }
                  slotProps={{ select: { sx: { fontFamily: 'monospace' } } }}
                >
                  {!availablePaths.includes(settings.path) && (
                    <MenuItem value={settings.path}>{settings.path || '—'}</MenuItem>
                  )}
                  {availablePaths.map((p) => (
                    <MenuItem key={p} value={p} sx={{ fontFamily: 'monospace' }}>
                      {p}
                    </MenuItem>
                  ))}
                </TextField>

                <Box>
                  <TextField
                    select
                    label="Preferred source"
                    value={settings.sourceType}
                    onChange={(e) =>
                      update('sourceType', e.target.value as SourceType)
                    }
                    disabled={isLive}
                    helperText="This only pre-selects the tab in the browser's share picker — you can still pick a different source there."
                  >
                    <MenuItem value="monitor">Entire desktop</MenuItem>
                    <MenuItem value="window">Application window</MenuItem>
                    <MenuItem value="browser">Browser tab</MenuItem>
                  </TextField>
                  {settings.sourceType === 'window' && settings.includeAudio && (
                    <Alert severity="warning" variant="outlined" sx={{ mt: 1, py: 0, fontSize: 12 }}>
                      Heads up: window audio is scoped to that window only (not
                      the whole desktop) via a Chrome-only hint, but support
                      varies — some browsers/OSes still can&apos;t provide it.
                      Pick &quot;Entire desktop&quot; or &quot;Browser tab&quot;
                      instead if it doesn&apos;t work.
                    </Alert>
                  )}
                </Box>

                <FormControlLabel
                  control={
                    <Checkbox
                      checked={settings.fixedResolution}
                      onChange={(e) => update('fixedResolution', e.target.checked)}
                      disabled={isLive}
                    />
                  }
                  label="Fix output resolution"
                  sx={{ my: -1 }}
                />

                {settings.fixedResolution && (
                  <Box sx={twoColumnsSx}>
                    <TextField
                      type="number"
                      label="Width"
                      value={settings.width}
                      onChange={(e) => update('width', Number(e.target.value))}
                      disabled={isLive}
                    />
                    <TextField
                      type="number"
                      label="Height"
                      value={settings.height}
                      onChange={(e) => update('height', Number(e.target.value))}
                      disabled={isLive}
                    />
                  </Box>
                )}

                <Box sx={twoColumnsSx}>
                  <TextField
                    type="number"
                    label="Framerate (fps)"
                    value={settings.fps}
                    onChange={(e) => update('fps', Number(e.target.value))}
                    disabled={isLive}
                  />
                  <TextField
                    select
                    label="Video codec"
                    value={settings.videoCodec}
                    onChange={(e) =>
                      update('videoCodec', e.target.value as VideoCodec)
                    }
                    disabled={isLive}
                    helperText="H.264 always negotiates a B-frame-free Baseline profile for lower latency. There is no API for a web page to pick a specific encoder (e.g. NVENC) - the browser decides - but Chrome only hardware-accelerates H.264 broadly (VP8 has no hardware encoder at all, VP9/AV1 support is limited), so H.264 is the closest equivalent to what OBS does with NVENC at high bitrates. Make sure hardware acceleration is enabled in your browser's settings."
                  >
                    <MenuItem value="h264">
                      H.264 (hardware/NVENC, recommended)
                    </MenuItem>
                    <MenuItem value="auto">Auto</MenuItem>
                    <MenuItem value="vp9">VP9</MenuItem>
                    <MenuItem value="vp8">VP8</MenuItem>
                    <MenuItem value="av1">AV1</MenuItem>
                  </TextField>
                </Box>

                <Box sx={twoColumnsSx}>
                  <TextField
                    select
                    label="Content hint"
                    value={settings.contentHint}
                    onChange={(e) =>
                      update('contentHint', e.target.value as ContentHint)
                    }
                    disabled={isLive}
                  >
                    <MenuItem value="motion">Motion (games, video)</MenuItem>
                    <MenuItem value="detail">Detail (static content)</MenuItem>
                    <MenuItem value="text">Text (reading/slides)</MenuItem>
                    <MenuItem value="none">Browser default</MenuItem>
                  </TextField>
                  <TextField
                    select
                    label="Degradation preference"
                    value={settings.degradationPreference}
                    onChange={(e) =>
                      update(
                        'degradationPreference',
                        e.target.value as DegradationPreference,
                      )
                    }
                    disabled={isLive}
                  >
                    <MenuItem value="maintain-framerate">
                      Maintain framerate (less stutter)
                    </MenuItem>
                    <MenuItem value="maintain-resolution">
                      Maintain resolution (sharper)
                    </MenuItem>
                    <MenuItem value="balanced">Balanced</MenuItem>
                  </TextField>
                </Box>

                <Box>
                  <Box
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 1.5,
                    }}
                  >
                    <Typography variant="body2" color="text.secondary">
                      Video bitrate (kbps)
                    </Typography>
                    <TextField
                      type="number"
                      value={settings.videoBitrateKbps}
                      onChange={(e) =>
                        update('videoBitrateKbps', Number(e.target.value))
                      }
                      onBlur={(e) =>
                        update(
                          'videoBitrateKbps',
                          roundToHundred(Number(e.target.value), 500, 20000),
                        )
                      }
                      disabled={isLive}
                      fullWidth={false}
                      slotProps={{
                        htmlInput: {
                          min: 500,
                          max: 20000,
                          step: 100,
                          style: { textAlign: 'right' },
                          'aria-label': 'Video bitrate (kbps)',
                        },
                      }}
                      sx={{ width: 112 }}
                    />
                  </Box>
                  <Slider
                    min={500}
                    max={20000}
                    step={100}
                    value={settings.videoBitrateKbps}
                    onChange={(_, value) =>
                      update('videoBitrateKbps', value as number)
                    }
                    disabled={isLive}
                    aria-label="Video bitrate"
                    valueLabelDisplay="auto"
                  />
                </Box>

                <FormControlLabel
                  control={
                    <Checkbox
                      checked={settings.includeAudio}
                      onChange={(e) => update('includeAudio', e.target.checked)}
                      disabled={isLive}
                    />
                  }
                  label="Include audio (system/tab, if supported by your browser)"
                  sx={{ my: -1 }}
                />

                {settings.includeAudio && (
                  <Box>
                    <Typography variant="body2" color="text.secondary">
                      Audio bitrate: {settings.audioBitrateKbps} kbps
                    </Typography>
                    <Slider
                      min={32}
                      max={320}
                      step={8}
                      value={settings.audioBitrateKbps}
                      onChange={(_, value) =>
                        update('audioBitrateKbps', value as number)
                      }
                      disabled={isLive}
                      aria-label="Audio bitrate"
                    />
                  </Box>
                )}

                <Button
                  fullWidth
                  variant="outlined"
                  color="inherit"
                  size="large"
                  onClick={saveSettings}
                  loading={saving}
                  loadingPosition="start"
                  startIcon={<Save size={16} />}
                  sx={{ borderColor: 'divider' }}
                >
                  {saved ? 'Saved!' : saving ? 'Saving…' : 'Save Settings'}
                </Button>
              </Stack>
            )}
          </Paper>
        </Box>

        <Paper
          variant="outlined"
          sx={{
            width: { xs: '100%', lg: 360 },
            flexShrink: 0,
            borderRadius: 3,
            overflow: 'hidden',
          }}
        >
          <DockClient embedded />
        </Paper>
      </Box>
    </Box>
  )
}

const twoColumnsSx = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 1.5,
  alignItems: 'start',
} as const
