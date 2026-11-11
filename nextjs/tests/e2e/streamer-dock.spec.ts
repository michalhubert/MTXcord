import {
  dockRow,
  expect,
  goLive,
  ipPattern,
  loginAsGuest,
  loginAsStreamer,
  rotatePassword,
  test,
  uniquePath,
} from './fixtures'
import { STREAMER_PASSWORD } from './env'

test.describe('streamer dock', () => {
  test('a wrong password is rejected, the right one opens the dock', async ({ client }) => {
    const { page } = await client()

    await page.goto('/login?mode=streamer&callbackUrl=/dock')
    await page.getByLabel('Streamer Password').fill(STREAMER_PASSWORD + '-wrong')
    await page.getByRole('button', { name: 'Open Dock' }).click()
    await expect(page.getByText('Invalid password. Try again.')).toBeVisible()
    await expect(page).toHaveURL(/\/login/)

    await page.getByLabel('Streamer Password').fill(STREAMER_PASSWORD)
    await page.getByRole('button', { name: 'Open Dock' }).click()
    await page.waitForURL((url) => url.pathname === '/dock')
    await expect(page.getByText('Current Viewer Password')).toBeVisible()
  })

  test('shows LIVE for a live stream and rotates the viewer password', async ({ client }) => {
    const path = uniquePath()
    await goLive(path)

    const { page } = await client()
    await loginAsStreamer(page)

    await expect(page.getByText(`/${path}`, { exact: true })).toBeVisible()
    await expect(page.getByText('LIVE', { exact: true })).toBeVisible()

    // The path has no password until the first rotation.
    await page.getByRole('button', { name: 'Rotate the viewer password for this stream' }).click()
    // The dock picks the new password up with its next snapshot.
    await expect(page.getByText(/^[0-9a-f]{32}$/)).toBeVisible()
  })

  test('lists pending requests above connected viewers in one searchable list', async ({
    client,
  }) => {
    const path = uniquePath()
    await goLive(path)
    const streamer = await client()
    const viewer = await client()
    const waiting = await client()
    await loginAsStreamer(streamer.page)
    const password = await rotatePassword(streamer.page, path)

    const page = streamer.page
    // The stream is private: the first guest is approved and watches, the second keeps waiting.
    await loginAsGuest(viewer.page, path, password)
    await dockRow(page, ipPattern(viewer.ip), 'Approve')
      .getByRole('button', { name: 'Approve', exact: true })
      .click()
    await expect(viewer.page).toHaveURL(new RegExp(`/${path}$`))
    const viewerRow = dockRow(page, ipPattern(viewer.ip), 'Kick this viewer')
    await expect(viewerRow).toBeVisible()

    await loginAsGuest(waiting.page, path, password)
    const pendingRow = dockRow(page, ipPattern(waiting.ip), 'Approve')
    await expect(pendingRow).toBeVisible()

    const pendingBox = await pendingRow.boundingBox()
    const viewerBox = await viewerRow.boundingBox()
    expect(pendingBox!.y).toBeLessThan(viewerBox!.y)

    await expect(page.getByText('1 pending')).toBeVisible()
    await expect(page.getByPlaceholder('Search name, Discord or IP')).toHaveCount(1)
  })
})
