import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useDialogFocus } from './useDialogFocus';

/**
 * Every dialog in the console handled Escape and nothing else. These pin the
 * three things that were missing.
 */

function Harness({ empty = false }: { empty?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useDialogFocus<HTMLDivElement>(open, () => setOpen(false));
  return (
    <div>
      <button onClick={() => setOpen(true)}>Open the dialog</button>
      <button>Behind the overlay</button>
      {open && (
        <div ref={ref} role="dialog" aria-modal="true" aria-label="Test dialog">
          {!empty && (
            <>
              <button onClick={() => setOpen(false)}>Close</button>
              <input aria-label="Middle field" />
              <button>Last</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

const open = async () => {
  render(<Harness />);
  await userEvent.click(screen.getByRole('button', { name: 'Open the dialog' }));
  return screen.findByRole('dialog');
};

describe('opening', () => {
  it('moves focus into the dialog', async () => {
    await open();
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
  });

  it('focuses the dialog itself when it holds nothing focusable', async () => {
    /** Otherwise focus stays on the page behind the overlay, and the first
     *  Tab moves through content the operator cannot see. */
    render(<Harness empty />);
    await userEvent.click(screen.getByRole('button', { name: 'Open the dialog' }));
    expect(await screen.findByRole('dialog')).toHaveFocus();
  });
});

describe('while open', () => {
  it('wraps Tab from the last control back to the first', async () => {
    await open();
    await userEvent.tab();  // -> input
    await userEvent.tab();  // -> Last
    expect(screen.getByRole('button', { name: 'Last' })).toHaveFocus();
    await userEvent.tab();  // wraps
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
  });

  it('wraps Shift+Tab from the first control back to the last', async () => {
    await open();
    await userEvent.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Last' })).toHaveFocus();
  });

  it('never lets focus reach the page behind the overlay', async () => {
    const behind = () => screen.getByRole('button', { name: 'Behind the overlay' });
    await open();
    for (let i = 0; i < 6; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await userEvent.tab();
      expect(behind()).not.toHaveFocus();
    }
  });
});

describe('closing', () => {
  it('returns focus to the control that opened it', async () => {
    /**
     * The gap this exists for: closing dropped focus onto <body>, so a
     * keyboard operator was returned to the top of the document and had to
     * tab all the way back to where they were.
     */
    await open();
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(
      screen.getByRole('button', { name: 'Open the dialog' })).toHaveFocus());
  });

  it('returns focus after Escape too', async () => {
    await open();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(
      screen.getByRole('button', { name: 'Open the dialog' })).toHaveFocus());
  });

  it('closes on Escape', async () => {
    await open();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('does not throw when the opener is gone', async () => {
    // A control that unmounts while the dialog is up — a row that was
    // filtered away by a live update, say.
    function Vanishing() {
      const [open, setOpen] = useState(false);
      const [gone, setGone] = useState(false);
      const ref = useDialogFocus<HTMLDivElement>(open, () => setOpen(false));
      return (
        <div>
          {!gone && <button onClick={() => { setOpen(true); setGone(true); }}>Open</button>}
          {open && (
            <div ref={ref} role="dialog" aria-label="d">
              <button onClick={() => setOpen(false)}>Close</button>
            </div>
          )}
        </div>
      );
    }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<Vanishing />);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
