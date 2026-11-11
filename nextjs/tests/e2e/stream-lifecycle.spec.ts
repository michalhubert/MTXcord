import {
  expect,
  fake,
  goLive,
  goOffline,
  loginAsGuest,
  loginAsStreamer,
  rotatePassword,
  setVisibility,
  test,
  uniquePath,
} from './fixtures'

test.describe('stream lifecycle', () => {
  test('the player follows the stream going live and offline', async ({ client }) => {
    const path = uniquePath()
    const streamer = await client()
    const guest = await client()
    await loginAsStreamer(streamer.page)
    // A password to log in with, and a public stream so the guest can sit on the player.
    const password = await rotatePassword(streamer.page, path)
    await setVisibility(streamer.page, path, 'public')

    // Offline: the player is up but has nothing to show.
    await loginAsGuest(guest.page, path, password)
    await expect(guest.page).toHaveURL(new RegExp(`/${path}$`))
    await expect(guest.page.getByText('Stream offline')).toBeVisible()
    expect(await fake.whepCount(path)).toBe(0)
    const before = await fake.whepCount(path)

    // Live: the online push makes the player connect right away.
    await goLive(path)
    await expect.poll(() => fake.whepCount(path), { timeout: 20_000 }).toBeGreaterThan(before)
    await expect(guest.page.getByText('Stream offline')).toHaveCount(0)

    // Offline again.
    await goOffline(path)
    await expect(guest.page.getByText('Stream offline')).toBeVisible()
  })
})
