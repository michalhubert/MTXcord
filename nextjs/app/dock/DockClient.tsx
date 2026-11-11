'use client'

import { useRef, useState, type ReactNode } from 'react'
import Avatar from '@mui/material/Avatar'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import Dialog from '@mui/material/Dialog'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import InputAdornment from '@mui/material/InputAdornment'
import IconButton from '@mui/material/IconButton'
import MenuItem from '@mui/material/MenuItem'
import Paper from '@mui/material/Paper'
import Select from '@mui/material/Select'
import Stack from '@mui/material/Stack'
import Switch from '@mui/material/Switch'
import TextField from '@mui/material/TextField'
import type { SxProps, Theme } from '@mui/material/styles'
import Typography from '@mui/material/Typography'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  Bell,
  BellOff,
  Dices,
  Globe,
  Lock,
  RefreshCw,
  ScrollText,
  Search,
  X,
} from 'lucide-react'
import AccentPicker from '@/app/components/AccentPicker'
import AvatarPreview from '@/app/components/AvatarPreview'
import type { PendingRequest } from '@/lib/accessRequests'
import type { DockSnapshot, DockViewer } from '@/lib/dockSnapshot'
import { accentAlpha } from '@/lib/theme'
import { useEventStream } from '../hooks/useEventStream'

type StreamEvent = {
  id: number
  type: 'join' | 'leave'
  text: string
  viewer: string
  path: string | null
  time: string
}

type Visibility = 'public' | 'private'

// What happens to people already watching when a stream goes private.
type ViewerAction = 'approve' | 'reapprove' | 'kick'

const MAX_EVENTS = 500

type HudStatus = 'checking' | 'live' | 'offline' | 'error'

const STATUS_LABELS: Record<HudStatus, string> = {
  checking: 'Checking',
  live: 'LIVE',
  offline: 'OFFLINE',
  error: 'API ERROR',
}

function requestKeyOf(req: PendingRequest) {
  return `${req.path}:${req.ip}:${req.role}`
}

function viewerLabel(viewer: DockViewer) {
  return viewer.name || viewer.ip || 'Guest'
}

function matchesQuery(query: string, ...fields: (string | null)[]) {
  const q = query.trim().toLowerCase()
  return !q || fields.some((f) => f?.toLowerCase().includes(q))
}

export default function DockClient({ embedded = false }: { embedded?: boolean }) {
  const [soundEnabled, setSoundEnabled] = useState(true)
  const [snapshot, setSnapshot] = useState<DockSnapshot | null>(null)
  const [events, setEvents] = useState<StreamEvent[]>([])
  const [copied, setCopied] = useState(false)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [logsOpen, setLogsOpen] = useState(false)
  const [confirmPrivatePath, setConfirmPrivatePath] = useState<string | null>(null)
  const [viewerQuery, setViewerQuery] = useState('')
  // A double-clicked deny would escalate the block.
  const [busy, setBusy] = useState<string | null>(null)

  const soundEnabledRef = useRef(soundEnabled)
  soundEnabledRef.current = soundEnabled
  const knownViewers = useRef<Map<string, DockViewer> | null>(null)
  // Logged as kicked, so not again as disconnected.
  const kickedViewers = useRef(new Set<string>())
  const audioCtxRef = useRef<AudioContext | null>(null)
  const wasLiveRef = useRef<boolean | null>(null)
  const nextEventId = useRef(0)

  function withAudio(play: (ctx: AudioContext, now: number) => void) {
    if (!soundEnabledRef.current) return
    try {
      if (!audioCtxRef.current) {
        audioCtxRef.current = new (
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext })
            .webkitAudioContext
        )()
      }
      const audioCtx = audioCtxRef.current
      if (audioCtx.state === 'suspended') audioCtx.resume()
      play(audioCtx, audioCtx.currentTime)
    } catch (e) {
      console.error('Audio playback error:', e)
    }
  }

  function playChime(isJoin = true) {
    withAudio((ctx, now) => {
      const [first, second] = isJoin ? [587.33, 880] : [880, 587.33]
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()

      osc.type = 'sine'
      osc.frequency.setValueAtTime(first, now)
      osc.frequency.setValueAtTime(second, now + 0.1)

      gain.gain.setValueAtTime(0.12, now)
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35)

      osc.connect(gain)
      gain.connect(ctx.destination)

      osc.start(now)
      osc.stop(now + 0.35)
    })
  }

  function playStreamTone(isStart = true) {
    withAudio((ctx, now) => {
      const notes = isStart ? [523.25, 783.99] : [783.99, 523.25]
      notes.forEach((freq, i) => {
        const start = now + i * 0.09
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()

        osc.type = 'sine'
        osc.frequency.setValueAtTime(freq, start)

        gain.gain.setValueAtTime(0, start)
        gain.gain.linearRampToValueAtTime(0.14, start + 0.015)
        gain.gain.exponentialRampToValueAtTime(0.001, start + 0.18)

        osc.connect(gain)
        gain.connect(ctx.destination)

        osc.start(start)
        osc.stop(start + 0.18)
      })
    })
  }

  function logEvent(type: 'join' | 'leave', text: string, viewer: DockViewer) {
    const now = new Date()
    const timeStr = now.toTimeString().split(' ')[0]
    const event = {
      id: nextEventId.current++,
      type,
      text,
      viewer: viewerLabel(viewer),
      path: viewer.path,
      time: timeStr,
    }
    setEvents((prev) => [event, ...prev].slice(0, MAX_EVENTS))
  }

  function announceChanges(next: DockSnapshot) {
    // A failed MediaMTX request isn't the stream ending or everyone leaving.
    if (!next.mediamtxReachable) return

    const isLive = next.livePaths.length > 0
    if (wasLiveRef.current !== null && isLive !== wasLiveRef.current) {
      playStreamTone(isLive)
    }
    wasLiveRef.current = isLive

    const known = knownViewers.current
    const current = new Map(next.viewers.map((v) => [v.id, v]))
    knownViewers.current = current
    if (!known) return
    for (const viewer of next.viewers) {
      if (known.has(viewer.id)) continue
      logEvent('join', `joined /${viewer.path || 'stream'}`, viewer)
      playChime(true)
    }
    for (const [id, viewer] of known) {
      if (current.has(id) || kickedViewers.current.delete(id)) continue
      logEvent('leave', 'disconnected', viewer)
      playChime(false)
    }
  }

  const { connected } = useEventStream<{ type: 'snapshot'; snapshot: DockSnapshot }>(
    '/api/dock/events',
    (event) => {
      if (event.type !== 'snapshot') return
      announceChanges(event.snapshot)
      setSnapshot(event.snapshot)
    },
  )

  const visibilities = snapshot?.visibility ?? {}
  const livePaths = snapshot?.livePaths ?? []
  // Falls back to the first live stream when the picked one ends.
  const currentPath =
    selectedPath && livePaths.includes(selectedPath) ? selectedPath : (livePaths[0] ?? null)
  // While offline nothing is filtered, so requests waiting for a stream to start still show.
  const onCurrentPath = (path: string | null) => !currentPath || path === currentPath
  const allPending = snapshot?.pending ?? []
  const allReaders = snapshot?.viewers ?? []
  const pendingRequests = allPending.filter((r) => onCurrentPath(r.path))
  const readers = allReaders.filter((r) => onCurrentPath(r.path))
  const visibleEvents = events.filter((e) => onCurrentPath(e.path))
  // Pending requests always come first, then connected viewers.
  const rows: DockRow[] = [
    ...pendingRequests
      .filter((r) => matchesQuery(viewerQuery, r.name, r.clientIp))
      .map((req): DockRow => ({ kind: 'pending', req })),
    ...readers
      .filter((r) => matchesQuery(viewerQuery, r.name, r.discordName, r.ip))
      .map((viewer): DockRow => ({ kind: 'viewer', viewer })),
  ]
  const viewerPassword = currentPath ? (snapshot?.viewerPasswords[currentPath] ?? null) : null
  const isPublic = !!currentPath && visibilities[currentPath] === 'public'
  const watchingCount = (path: string) => allReaders.filter((r) => r.path === path).length
  const confirmPrivateViewers = confirmPrivatePath ? watchingCount(confirmPrivatePath) : 0

  let status: HudStatus = 'checking'
  if (snapshot) {
    if (!connected || !snapshot.mediamtxReachable) status = 'error'
    else status = snapshot.livePaths.length > 0 ? 'live' : 'offline'
  }

  async function run(key: string, request: () => Promise<Response>) {
    setBusy(key)
    try {
      const res = await request()
      if (!res.ok) console.error(`Dock action failed: HTTP ${res.status}`)
      return res.ok
    } catch (err) {
      console.error('Dock action failed:', err)
      return false
    } finally {
      setBusy(null)
    }
  }

  function setVisibility(path: string, visibility: Visibility, viewers?: ViewerAction) {
    return run(`visibility:${path}`, () =>
      fetch('/api/streams/visibility', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, visibility, viewers }),
      }),
    )
  }

  function toggleVisibility(path: string) {
    if (visibilities[path] !== 'public') return setVisibility(path, 'public')
    if (watchingCount(path) === 0) return setVisibility(path, 'private')
    setConfirmPrivatePath(path)
  }

  function confirmGoPrivate(viewers: ViewerAction) {
    if (!confirmPrivatePath) return
    setConfirmPrivatePath(null)
    return setVisibility(confirmPrivatePath, 'private', viewers)
  }

  function respondToRequest(req: PendingRequest, action: 'approve' | 'deny') {
    return run(`request:${requestKeyOf(req)}`, () =>
      fetch(`/api/streams/pending/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: req.path, ip: req.ip, role: req.role }),
      }),
    )
  }

  async function copyPassword() {
    if (!viewerPassword) return
    try {
      await navigator.clipboard.writeText(viewerPassword)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch (err) {
      console.error('Failed to copy password:', err)
    }
  }

  function rotatePassword() {
    if (!currentPath) return
    return run('password', () =>
      fetch(`/api/dock/password?path=${encodeURIComponent(currentPath)}`, {
        method: 'POST',
      }),
    )
  }

  async function kickViewer(viewer: DockViewer) {
    kickedViewers.current.add(viewer.id)
    const kicked = await run(`kick:${viewer.id}`, () =>
      fetch(`/api/dock/viewers?id=${encodeURIComponent(viewer.id)}`, {
        method: 'DELETE',
      }),
    )
    if (kicked) logEvent('leave', 'kicked by streamer', viewer)
    else kickedViewers.current.delete(viewer.id)
  }

  function rerollAvatar(sessionId: string) {
    return run(`reroll:${sessionId}`, () =>
      fetch(`/api/dock/viewers/avatar?id=${encodeURIComponent(sessionId)}`, {
        method: 'POST',
      }),
    )
  }

  const statusLabel = STATUS_LABELS[status]

  return (
    <Box
      sx={{
        minHeight: embedded ? undefined : '100vh',
        bgcolor: 'background.paper',
        fontSize: 13,
        lineHeight: 1.4,
        p: 1.5,
        userSelect: 'none',
      }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          pb: 1.25,
          mb: 1.5,
          borderBottom: 1,
          borderColor: 'divider',
        }}
      >
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          {livePaths.length > 1 ? (
            <Select
              variant="standard"
              disableUnderline
              value={currentPath ?? ''}
              onChange={(e) => setSelectedPath(e.target.value)}
              renderValue={(p) => `/${p}`}
              title="Switch which stream the dock shows"
              sx={{ ...headerTitleSx, fontFamily: 'monospace' }}
            >
              {livePaths.map((p) => {
                const viewers = watchingCount(p)
                const pending = allPending.filter((r) => r.path === p).length
                return (
                  <MenuItem key={p} value={p} sx={{ gap: 1.5, fontSize: 12 }}>
                    <Box component="span" sx={{ fontFamily: 'monospace', flexGrow: 1 }}>
                      /{p}
                    </Box>
                    <Box component="span" sx={{ fontSize: 10, color: 'text.secondary' }}>
                      {viewers} watching
                    </Box>
                    {pending > 0 && (
                      <Box
                        component="span"
                        sx={{ fontSize: 10, fontWeight: 700, color: 'warning.light' }}
                      >
                        {pending} pending
                      </Box>
                    )}
                  </MenuItem>
                )
              })}
            </Select>
          ) : (
            <Typography
              noWrap
              sx={[headerTitleSx, !!currentPath && { fontFamily: 'monospace' }]}
            >
              {currentPath ? `/${currentPath}` : 'MTXcord'}
            </Typography>
          )}
          <StatusPill live={status === 'live'} label={statusLabel} />
        </Stack>
        <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
          <AccentPicker size="small" sx={{ color: 'text.secondary' }} />
          <IconButton
            size="small"
            onClick={() => setLogsOpen(true)}
            title="Show recent viewer activity"
            sx={{ color: 'text.secondary' }}
          >
            <ScrollText size={16} />
          </IconButton>
          <Button
            size="small"
            variant={soundEnabled ? 'outlined' : 'contained'}
            color={soundEnabled ? 'inherit' : 'primary'}
            onClick={() => setSoundEnabled((s) => !s)}
            title="Toggle audio chime on viewer join/leave and stream start/end"
            startIcon={soundEnabled ? <Bell size={14} /> : <BellOff size={14} />}
            sx={{
              fontSize: 11,
              py: 0.25,
              ...(soundEnabled && { color: 'text.secondary', borderColor: 'divider' }),
            }}
          >
            {soundEnabled ? 'Sound On' : 'Muted'}
          </Button>
        </Stack>
      </Box>

      <SectionHeader title="Current Viewer Password" />
      <Card
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 1,
          px: 1.5,
          py: 1,
          mb: 1.5,
        }}
      >
        <Typography
          noWrap
          sx={{ fontFamily: 'monospace', fontSize: 14, color: 'warning.light' }}
        >
          {!currentPath ? 'no active stream' : (viewerPassword ?? 'unavailable')}
        </Typography>
        <Stack direction="row" spacing={0.5} sx={{ flexShrink: 0 }}>
          <IconButton
            size="small"
            onClick={rotatePassword}
            disabled={!currentPath || busy === 'password'}
            title="Rotate the viewer password for this stream"
            sx={smallButtonSx}
          >
            <RefreshCw size={12} />
          </IconButton>
          <Button
            size="small"
            onClick={copyPassword}
            disabled={!viewerPassword}
            title="Copy viewer password"
            sx={smallButtonSx}
          >
            {copied ? 'Copied!' : 'Copy'}
          </Button>
        </Stack>
      </Card>

      <SectionHeader title="Stream Access" />
      <List>
        {!currentPath ? (
          <EmptyRow>No active stream</EmptyRow>
        ) : (
          <Row>
            <Stack
              direction="row"
              spacing={0.75}
              sx={{
                alignItems: 'center',
                fontSize: 11,
                fontWeight: 600,
                textTransform: 'uppercase',
                color: 'text.secondary',
              }}
            >
              {isPublic ? <Globe size={12} /> : <Lock size={12} />}
              <span>{isPublic ? 'Public' : 'Private'}</span>
              <Box component="span" sx={{ fontWeight: 400, textTransform: 'none' }}>
                {isPublic ? 'anyone can join' : 'you approve each viewer'}
              </Box>
            </Stack>
            <Switch
              size="small"
              checked={!isPublic}
              onChange={() => toggleVisibility(currentPath)}
              disabled={busy === `visibility:${currentPath}`}
              slotProps={{ input: { 'aria-label': `Make /${currentPath} private` } }}
            />
          </Row>
        )}
      </List>

      <SectionHeader
        title="Viewers"
        extra={
          <Stack direction="row" spacing={1}>
            {readers.length > 0 && (
              <Box component="span" sx={{ fontSize: 10, fontWeight: 700, color: 'success.main' }}>
                {readers.length}
              </Box>
            )}
            {pendingRequests.length > 0 && (
              <Box component="span" sx={{ fontSize: 10, fontWeight: 700, color: 'warning.light' }}>
                {pendingRequests.length} pending
              </Box>
            )}
          </Stack>
        }
      />
      <SearchField value={viewerQuery} onChange={setViewerQuery} />
      <VirtualList
        items={rows}
        getKey={(row) =>
          row.kind === 'pending' ? `pending:${requestKeyOf(row.req)}` : `viewer:${row.viewer.id}`
        }
        empty={viewerQuery ? 'No matching viewers or requests' : 'No viewers connected'}
        last
        renderItem={(row) =>
          row.kind === 'pending' ? (
            <PendingRow
              req={row.req}
              busy={busy === `request:${requestKeyOf(row.req)}`}
              onRespond={(action) => respondToRequest(row.req, action)}
            />
          ) : (
            <ViewerRow
              viewer={row.viewer}
              rerolling={busy === `reroll:${row.viewer.id}`}
              kicking={busy === `kick:${row.viewer.id}`}
              onReroll={() => rerollAvatar(row.viewer.id)}
              onKick={() => kickViewer(row.viewer)}
            />
          )
        }
      />

      <Dialog
        open={!!confirmPrivatePath}
        onClose={() => setConfirmPrivatePath(null)}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle sx={{ fontSize: 14, fontWeight: 700 }}>
          Make /{confirmPrivatePath} private?
        </DialogTitle>
        <DialogContent>
          <Typography sx={{ fontSize: 12, color: 'text.secondary', mb: 1.5 }}>
            {confirmPrivateViewers === 1
              ? '1 person is watching.'
              : `${confirmPrivateViewers} people are watching.`}{' '}
            New viewers will need your approval. What about the people already here?
          </Typography>
          <Stack spacing={0.75}>
            <Button
              onClick={() => confirmGoPrivate('approve')}
              sx={[tintedButtonSx('success'), { py: 1 }]}
            >
              Approve all, keep them watching
            </Button>
            <Button
              onClick={() => confirmGoPrivate('reapprove')}
              sx={[tintedButtonSx('warning'), { py: 1 }]}
            >
              Make them request access again
            </Button>
            <Button
              onClick={() => confirmGoPrivate('kick')}
              sx={[tintedButtonSx('error'), { py: 1 }]}
            >
              Kick all
            </Button>
            <Button onClick={() => setConfirmPrivatePath(null)} sx={[smallButtonSx, { py: 1 }]}>
              Cancel
            </Button>
          </Stack>
        </DialogContent>
      </Dialog>

      <Dialog open={logsOpen} onClose={() => setLogsOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 1,
            fontSize: 14,
            fontWeight: 700,
          }}
        >
          Recent Activity{currentPath ? ` · /${currentPath}` : ''}
          <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
            <Button
              size="small"
              onClick={() => setEvents([])}
              disabled={events.length === 0}
              sx={smallButtonSx}
            >
              Clear
            </Button>
            <IconButton size="small" onClick={() => setLogsOpen(false)} title="Close" sx={smallButtonSx}>
              <X size={12} />
            </IconButton>
          </Stack>
        </DialogTitle>
        <DialogContent>
          <VirtualList
            items={visibleEvents}
            getKey={(e) => e.id}
            empty="No recent activity"
            estimateSize={34}
            maxHeight="60vh"
            last
            renderItem={(e) => (
              <Row as="div" dense>
                <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', minWidth: 0 }}>
                  <Box
                    component="span"
                    sx={{
                      bgcolor: accentAlpha(0.15, e.type === 'join' ? 'success' : 'error'),
                      color: e.type === 'join' ? 'success.light' : 'error.light',
                      fontSize: 10,
                      fontWeight: 600,
                      px: 0.75,
                      borderRadius: 0.5,
                    }}
                  >
                    {e.type === 'join' ? 'JOIN' : 'LEAVE'}
                  </Box>
                  <Box component="span" sx={{ fontWeight: 600 }}>
                    {e.viewer}
                  </Box>
                  <Box component="span" sx={{ fontSize: 10, color: 'text.secondary' }}>
                    {e.text}
                  </Box>
                </Stack>
                <Box
                  component="span"
                  sx={{ fontFamily: 'monospace', fontSize: 10, color: 'text.secondary' }}
                >
                  {e.time}
                </Box>
              </Row>
            )}
          />
        </DialogContent>
      </Dialog>
    </Box>
  )
}

type Tone = 'success' | 'error' | 'warning' | 'info'

const headerTitleSx = { fontWeight: 700, fontSize: 14, letterSpacing: '0.02em' } as const

function tintedButtonSx(tone: Tone) {
  return {
    minWidth: 0,
    px: 1,
    py: 0.5,
    borderRadius: 1.5,
    fontSize: 11,
    fontWeight: 600,
    lineHeight: 1.4,
    bgcolor: accentAlpha(0.18, tone),
    color: `${tone}.light`,
    '&:hover': { bgcolor: accentAlpha(0.3, tone) },
    '&.Mui-disabled': { color: `${tone}.light`, opacity: 0.4 },
  } as const
}

const smallButtonSx = {
  minWidth: 0,
  px: 1,
  py: 0.5,
  borderRadius: 1.5,
  fontSize: 11,
  lineHeight: 1.4,
  color: 'text.primary',
  bgcolor: 'rgba(255, 255, 255, 0.06)',
  border: 1,
  borderColor: 'divider',
  '&:hover': { bgcolor: accentAlpha(0.3) },
} as const

function StatusPill({ live, label }: { live: boolean; label: string }) {
  return (
    <Box
      component="span"
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 0.75,
        px: 1,
        py: 0.25,
        borderRadius: 5,
        fontSize: 11,
        fontWeight: 600,
        textTransform: 'uppercase',
        bgcolor: live ? accentAlpha(0.15, 'success') : 'rgba(255, 255, 255, 0.06)',
        color: live ? 'success.main' : 'text.secondary',
      }}
    >
      <Box
        component="span"
        sx={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          bgcolor: 'currentColor',
          boxShadow: live ? '0 0 6px currentColor' : 'none',
        }}
      />
      {label}
    </Box>
  )
}

function SectionHeader({ title, extra }: { title: string; extra?: ReactNode }) {
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        my: 1.5,
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        color: 'text.secondary',
      }}
    >
      <span>{title}</span>
      {extra}
    </Box>
  )
}

function Card({ sx, children }: { sx?: SxProps<Theme>; children: ReactNode }) {
  return (
    <Paper
      variant="outlined"
      sx={[
        { bgcolor: 'background.default', borderRadius: 2 },
        ...(Array.isArray(sx) ? sx : [sx]),
      ]}
    >
      {children}
    </Paper>
  )
}

function List({
  scroll,
  last,
  children,
}: {
  scroll?: boolean
  last?: boolean
  children: ReactNode
}) {
  return (
    <Box
      component="ul"
      sx={{
        listStyle: 'none',
        m: 0,
        mb: last ? 0 : 1.5,
        p: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 0.75,
        maxHeight: scroll ? 220 : undefined,
        overflowY: scroll ? 'auto' : undefined,
      }}
    >
      {children}
    </Box>
  )
}

type DockRow =
  | { kind: 'pending'; req: PendingRequest }
  | { kind: 'viewer'; viewer: DockViewer }

function PendingRow({
  req,
  busy,
  onRespond,
}: {
  req: PendingRequest
  busy: boolean
  onRespond: (action: 'approve' | 'deny') => void
}) {
  return (
    <Row as="div" pending>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', minWidth: 0 }}>
        <SmallAvatar image={req.image} fallback={req.name || req.clientIp || 'Guest'} />
        <Box sx={{ minWidth: 0 }}>
          <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', minWidth: 0 }}>
            <Typography noWrap sx={{ fontSize: 12, fontWeight: 600, color: 'primary.light' }}>
              {req.name ?? req.clientIp ?? 'Guest'}
            </Typography>
            {req.role === 'discord' && <DiscordIcon />}
          </Stack>
          <Typography sx={{ fontSize: 10, color: 'text.secondary' }}>
            {req.name && req.clientIp && <>{req.clientIp} · </>}
            wants to join <strong>/{req.path}</strong>
          </Typography>
        </Box>
      </Stack>
      <Stack direction="row" spacing={0.75} sx={{ flexShrink: 0 }}>
        <Button
          size="small"
          onClick={() => onRespond('approve')}
          disabled={busy}
          sx={tintedButtonSx('success')}
        >
          Approve
        </Button>
        <Button
          size="small"
          onClick={() => onRespond('deny')}
          disabled={busy}
          sx={tintedButtonSx('error')}
        >
          Deny
        </Button>
      </Stack>
    </Row>
  )
}

function ViewerRow({
  viewer,
  rerolling,
  kicking,
  onReroll,
  onKick,
}: {
  viewer: DockViewer
  rerolling: boolean
  kicking: boolean
  onReroll: () => void
  onKick: () => void
}) {
  return (
    <Row as="div">
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', minWidth: 0 }}>
        {viewer.image ? (
          <AvatarPreview
            image={viewer.image}
            name={viewerLabel(viewer)}
            sx={{ display: 'flex', flexShrink: 0, cursor: 'zoom-in' }}
          >
            <SmallAvatar image={viewer.image} fallback="G" />
          </AvatarPreview>
        ) : (
          <SmallAvatar image={null} fallback={viewer.name || 'G'} />
        )}
        <Box sx={{ minWidth: 0 }}>
          <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', minWidth: 0 }}>
            <Typography noWrap sx={{ fontSize: 12, fontWeight: 600, color: 'primary.light' }}>
              {viewerLabel(viewer)}
            </Typography>
            {viewer.role === 'discord' && !viewer.hasPony && <DiscordIcon />}
          </Stack>
          {viewer.discordName && (
            <Stack
              direction="row"
              spacing={0.5}
              sx={{ alignItems: 'center', fontSize: 10, color: 'discord.light' }}
            >
              {viewer.discordImage && (
                <Avatar
                  src={viewer.discordImage}
                  alt=""
                  slotProps={{ img: { referrerPolicy: 'no-referrer' } }}
                  sx={{ width: 12, height: 12 }}
                />
              )}
              <span>{viewer.discordName}</span>
              <DiscordIcon size={10} />
            </Stack>
          )}
          <Typography sx={{ fontSize: 10, color: 'text.secondary' }}>
            {viewer.ip && <>{viewer.ip} · </>}
            Path: <strong>{viewer.path || 'default'}</strong>
          </Typography>
        </Box>
      </Stack>
      <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', flexShrink: 0 }}>
        {viewer.hasPony && (
          <IconButton
            size="small"
            onClick={onReroll}
            disabled={rerolling}
            title="Give this viewer a different pony picture"
            sx={tintedButtonSx('info')}
          >
            {rerolling ? (
              <CircularProgress size={12} color="inherit" />
            ) : (
              <Dices size={12} />
            )}
          </IconButton>
        )}
        <IconButton
          size="small"
          onClick={onKick}
          disabled={kicking}
          title="Kick this viewer"
          sx={tintedButtonSx('error')}
        >
          <X size={12} />
        </IconButton>
      </Stack>
    </Row>
  )
}

function Row({
  dense,
  pending,
  as = 'li',
  children,
}: {
  dense?: boolean
  pending?: boolean
  as?: 'li' | 'div'
  children: ReactNode
}) {
  return (
    <Paper
      component={as}
      variant="outlined"
      sx={{
        bgcolor: 'background.default',
        borderRadius: 1.5,
        px: 1.25,
        py: dense ? 0.75 : 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 1,
        fontSize: dense ? 11 : 12,
        ...(pending && { borderLeft: 3, borderLeftColor: 'warning.main' }),
      }}
    >
      {children}
    </Paper>
  )
}

function SearchField({
  value,
  onChange,
}: {
  value: string
  onChange: (value: string) => void
}) {
  return (
    <TextField
      size="small"
      fullWidth
      placeholder="Search name, Discord or IP"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      slotProps={{
        input: {
          startAdornment: (
            <InputAdornment position="start">
              <Search size={14} />
            </InputAdornment>
          ),
          endAdornment: value && (
            <InputAdornment position="end">
              <IconButton size="small" onClick={() => onChange('')} title="Clear search">
                <X size={12} />
              </IconButton>
            </InputAdornment>
          ),
          sx: { fontSize: 12 },
        },
      }}
      sx={{ mb: 0.75 }}
    />
  )
}

// Only the rows in view are mounted, so long viewer/request lists stay cheap.
function VirtualList<T>({
  items,
  getKey,
  renderItem,
  empty,
  estimateSize = 52,
  maxHeight = 220,
  last,
}: {
  items: T[]
  getKey: (item: T) => string | number
  renderItem: (item: T) => ReactNode
  empty: string
  estimateSize?: number
  maxHeight?: number | string
  last?: boolean
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimateSize,
    getItemKey: (index) => getKey(items[index]),
    gap: 6,
  })

  if (items.length === 0) {
    return (
      <List last={last}>
        <EmptyRow>{empty}</EmptyRow>
      </List>
    )
  }

  return (
    <Box ref={scrollRef} sx={{ maxHeight, overflowY: 'auto', mb: last ? 0 : 1.5 }}>
      <Box
        component="ul"
        sx={{
          listStyle: 'none',
          m: 0,
          p: 0,
          position: 'relative',
          height: virtualizer.getTotalSize(),
        }}
      >
        {virtualizer.getVirtualItems().map((item) => (
          <Box
            component="li"
            key={item.key}
            data-index={item.index}
            ref={virtualizer.measureElement}
            sx={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${item.start}px)`,
            }}
          >
            {renderItem(items[item.index])}
          </Box>
        ))}
      </Box>
    </Box>
  )
}

function EmptyRow({ children }: { children: ReactNode }) {
  return (
    <Box
      component="li"
      sx={{
        p: 2,
        textAlign: 'center',
        fontStyle: 'italic',
        color: 'text.secondary',
        borderRadius: 1.5,
        border: '1px dashed',
        borderColor: 'divider',
        bgcolor: 'rgba(0, 0, 0, 0.2)',
      }}
    >
      {children}
    </Box>
  )
}

function SmallAvatar({
  image,
  fallback,
}: {
  image: string | null
  fallback: string
}) {
  return (
    <Avatar
      src={image ?? undefined}
      alt=""
      slotProps={{ img: { referrerPolicy: 'no-referrer' } }}
      sx={{
        width: 24,
        height: 24,
        flexShrink: 0,
        fontSize: 10,
        fontWeight: 600,
        bgcolor: 'rgba(255, 255, 255, 0.08)',
        color: 'text.secondary',
      }}
    >
      {fallback.charAt(0).toUpperCase()}
    </Avatar>
  )
}

function DiscordIcon({ size = 12 }: { size?: number }) {
  return (
    // A mask instead of <img>, so the logo takes the accent colour.
    <Box
      component="span"
      role="img"
      aria-label="Discord"
      title="Discord"
      sx={{
        width: size,
        height: size,
        flexShrink: 0,
        bgcolor: 'primary.main',
        mask: 'url(/discord.svg) center / contain no-repeat',
      }}
    />
  )
}
