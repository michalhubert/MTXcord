import { Suspense } from 'react'
import { auth } from '@/lib/auth'
import { headers } from 'next/headers'
import { isSessionRevoked, type SessionUser } from '@/lib/authz'
import { getClientIp } from '@/lib/net'
import { trustedLogin } from '@/lib/trustedLogin'
import { streamPathOf } from '@/lib/loginUrl'
import LoginForm from './LoginForm'
import StreamGate from './StreamGate'

export const dynamic = 'force-dynamic'

function getDiscordEnabled() {
  return (
    process.env.NEXT_PUBLIC_DISCORD_ENABLED === 'true' ||
    !!(process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET)
  )
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { callbackUrl, mode, manual } = await searchParams
  const path = streamPathOf(callbackUrl)
  const user = (await auth())?.user as SessionUser | undefined
  const ip = getClientIp({ headers: await headers() })

  const revoked = !!user && isSessionRevoked(user, path, ip)

  if (path && mode !== 'streamer' && user && user.role !== 'streamer' && !revoked) {
    return <StreamGate path={path} />
  }

  return (
    <Suspense>
      <LoginForm
        discordEnabled={getDiscordEnabled()}
        {...trustedLogin({ user, revoked, mode, manual, ip })}
      />
    </Suspense>
  )
}
