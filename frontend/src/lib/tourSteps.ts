export interface TourStep {
  /** Matched against `data-tour` in the DOM. */
  target: string;
  title: string;
  body: string;
  /**
   * What the visitor should do here, when doing it is the point. Rendered as
   * a hint under the copy, not as a button — the tour narrates, it does not
   * drive the console on somebody's behalf.
   */
  action?: string;
}

/**
 * The five-stop tour of the console.
 *
 * Someone evaluating this has a minute, and the console does not lead with
 * its best work: the lookup looks like a search box, the standing alerts look
 * like a notification list, and the one genuinely unusual thing it does —
 * keeping a station running through a satellite outage — is a toggle in the
 * corner of the navigation band that nobody would press without being told
 * what it was for.
 *
 * Every stop is on the dashboard or in the navigation band. A tour that
 * navigates between modules has to wait for each page to fetch before it can
 * find its next anchor, and a visitor watching a spinner is a visitor who has
 * stopped reading. The modules are one click away from the stops below.
 *
 * Ordered so it builds: what the console knows, what it works out for itself,
 * what it hands over, what it survives, and where to go to see the whole
 * thing run.
 */
export const TOUR_STEPS: TourStep[] = [
  {
    target: 'lookup',
    title: 'One box for the whole station',
    body: 'A traverse ID, a consignment number, a person or a stock item — the same '
      + 'field finds any of them and opens the module that owns it. An operator '
      + 'holding a crate label does not have to know which screen it belongs to.',
  },
  {
    target: 'alerts',
    title: 'It works out the consequences itself',
    body: 'These are not notifications somebody typed. The station reads a blizzard '
      + 'load through to the cargo that will now land late, and through to the '
      + 'stock that runs out before it does — the chain no single module owns.',
  },
  {
    target: 'handover',
    title: 'The watch changes every day',
    body: 'Every figure on this page as one document the outgoing watch can hand to '
      + 'the incoming one — printed, read over HF radio, or carried on a handset '
      + 'when there is no link at all.',
  },
  {
    target: 'blackout',
    title: 'Now lose the satellite',
    body: 'Antarctic stations lose their link for hours at a time. Press this and the '
      + 'console keeps working on its own cache: every change you make is held here '
      + 'and counted, then replayed in order the moment the link returns.',
    action: 'Press it, change something on any module, then press it again.',
  },
  {
    target: 'scenario',
    title: 'See the whole thing run',
    body: 'A scripted season — plan a traverse, load a ship, lose a crate to weather, '
      + 'declare an emergency and account for everyone — against the same live '
      + 'backend the rest of the console uses.',
  },
];
