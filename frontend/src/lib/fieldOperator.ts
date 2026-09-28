/**
 * Who is holding the phone.
 *
 * Field mode's three actions are all *about someone*: an SOS has to say who
 * is in trouble, a check-in has to say who came back, and a consumption
 * entry should say who drew the fuel. The console has one shared credential
 * and cannot tell operators apart, so field mode asks once and remembers.
 *
 * That is a weaker claim than per-user authentication and the UI says so —
 * it is who this handset was last told it is, not a verified identity. It is
 * still the difference between "SOS" and "SOS from Dr Priya Sharma at these
 * coordinates", which is the whole of what a rescue needs.
 */

const STORAGE_KEY = 'prahari_field_operator';

export interface FieldOperator {
  id: string;
  name: string;
  station: string;
}

export function loadFieldOperator(): FieldOperator | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed.id === 'string' ? (parsed as FieldOperator) : null;
  } catch {
    return null;
  }
}

export function saveFieldOperator(operator: FieldOperator | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (operator) localStorage.setItem(STORAGE_KEY, JSON.stringify(operator));
    else localStorage.removeItem(STORAGE_KEY);
  } catch { /* blocked storage — field mode still works, it just asks again */ }
}

// ── Choosing the view ──────────────────────────────────────────────────────

const PREFERENCE_KEY = 'prahari_console_preference';

/** Widths at or below this get offered field mode on arrival. */
export const FIELD_BREAKPOINT_PX = 768;

export type ConsolePreference = 'field' | 'full';

/**
 * Which view this handset has settled on, if any.
 *
 * A phone is *offered* field mode; it is not trapped in it. Forcing every
 * narrow viewport into three buttons would make the console unusable to
 * someone who genuinely needs the roster on a phone, and an operator who
 * chose the full console should not have to choose again on every page.
 */
export function loadConsolePreference(): ConsolePreference | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(PREFERENCE_KEY);
    return raw === 'field' || raw === 'full' ? raw : null;
  } catch {
    return null;
  }
}

export function saveConsolePreference(preference: ConsolePreference | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (preference) localStorage.setItem(PREFERENCE_KEY, preference);
    else localStorage.removeItem(PREFERENCE_KEY);
  } catch { /* non-fatal */ }
}

/** True when this viewport is a handset by width. */
export function isHandsetWidth(width?: number): boolean {
  const w = width ?? (typeof window === 'undefined' ? 0 : window.innerWidth);
  return w > 0 && w <= FIELD_BREAKPOINT_PX;
}
