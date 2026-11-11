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
})
