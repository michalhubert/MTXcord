'use client'

import { signOut } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { useEffect, useState, type ReactNode } from 'react'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { Lock, Radio, UserX } from 'lucide-react'
import { useViewerChannel } from '@/app/hooks/useViewerChannel'
import { withManualLogin } from '@/lib/loginUrl'
import LoginShell from './LoginShell'

type Gate =
  | { status: 'checking' | 'pending' | 'offline' }
  | { status: 'blocked'; reason: 'kicked' | 'denied'; until: number }

const blockTitles: Record<'kicked' | 'denied', string> = {
  kicked: 'You were removed by the streamer',
  denied: 'The streamer declined your request',
}

function formatTimeRemaining(ms: number): string {
  const seconds = Math.max(Math.ceil(ms / 1000), 0)
  if (seconds < 60) return `${seconds}s`
  return `${Math.ceil(seconds / 60)}m`
}

// For a signed-in viewer who can't watch yet.
export default function StreamGate({ path }: { path: string }) {
  const router = useRouter()
  const [now, setNow] = useState(() => Date.now())
  const { state } = useViewerChannel(path, {
    gate: true,
    onEvent(event) {
      if (event.type === 'state') setNow(Date.now())
    },
  })
  const canWatch = state?.access.status === 'ok' && state.online
  const isUnauthorized = state?.access.status === 'unauthorized'

  let gate: Gate = { status: 'checking' }
  if (state && !canWatch && !isUnauthorized) {
    gate =
      state.access.status === 'blocked'
        ? {
            status: 'blocked',
            reason: state.access.reason,
            until: state.receivedAt + state.access.remainingMs,
          }
        : { status: state.online ? 'pending' : 'offline' }
  }
  const isBlocked = gate.status === 'blocked'

  useEffect(() => {
    if (canWatch) router.replace(`/${path}`)
    // Shows the login form instead.
    else if (isUnauthorized) router.refresh()
  }, [canWatch, isUnauthorized, path, router])

  useEffect(() => {
    if (!isBlocked) return
    const interval = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(interval)
  }, [isBlocked])

  return (
    <LoginShell>
      {gate.status === 'checking' && (
        <Stack sx={{ alignItems: 'center', py: 2 }}>
          <CircularProgress size={28} />
        </Stack>
      )}
      {gate.status === 'pending' && (
        <GateMessage
          icon={<Lock size={36} />}
          title="Waiting for the streamer to let you in…"
          footer={<CircularProgress size={20} />}
        >
          This is a private stream. Hang tight.
        </GateMessage>
      )}
      {gate.status === 'offline' && (
        <GateMessage icon={<Radio size={36} />} title="Stream is offline">
          You&apos;ll be let in once the streamer goes live.
        </GateMessage>
      )}
      {gate.status === 'blocked' && (
        <GateMessage
          icon={<UserX size={36} />}
          iconColor="error.main"
          title={blockTitles[gate.reason]}
        >
          You can try again in{' '}
          <Box component="span" sx={{ color: 'error.light', fontWeight: 600 }}>
            {formatTimeRemaining(gate.until - now)}
          </Box>
        </GateMessage>
      )}

      <Button
        fullWidth
        size="small"
        color="inherit"
        sx={{ mt: 3, color: 'text.secondary' }}
        onClick={() =>
          signOut({ redirect: false }).then(() => {
            const { pathname, search } = window.location
            window.location.href = withManualLogin(pathname + search)
          })
        }
      >
        Sign out
      </Button>
    </LoginShell>
  )
}

function GateMessage({
  icon,
  iconColor = 'text.disabled',
  title,
  footer,
  children,
}: {
  icon: ReactNode
  iconColor?: string
  title: string
  footer?: ReactNode
  children: ReactNode
}) {
  return (
    <Stack spacing={1.5} sx={{ alignItems: 'center', textAlign: 'center' }}>
      <Box sx={{ display: 'flex', color: iconColor }}>{icon}</Box>
      <Typography variant="subtitle1" component="p" sx={{ fontWeight: 600 }}>
        {title}
      </Typography>
      <Typography variant="body2" color="text.secondary">
        {children}
      </Typography>
      {footer}
    </Stack>
  )
}
