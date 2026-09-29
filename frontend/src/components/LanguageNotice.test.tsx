import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LanguageNotice } from './LanguageNotice';

/**
 * The rail's language entry.
 *
 * It was a `<span>` reading "English" between two controls that work — the
 * same shape of defect the screen-reader entry had before it. These tests
 * are about the two ways of "fixing" that which would have been worse: a
 * dropdown with one item in it, which is still a dead control, and a second
 * language the console does not really have.
 */

const openIt = async () => {
  await userEvent.click(screen.getByRole('button', { name: /english/i }));
  return screen.getByRole('dialog');
};

describe('LanguageNotice', () => {
  it('names the language, because that is what the rail is for', () => {
    render(<LanguageNotice />);
    expect(screen.getByRole('button', { name: /english/i })).toBeInTheDocument();
  });

  it('is a real control that says it opens a dialog', () => {
    render(<LanguageNotice />);
    const control = screen.getByRole('button', { name: /english/i });
    expect(control).toHaveAttribute('aria-haspopup', 'dialog');
  });

  /**
   * A screen reader user should not have to press it to discover it is not a
   * switch, so the accessible name carries what it actually does.
   */
  it('does not present itself as a way to change language', async () => {
    render(<LanguageNotice />);
    expect(screen.getByRole('button', { name: /language support on this console/i }))
      .toBeInTheDocument();

    const dialog = await openIt();
    expect(dialog).not.toHaveTextContent(/switch to|change language|select language/i);
  });

  it('opens the statement, on the line about language', async () => {
    render(<LanguageNotice />);
    const dialog = await openIt();

    expect(dialog).toHaveTextContent(/english only/i);
    expect(dialog).toHaveTextContent(/have not been implemented/i);
  });

  /**
   * Opening at the top of a nine-entry statement, when the operator asked
   * about one of them, makes them go looking for it.
   */
  it('scrolls to that line rather than making the reader find it', async () => {
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView');
    render(<LanguageNotice />);
    await openIt();

    await waitFor(() => expect(scroll).toHaveBeenCalled());
    const target = scroll.mock.instances[0] as unknown as Element;
    expect(target.id).toBe('a11y-english-only');
    expect(target).toHaveTextContent(/english only/i);
  });

  /**
   * The two places another script could not reach even if every string were
   * translated. Naming them is the difference between a gap and an excuse.
   */
  it('says where another script could not reach at all', async () => {
    render(<LanguageNotice />);
    const dialog = await openIt();

    expect(dialog).toHaveTextContent(/five-bit alphabet/i);
    expect(dialog).toHaveTextContent(/telemetry figures would stay latin/i);
  });

  it('offers no language options, because there are none to offer', async () => {
    render(<LanguageNotice />);
    const dialog = await openIt();

    expect(dialog.querySelector('select')).toBeNull();
    for (const other of [/हिन्दी/, /hindi\b(?!.*not been)/i, /tamil/i, /bengali/i]) {
      expect(dialog).not.toHaveTextContent(other);
    }
  });

  it('closes on Escape and gives focus back', async () => {
    render(<LanguageNotice />);
    const control = screen.getByRole('button', { name: /english/i });

    await userEvent.click(control);
    await userEvent.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(control).toHaveFocus();
  });
});
