import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { GovRail } from './GovRail';

/**
 * Tier 1 — the government utility rail.
 *
 * Every entry here has been a `<span>` that looked like a control at some
 * point: first "Screen Reader", then "English". Both named support that was
 * real, which is what made a dead label worse than none — it reads as a
 * control that is simply broken. These assert the rail is controls all the
 * way along, so the next one cannot quietly regress to a label.
 */
describe('GovRail', () => {
  it('offers text scaling, contrast, screen reader and language as controls', () => {
    render(<GovRail />);

    for (const name of [/^A-$/, /^A$/, /^A\+$/, /high contrast/i,
                        /screen reader/i, /english/i]) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
  });

  /**
   * The specific regression this guards: the language entry rendering as
   * inert text again. Querying by role is the whole point — a `<span>` has
   * no button role however it is styled.
   */
  it('does not render the language entry as inert text', () => {
    const { container } = render(<GovRail />);

    const language = screen.getByRole('button', { name: /english/i });
    expect(language.tagName).toBe('BUTTON');

    const inert = [...container.querySelectorAll('span')]
      .filter((s) => s.textContent?.trim() === 'English' && !s.closest('button'));
    expect(inert).toHaveLength(0);
  });

  it('says that the language control opens a statement rather than switching', () => {
    render(<GovRail />);
    expect(screen.getByRole('button', { name: /english/i }))
      .toHaveAttribute('aria-haspopup', 'dialog');
  });
});
