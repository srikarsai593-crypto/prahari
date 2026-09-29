import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import FieldPage from './page';
import { StationProvider } from '@/components/StationProvider';
import { ToastProvider } from '@/components/Toast';
import { api } from '@/lib/api';
import { SOS_HOLD_MS } from './page';
import type { Personnel } from '@/lib/types';

/**
 * Field mode is used in gloves, outdoors, by someone who may be in trouble.
 * The properties worth pinning are the ones that protect against the
 * interface rather than the ones that exercise it: that an SOS cannot be
 * raised by brushing the screen, and that the console never tells a field
 * operator something reached the station when it did not.
 */

const crew: Personnel[] = [
  { id: 'per-priya', name: 'Dr. Priya Sharma', role: 'Researcher', station: 'Maitri',
    expedition_id: null, status: 'at_station', current_lat: -70.767, current_lng: 11.731,
    last_update_at: null },
  { id: 'per-raj', name: 'Sgt. Raj Kumar', role: 'Logistics', station: 'Maitri',
    expedition_id: null, status: 'field', current_lat: -70.77, current_lng: 11.74,
    last_update_at: null },
];

const page = () => render(
  <StationProvider><ToastProvider><FieldPage /></ToastProvider></StationProvider>,
);

/** Get past the "who has this handset?" screen. */
async function signInAs(name: string) {
  page();
  await userEvent.click(await screen.findByText(name));
}

beforeEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
  vi.spyOn(api, 'listPersonnel').mockResolvedValue(crew);
  vi.spyOn(api, 'listInventory').mockResolvedValue([]);
});

describe('who has the handset', () => {
  it('asks before offering any action', async () => {
    /** All three actions are about a person, and an anonymous SOS is a much
     *  worse artefact than one extra tap. */
    page();
    expect(await screen.findByText(/who has this handset/i)).toBeInTheDocument();
    expect(screen.queryByText('SOS')).not.toBeInTheDocument();
  });

  it('says plainly that it is not a sign-in', async () => {
    page();
    expect(await screen.findByText(/not a sign-in/i)).toBeInTheDocument();
  });

  it('remembers the choice so it is asked once', async () => {
    await signInAs('Dr. Priya Sharma');
    await screen.findByText('Log consumption');
    expect(window.localStorage.getItem('prahari_field_operator'))
      .toContain('Dr. Priya Sharma');
  });
});

describe('the things you do outside', () => {
  it('offers exactly consumption, scanning, check-in and SOS', async () => {
    await signInAs('Dr. Priya Sharma');
    expect(await screen.findByText('Log consumption')).toBeInTheDocument();
    expect(screen.getByText('Scan cargo')).toBeInTheDocument();
    expect(screen.getByText('Check in')).toBeInTheDocument();
    expect(screen.getByText('SOS')).toBeInTheDocument();
  });

  it('keeps the link state on screen, because out here it changes the meaning',
     async () => {
    await signInAs('Dr. Priya Sharma');
    expect(await screen.findByText(/connected to the station/i)).toBeInTheDocument();
  });

  it('leaves a way back to the full console', async () => {
    await signInAs('Dr. Priya Sharma');
    expect(await screen.findByRole('link', { name: /full console/i })).toBeInTheDocument();
  });
});

describe('the SOS guard', () => {
  it('is not raised by a tap', async () => {
    /** A knock against a parka must not declare a station-wide emergency. */
    const sos = vi.spyOn(api, 'triggerSOS');
    await signInAs('Dr. Priya Sharma');
    await userEvent.click(await screen.findByText('SOS'));

    const hold = await screen.findByRole('button', { name: /hold for .* seconds/i });
    await userEvent.click(hold);

    expect(sos).not.toHaveBeenCalled();
  });

  it('says whose SOS it would be', async () => {
    await signInAs('Dr. Priya Sharma');
    await userEvent.click(await screen.findByText('SOS'));
    expect(await screen.findByText(/raised as dr\. priya sharma/i)).toBeInTheDocument();
  });

  it('states what it will do before it is held', async () => {
    await signInAs('Dr. Priya Sharma');
    await userEvent.click(await screen.findByText('SOS'));
    expect(await screen.findByText(/declares a critical incident/i)).toBeInTheDocument();
  });

  /**
   * The hold was wired to pointer events alone, so an operator on a keyboard
   * — or anyone using a switch or a screen reader — could reach the SOS
   * button, press it, and have nothing happen at all. On the one control in
   * this console that exists to summon help, and on a console whose
   * accessibility statement promises every control is operable by keyboard.
   */
  const openSos = async () => {
    await signInAs('Dr. Priya Sharma');
    await userEvent.click(await screen.findByText('SOS'));
    return screen.findByRole('button', { name: /hold for .* seconds/i });
  };

  /* Raw key events rather than userEvent: this is specifically about the
     keydown/keyup pair, and dispatching them directly says exactly that. */
  const press = (el: HTMLElement, key: string, init: KeyboardEventInit = {}) =>
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
  const release = (el: HTMLElement, key: string) =>
    el.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));

  for (const [name, key] of [['Enter', 'Enter'], ['Space', ' ']]) {
    it(`can be raised from the keyboard with ${name}`, async () => {
      const sos = vi.spyOn(api, 'triggerSOS').mockResolvedValue({} as never);
      const hold = await openSos();
      hold.focus();

      press(hold, key);
      await waitFor(() => expect(sos).toHaveBeenCalledWith('per-priya'),
        { timeout: SOS_HOLD_MS + 2000 });
    });
  }

  it('is not raised by a keyboard press let go too early', async () => {
    const sos = vi.spyOn(api, 'triggerSOS');
    const hold = await openSos();
    hold.focus();

    press(hold, 'Enter');
    await new Promise((r) => setTimeout(r, 200));
    release(hold, 'Enter');
    await new Promise((r) => setTimeout(r, SOS_HOLD_MS + 400));

    expect(sos).not.toHaveBeenCalled();
  });

  /** Holding a key repeats keydown; without a guard each repeat restarted
   *  the clock and the hold could never finish. */
  it('is not restarted by the key repeating while it is held', async () => {
    const sos = vi.spyOn(api, 'triggerSOS').mockResolvedValue({} as never);
    const hold = await openSos();
    hold.focus();

    press(hold, 'Enter');
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, SOS_HOLD_MS / 4));
      press(hold, 'Enter', { repeat: true });
    }

    await waitFor(() => expect(sos).toHaveBeenCalled(), { timeout: SOS_HOLD_MS + 2000 });
  });

  it('abandons the hold if focus leaves the button', async () => {
    const sos = vi.spyOn(api, 'triggerSOS');
    const hold = await openSos();
    hold.focus();

    press(hold, 'Enter');
    hold.blur();
    await new Promise((r) => setTimeout(r, SOS_HOLD_MS + 300));

    expect(sos).not.toHaveBeenCalled();
  });
});

describe('checking in', () => {
  it('reports back at the station as returned', async () => {
    const update = vi.spyOn(api, 'updatePersonnelStatus')
      .mockResolvedValue(crew[0]);
    await signInAs('Dr. Priya Sharma');
    await userEvent.click(await screen.findByText('Check in'));
    await userEvent.click(await screen.findByText(/back at the station/i));

    await waitFor(() => expect(update).toHaveBeenCalledWith('per-priya', 'returned'));
  });

  it('does not claim the station knows when the write is queued', async () => {
    /** Out here that distinction is the whole point of the banner. */
    vi.spyOn(api, 'updatePersonnelStatus')
      .mockResolvedValue({ queued: true, pending: true } as never);
    await signInAs('Dr. Priya Sharma');
    await userEvent.click(await screen.findByText('Check in'));
    await userEvent.click(await screen.findByText(/back at the station/i));

    expect(await screen.findByText(/held on this handset/i)).toBeInTheDocument();
  });
});

describe('scanning a crate', () => {
  it('still takes a code by hand when there is no camera', async () => {
    /**
     * A label can be frosted over, torn off, or the handset can simply
     * refuse the camera. The manual field is always offered, not revealed
     * on failure, because discovering it while holding a crate is worse.
     */
    const scan = vi.spyOn(api, 'scanBarcode').mockResolvedValue({
      barcode_id: 'SHP-2026-01', old_status: 'in_transit', new_status: 'arrived',
    } as never);
    await signInAs('Dr. Priya Sharma');
    await userEvent.click(await screen.findByText('Scan cargo'));

    await userEvent.type(await screen.findByLabelText(/type the code/i), 'SHP-2026-01');
    await userEvent.click(screen.getByRole('button', { name: /scan this code/i }));

    await waitFor(() => expect(scan).toHaveBeenCalledWith('SHP-2026-01'));
  });

  it('will not send an empty code', async () => {
    const scan = vi.spyOn(api, 'scanBarcode');
    await signInAs('Dr. Priya Sharma');
    await userEvent.click(await screen.findByText('Scan cargo'));

    await userEvent.click(await screen.findByRole('button', { name: /scan this code/i }));
    expect(scan).not.toHaveBeenCalled();
  });

  it('does not claim the crate was logged when the write is queued', async () => {
    vi.spyOn(api, 'scanBarcode').mockResolvedValue({ queued: true, pending: true } as never);
    await signInAs('Dr. Priya Sharma');
    await userEvent.click(await screen.findByText('Scan cargo'));

    await userEvent.type(await screen.findByLabelText(/type the code/i), 'SHP-2026-01');
    await userEvent.click(screen.getByRole('button', { name: /scan this code/i }));

    expect(await screen.findByText(/held on this handset/i)).toBeInTheDocument();
  });

  it('reports a code that is not on the manifest', async () => {
    vi.spyOn(api, 'scanBarcode').mockRejectedValue(new Error('No such consignment'));
    await signInAs('Dr. Priya Sharma');
    await userEvent.click(await screen.findByText('Scan cargo'));

    await userEvent.type(await screen.findByLabelText(/type the code/i), 'NOPE');
    await userEvent.click(screen.getByRole('button', { name: /scan this code/i }));

    expect(await screen.findByText(/no such consignment/i)).toBeInTheDocument();
  });
});

describe('an SOS that could not be sent', () => {
  /**
   * Put a finger on the button and leave it there.
   *
   * `fireEvent.pointerDown` rather than `userEvent.pointer`: userEvent
   * settles its pointer afterwards, which released the button and made the
   * held state impossible to observe — it hid the repeat-fire bug below
   * entirely. A raw pointerdown with no matching up is literally what a
   * finger resting on the screen is.
   *
   * It returns as soon as the pointer is down. The hold takes SOS_HOLD_MS of
   * real time, so every caller waits on its own expectation.
   */
  async function pressAndHold() {
    const hold = await screen.findByRole('button', { name: /hold for .* seconds/i });
    fireEvent.pointerDown(hold);
  }

  const HELD = { timeout: 4000 };

  it('does not tell the operator the station knows', async () => {
    /**
     * Said twice on purpose — once as the screen the operator is now
     * looking at, once as a toast that survives them navigating away. This
     * is the one place in the console that must not be optimistic.
     */
    vi.spyOn(api, 'triggerSOS').mockResolvedValue({ queued: true, pending: true } as never);
    await signInAs('Dr. Priya Sharma');
    await userEvent.click(await screen.findByText('SOS'));
    await pressAndHold();

    expect(await screen.findByText(/^SOS NOT SENT$/, {}, HELD)).toBeInTheDocument();
    expect(screen.getAllByText(/the station has not been told/i).length)
      .toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/do not wait for that/i)).toBeInTheDocument();
  });

  it('hands over a radio message rather than only telling them to use the radio',
     async () => {
    /**
     * The gap this closes: field mode used to say "raise the alarm by radio
     * now" and show nothing, leaving somebody in trouble to compose a
     * position report from memory.
     */
    vi.spyOn(api, 'triggerSOS').mockResolvedValue({ queued: true, pending: true } as never);
    await signInAs('Dr. Priya Sharma');
    await userEvent.click(await screen.findByText('SOS'));
    await pressAndHold();

    const message = await screen.findByText(/ZCZC PRAHARI SOS/, {}, HELD);
    expect(message).toHaveTextContent('DE MAITRI');
    expect(message).toHaveTextContent('OP DR. PRIYA SHARMA');
    // Her last known position, from the roster the page already loaded.
    expect(message).toHaveTextContent('POS 7046.0S 01143.9E');
    expect(message).toHaveTextContent('NNNN');
  });

  it('says the position is unknown rather than inventing one', async () => {
    vi.spyOn(api, 'listPersonnel').mockResolvedValue(
      [{ ...crew[0], current_lat: null, current_lng: null }]);
    vi.spyOn(api, 'triggerSOS').mockResolvedValue({ queued: true, pending: true } as never);
    await signInAs('Dr. Priya Sharma');
    await userEvent.click(await screen.findByText('SOS'));
    await pressAndHold();

    expect(await screen.findByText(/ZCZC PRAHARI SOS/, {}, HELD))
      .toHaveTextContent('POS UNKNOWN');
  });

  it('raises exactly one SOS however long the button is held', async () => {
    /**
     * Found live, four times over.
     *
     * The sent path closes this screen, so the question never arose. The
     * queued path stays open to show the radio message, and the finger is
     * very likely still down because nothing asked for it back — so the
     * hold timer re-armed against a still-pressed button and queued another
     * SOS every 1.5 seconds, indefinitely.
     *
     * The call has to resolve on a later task, not in a microtask. An
     * instantly-resolved mock lets React batch `sending` true-then-false
     * into no change at all, the effect never re-runs, and the bug is
     * invisible — which is exactly what happened the first time this test
     * was written, and it passed against the broken code.
     */
    const sos = vi.spyOn(api, 'triggerSOS').mockImplementation(
      () => new Promise((resolve) => setTimeout(
        () => resolve({ queued: true, pending: true } as never), 20)));
    await signInAs('Dr. Priya Sharma');
    await userEvent.click(await screen.findByText('SOS'));
    await pressAndHold();

    await screen.findByText(/^SOS NOT SENT$/, {}, HELD);
    // Keep holding, well past a second threshold, without ever releasing.
    await new Promise((resolve) => setTimeout(resolve, SOS_HOLD_MS * 2));
    expect(sos).toHaveBeenCalledTimes(1);
  }, 15000);

  it('shows the radio message only when the station could not be reached', async () => {
    vi.spyOn(api, 'triggerSOS').mockResolvedValue({ id: 'INC-1' } as never);
    await signInAs('Dr. Priya Sharma');
    await userEvent.click(await screen.findByText('SOS'));
    await pressAndHold();

    // Success returns to the home screen; no radio fallback is offered.
    await waitFor(() => expect(
      screen.getByText('Log consumption')).toBeInTheDocument(), HELD);
    expect(screen.queryByText(/ZCZC PRAHARI/)).not.toBeInTheDocument();
  });
});
