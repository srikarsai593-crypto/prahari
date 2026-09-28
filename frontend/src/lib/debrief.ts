import { api } from './api';
import { downloadTextFile } from './download';
import { RULE, heading, masthead, row, stamp } from './textReport';
import { getStation } from './stations';
import type { AppEvent, Incident, NearbyAsset } from './types';

/**
 * The post-incident debrief NCPOR/MoES expects after any declared emergency.
 *
 * Everything in the document is read back out of the station's own records at
 * export time — the incident row, the accountability count, the protocol
 * checklist with its tick timestamps, the assets that were committed, and the
 * audit timeline. Nothing is composed from what the page happens to have in
 * state, because a debrief is the artefact someone is answerable for and it
 * has to match the record rather than the screen.
 *
 * Plain text on purpose: it prints from any machine at any station, survives
 * being pasted into a ticket or an email, and needs no font, viewer or
 * dependency that a console at the end of a satellite link might not have.
 */

/** A metadata blob is `{"k": v}` or a JSON string, and sometimes neither. */
function readMetadata(raw: AppEvent['metadata']): Record<string, unknown> | null {
  if (!raw) return null;
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null
      ? parsed as Record<string, unknown>
      : null;
  } catch { return null; }
}

/**
 * Whether an audit row belongs to this incident.
 *
 * Most rows carry the incident as `related_id`, but an asset dispatch is
 * filed against the *asset* and names the incident in its metadata — so
 * matching on `related_id` alone silently dropped the one line the SAR
 * section exists to report, that a vehicle was actually sent.
 */
function belongsToIncident(event: AppEvent, incidentId: string): boolean {
  if (event.related_id === incidentId) return true;
  const meta = readMetadata(event.metadata);
  return meta?.incident_id === incidentId;
}

export interface DebriefSources {
  incident: Incident;
  accountability: Awaited<ReturnType<typeof api.readAccountability>> | null;
  sop: Awaited<ReturnType<typeof api.getIncidentSop>> | null;
  assets: NearbyAsset[];
  events: AppEvent[];
}

/**
 * Pull everything the debrief cites, in one pass.
 *
 * Each source is allowed to fail on its own: a debrief missing its protocol
 * section because that one call failed is worth far more than no debrief at
 * all, and the document says plainly which section could not be read rather
 * than quietly omitting it.
 */
export async function collectDebrief(incident: Incident): Promise<DebriefSources> {
  const station = incident.station ?? undefined;
  const [accountability, sop, assets, events] = await Promise.all([
    api.readAccountability(incident.id).catch(() => null),
    api.getIncidentSop(incident.id).catch(() => null),
    api.listAssets(station).catch(() => [] as NearbyAsset[]),
    api.listEvents({ module: 'emergency', station, limit: 500 })
      .catch(() => [] as AppEvent[]),
  ]);
  return { incident, accountability, sop, assets: assets ?? [], events: events ?? [] };
}

export function renderDebrief(sources: DebriefSources, generatedAt = new Date()): string {
  const { incident, accountability, sop, assets, events } = sources;
  const station = getStation(incident.station);
  const out: string[] = [];

  // ── Masthead ──────────────────────────────────────────────────────────────
  out.push(...masthead('POST-INCIDENT OPERATIONAL DEBRIEF',
                       `${station.label} — ${station.region}`));
  out.push(row('Incident reference', incident.id));
  out.push(row('Category', incident.type.replace(/_/g, ' ').toUpperCase()));
  out.push(row('Severity at closure', incident.severity.toUpperCase()));
  out.push(row('Status', String(incident.status).toUpperCase()));
  out.push(row('Declared at', stamp(incident.created_at)));
  out.push(row('Debrief generated', stamp(generatedAt.toISOString())));

  // ── Position ──────────────────────────────────────────────────────────────
  out.push(heading('1. INCIDENT POSITION'));
  out.push(row('Latitude', `${incident.location_lat.toFixed(5)}°`));
  out.push(row('Longitude', `${incident.location_lng.toFixed(5)}°`));
  out.push(row('Affected radius', `${Math.round(incident.affected_radius_m)} m`));
  out.push(row('Responding station', station.label));

  // ── Accountability ────────────────────────────────────────────────────────
  out.push(heading('2. PERSONNEL ACCOUNTABILITY'));
  if (!accountability) {
    out.push('  Accountability record could not be read from the station at export time.');
  } else {
    out.push(row('Expected in affected zone', accountability.expected));
    out.push(row('Confirmed safe', accountability.confirmed_safe));
    out.push(row('Unaccounted at closure', accountability.unaccounted));
    out.push('');
    out.push(accountability.unaccounted > 0
      ? `  ** ${accountability.unaccounted} PERSON(S) UNACCOUNTED FOR — THIS INCIDENT WAS `
        + 'CLOSED WITH AN OPEN HEAD-COUNT. **'
      : '  All personnel within the affected radius were confirmed safe before closure.');
    if (accountability.personnel?.length) {
      out.push('');
      out.push('  Roll at closure:');
      for (const p of accountability.personnel) {
        out.push(`    - ${p.name} (${p.role}) — ${p.status}, `
          + `${Math.round(p.distance_m)} m from the incident`);
      }
    }
  }

  // ── Protocol ──────────────────────────────────────────────────────────────
  out.push(heading('3. RESPONSE PROTOCOL (SOP) EXECUTION'));
  if (!sop) {
    out.push('  Protocol record could not be read from the station at export time.');
  } else if (sop.tasks.length === 0) {
    out.push('  No protocol is defined for this incident category.');
  } else {
    out.push(row('Steps completed', `${sop.completed} of ${sop.total}`));
    out.push('');
    for (const task of [...sop.tasks].sort((a, b) => a.position - b.position)) {
      out.push(`  [${task.done ? 'x' : ' '}] ${task.label}`);
      if (task.done) {
        out.push(`        completed ${stamp(task.done_at)} by ${task.done_by ?? 'unknown'}`);
      }
    }
    if (sop.completed < sop.total) {
      out.push('');
      out.push(`  ** ${sop.total - sop.completed} protocol step(s) were not recorded as `
        + 'completed. **');
    }
  }

  // ── Assets ────────────────────────────────────────────────────────────────
  out.push(heading('4. SEARCH & RESCUE ASSETS COMMITTED'));
  const committed = assets.filter((a) => a.assigned_incident_id === incident.id);
  // Assets are released on closure, so the live roster usually shows none by
  // the time a debrief is run. The audit trail is the durable record of what
  // was actually sent, and it is what the timeline below reports.
  const dispatchEvents = events.filter((e) =>
    belongsToIncident(e, incident.id) && /dispatch|deploy|release|asset/i.test(e.action));
  if (committed.length === 0 && dispatchEvents.length === 0) {
    out.push('  No rescue asset was committed to this incident.');
  } else {
    if (committed.length > 0) {
      out.push('  Still committed at export time:');
      for (const a of committed) {
        out.push(`    - ${a.name} (${a.type}) — ${a.status}, `
          + `${(a.distance_m / 1000).toFixed(2)} km from the incident`);
      }
      out.push('');
    }
    if (dispatchEvents.length > 0) {
      out.push('  Dispatch and release record:');
      for (const e of [...dispatchEvents].sort((a, b) => a.seq - b.seq)) {
        out.push(`    ${stamp(e.created_at)}  ${e.action}  (${e.actor})`);
      }
    }
  }

  // ── Timeline ──────────────────────────────────────────────────────────────
  out.push(heading('5. SAFETY TIMELINE (STATION AUDIT RECORD)'));
  const trail = events
    .filter((e) => belongsToIncident(e, incident.id))
    .sort((a, b) => a.seq - b.seq);
  if (trail.length === 0) {
    out.push('  No audit entries are recorded against this incident reference.');
  } else {
    // Action text runs to arbitrary length, so the actor goes at the end in
    // parentheses rather than in a column that nothing would ever line up in.
    for (const e of trail) {
      out.push(`  ${stamp(e.created_at)}  ${e.action}  (${e.actor})`);
    }
  }

  // ── Footer ────────────────────────────────────────────────────────────────
  out.push('');
  out.push(RULE);
  out.push('  Generated by PRAHARI — National Antarctic Operations Intelligence &');
  out.push('  Logistics Grid. Every figure above is read from the station\'s own');
  out.push('  records at export time; none is estimated. Times are UTC.');
  out.push(RULE);
  out.push('');

  return out.join('\n');
}

/** `MoES-Debrief-INC-01-20260928.txt` — sorts and reads sensibly in a folder. */
export function debriefFilename(incident: Incident, generatedAt = new Date()): string {
  const day = generatedAt.toISOString().slice(0, 10).replace(/-/g, '');
  const safeId = incident.id.replace(/[^A-Za-z0-9_-]/g, '-');
  return `MoES-Debrief-${safeId}-${day}.txt`;
}

/** Hand the rendered debrief to the browser as a download. The mechanics are
 *  shared with the shift handover brief; see lib/download.ts. */
export const downloadDebrief = downloadTextFile;
