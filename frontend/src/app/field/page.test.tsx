import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import FieldPage from './page';
import { StationProvider } from '@/components/StationProvider';
import { ToastProvider } from '@/components/Toast';
import { api } from '@/lib/api';
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

describe('the three things you do outside', () => {
  it('offers exactly consumption, check-in and SOS', async () => {
    await signInAs('Dr. Priya Sharma');
    expect(await screen.findByText('Log consumption')).toBeInTheDocument();
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
