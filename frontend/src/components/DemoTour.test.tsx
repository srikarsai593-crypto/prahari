import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DemoTour, DemoTourButton } from './DemoTour';
import { TOUR_STEPS } from '@/lib/tourSteps';

/**
 * The tour exists because somebody evaluating this console has under a
 * minute. Everything below is about that minute: it has to start on the
 * first step, it has to be escapable without hunting for a control, and it
 * must not strand anyone on a step whose anchor is not on their screen.
 */

/** Anchors live all over the page; the tour finds them by attribute. */
function Anchors({ omit = [] }: { omit?: string[] }) {
  return (
    <>
      {TOUR_STEPS.filter((s) => !omit.includes(s.target)).map((s) => (
        <div key={s.target} data-tour={s.target}>{s.target}</div>
      ))}
    </>
  );
}

describe('DemoTour', () => {
  it('opens on the first stop', () => {
    render(<><Anchors /><DemoTour open onClose={vi.fn()} /></>);
    expect(screen.getByText(`Step 1 of ${TOUR_STEPS.length}`)).toBeInTheDocument();
    expect(screen.getByText(TOUR_STEPS[0].title)).toBeInTheDocument();
  });

  it('renders nothing at all when it is closed', () => {
    render(<><Anchors /><DemoTour open={false} onClose={vi.fn()} /></>);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('walks forwards and backwards through every stop', async () => {
    render(<><Anchors /><DemoTour open onClose={vi.fn()} /></>);

    for (let i = 1; i < TOUR_STEPS.length; i++) {
      await userEvent.click(screen.getByRole('button', { name: /next/i }));
      expect(screen.getByText(TOUR_STEPS[i].title)).toBeInTheDocument();
    }

    await userEvent.click(screen.getByRole('button', { name: /back/i }));
    expect(screen.getByText(TOUR_STEPS[TOUR_STEPS.length - 2].title)).toBeInTheDocument();
  });

  it('offers no way back from the first stop, and finishes on the last', async () => {
    const onClose = vi.fn();
    render(<><Anchors /><DemoTour open onClose={onClose} /></>);
    expect(screen.queryByRole('button', { name: /back/i })).not.toBeInTheDocument();

    for (let i = 1; i < TOUR_STEPS.length; i++) {
      await userEvent.click(screen.getByRole('button', { name: /next/i }));
    }
    await userEvent.click(screen.getByRole('button', { name: /finish/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it('leaves on Escape', async () => {
    const onClose = vi.fn();
    render(<><Anchors /><DemoTour open onClose={onClose} /></>);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('steps with the arrow keys, and does not run off either end', async () => {
    render(<><Anchors /><DemoTour open onClose={vi.fn()} /></>);

    await userEvent.keyboard('{ArrowLeft}');
    expect(screen.getByText('Step 1 of 5')).toBeInTheDocument();

    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByText('Step 2 of 5')).toBeInTheDocument();

    for (let i = 0; i < 10; i++) await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByText(`Step ${TOUR_STEPS.length} of ${TOUR_STEPS.length}`))
      .toBeInTheDocument();
  });

  /**
   * The navigation band is hidden below `md`, so the blackout stop has no
   * anchor on a narrow screen. The step still has something to say, and a
   * tour that blanks out there is worse than one with no highlight.
   */
  it('still shows a stop whose anchor is not on this screen', async () => {
    render(<>
      <Anchors omit={['blackout']} />
      <DemoTour open onClose={vi.fn()} />
    </>);

    const blackoutIndex = TOUR_STEPS.findIndex((s) => s.target === 'blackout');
    for (let i = 0; i < blackoutIndex; i++) {
      await userEvent.click(screen.getByRole('button', { name: /next/i }));
    }

    expect(screen.getByText(TOUR_STEPS[blackoutIndex].title)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /next/i })).toBeInTheDocument();
  });

  it('is a dialog, so a screen reader announces it as one', () => {
    render(<><Anchors /><DemoTour open onClose={vi.fn()} /></>);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName(TOUR_STEPS[0].title);
  });
});

describe('DemoTourButton', () => {
  it('starts closed and opens on the first stop', async () => {
    render(<><Anchors /><DemoTourButton /></>);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /start demo tour/i }));
    expect(screen.getByText('Step 1 of 5')).toBeInTheDocument();
  });

  /**
   * Somebody who leaves halfway and comes back wants the tour, not the middle
   * of the one they abandoned.
   */
  it('restarts from the beginning rather than resuming', async () => {
    render(<><Anchors /><DemoTourButton /></>);

    await userEvent.click(screen.getByRole('button', { name: /start demo tour/i }));
    await userEvent.click(screen.getByRole('button', { name: /next/i }));
    await userEvent.click(screen.getByRole('button', { name: /next/i }));
    expect(screen.getByText('Step 3 of 5')).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByRole('button', { name: /start demo tour/i }));
    expect(screen.getByText('Step 1 of 5')).toBeInTheDocument();
  });

  it('gives focus back to the control that opened it', async () => {
    render(<><Anchors /><DemoTourButton /></>);
    const opener = screen.getByRole('button', { name: /start demo tour/i });

    await userEvent.click(opener);
    await userEvent.keyboard('{Escape}');
    expect(opener).toHaveFocus();
  });
});
