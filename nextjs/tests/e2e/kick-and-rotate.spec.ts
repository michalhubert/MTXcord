import {
  dockRow,
  expect,
  fake,
  goLive,
  ipPattern,
  loginAsGuest,
  loginAsStreamer,
  rotatePassword,
  setVisibility,
  test,
  uniquePath,
} from './fixtures'

// Both specs run on a public stream, so a guest only needs the viewer password.
test.describe('kick and rotate', () => {
  test('kicking a viewer sends them to the "removed" screen', async ({ client }) => {
    const path = uniquePath()
    await goLive(path)
    const streamer = await client()
    const guest = await client()
    await loginAsStreamer(streamer.page)
    const password = await rotatePassword(streamer.page, path)
    await setVisibility(streamer.page, path, 'public')

    await loginAsGuest(guest.page, path, password)
    await expect(guest.page).toHaveURL(new RegExp(`/${path}$`))

    // The viewer appears once its WHEP session is established.
    const row = dockRow(streamer.page, ipPattern(guest.ip), 'Kick this viewer')
    await expect(row).toContainText(`Path: ${path}`)
    await row.getByRole('button', { name: 'Kick this viewer' }).click()

    await expect(guest.page.getByText('You were removed by the streamer')).toBeVisible()
    await expect(guest.page.getByText(/You can try again in/)).toBeVisible()
    await expect(streamer.page.getByText('No viewers connected')).toBeVisible()
    expect((await fake.state()).kickedIds.length).toBeGreaterThan(0)
  })

  test('rotating the password sends viewers back to the login form', async ({ client }) => {
    const path = uniquePath()
    await goLive(path)
    const streamer = await client()
    const guest = await client()
    await loginAsStreamer(streamer.page)
    const oldPassword = await rotatePassword(streamer.page, path)
    await setVisibility(streamer.page, path, 'public')

    await loginAsGuest(guest.page, path, oldPassword)
    await expect(guest.page).toHaveURL(new RegExp(`/${path}$`))
    await expect.poll(() => fake.whepCount(path)).toBeGreaterThan(0)

    // Rotate from the dock, like the streamer would.
    await streamer.page
      .getByRole('button', { name: 'Rotate the viewer password for this stream' })
      .click()
    await expect(streamer.page.getByText(/^[0-9a-f]{32}$/)).not.toHaveText(oldPassword)
    const newPassword = (await streamer.page.getByText(/^[0-9a-f]{32}$/).textContent()) ?? ''
    expect(newPassword).toMatch(/^[0-9a-f]{32}$/)
    expect(newPassword).not.toBe(oldPassword)

    // The guest's session carries the old password: back to the login form.
    const field = guest.page.getByLabel('Viewer Password')
    await expect(field).toBeVisible()
    await expect(guest.page).toHaveURL(/\/login/)

    await field.fill(oldPassword)
    await guest.page.getByRole('button', { name: 'Watch Stream' }).click()
    await expect(guest.page.getByText('Invalid password. Try again.')).toBeVisible()

    await guest.page.getByLabel('Viewer Password').fill(newPassword)
    await guest.page.getByRole('button', { name: 'Watch Stream' }).click()
    await expect(guest.page).toHaveURL(new RegExp(`/${path}$`))
    await expect(guest.page.locator('video')).toBeAttached()
  })
})
