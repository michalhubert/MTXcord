import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({ usePathname: vi.fn(() => '/') }))

import { followsAvatar, resolveAccent, useThemeStore } from '@/lib/themeStore'
import { DEFAULT_ACCENT } from '@/lib/theme'

beforeEach(() => {
  useThemeStore.setState(useThemeStore.getInitialState(), true)
})

describe('themeStore', () => {
  it('starts following the avatar with the default accent', () => {
    const s = useThemeStore.getState()
    expect(s.accentMode).toBe('avatar')
    expect(s.customAccent).toBe(DEFAULT_ACCENT)
    expect(s.avatarAccent).toBeNull()
  })

  it('setCustomAccent switches to custom mode; followAvatarAccent switches back', () => {
    useThemeStore.getState().setCustomAccent('#112233')
    expect(useThemeStore.getState()).toMatchObject({
      accentMode: 'custom',
      customAccent: '#112233',
    })
    useThemeStore.getState().followAvatarAccent()
    expect(useThemeStore.getState().accentMode).toBe('avatar')
  })

  describe('followsAvatar', () => {
    it('needs avatar mode and a detected avatar accent', () => {
      const s = useThemeStore.getState()
      expect(followsAvatar(s)).toBe(false)
      expect(followsAvatar({ ...s, avatarAccent: '#123456' })).toBe(true)
      expect(
        followsAvatar({ ...s, avatarAccent: '#123456', accentMode: 'custom' }),
      ).toBe(false)
    })
  })

  describe('resolveAccent', () => {
    const base = () => useThemeStore.getState()

    it('studio scope always uses the studio accent', () => {
      const s = { ...base(), studioAccent: '#aa0000', avatarAccent: '#00aa00' }
      expect(resolveAccent(s, 'studio')).toBe('#aa0000')
    })

    it('viewer scope uses the avatar accent when following it', () => {
      const s = { ...base(), avatarAccent: '#00aa00', customAccent: '#0000aa' }
      expect(resolveAccent(s, 'viewer')).toBe('#00aa00')
    })

    it('viewer scope uses the custom accent otherwise', () => {
      const custom = {
        ...base(),
        accentMode: 'custom' as const,
        avatarAccent: '#00aa00',
        customAccent: '#0000aa',
      }
      expect(resolveAccent(custom, 'viewer')).toBe('#0000aa')
      const noAvatar = { ...base(), customAccent: '#0000aa' }
      expect(resolveAccent(noAvatar, 'viewer')).toBe('#0000aa')
    })
  })
})
