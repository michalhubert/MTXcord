import { describe, expect, it, vi } from 'vitest'
import { POST } from '@/app/api/streams/hook/route'
import { approveAccess, isApproved } from '@/lib/accessRequests'
import { getDiscordWebhookMessageId } from '@/lib/db'
import { onChanged } from '@/lib/events'
import { isStreamOnline, syncStreamState } from '@/lib/streamState'
import { flushNotifications } from '../helpers/clock'
import { useFakeDiscordWebhook } from '../helpers/msw'
import { installFakeDiscordWebhook } from './_support'
import { nextRequest } from '../helpers/request'

const SECRET = 'test-hook-secret'

const hook = (
  body: unknown,
  headers: Record<string, string> = { 'x-hook-secret': SECRET },
) => POST(nextRequest('/api/streams/hook', { json: body, headers }))

describe('POST /api/streams/hook', () => {
  describe('authentication', () => {
    it('rejects a missing secret with 401 and changes nothing', async () => {
      const res = await hook({ path: 'cam', action: 'ready' }, {})
      expect(res.status).toBe(401)
      expect(isStreamOnline('cam')).toBe(false)
    })

    it('rejects a wrong secret with 401', async () => {
      const res = await hook(
        { path: 'cam', action: 'ready' },
        { 'x-hook-secret': 'nope' },
      )
      expect(res.status).toBe(401)
      expect(isStreamOnline('cam')).toBe(false)
    })

    it('rejects everything when HOOK_SECRET is not configured', async () => {
      vi.stubEnv('HOOK_SECRET', '')
      const res = await hook({ path: 'cam', action: 'ready' }, { 'x-hook-secret': '' })
      expect(res.status).toBe(401)
      const res2 = await hook({ path: 'cam', action: 'ready' })
      expect(res2.status).toBe(401)
      expect(isStreamOnline('cam')).toBe(false)
    })
  })

  describe('stream state', () => {
    it.each(['ready', 'online'])('%s creates the stream session', async (action) => {
      const res = await hook({ path: 'cam', action })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
      expect(isStreamOnline('cam')).toBe(true)
      expect(isStreamOnline('other')).toBe(false)
    })

    it.each(['notReady', 'offline'])('%s deletes the stream session', async (action) => {
      syncStreamState('cam', { ready: true })
      expect(isStreamOnline('cam')).toBe(true)

      const res = await hook({ path: 'cam', action })
      expect(res.status).toBe(200)
      expect(isStreamOnline('cam')).toBe(false)
    })

    it('clears that path\'s approvals when the stream goes live, not other paths\'', async () => {
      approveAccess('cam', '198.51.100.7', 'viewer')
      approveAccess('other', '198.51.100.7', 'viewer')

      await hook({ path: 'cam', action: 'ready' })

      expect(isApproved('cam', '198.51.100.7', 'viewer')).toBe(false)
      expect(isApproved('other', '198.51.100.7', 'viewer')).toBe(true)
    })

    it('clears that path\'s approvals when the stream goes offline', async () => {
      await hook({ path: 'cam', action: 'ready' })
      approveAccess('cam', '198.51.100.7', 'viewer')
      approveAccess('other', '198.51.100.7', 'viewer')

      await hook({ path: 'cam', action: 'notReady' })

      expect(isApproved('cam', '198.51.100.7', 'viewer')).toBe(false)
      expect(isApproved('other', '198.51.100.7', 'viewer')).toBe(true)
    })

    it('keeps approvals when a duplicate ready hook arrives for a live stream', async () => {
      await hook({ path: 'cam', action: 'ready' })
      approveAccess('cam', '198.51.100.7', 'viewer')

      await hook({ path: 'cam', action: 'ready' })

      expect(isStreamOnline('cam')).toBe(true)
      expect(isApproved('cam', '198.51.100.7', 'viewer')).toBe(true)
    })

    it('notifies change listeners about the path', async () => {
      const seen: string[] = []
      onChanged((paths) => seen.push(...paths))

      await hook({ path: 'cam', action: 'ready' })
      await flushNotifications()

      expect(seen).toContain('cam')
    })
  })

  describe('read / unread', () => {
    it.each(['read', 'unread'])('%s only notifies, with no DB change', async (action) => {
      const seen: string[] = []
      onChanged((paths) => seen.push(...paths))

      const res = await hook({ path: 'cam', action })
      await flushNotifications()

      expect(res.status).toBe(200)
      expect(seen).toEqual(['cam'])
      expect(isStreamOnline('cam')).toBe(false)
    })

    it('does not end a live stream', async () => {
      syncStreamState('cam', { ready: true })
      await hook({ path: 'cam', action: 'unread' })
      expect(isStreamOnline('cam')).toBe(true)
    })

    it('does not post to Discord', async () => {
      vi.stubEnv('DISCORD_WEBHOOK_URL', 'https://discord.test/api/webhooks/123/token')
      const discord = useFakeDiscordWebhook()
      await hook({ path: 'cam', action: 'read' })
      expect(discord.calls).toHaveLength(0)
    })
  })

  describe('no-ops and bad input', () => {
    it('answers 200 and does nothing for an unknown action', async () => {
      const res = await hook({ path: 'cam', action: 'explode' })
      expect(res.status).toBe(200)
      expect(isStreamOnline('cam')).toBe(false)
    })

    it('answers 200 and does nothing when the path is missing', async () => {
      const res = await hook({ action: 'ready' })
      expect(res.status).toBe(200)
      expect(isStreamOnline('cam')).toBe(false)
    })

    it('ignores a non-string path', async () => {
      const res = await hook({ path: 42, action: 'ready' })
      expect(res.status).toBe(200)
    })

    it('answers 200 for a JSON null body', async () => {
      const res = await hook(null)
      expect(res.status).toBe(200)
    })

    it('answers 400 for a body that is not JSON', async () => {
      const res = await POST(
        nextRequest('/api/streams/hook', {
          method: 'POST',
          body: 'not json',
          headers: { 'x-hook-secret': SECRET },
        }),
      )
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'Invalid request' })
    })
  })

  describe('Discord webhook', () => {
    const WEBHOOK = 'https://discord.test/api/webhooks/123/token'

    function configure() {
      vi.stubEnv('DISCORD_WEBHOOK_URL', WEBHOOK)
      vi.stubEnv('PLAYER_DOMAIN', 'watch.example.test')
      return installFakeDiscordWebhook(WEBHOOK)
    }

    it('posts a LIVE message when the stream goes live', async () => {
      const discord = configure()

      await hook({ path: 'cam', action: 'ready' })

      expect(discord.posts()).toHaveLength(1)
      expect(discord.patches()).toHaveLength(0)
      const embed = discord.posts()[0].body.embeds?.[0]
      expect(embed?.title).toContain('LIVE')
      expect(embed?.description).toContain('https://watch.example.test/cam/')
      expect(getDiscordWebhookMessageId('cam')).toBe('msg-1')
    })

    it('edits the same message when the stream goes offline', async () => {
      const discord = configure()
      await hook({ path: 'cam', action: 'ready' })

      await hook({ path: 'cam', action: 'notReady' })

      expect(discord.posts()).toHaveLength(1)
      expect(discord.patches()).toHaveLength(1)
      expect(discord.patches()[0].url).toContain('/messages/msg-1')
      expect(discord.patches()[0].body.embeds?.[0].title).toContain('ended')
    })

    it('edits the existing message again on the next go-live instead of posting a new one', async () => {
      const discord = configure()
      await hook({ path: 'cam', action: 'ready' })
      await hook({ path: 'cam', action: 'offline' })

      await hook({ path: 'cam', action: 'online' })

      expect(discord.posts()).toHaveLength(1)
      expect(discord.patches()).toHaveLength(2)
      expect(discord.patches()[1].body.embeds?.[0].title).toContain('LIVE')
    })

    it('does not call Discord when going offline without ever having announced', async () => {
      const discord = configure()
      syncStreamState('cam', { ready: true })

      await hook({ path: 'cam', action: 'notReady' })

      expect(discord.calls).toHaveLength(0)
    })

    it('makes no Discord call when no webhook is configured', async () => {
      const discord = useFakeDiscordWebhook(WEBHOOK)
      const res = await hook({ path: 'cam', action: 'ready' })
      expect(res.status).toBe(200)
      expect(discord.calls).toHaveLength(0)
    })

    it('uses the per-path webhook URL', async () => {
      vi.stubEnv('DISCORD_WEBHOOK_URL', '')
      vi.stubEnv('DISCORD_WEBHOOK_URLS', `cam:${WEBHOOK}`)
      vi.stubEnv('PLAYER_DOMAIN', 'watch.example.test')
      const discord = useFakeDiscordWebhook(WEBHOOK)

      await hook({ path: 'other', action: 'ready' })
      expect(discord.calls).toHaveLength(0)

      await hook({ path: 'cam', action: 'ready' })
      expect(discord.posts()).toHaveLength(1)
    })
  })
})
