import {
  dockRow,
  expect,
  fake,
  goLive,
  ipPattern,
  loginAsGuest,
  loginAsStreamer,
  rotatePassword,
  test,
  trustedIp,
  uniquePath,
} from './fixtures'

const WAITING = 'Waiting for the streamer to let you in…'

test.describe('guest access', () => {
  test('private stream: the guest waits until the streamer approves', async ({ client }) => {
    const path = uniquePath()
    await goLive(path)
    const streamer = await client()
    const guest = await client()
    await loginAsStreamer(streamer.page)
    const password = await rotatePassword(streamer.page, path)

    await loginAsGuest(guest.page, path, password)
    await expect(guest.page.getByText(WAITING)).toBeVisible()

    // The request shows up in the dock, keyed by the guest's IP.
    const row = dockRow(streamer.page, ipPattern(guest.ip), 'Approve')
    await expect(row).toContainText(`wants to join /${path}`)
    await row.getByRole('button', { name: 'Approve', exact: true }).click()

    // The gate lets the guest through to the player.
    await expect(guest.page).toHaveURL(new RegExp(`/${path}$`))
    await expect(guest.page.getByText(WAITING)).toHaveCount(0)
    await expect(guest.page.locator('video')).toBeAttached()

    await expect
      .poll(async () => {
        const { whepPosts } = await fake.state()
        return whepPosts.filter((r) => r.path === `/${path}/whep` && r.authorized).length
      })
      .toBeGreaterThan(0)
  })

  test('private stream: a denied guest is told to wait', async ({ client }) => {
    const path = uniquePath()
    await goLive(path)
    const streamer = await client()
    const guest = await client()
    await loginAsStreamer(streamer.page)
    const password = await rotatePassword(streamer.page, path)

    await loginAsGuest(guest.page, path, password)
    await expect(guest.page.getByText(WAITING)).toBeVisible()

    const row = dockRow(streamer.page, ipPattern(guest.ip), 'Deny')
    await expect(row).toContainText(`wants to join /${path}`)
    await row.getByRole('button', { name: 'Deny', exact: true }).click()

    await expect(guest.page.getByText('The streamer declined your request')).toBeVisible()
    await expect(guest.page.getByText(/You can try again in/)).toBeVisible()
    // Never reached the player.
    expect((await fake.state()).whepPosts).toHaveLength(0)
  })

  test('public stream: the guest goes straight to the player', async ({ client }) => {
    const path = uniquePath()
    await goLive(path)
    const streamer = await client()
    const guest = await client()
    await loginAsStreamer(streamer.page)
    const password = await rotatePassword(streamer.page, path)

    // Streams start private; flip the dock's switch (checked = private).
    const toggle = streamer.page.getByLabel(`Make /${path} private`)
    await expect(toggle).toBeChecked()
    await toggle.click()
    await expect(toggle).not.toBeChecked()
    await expect(streamer.page.getByText('anyone can join')).toBeVisible()

    await loginAsGuest(guest.page, path, password)
    await expect(guest.page).toHaveURL(new RegExp(`/${path}$`))
    await expect(guest.page.locator('video')).toBeAttached()
    await expect(guest.page.getByText(WAITING)).toHaveCount(0)
    await expect.poll(() => fake.whepCount(path)).toBeGreaterThan(0)
  })
  test('trusted network: skips the password and waits for approval on a private stream', async ({ client }) => {
    const path = uniquePath()
    await goLive(path)
    const streamer = await client()
    const trusted = await client(trustedIp())
    await loginAsStreamer(streamer.page)

    // No password entered: the login page signs the client in by its IP.
    await trusted.page.goto(`/login?callbackUrl=/${path}`)
    await expect(trusted.page.getByText(WAITING)).toBeVisible()
    await expect(trusted.page.getByLabel('Viewer Password')).toHaveCount(0)

    const row = dockRow(streamer.page, ipPattern(trusted.ip), 'Approve')
    await expect(row).toContainText(`wants to join /${path}`)
    await row.getByRole('button', { name: 'Approve', exact: true }).click()

    await expect(trusted.page).toHaveURL(new RegExp(`/${path}$`))
    await expect(trusted.page.locator('video')).toBeAttached()
    await expect.poll(() => fake.whepCount(path)).toBeGreaterThan(0)
  })

  test('trusted network: password rotation does not affect the viewer', async ({ client }) => {
    const path = uniquePath()
    await goLive(path)
    const streamer = await client()
    const trusted = await client(trustedIp())
    await loginAsStreamer(streamer.page)
    await rotatePassword(streamer.page, path)

    await trusted.page.goto(`/login?callbackUrl=/${path}`)
    const row = dockRow(streamer.page, ipPattern(trusted.ip), 'Approve')
    await row.getByRole('button', { name: 'Approve', exact: true }).click()
    await expect(trusted.page.locator('video')).toBeAttached()

    await rotatePassword(streamer.page, path)

    await trusted.page.reload()
    await expect(trusted.page).toHaveURL(new RegExp(`/${path}$`))
    await expect(trusted.page.locator('video')).toBeAttached()
  })

  test('trusted network: signing out offers the manual login instead of signing straight back in', async ({ client }) => {
    const path = uniquePath()
    await goLive(path)
    const trusted = await client(trustedIp())

    await trusted.page.goto(`/login?callbackUrl=/${path}`)
    await expect(trusted.page.getByText(WAITING)).toBeVisible()
    await trusted.page.getByRole('button', { name: 'Sign out' }).click()

    await expect(trusted.page).toHaveURL(/manual=1/)
    await expect(trusted.page.getByRole('button', { name: 'Continue without password' })).toBeVisible()
    await expect(trusted.page.getByLabel('Viewer Password')).toBeVisible()
    await expect(trusted.page.getByText(WAITING)).toHaveCount(0)
  })

  test('trusted network: opening /login keeps an existing streamer session', async ({ client }) => {
    const path = uniquePath()
    await goLive(path)
    const streamer = await client(trustedIp())
    await loginAsStreamer(streamer.page)

    for (const url of ['/login', `/login?callbackUrl=/${path}`]) {
      await streamer.page.goto(url)
      // No way to swap the streamer session for a trusted viewer one, by click or behind their back.
      await expect(streamer.page.getByRole('button', { name: 'Continue without password' })).toHaveCount(0)
      await streamer.page.goto('/dock')
      await expect(streamer.page).toHaveURL(/\/dock$/)
      await expect(streamer.page.getByPlaceholder('Search name, Discord or IP')).toBeVisible()
    }
  })

  test('untrusted network: still sees the password form', async ({ client }) => {
    const path = uniquePath()
    await goLive(path)
    const guest = await client()

    await guest.page.goto(`/login?callbackUrl=/${path}`)

    await expect(guest.page.getByLabel('Viewer Password')).toBeVisible()
    await expect(guest.page.getByRole('button', { name: 'Continue without password' })).toHaveCount(0)
    await expect(guest.page.getByText(WAITING)).toHaveCount(0)
  })
})
