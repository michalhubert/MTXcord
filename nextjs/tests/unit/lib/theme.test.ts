import { describe, expect, it } from 'vitest'
import {
  accentAlpha,
  accentScopeFor,
  createAppTheme,
  DEFAULT_ACCENT,
  isHexColor,
} from '@/lib/theme'

describe('accentScopeFor', () => {
  it.each(['/dock', '/dock/x', '/stream', '/stream/deep/er'])(
    '%s is studio',
    (p) => expect(accentScopeFor(p)).toBe('studio'),
  )

  it.each(['/', '/docker', '/streams', '/mystream', '/login', '/a/dock'])(
    '%s is viewer',
    (p) => expect(accentScopeFor(p)).toBe('viewer'),
  )
})

describe('isHexColor', () => {
  it('accepts 6-digit hex only', () => {
    expect(isHexColor('#aabbcc')).toBe(true)
    expect(isHexColor('#AABBCC')).toBe(true)
    expect(isHexColor('#abc')).toBe(false)
    expect(isHexColor('#aabbccdd')).toBe(false)
    expect(isHexColor('aabbcc')).toBe(false)
    expect(isHexColor('#gggggg')).toBe(false)
    expect(isHexColor(null)).toBe(false)
    expect(isHexColor(123456)).toBe(false)
  })
})

describe('createAppTheme', () => {
  it('uses a valid accent as the primary colour', () => {
    expect(createAppTheme('#112233').palette.primary.main).toBe('#112233')
  })

  it.each(['red', '#fff', '', 'javascript:1'])(
    'falls back to the default for %j',
    (accent) => {
      expect(createAppTheme(accent).palette.primary.main).toBe(DEFAULT_ACCENT)
    },
  )
})

describe('accentAlpha', () => {
  it('references the palette channel variable', () => {
    expect(accentAlpha(0.5)).toBe(
      'rgba(var(--mui-palette-primary-mainChannel) / 0.5)',
    )
    expect(accentAlpha(0.2, 'error')).toBe(
      'rgba(var(--mui-palette-error-mainChannel) / 0.2)',
    )
  })
})
