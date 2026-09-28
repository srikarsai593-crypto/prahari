import { describe, expect, it } from 'vitest';
import { debriefFilename, renderDebrief, type DebriefSources } from './debrief';
import type { AppEvent, Incident, NearbyAsset } from './types';

/**
 * The debrief is the document someone at MoES is answerable for after an
 * emergency. It has to report what the station's record actually says —
 * including the parts nobody wants to file, like an incident closed with an
 * open head-count or a protocol step nobody ticked.
 */

const INCIDENT: Incident = {
  id: 'inc-aa00cc84',
  type: 'fire',
  station: 'Maitri',
  location_lat: -70.767,
  location_lng: 11.731,
  affected_radius_m: 1000,
  severity: 'high',
  status: 'resolved',
  expected_count: 6,
  confirmed_safe_count: 6,
  unaccounted_count: 0,
  created_at: '2026-09-28T08:12:56Z',
};

const event = (over: Partial<AppEvent> & { seq: number }): AppEvent => ({
  id: `ev-${over.seq}`,
  module: 'emergency',
  action: 'something happened',
  actor: 'commander',
  station: 'Maitri',
  related_id: INCIDENT.id,
  metadata: null,
  created_at: '2026-09-28T08:13:07Z',
  ...over,
});

/**
 * The dispatch row is the awkward one: it is filed against the *asset*, and
 * names the incident only in its metadata.
 */
const DISPATCH = event({
  seq: 293,
  action: 'Emergency Sled deployed to fire incident inc-aa00cc84',
  related_id: 'ast-mai-sled',
  metadata: { incident_id: 'inc-aa00cc84', asset_id: 'ast-mai-sled' },
});

const sources = (over: Partial<DebriefSources> = {}): DebriefSources => ({
  incident: INCIDENT,
  accountability: { incident_id: INCIDENT.id, expected: 6, confirmed_safe: 6, unaccounted: 0 },
  sop: {
    incident_id: INCIDENT.id,
    tasks: [
      { incident_id: INCIDENT.id, task_key: 'klaxon', label: 'Sound klaxon', position: 1,
        done: true, done_at: '2026-09-28T08:13:07Z', done_by: 'commander' },
      { incident_id: INCIDENT.id, task_key: 'manifold', label: 'Isolate fuel manifold',
        position: 2, done: false, done_at: null, done_by: null },
    ],
    completed: 1,
    total: 2,
  },
  assets: [],
  events: [event({ seq: 290, action: 'Incident created: fire (severity: high)' }), DISPATCH],
  ...over,
});

const AT = new Date('2026-09-28T08:13:46Z');

describe('renderDebrief', () => {
  it('heads the document with the incident reference and the responding station', () => {
    const out = renderDebrief(sources(), AT);
    expect(out).toContain('inc-aa00cc84');
    expect(out).toContain('Maitri Base');
    expect(out).toContain('MINISTRY OF EARTH SCIENCES');
    expect(out).toContain('FIRE');
  });

  it('reports times in UTC, not the reader’s zone', () => {
    const out = renderDebrief(sources(), AT);
    expect(out).toContain('2026-09-28 08:12:56Z');
    expect(out).toContain('2026-09-28 08:13:46Z');
  });

  /**
   * The regression this exists for: matching audit rows on `related_id` alone
   * silently dropped the dispatch, so a debrief could report "no rescue asset
   * was committed" for an incident that had a snowcat sent to it.
   */
  it('credits an asset dispatch that is filed against the asset, not the incident', () => {
    const out = renderDebrief(sources(), AT);
    expect(out).toContain('Emergency Sled deployed');
    expect(out).not.toContain('No rescue asset was committed');
  });

  it('says plainly when no asset was committed', () => {
    const out = renderDebrief(sources({ events: [event({ seq: 290 })] }), AT);
    expect(out).toContain('No rescue asset was committed');
  });

  it('flags protocol steps that were never ticked', () => {
    const out = renderDebrief(sources(), AT);
    expect(out).toContain('[x] Sound klaxon');
    expect(out).toContain('[ ] Isolate fuel manifold');
    expect(out).toContain('1 protocol step(s) were not recorded as completed');
  });

  // Closing with people still missing is the single most consequential thing
  // a debrief can record, so it is called out rather than left to the reader
  // to spot in a number.
  it('calls out an incident closed with an open head-count', () => {
    const out = renderDebrief(sources({
      accountability: { incident_id: INCIDENT.id, expected: 6, confirmed_safe: 4, unaccounted: 2 },
    }), AT);
    expect(out).toContain('2 PERSON(S) UNACCOUNTED FOR');
  });

  it('does not claim everyone was safe when the count is clean', () => {
    const out = renderDebrief(sources(), AT);
    expect(out).toContain('All personnel within the affected radius were confirmed safe');
    expect(out).not.toContain('UNACCOUNTED FOR — THIS INCIDENT');
  });

  // A debrief missing one section beats no debrief at all, but it must not
  // pass off an unreadable section as an empty one.
  it('says a section could not be read rather than implying it was empty', () => {
    const out = renderDebrief(sources({ accountability: null, sop: null }), AT);
    expect(out).toContain('Accountability record could not be read');
    expect(out).toContain('Protocol record could not be read');
  });

  it('ignores audit rows belonging to a different incident', () => {
    const out = renderDebrief(sources({
      events: [
        event({ seq: 1, action: 'Unrelated incident opened', related_id: 'inc-other' }),
        event({ seq: 2, action: 'Incident created: fire (severity: high)' }),
      ],
    }), AT);
    expect(out).not.toContain('Unrelated incident opened');
    expect(out).toContain('Incident created: fire');
  });

  it('survives an incident with no audit trail at all', () => {
    const out = renderDebrief(sources({ events: [] }), AT);
    expect(out).toContain('No audit entries are recorded against this incident reference');
  });

  it('lists committed assets that are still attached at export time', () => {
    const asset: NearbyAsset = {
      id: 'ast-mai-sled', name: 'Emergency Sled', type: 'sled',
      lat: -70.77, lng: 11.73, station: 'Maitri', status: 'deployed',
      assigned_incident_id: INCIDENT.id, distance_m: 1240,
    };
    const out = renderDebrief(sources({ assets: [asset] }), AT);
    expect(out).toContain('Still committed at export time');
    expect(out).toContain('1.24 km from the incident');
  });
});

describe('debriefFilename', () => {
  it('names the file after the incident and the day it was drawn', () => {
    expect(debriefFilename(INCIDENT, AT)).toBe('MoES-Debrief-inc-aa00cc84-20260928.txt');
  });

  // An id is generated server-side, but a filename is written to a filesystem.
  it('strips anything that would not survive being a filename', () => {
    const name = debriefFilename({ ...INCIDENT, id: 'inc/../../etc passwd' }, AT);
    expect(name).not.toContain('/');
    expect(name).not.toContain(' ');
    expect(name).toBe('MoES-Debrief-inc-------etc-passwd-20260928.txt');
  });
});
