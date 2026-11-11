import { http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { getDiscordWebhookMessageId } from '@/lib/db'
import { syncDiscordWebhookMessage } from '@/lib/discordWebhook'
import { server, useFakeDiscordWebhook } from '../../helpers/msw'

describe('webhook selection', () => {
  it('does nothing when no webhook is configured', async () => {
    const fake = useFakeDiscordWebhook()
    await syncDiscordWebhookMessage('live', true)
    await syncDiscordWebhookMessage('live', false)
    expect(fake.calls).toEqual([])
    expect(getDiscordWebhookMessageId('live')).toBeNull()
  })

  it('uses the fallback DISCORD_WEBHOOK_URL', async () => {
    const fake = useFakeDiscordWebhook()
    vi.stubEnv('DISCORD_WEBHOOK_URL', fake.url)
    await syncDiscordWebhookMessage('anything', true)
    expect(fake.posts()).toHaveLength(1)
  })

  it('prefers the per-path URL from DISCORD_WEBHOOK_URLS', async () => {
    const fallback = useFakeDiscordWebhook('https://discord.test/api/webhooks/1/fallback')
    const a = useFakeDiscordWebhook('https://discord.test/api/webhooks/2/aaa')
    const b = useFakeDiscordWebhook('https://discord.test/api/webhooks/3/bbb')
    vi.stubEnv('DISCORD_WEBHOOK_URL', fallback.url)
    vi.stubEnv('DISCORD_WEBHOOK_URLS', ` a:${a.url} , b : ${b.url} ,junk-without-separator,`)

    await syncDiscordWebhookMessage('a', true)
    await syncDiscordWebhookMessage('b', true)
    await syncDiscordWebhookMessage('c', true)

    expect(a.posts()).toHaveLength(1)
    expect(b.posts()).toHaveLength(1)
    expect(fallback.posts()).toHaveLength(1)
    expect(fallback.posts()[0].body.embeds?.[0].description).toContain('**c**')
  })

  it('does nothing for a path missing from DISCORD_WEBHOOK_URLS without a fallback', async () => {
    const a = useFakeDiscordWebhook()
    vi.stubEnv('DISCORD_WEBHOOK_URLS', `a:${a.url}`)
    await syncDiscordWebhookMessage('other', true)
    expect(a.calls).toEqual([])
  })
})

describe('message lifecycle', () => {
  function useConfiguredWebhook() {
    const fake = useFakeDiscordWebhook()
    vi.stubEnv('DISCORD_WEBHOOK_URL', fake.url)
    return fake
  }

  it('posts a new message when going live and remembers its id', async () => {
    const fake = useConfiguredWebhook()
    await syncDiscordWebhookMessage('live', true)
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0].method).toBe('POST')
    expect(fake.calls[0].url).toBe(`${fake.url}?wait=true`)
    expect(fake.calls[0].body.embeds?.[0]).toMatchObject({
      title: '🔴 Stream is LIVE',
      color: 0xed4245,
      footer: { text: 'live' },
    })
    expect(getDiscordWebhookMessageId('live')).toBe('msg-1')
  })

  it('edits that message on later transitions instead of posting again', async () => {
    const fake = useConfiguredWebhook()
    await syncDiscordWebhookMessage('live', true)
    await syncDiscordWebhookMessage('live', false)
    await syncDiscordWebhookMessage('live', true)

    expect(fake.posts()).toHaveLength(1)
    expect(fake.patches().map((c) => c.url)).toEqual([
      `${fake.url}/messages/msg-1`,
      `${fake.url}/messages/msg-1`,
    ])
    expect(fake.patches()[0].body.embeds?.[0]).toMatchObject({
      title: '⚫ Stream ended',
      color: 0x747f8d,
    })
    expect(fake.patches()[1].body.embeds?.[0].title).toBe('🔴 Stream is LIVE')
  })

  it('keeps messages per path', async () => {
    const fake = useConfiguredWebhook()
    await syncDiscordWebhookMessage('one', true)
    await syncDiscordWebhookMessage('two', true)
    expect(getDiscordWebhookMessageId('one')).toBe('msg-1')
    expect(getDiscordWebhookMessageId('two')).toBe('msg-2')
    await syncDiscordWebhookMessage('two', false)
    expect(fake.patches().map((c) => c.url)).toEqual([`${fake.url}/messages/msg-2`])
  })

  it('posts a fresh message when the old one was deleted', async () => {
    const fake = useConfiguredWebhook()
    await syncDiscordWebhookMessage('live', true)
    fake.deleteMessage('msg-1')
    await syncDiscordWebhookMessage('live', true)

    expect(fake.patches()).toHaveLength(1)
    expect(fake.posts()).toHaveLength(2)
    expect(getDiscordWebhookMessageId('live')).toBe('msg-2')
  })

  it('does not announce "offline" without an earlier message', async () => {
    const fake = useConfiguredWebhook()
    await syncDiscordWebhookMessage('live', false)
    expect(fake.calls).toEqual([])
  })

  it('does not repost when going offline and the message was deleted', async () => {
    const fake = useConfiguredWebhook()
    await syncDiscordWebhookMessage('live', true)
    fake.deleteMessage('msg-1')
    await syncDiscordWebhookMessage('live', false)

    expect(fake.posts()).toHaveLength(1)
    expect(fake.patches()).toHaveLength(1)
    expect(getDiscordWebhookMessageId('live')).toBeNull()
  })

  it('links the player when PLAYER_DOMAIN is set', async () => {
    const fake = useConfiguredWebhook()
    vi.stubEnv('PLAYER_DOMAIN', 'watch.example.com')
    await syncDiscordWebhookMessage('live', true)
    const embed = fake.posts()[0].body.embeds?.[0]
    expect(embed?.description).toContain('[Watch now](https://watch.example.com/live/)')
    expect(embed?.description).toContain('**live** just went live!')
  })

  it('announces going live without a link when PLAYER_DOMAIN is unset', async () => {
    const fake = useConfiguredWebhook()
    vi.stubEnv('PLAYER_DOMAIN', '')
    await syncDiscordWebhookMessage('live', true)
    const embed = fake.posts()[0].body.embeds?.[0]
    expect(embed?.title).toBe('🔴 Stream is LIVE')
    expect(embed?.description).toBe('**live** just went live!')
    expect(embed?.description).not.toContain('offline')
    expect(embed?.description).not.toContain('http')
  })

  it('survives a failing webhook without storing an id', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    server.use(
      http.post('https://discord.test/api/webhooks/9/bad', () =>
        HttpResponse.text('nope', { status: 500 }),
      ),
    )
    vi.stubEnv('DISCORD_WEBHOOK_URL', 'https://discord.test/api/webhooks/9/bad')
    await expect(syncDiscordWebhookMessage('live', true)).resolves.toBeUndefined()
    expect(getDiscordWebhookMessageId('live')).toBeNull()
    expect(error).toHaveBeenCalled()
  })

  it('survives a network error', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    server.use(
      http.post('https://discord.test/api/webhooks/9/down', () => HttpResponse.error()),
    )
    vi.stubEnv('DISCORD_WEBHOOK_URL', 'https://discord.test/api/webhooks/9/down')
    await expect(syncDiscordWebhookMessage('live', true)).resolves.toBeUndefined()
    expect(getDiscordWebhookMessageId('live')).toBeNull()
    expect(error).toHaveBeenCalled()
  })
})
