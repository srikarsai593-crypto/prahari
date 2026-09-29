import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AccessibilityStatement } from './AccessibilityStatement';

/**
 * This replaced a <span> that did nothing. The tests that matter are that it
 * is a real control, and that the statement it opens admits its gaps —
 * a list of only the wins is marketing, not an accessibility statement.
 */

const open = async () => {
  render(<AccessibilityStatement />);
  await userEvent.click(screen.getByRole('button', { name: /screen reader/i }));
  return screen.findByRole('dialog');
};

describe('the control', () => {
  it('is a button, not decoration', () => {
    render(<AccessibilityStatement />);
    const control = screen.getByRole('button', { name: /screen reader/i });
    expect(control).toHaveAttribute('aria-haspopup', 'dialog');
  });

  it('opens a labelled dialog', async () => {
    const dialog = await open();
    expect(dialog).toHaveAccessibleName(/screen reader and accessibility/i);
  });

  it('closes on Escape', async () => {
    await open();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});

describe('the statement', () => {
  it('names the support that actually exists', async () => {
    const dialog = await open();
    for (const claim of [/skip to main content/i, /landmark regions/i,
                         /alerts are announced/i, /operable by keyboard/i,
                         /text size/i, /high contrast/i]) {
      expect(dialog).toHaveTextContent(claim);
    }
  });

  it('says plainly what is not supported', async () => {
    /**
     * The point of the whole component. Someone deciding whether they can
     * use this console on a screen reader needs the gaps more than the wins,
     * and the map is the big one.
     */
    const dialog = await open();
    expect(dialog).toHaveTextContent(/maps are visual/i);
    expect(dialog).toHaveTextContent(/not meaningfully readable by a screen reader/i);
    // The substance, not the sentence: the gap has to be stated, and the
    // rail must not be described as offering a choice it does not have.
    expect(dialog).toHaveTextContent(/english only/i);
    expect(dialog).toHaveTextContent(/have not been implemented/i);
  });

  it('points at the text equivalent rather than only admitting the gap', async () => {
    const dialog = await open();
    expect(dialog).toHaveTextContent(/also listed as text/i);
  });

  it('marks each line supported or not for a reader that cannot see the icon', async () => {
    /** The tick and the dash are aria-hidden, so without this a screen
     *  reader hears the claims and the gaps identically. */
    await open();
    expect(screen.getAllByText(/— supported/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/— not supported/).length).toBeGreaterThan(0);
  });

  it('names screen readers without pretending to supply one', async () => {
    const dialog = await open();
    expect(dialog).toHaveTextContent('NVDA');
    expect(dialog).toHaveTextContent('VoiceOver');
    expect(dialog).toHaveTextContent(/does not supply one/i);
  });
});
