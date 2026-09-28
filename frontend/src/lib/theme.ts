/**
 * Display themes — the standard console, and a high-contrast one.
 *
 * Two different people need the same thing here. GIGW 3.0 expects a public
 * portal to offer a high-contrast view, which is why the accessibility rail
 * exists at all and why the text-size control sits in it. And a station
 * laptop carried outside is read against snow under a sun that does not set
 * for months: the default palette is a pale grey canvas, which is the worst
 * possible surface to read in that light because the glare it reflects
 * competes with everything drawn on it.
 *
 * Both wants resolve to the same answer — drop the luminance of the page to
 * near-black, push the foreground to maximum, and thicken every boundary so
 * structure survives a squint. So this is one theme, not two.
 *
 * ## How it is applied
 *
 * `data-theme` on `<html>`, and nothing else. Every rule lives behind that
 * attribute in `globals.css`, so the default console cannot be changed by
 * anything in this file — the worst a bug here can do is fail to switch.
 * That property is why the theme is an attribute rather than a class swap or
 * a second stylesheet.
 */

export const THEMES = ['standard', 'contrast'] as const;
export type Theme = (typeof THEMES)[number];

export const DEFAULT_THEME: Theme = 'standard';

const STORAGE_KEY = 'prahari_theme';

export const isTheme = (value: unknown): value is Theme =>
  typeof value === 'string' && (THEMES as readonly string[]).includes(value);

export function loadTheme(): Theme {
  if (typeof window === 'undefined') return DEFAULT_THEME;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return isTheme(saved) ? saved : DEFAULT_THEME;
  } catch {
    // Storage can be blocked outright (private mode, a locked-down kiosk).
    // The console still works; it just opens on the standard theme.
    return DEFAULT_THEME;
  }
}

export function saveTheme(theme: Theme): void {
  if (typeof window === 'undefined') return;
  try { localStorage.setItem(STORAGE_KEY, theme); } catch { /* non-fatal */ }
}

/**
 * Put the theme on the document.
 *
 * The standard theme *removes* the attribute rather than setting
 * `data-theme="standard"`, so the default console renders with no theme
 * selector matching at all. A console that has never touched this code and
 * one that has switched back are then byte-identical in their computed
 * styles, which is the only way to be sure the default cannot drift.
 *
 * `color-scheme` moves with it so the browser's own furniture — scrollbars,
 * form controls, the spellcheck underline — follows the page instead of
 * staying light against a black background.
 */
export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (theme === DEFAULT_THEME) {
    delete root.dataset.theme;
    root.style.colorScheme = 'light';
  } else {
    root.dataset.theme = theme;
    root.style.colorScheme = 'dark';
  }
}

export const themeLabel = (theme: Theme): string =>
  theme === 'contrast' ? 'High contrast' : 'Standard';

export const nextTheme = (theme: Theme): Theme =>
  theme === 'contrast' ? 'standard' : 'contrast';
