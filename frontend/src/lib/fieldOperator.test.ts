import { beforeEach, describe, expect, it } from 'vitest';
import {
  FIELD_BREAKPOINT_PX, isHandsetWidth, loadConsolePreference, loadFieldOperator,
  saveConsolePreference, saveFieldOperator,
} from './fieldOperator';

/**
 * Field mode's two pieces of remembered state. Both are conveniences, and
 * both have to survive the storage being unavailable — a console that
 * throws in a private window is worse than one that asks again.
 */

beforeEach(() => { window.localStorage.clear(); });

describe('who is holding the handset', () => {
  it('remembers the operator across a reload', () => {
    saveFieldOperator({ id: 'per-priya', name: 'Dr. Priya Sharma', station: 'Maitri' });
    expect(loadFieldOperator()?.name).toBe('Dr. Priya Sharma');
  });

  it('starts with nobody', () => {
    expect(loadFieldOperator()).toBeNull();
  });

  it('can be handed to someone else', () => {
    saveFieldOperator({ id: 'a', name: 'A', station: 'Maitri' });
    saveFieldOperator(null);
    expect(loadFieldOperator()).toBeNull();
  });

  it('ignores a corrupted entry rather than crashing the page', () => {
    window.localStorage.setItem('prahari_field_operator', '{not json');
    expect(loadFieldOperator()).toBeNull();
  });

  it('ignores an entry with no id, which could not raise an SOS', () => {
    window.localStorage.setItem('prahari_field_operator', '{"name":"Nobody"}');
    expect(loadFieldOperator()).toBeNull();
  });
});

describe('which view this handset uses', () => {
  it('has no preference until one is made', () => {
    expect(loadConsolePreference()).toBeNull();
  });

  it('remembers a choice of the full console', () => {
    /** Someone who needs the roster on a phone must not be asked twice. */
    saveConsolePreference('full');
    expect(loadConsolePreference()).toBe('full');
  });

  it('remembers a choice of field mode', () => {
    saveConsolePreference('field');
    expect(loadConsolePreference()).toBe('field');
  });

  it('ignores a value it did not write', () => {
    window.localStorage.setItem('prahari_console_preference', 'somethingelse');
    expect(loadConsolePreference()).toBeNull();
  });
});

describe('what counts as a handset', () => {
  it('a phone width does', () => {
    expect(isHandsetWidth(375)).toBe(true);
  });

  it('a desk width does not', () => {
    expect(isHandsetWidth(1440)).toBe(false);
  });

  it('the breakpoint itself counts as a handset', () => {
    expect(isHandsetWidth(FIELD_BREAKPOINT_PX)).toBe(true);
    expect(isHandsetWidth(FIELD_BREAKPOINT_PX + 1)).toBe(false);
  });

  it('a width of zero is not a handset', () => {
    /** Server render and some headless contexts report 0; guessing "phone"
     *  there would redirect a desktop user on first paint. */
    expect(isHandsetWidth(0)).toBe(false);
  });
});
