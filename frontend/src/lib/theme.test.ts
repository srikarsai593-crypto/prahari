import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_THEME, THEMES, applyTheme, isTheme, loadTheme, nextTheme, saveTheme, themeLabel,
} from './theme';

/**
 * The theme is one attribute on <html>, and the whole safety argument for the
 * high-contrast stylesheet rests on that attribute being *absent* for the
 * standard console. These tests hold that line.
 */

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  document.documentElement.style.colorScheme = '';
});

afterEach(() => { vi.restoreAllMocks(); });

describe('reading the saved theme', () => {
  it('opens on the standard console when nothing is saved', () => {
    expect(loadTheme()).toBe('standard');
    expect(DEFAULT_THEME).toBe('standard');
  });

  it('remembers a choice across a reload', () => {
    saveTheme('contrast');
    expect(loadTheme()).toBe('contrast');
  });

  it('ignores a stored value that is not a theme', () => {
    // A stale key from an older build, or someone editing devtools.
    localStorage.setItem('prahari_theme', 'neon');
    expect(loadTheme()).toBe('standard');
  });

  it('falls back to the standard console when storage is blocked', () => {
    // Private mode and locked-down kiosks throw on access rather than
    // returning null. The console must still render.
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('access denied');
    });
    expect(loadTheme()).toBe('standard');
  });

  it('does not throw when the choice cannot be written', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(() => saveTheme('contrast')).not.toThrow();
  });
});

describe('applying the theme', () => {
  it('marks the document for high contrast', () => {
    applyTheme('contrast');
    expect(document.documentElement.dataset.theme).toBe('contrast');
    expect(document.documentElement.style.colorScheme).toBe('dark');
  });

  it('removes the attribute entirely for the standard console', () => {
    /**
     * Not `data-theme="standard"`. Every rule in the themed block is scoped
     * behind `[data-theme='contrast']`, and the guarantee that the default
     * console cannot regress holds only while no selector matches at all.
     */
    applyTheme('contrast');
    applyTheme('standard');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe('light');
  });

  it('is idempotent', () => {
    applyTheme('contrast');
    applyTheme('contrast');
    expect(document.documentElement.dataset.theme).toBe('contrast');
  });
});

describe('the toggle', () => {
  it('flips between exactly the two themes', () => {
    expect(nextTheme('standard')).toBe('contrast');
    expect(nextTheme('contrast')).toBe('standard');
  });

  it('round-trips, so a double tap leaves no trace', () => {
    for (const theme of THEMES) expect(nextTheme(nextTheme(theme))).toBe(theme);
  });

  it('names each theme for the control that announces it', () => {
    expect(themeLabel('contrast')).toMatch(/contrast/i);
    expect(themeLabel('standard')).toMatch(/standard/i);
  });

  it('recognises only the themes it ships', () => {
    expect(isTheme('contrast')).toBe(true);
    expect(isTheme('standard')).toBe(true);
    expect(isTheme('dark')).toBe(false);
    expect(isTheme(null)).toBe(false);
    expect(isTheme(1)).toBe(false);
  });
});
