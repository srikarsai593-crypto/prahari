import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type React from 'react';
import { PanelBoundary } from './PanelBoundary';

/**
 * The point of a per-panel boundary is what stays on screen when one thing
 * fails, so that is what these assert.
 */

// Annotated because a function that only throws infers `void`, which is not a
// valid JSX element type.
function Exploding({ message = 'Leaflet: invalid LatLng' }:
                   { message?: string }): React.ReactNode {
  throw new Error(message);
}

beforeEach(() => {
  // React logs the caught error; the test output is not the place for it.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('PanelBoundary', () => {
  it('renders its panel when nothing is wrong', () => {
    render(<PanelBoundary label="The map"><p>the map</p></PanelBoundary>);
    expect(screen.getByText('the map')).toBeInTheDocument();
  });

  it('contains a failure to the panel that failed', () => {
    render(
      <div>
        <p>accountability: 1 unaccounted</p>
        <PanelBoundary label="The map"><Exploding /></PanelBoundary>
        <button type="button">Resolve incident</button>
      </div>);

    // The two things an operator needs during an incident are still there.
    expect(screen.getByText('accountability: 1 unaccounted')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resolve incident' })).toBeInTheDocument();
    expect(screen.getByText(/the map could not be shown/i)).toBeInTheDocument();
  });

  it("names the panel in the operator's own terms", () => {
    render(<PanelBoundary label="The audit timeline"><Exploding /></PanelBoundary>);
    expect(screen.getByText(/the audit timeline could not be shown/i)).toBeInTheDocument();
  });

  it("says the records are intact, because that is the operator's next question", () => {
    render(<PanelBoundary label="The map"><Exploding /></PanelBoundary>);
    expect(screen.getByText(/records are intact/i)).toBeInTheDocument();
  });

  it('announces itself to assistive technology', () => {
    render(<PanelBoundary label="The map"><Exploding /></PanelBoundary>);
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('keeps the technical detail out of the way but available', async () => {
    render(<PanelBoundary label="The map"><Exploding message="tile 404" /></PanelBoundary>);
    // Not in the operator's face; one click away for whoever is fixing it.
    expect(screen.getByText('tile 404')).not.toBeVisible();
    await userEvent.click(screen.getByText(/technical detail/i));
    expect(screen.getByText('tile 404')).toBeVisible();
  });

  it('recovers when the panel is asked to try again', async () => {
    let shouldFail = true;
    function Flaky() {
      if (shouldFail) throw new Error('transient');
      return <p>the map</p>;
    }

    render(<PanelBoundary label="The map"><Flaky /></PanelBoundary>);
    expect(screen.getByText(/could not be shown/i)).toBeInTheDocument();

    shouldFail = false;
    await userEvent.click(screen.getByRole('button', { name: /retry/i }));

    expect(screen.getByText('the map')).toBeInTheDocument();
  });

  it('settles instead of retrying in a loop', async () => {
    /**
     * A component that threw once usually throws again on the same data. A
     * boundary that remounts it by itself turns one failure into a flickering
     * page and can spin the CPU during an incident.
     *
     * React re-renders the subtree itself while diagnosing the error, so the
     * assertion is that the count *stops*, not what it reaches.
     */
    const attempt = vi.fn(() => { throw new Error('always'); });
    function Always(): React.ReactNode { return attempt(); }

    render(<PanelBoundary label="The map"><Always /></PanelBoundary>);
    const settled = attempt.mock.calls.length;

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(attempt.mock.calls.length).toBe(settled);
    expect(screen.getByText(/could not be shown/i)).toBeInTheDocument();
  });

  it('has a compact form for a panel with no room for the full notice', () => {
    render(<PanelBoundary label="Standing alerts" compact><Exploding /></PanelBoundary>);
    expect(screen.getByText(/standing alerts could not be shown/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    expect(screen.queryByText(/records are intact/i)).not.toBeInTheDocument();
  });
});
