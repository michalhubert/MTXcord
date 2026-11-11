'use client'

import { signIn } from 'next-auth/react'
import { useSearchParams } from 'next/navigation'
import { type SubmitEvent, useCallback, useEffect, useRef, useState } from 'react'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import Divider from '@mui/material/Divider'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { sameSitePath } from '@/lib/loginUrl'
import LoginShell from './LoginShell'

const TRUSTED_SIGN_IN_FAILED = "Couldn't sign you in automatically. Use the password or Discord."

export default function LoginForm({
  discordEnabled,
  trusted = false,
  autoSignIn = false,
}: {
  discordEnabled: boolean
  // The client's IP is in TRUSTED_NETWORKS: no password needed. Both flags are decided
  // on the server (lib/trustedLogin.ts), including the streamer-mode and session rules.
  trusted?: boolean
  autoSignIn?: boolean
}) {
  const searchParams = useSearchParams()
  const isStreamerMode = searchParams.get('mode') === 'streamer'
  const callbackUrl = sameSitePath(
    searchParams.get('callbackUrl'),
    isStreamerMode ? '/dock' : '/',
  )
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [trustedError, setTrustedError] = useState(false)
  const [loading, setLoading] = useState(false)
  const [signingInTrusted, setSigningInTrusted] = useState(autoSignIn)
  const autoStarted = useRef(false)

  // Fails when the server refuses, e.g. the IP is no longer trusted: back to the form.
  const signInTrusted = useCallback(async () => {
    setSigningInTrusted(true)
    setTrustedError(false)
    try {
      const res = await signIn('trusted-network', { redirect: false })
      if (res && !res.error) {
        window.location.href = callbackUrl
        return
      }
    } catch {
      // Handled below, like a refusal.
    }
    setTrustedError(true)
    setSigningInTrusted(false)
  }, [callbackUrl])

  useEffect(() => {
    if (!autoSignIn || autoStarted.current) return
    autoStarted.current = true
    void signInTrusted()
  }, [autoSignIn, signInTrusted])

  async function handleSubmit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault()
    setLoading(true)
    setError('')
    const res = await signIn(
      isStreamerMode ? 'streamer-password' : 'viewer-password',
      { password, redirect: false },
    )
    setLoading(false)
    if (res?.error) {
      setError('Invalid password. Try again.')
    } else {
      window.location.href = callbackUrl
    }
  }

  if (signingInTrusted) {
    return (
      <LoginShell>
        <Stack spacing={2} sx={{ alignItems: 'center', py: 2 }}>
          <CircularProgress size={28} />
          <Typography variant="body2" color="text.secondary">
            Signing you in…
          </Typography>
        </Stack>
      </LoginShell>
    )
  }

  return (
    <LoginShell isStreamerMode={isStreamerMode}>
      {trusted && trustedError && (
        // Trust is decided by the server on every request, so retrying can't help.
        <Typography
          role="alert"
          variant="body2"
          color="error"
          sx={{ mb: 2, textAlign: 'center' }}
        >
          {TRUSTED_SIGN_IN_FAILED}
        </Typography>
      )}
      {trusted && !trustedError && (
        <>
          <Button
            fullWidth
            variant="contained"
            size="large"
            onClick={() => void signInTrusted()}
          >
            Continue without password
          </Button>
          <Divider
            sx={{ my: 2.5, typography: 'caption', color: 'text.disabled' }}
          >
            or
          </Divider>
        </>
      )}

      {!isStreamerMode && discordEnabled && (
        <>
          <Button
            fullWidth
            variant="contained"
            color="discord"
            size="large"
            onClick={() => signIn('discord', { callbackUrl })}
          >
            Sign in with Discord
          </Button>
          <Divider
            sx={{ my: 2.5, typography: 'caption', color: 'text.disabled' }}
          >
            or
          </Divider>
        </>
      )}

      <Stack component="form" onSubmit={handleSubmit} spacing={2}>
        <TextField
          type="password"
          label={isStreamerMode ? 'Streamer Password' : 'Viewer Password'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={
            isStreamerMode ? 'Enter streamer password' : 'Enter stream password'
          }
          required
          error={!!error}
          helperText={error || undefined}
        />

        <Button
          type="submit"
          fullWidth
          variant="contained"
          size="large"
          loading={loading}
          loadingPosition="start"
        >
          {loading
            ? 'Signing in…'
            : isStreamerMode
              ? 'Open Dock'
              : 'Watch Stream'}
        </Button>
      </Stack>

      {!isStreamerMode && (
        <Typography
          variant="caption"
          component="p"
          color="text.disabled"
          sx={{ mt: 3, textAlign: 'center' }}
        >
          Don&apos;t have Discord? Ask the streamer for the viewer password.
        </Typography>
      )}
    </LoginShell>
  )
}
