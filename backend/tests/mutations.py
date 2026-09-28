"""Do these tests still have teeth?

A suite is trusted on its size far more often than it deserves to be. This
reintroduces bugs the codebase has a comment about, one at a time, and requires
the suite to fail on each. A mutation that survives is a test that does not
really exist — three did on the first run of this, and all three were gaps in
the tests rather than in the code.

    python -m tests.mutations            # all of them
    python -m tests.mutations --list     # names only
    python -m tests.mutations geo auth   # only mutations matching these words

Every mutation is restored in a `finally`, including on Ctrl-C, so a run that
is interrupted does not leave a bug behind in the working tree.
"""

from __future__ import annotations

import argparse
import pathlib
import subprocess
import sys
from dataclasses import dataclass

BACKEND = pathlib.Path(__file__).resolve().parent.parent


@dataclass(frozen=True)
class Mutation:
    """A single reintroduced bug. `anchor` must appear exactly as written.

    `also` removes a second guard in the same run, for a property protected in
    more than one place. Mutating one guard alone survives because the other
    still holds — correct behaviour, and not a useful question. What is worth
    asking is whether the property is protected at all.
    """
    label: str
    path: str
    anchor: str
    replacement: str
    also: tuple[tuple[str, str, str], ...] = ()

    @property
    def file(self) -> pathlib.Path:
        return BACKEND / self.path

    @property
    def edits(self) -> list[tuple[pathlib.Path, str, str]]:
        return [(self.file, self.anchor, self.replacement)] + [
            (BACKEND / path, anchor, replacement) for path, anchor, replacement in self.also]


MUTATIONS: list[Mutation] = [
    # ── Playback and geodesy ────────────────────────────────────────────────
    Mutation('traverse playback back to the 26-second blur',
             'app/simulation.py',
             'FIXES_PER_LEG = 8', 'FIXES_PER_LEG = 2'),
    Mutation('bearing via the flat approximation',
             'app/geo.py',
             '    y = math.sin(delta_lambda) * math.cos(phi2)', '    y = delta_lambda'),
    Mutation('deviation measured to waypoints, not segments',
             'app/geo.py',
             '    return min(distance_to_segment_m(lat, lng, a, b)\n'
             '               for a, b in zip(planned_waypoints, planned_waypoints[1:]))',
             '    return min(haversine_distance(lat, lng, wp["lat"], wp["lng"])\n'
             '               for wp in planned_waypoints)'),

    # ── Inventory policy ────────────────────────────────────────────────────
    Mutation('flat criticality for every supply class',
             'app/routes/inventory.py',
             "'fuel':        {'critical_days': 14, 'warning_days': 30},",
             "'fuel':        {'critical_days': 15, 'warning_days': 30},"),
    Mutation('burn rate ignores headcount again',
             'app/routes/inventory.py',
             'factor = headcount_factor if scaled else 1.0', 'factor = 1.0'),
    Mutation('stock delta carries its sign again',
             'app/routes/inventory.py',
             "delta = abs(float(result['quantity'] or 0))",
             "delta = float(result['quantity'] or 0)"),

    # ── Emergency accountability ────────────────────────────────────────────
    Mutation('incident resolvable while someone is unaccounted for',
             'app/routes/incidents.py',
             "if target == lifecycle.RESOLVED and (row['unaccounted_count'] or 0) > 0:",
             'if False:'),
    Mutation('reset forgets asset commitments again',
             'app/routes/admin.py',
             "assigned_incident_id = NULL')",
             "assigned_incident_id = assigned_incident_id')"),


    # ── Time and ordering ───────────────────────────────────────────────────
    Mutation('timestamp reads the clock twice again',
             'app/timeutil.py',
             '    return _format_iso(utc_now())',
             "    return utc_now().strftime('%Y-%m-%dT%H:%M:%S.') + "
             "f'{utc_now().microsecond // 1000:03d}Z'"),

    # ── What a model is allowed to have understood ──────────────────────────
    Mutation('LLM quantity unbounded again',
             'app/models.py',
             '    quantity: float = Field(ge=0, le=1_000_000)', '    quantity: float'),
    Mutation('any station name accepted from the model',
             'app/models.py',
             "            raise ValueError(f'unknown station {value!r}')",
             '            return str(value)'),

    # ── Expedition readiness ────────────────────────────────────────────────
    Mutation('inbound cargo blocks feasibility again',
             'app/routes/expeditions.py',
             '    cargo_ok = not delayed', '    cargo_ok = not pending'),
    Mutation('crew from any station may be assigned',
             'app/routes/expeditions.py',
             "                   f'traverse departing from there.')",
             "                   f'traverse departing from there.') if False else None"),
    Mutation('degradation alarm never fires',
             'app/cascade.py',
             '        is_degraded = live < baseline - DEGRADE_TOLERANCE',
             '        is_degraded = False'),

    # ── Cargo ───────────────────────────────────────────────────────────────
    Mutation('overdue convoy detection disabled',
             'app/routes/shipments.py',
             "    if eta is None or shipment.get('status') not in IN_FLIGHT_STATUSES "
             'or now <= eta:',
             '    if True:'),

    # ── Work done per request ───────────────────────────────────────────────
    # These were invisible at seed size and linear in it, which is the worst
    # combination: nothing to see in a demo, and the first real deployment is
    # where it shows up.
    Mutation('roster re-queries each plan per person again',
             'app/routes/personnel.py',
             '        person.update(playback_state(plan))',
             "        person['progress'] = get_progress(row['id'], db) if plan else None\n"
             "        person['telemetry'] = get_telemetry(plan) if plan else None"),
    Mutation('alert state inferred from the audit log again',
             'app/routes/inventory.py',
             '''    query = "SELECT * FROM inventory_items WHERE stock_alert_state = 'raised'"''',
             "    query = 'SELECT * FROM inventory_items WHERE 1=1'"),
    Mutation('cascade re-reads station facts per traverse again',
             'app/cascade.py',
             '            ), log=False, snapshot=snapshot)',
             '            ), log=False)'),

    # ── Domain modelling ────────────────────────────────────────────────────
    Mutation('station cannot be asked whether it can spare the fuel',
             'app/routes/expeditions.py',
             '        reserve_ok = reserve_days >= trip_days',
             '        reserve_ok = True'),
    Mutation('burn baseline back to a constant that desynchronises',
             'app/routes/inventory.py',
             "    profile = db.execute('SELECT nominal_headcount FROM station_profile "
             "WHERE station = ?',\n                         (station,)).fetchone()",
             '    profile = None'),
    # Protocol rows outliving their incident is guarded twice over: the reset
    # deletes them explicitly, and the foreign key cascades. Mutating either
    # one alone survives, because the other still holds - which is what
    # defence in depth is supposed to look like. The question worth asking is
    # whether the property is protected at all, so this removes both.
    # Guarded three times over: the schema's foreign key, the migration that
    # rebuilds the table with it on databases that predate it, and the reset's
    # explicit delete. Mutating any one alone survives because the others hold
    # - which is what defence in depth is supposed to look like, and why the
    # useful question is whether the property is protected at all.
    Mutation('protocol rows may outlive their incident again',
             'app/database.py',
             '        FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE',
             '        CHECK (incident_id IS NOT NULL)',
             also=(('app/database.py',
                    '                FOREIGN KEY (incident_id) REFERENCES incidents(id) '
                    'ON DELETE CASCADE',
                    '                CHECK (incident_id IS NOT NULL)'),
                   ('app/routes/admin.py',
                    "db.execute('DELETE FROM incident_tasks')", 'pass'))),

    # ── Deployment posture ──────────────────────────────────────────────────
    Mutation('CORS wildcard headers restored',
             'app/main.py',
             "    allow_headers=['Content-Type', 'X-Commander-Key'],",
             "    allow_headers=['*'],"),
    Mutation('the blueprint key name is ignored again',
             'app/auth.py',
             "_KEY_ENV_NAMES = ('PRAHARI_API_KEY', 'PRAHARI_COMMANDER_KEY')",
             "_KEY_ENV_NAMES = ('PRAHARI_API_KEY',)"),
    Mutation('reads served to anyone who knows the URL',
             'app/auth.py',
             "    if reads_are_public():\n        return identify(request)",
             '    if True:\n        return identify(request)'),
    Mutation('session signature not verified',
             'app/auth.py',
             '    if not hmac.compare_digest(signature, expected):\n        return None',
             '    if False:\n        return None'),
    Mutation('an expired session stays valid',
             'app/auth.py',
             "    if not isinstance(claims, dict) or claims.get('exp', 0) < time.time():",
             '    if not isinstance(claims, dict):'),
    Mutation('CORS admits every deployment on vercel.app again',
             'app/main.py',
             "    return _project_origin_regex(project) if project else None",
             r"""    return r'^https://.*\.vercel\.app$'"""),
    Mutation('a traverse loads whichever fuel there is most of',
             'app/routes/expeditions.py',
             '    return _match(TRAVERSE_FUEL_MATCH) or _match(FUEL_ITEM_MATCH)',
             '    return _match(FUEL_ITEM_MATCH)'),
    Mutation('sign-in brute force unlimited',
             'app/routes/auth_routes.py',
             '    client = guard_login(request)', "    client = 'unguarded'"),

    # ── What-if and stockout risk ───────────────────────────────────────────
    Mutation('a projection writes to the audit log',
             'app/projection.py',
             'before = await score_feasibility(request, log=False, snapshot=current)',
             'before = await score_feasibility(request, snapshot=current)'),
    Mutation('the projection scores both sides against the same station',
             'app/projection.py',
             'after = await score_feasibility(request, log=False, snapshot=modified)',
             'after = await score_feasibility(request, log=False, snapshot=current)'),
    Mutation('stock projects below empty',
             'app/projection.py',
             "        projected['quantity'] = max(0.0, float(projected['quantity'] or 0) "
             '- rate * days)',
             "        projected['quantity'] = float(projected['quantity'] or 0) - rate * days"),
    Mutation('the crew delta never reaches the depletion formula',
             'app/projection.py',
             "    after_present = max(0, basis['headcount'] + scenario.extra_crew)",
             "    after_present = basis['headcount']"),
    Mutation('a forecast is produced from two days of history',
             'app/forecast.py',
             'MIN_OBSERVED_DAYS = 5', 'MIN_OBSERVED_DAYS = 1'),
    Mutation('days with no consumption pad the observation count',
             'app/forecast.py',
             '    days = [amount for amount in daily_consumption.values() if amount > 0]',
             '    days = list(daily_consumption.values())'),
    Mutation('the forecast ignores the conditions it is asked about',
             'app/forecast.py',
             '            remaining -= rng.choice(days) * multiplier\n'
             '            if remaining <= 0:\n'
             '                exhausted_on.append(day)',
             '            remaining -= rng.choice(days)\n'
             '            if remaining <= 0:\n'
             '                exhausted_on.append(day)'),
    Mutation('the conditions multiplier is a ratio of absolute rates again',
             'app/routes/inventory.py',
             "        weather = max(0.1, 1 + (depletion['beta'] or 0) * delta_t)\n"
             "        multiplier = weather * (depletion['headcount_factor'] or 1.0)",
             "        base = compute_depletion(item, 0, 1.0)['depletion_rate'] or 1\n"
             "        multiplier = (depletion['depletion_rate'] / base) if base else 1.0"),
    Mutation('the forecast is reseeded on every call',
             'app/forecast.py',
             '    rng = random.Random(seed if seed is not None else _stable_seed(quantity, days))',
             '    rng = random.Random()'),
    Mutation('two draws in one day count as two observations',
             'app/stock_ledger.py',
             '        day = created_at[:10]', '        day = created_at'),

    # ── Procurement: the leg before the ship ────────────────────────────────
    Mutation('an unconfirmed order can be put on the cargo board',
             'app/routes/procurement.py',
             "    if row['status'] not in DISPATCHABLE_STATUSES:",
             '    if False:'),
    Mutation('an order can be dispatched twice',
             'app/routes/procurement.py',
             "    if row['status'] not in DISPATCHABLE_STATUSES:",
             '    if False:',
             also=(('app/routes/procurement.py',
                    "    if row['status'] == 'shipped':\n"
                    "        raise HTTPException(status_code=409,\n"
                    "                            detail=f'{row[\"reference\"]} has already "
                    "been dispatched.')",
                    '    if False:\n        pass'),)),
    Mutation('the order and the crate are no longer linked',
             'app/routes/procurement.py',
             '    db.execute("UPDATE purchase_orders SET status = \'shipped\', '
             'shipment_id = ? WHERE id = ?",\n               (shipment[\'id\'], order_id))',
             "    db.execute(\"UPDATE purchase_orders SET status = 'shipped' WHERE id = ?\",\n"
             '               (order_id,))'),
    Mutation('the stock row an order names is dropped at the handover',
             'app/routes/procurement.py',
             "        inventory_item_id=row['inventory_item_id'],",
             '        inventory_item_id=None,'),
    Mutation('a vendor missing their date is never flagged',
             'app/routes/procurement.py',
             "    if promised is None or order.get('status') not in AWAITING_STATUSES "
             'or now <= promised:',
             '    if True:'),
    Mutation('an order may restock another station',
             'app/routes/procurement.py',
             "        if target['station'] != data.destination_station:",
             '        if False:'),
    Mutation('orders survive a reset and double on the next season',
             'app/routes/admin.py',
             "OPERATIONAL_TABLES = ('movement_plans', 'incidents', 'shipments', "
             "'expeditions',\n                      'purchase_orders')",
             "OPERATIONAL_TABLES = ('movement_plans', 'incidents', 'shipments', "
             "'expeditions')"),

    # ── Roles ───────────────────────────────────────────────────────────────
    Mutation('an observer can write after all',
             'app/auth.py',
             '    if is_observer(identity):',
             '    if False:'),
    Mutation('the role is read from outside the signature',
             'app/auth.py',
             "            return {**claims, 'role': claims.get('role', COMMANDER), "
             "'via': 'session'}",
             "            return {**claims, 'role': COMMANDER, 'via': 'session'}"),
    Mutation('observer access is open whether the station offers it or not',
             'app/routes/auth_routes.py',
             '    if not observer_enabled():',
             '    if False:'),
    Mutation('an observer cannot sign out of their own session',
             'app/auth.py',
             'async def require_identity(request: Request) -> dict:',
             'async def require_identity(request: Request) -> dict:\n'
             '    return await require_commander(request)  # mutation'),

    # ── Durability and the demonstration season ─────────────────────────────
    Mutation('the database goes back inside the application directory',
             'app/database.py',
             "    path = os.getenv('PRAHARI_DB_PATH') or DEFAULT_DB_PATH",
             '    path = DEFAULT_DB_PATH'),
    Mutation('a bare mount point is not given its directory',
             'app/database.py',
             '    if directory:\n        os.makedirs(directory, exist_ok=True)',
             '    if False:\n        os.makedirs(directory, exist_ok=True)'),
    Mutation('the boot seed overwrites a station that already holds records',
             'app/main.py',
             '        if existing:',
             '        if False:'),
    Mutation('the demo season stacks instead of replacing',
             'app/routes/admin.py',
             '    restore_baseline(db, clear_events=body.clear_events)\n    created',
             '    created'),
    Mutation('the demo season declares its historical incident as live',
             'app/demo.py',
             "(inc_id, spec['type'], lat, lng, radius, spec['severity'], 'resolved',",
             "(inc_id, spec['type'], lat, lng, radius, spec['severity'], 'open',"),
    Mutation('the demo board is left entirely undispatched',
             'app/demo.py',
             "        for _ in range(spec.get('scans', 0)):",
             '        for _ in range(0):'),
    Mutation('the demo season unloads its cargo into the store',
             'app/demo.py',
             "        for _ in range(spec.get('scans', 0)):",
             "        for _ in range(3):"),
    Mutation('the demo season stops declaring itself synthetic',
             'app/demo.py',
             "        f'These records are synthetic.',",
             "        f'incident(s) across all three stations.',"),
    Mutation('nothing in the season is overdue, so the stalled path is unreachable',
             'app/demo.py',
             "'priority': 'normal', 'eta_hours': -26, 'scans': 1},",
             "'priority': 'normal', 'eta_hours': 26, 'scans': 1},"),

    # ── The audit chain ─────────────────────────────────────────────────────
    Mutation('entries no longer link to the one before them',
             'app/events.py',
             '    prev_hash = head_hash(db)',
             '    prev_hash = GENESIS_HASH'),
    Mutation('the digest ignores the metadata',
             'app/events.py',
             "        'metadata': metadata,\n        'station': station,",
             "        'station': station,"),
    Mutation('verification passes over an unhashed entry',
             'app/events.py',
             "        if not stored:\n            return {'ok': False,",
             "        if False:\n            return {'ok': False,"),

    # ── Observed burn rate ──────────────────────────────────────────────────
    Mutation('a stocktake correction counts as consumption',
             'app/stock_ledger.py',
             'CONSUMING_REASONS = (REASON_COMMAND, REASON_EXPEDITION_DRAW)',
             'CONSUMING_REASONS = (REASON_COMMAND, REASON_EXPEDITION_DRAW, '
             'REASON_CORRECTION, REASON_TRANSFER_OUT)'),
    Mutation('a rate is inferred from a single movement',
             'app/stock_ledger.py',
             'MIN_MOVEMENTS = 2', 'MIN_MOVEMENTS = 0'),
    Mutation('the observation window ends at the last draw, not now',
             'app/stock_ledger.py',
             "        elapsed_days = (now.timestamp() - entry['first']) / 86400",
             "        elapsed_days = (entry['last'] - entry['first']) / 86400"),
    Mutation('restocks count as negative burn',
             'app/stock_ledger.py',
             'if item_id is None or not isinstance(delta, (int, float)) or delta >= 0:',
             'if item_id is None or not isinstance(delta, (int, float)) or delta == 0:'),

    # ── Cold chain ──────────────────────────────────────────────────────────
    Mutation('only the threshold is checked, never the rate of change',
             'app/coldchain.py',
             "    drifting = drift is not None and abs(drift) >= RATE_OF_CHANGE_LIMIT_C_PER_H",
             '    drifting = False'),
    Mutation('a crate that recovered forgets it was ever out of band',
             'app/routes/shipments.py',
             "    excursions = int(shipment.get('excursion_count') or 0) + "
             "(1 if verdict['excursion'] else 0)",
             "    excursions = 1 if verdict['excursion'] else 0"),
    Mutation('a reading below the band is treated as fine',
             'app/coldchain.py',
             "    if temp_min is not None and temp_c < temp_min:",
             '    if False:'),

    # ── Replay protection ───────────────────────────────────────────────────
    Mutation('a replayed write is applied a second time',
             'app/idempotency.py',
             '    if seen:\n        return Response(content=seen[\'body\']',
             '    if False:\n        return Response(content=seen[\'body\']'),
    Mutation('sign-in is replayed from the record, losing its cookie',
             'app/idempotency.py',
             "            or request.url.path.startswith(EXCLUDED_PREFIXES)):",
             '            or False):'),
    Mutation('the consumption reader scans the whole log again',
             'app/stock_ledger.py',
             "        'AND created_at >= ? ORDER BY seq ASC', (station, cutoff)).fetchall()",
             "        'ORDER BY seq ASC', (station,)).fetchall()"),
    Mutation('a refusal is remembered and replayed back for ever',
             'app/idempotency.py',
             '    if 200 <= response.status_code < 300:',
             '    if True:'),
    # The console's half of replay protection — that the queue reuses an
    # entry's id as its key across retries — is pinned in
    # frontend/src/lib/offlineQueue.test.ts. This harness runs pytest, so a
    # mutation there would survive for the wrong reason.

    # ── Incident lifecycle and asset ranking ────────────────────────────────
    Mutation('a response can be rolled backwards through its stages',
             'app/incident_lifecycle.py',
             '    if rank(target) < rank(current):',
             '    if False:'),
    Mutation('committing an asset leaves the incident unstarted',
             'app/routes/incidents.py',
             '        if lifecycle.rank(incident[\'status\']) < '
             'lifecycle.rank(lifecycle.RESPONDING):',
             '        if False:'),
    Mutation('assets are ranked by distance alone again',
             'app/routes/incidents.py',
             "    results.sort(key=lambda x: (-x['suitability'], x['distance_m']))",
             "    results.sort(key=lambda x: x['distance_m'])"),
    Mutation('range is judged one way, ignoring the trip home',
             'app/routes/incidents.py',
             '    needed_km = (distance_m / 1000) * 2',
             '    needed_km = distance_m / 1000'),
]


def run_suite() -> bool:
    """True when the suite passed — which, under a mutation, is a failure."""
    result = subprocess.run(
        [sys.executable, '-m', 'pytest', '-x', '-q', '--no-header', '-p', 'no:cacheprovider'],
        cwd=BACKEND, capture_output=True, text=True)
    return result.returncode == 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('filters', nargs='*',
                        help='only run mutations whose label contains one of these')
    parser.add_argument('--list', action='store_true', help='list mutations and exit')
    args = parser.parse_args()

    selected = [m for m in MUTATIONS
                if not args.filters
                or any(f.lower() in m.label.lower() or f.lower() in m.path.lower()
                       for f in args.filters)]

    if args.list:
        for mutation in selected:
            print(f'  {mutation.label}  [{mutation.path}]')
        return 0

    if not selected:
        print('No mutations matched.')
        return 1

    print(f'Checking {len(selected)} mutation(s) against the suite.\n')
    survivors: list[str] = []
    missing: list[str] = []

    for mutation in selected:
        edits = mutation.edits
        originals = {path: path.read_text(encoding='utf-8') for path, _, _ in edits}
        lost = [path for path, anchor, _ in edits if anchor not in originals[path]]
        if lost:
            # The code moved. That is not a pass — the mutation is no longer
            # testing anything and has to be rewritten.
            print(f'  ANCHOR LOST  {mutation.label}  [{mutation.path}]')
            missing.append(mutation.label)
            continue

        # Accumulated per file. Two edits to the same file each written from
        # the pristine original meant the second silently undid the first, and
        # the mutation then reported itself as caught by a suite that had
        # never actually seen it.
        mutated = dict(originals)
        for path, anchor, replacement in edits:
            mutated[path] = mutated[path].replace(anchor, replacement, 1)
        for path, source in mutated.items():
            path.write_text(source, encoding='utf-8')
        try:
            survived = run_suite()
        finally:
            for path, source in originals.items():
                path.write_text(source, encoding='utf-8')

        print(f'  {"SURVIVED" if survived else "caught  "} {mutation.label}')
        if survived:
            survivors.append(mutation.label)

    print()
    if missing:
        print(f'{len(missing)} mutation(s) no longer match the source and need rewriting:')
        for label in missing:
            print(f'  - {label}')
    if survivors:
        print(f'{len(survivors)} mutation(s) survived — those are gaps in the suite:')
        for label in survivors:
            print(f'  - {label}')
    if not survivors and not missing:
        print(f'All {len(selected)} mutations caught.')
    return 1 if (survivors or missing) else 0


if __name__ == '__main__':
    raise SystemExit(main())
