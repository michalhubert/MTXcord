import { expect, goLive, loginAsStreamer, test, uniquePath } from './fixtures'
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
})
