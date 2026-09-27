import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TelemetryHud, TraverseProgress } from './TraverseTelemetry';
import type { Telemetry } from '@/lib/types';

const telemetry = (overrides: Partial<Telemetry> = {}): Telemetry => ({
  heading_deg: 172,
  heading_compass: 'S',
  speed_kmh: 2.3,
  distance_remaining_km: 13.2,
  eta_minutes: 332,
  eta_at: '2026-09-27T14:28:00.000Z',
  ...overrides,
});

describe('TraverseProgress', () => {
  it('says nothing when there is no traverse to report on', () => {
    // An empty strip on every row of a six-person roster is noise.
    const { container } = render(<TraverseProgress progress={null} active={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('is hidden for someone sitting at base', () => {
    const { container } = render(
      <TraverseProgress progress={{ step: 0, total: 41, percent: 0 }} active={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('reports the fix count and the percentage', () => {
    render(<TraverseProgress progress={{ step: 7, total: 41, percent: 17 }} active />);
    expect(screen.getByText(/Fix 7 of 41 \(17%\)/)).toBeInTheDocument();
  });

  it('exposes progress to assistive technology, not only as a coloured bar', () => {
    render(<TraverseProgress progress={{ step: 7, total: 41, percent: 17 }} active />);
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '17');
    expect(bar).toHaveAccessibleName(/traverse progress/i);
  });

  it('runs to 100% on arrival rather than vanishing', () => {
    render(<TraverseProgress progress={{ step: 41, total: 41, percent: 100 }} arrived />);
    expect(screen.getByText('Arrived at Destination')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
  });

  it('clamps a percentage the station reports out of range', () => {
    render(<TraverseProgress progress={{ step: 99, total: 41, percent: 140 }} active />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
  });
});

describe('TelemetryHud', () => {
  it('is absent until there is movement to describe', () => {
    const { container } = render(<TelemetryHud telemetry={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the four readings an operator navigates on', () => {
    render(<TelemetryHud telemetry={telemetry()} destination="Camp Alpha" />);
    expect(screen.getByText('172° S')).toBeInTheDocument();
    expect(screen.getByText('2.3 km/h')).toBeInTheDocument();
    expect(screen.getByText('13.2 km')).toBeInTheDocument();
    expect(screen.getByText('5h 32m')).toBeInTheDocument();
  });

  it('pads the bearing to three digits, as a heading is read', () => {
    render(<TelemetryHud telemetry={telemetry({ heading_deg: 34, heading_compass: 'NE' })} />);
    expect(screen.getByText('034° NE')).toBeInTheDocument();
  });

  it('shows a dash rather than asserting due north for a stationary fix', () => {
    /**
     * 000 is a bearing. A party that has not moved has no heading at all, and
     * printing one is a fabricated reading on a navigation display.
     */
    render(<TelemetryHud telemetry={telemetry({ heading_deg: null, heading_compass: null })} />);
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByText(/000°/)).not.toBeInTheDocument();
  });

  it('formats a short ETA in minutes', () => {
    render(<TelemetryHud telemetry={telemetry({ eta_minutes: 39 })} />);
    expect(screen.getByText('39m')).toBeInTheDocument();
  });

  it('formats an ETA past the hour with a zero-padded remainder', () => {
    render(<TelemetryHud telemetry={telemetry({ eta_minutes: 125 })} />);
    expect(screen.getByText('2h 05m')).toBeInTheDocument();
  });

  it('quotes the arrival time in UTC, not the browser timezone', () => {
    // A console in Goa and a console at Maitri must read the same clock.
    render(<TelemetryHud telemetry={telemetry()} />);
    expect(screen.getByText(/14:28 UTC/)).toBeInTheDocument();
  });

  it('names the destination it is counting down to', () => {
    render(<TelemetryHud telemetry={telemetry()} destination="Camp Alpha" />);
    expect(screen.getByText(/Camp Alpha/)).toBeInTheDocument();
  });
});
