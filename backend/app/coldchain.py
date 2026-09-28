"""Temperature-controlled cargo: bands, excursions, and rate of change.

Antarctic resupply is not only a question of whether a crate arrives. Vaccines,
blood products, reagents and fresh food arrive *useless* if they spent six
hours outside their band on the ice — and the crate looks identical either way,
which is exactly why the reading has to be on the record rather than in
somebody's memory of the unloading.

Two checks, because they catch different failures:

* **A threshold breach** is the obvious one: the reading is outside the band
  the consignment is rated for. Recorded with how far outside, because 0.5 °C
  over on a vaccine is a conversation and 8 °C over is a write-off.

* **Rate of change** catches the failure *before* it becomes a breach. A
  reefer whose compressor has stopped is still inside its band for the first
  hour; what gives it away is that it is climbing 3 °C an hour. A threshold
  alone tells you afterwards, which for a cold chain is too late to act on.

Prahari has no temperature sensors. Readings arrive because an operator
recorded one, or a handheld logger was read out at a scan, and the API says so
— `source` is stored with every reading and the console shows it. A console
that presented an operator's typed figure as telemetry would be inventing a
sensor network.
"""

from .timeutil import utc_now, utc_now_iso

# Default bands per cargo category, in °C. Only categories that genuinely have
# a cold chain get one: a crate of generator spares has no temperature it must
# be kept at, and giving it a band would produce alerts nobody should act on.
#
# Medical covers the vaccine/reagent range rather than the wider "keep cool"
# band, because that is the one whose breach destroys the contents.
DEFAULT_BANDS = {
    'medical': (2.0, 8.0),
    'food': (-25.0, -15.0),
}

# °C per hour. Above this the load is losing control of its temperature even
# if it is still inside the band. Chosen well above the drift a crate shows
# from ordinary handling, so a door opened at a transfer does not cry wolf.
RATE_OF_CHANGE_LIMIT_C_PER_H = 2.0

# A rate needs two readings and some time between them. Below this the
# divisor is small enough that ordinary sensor jitter reads as a runaway.
MIN_RATE_INTERVAL_MINUTES = 5.0


def default_band(category: str) -> tuple[float, float] | None:
    return DEFAULT_BANDS.get(category)


def classify(temp_c: float, temp_min, temp_max) -> dict:
    """Where a reading sits against the band, and by how much."""
    if temp_c is None or (temp_min is None and temp_max is None):
        return {'state': 'unmonitored', 'deviation_c': None}
    if temp_max is not None and temp_c > temp_max:
        return {'state': 'above', 'deviation_c': round(temp_c - float(temp_max), 2)}
    if temp_min is not None and temp_c < temp_min:
        return {'state': 'below', 'deviation_c': round(float(temp_min) - temp_c, 2)}
    return {'state': 'within', 'deviation_c': 0.0}


def rate_of_change(previous_c, previous_at, temp_c: float, now=None) -> float | None:
    """°C per hour between the last reading and this one.

    None when there is no previous reading, or the two are too close together
    for the division to mean anything.
    """
    if previous_c is None or not previous_at:
        return None
    from datetime import datetime, timezone
    try:
        then = datetime.fromisoformat(str(previous_at).replace('Z', '+00:00'))
    except (TypeError, ValueError):
        return None
    if then.tzinfo is None:
        then = then.replace(tzinfo=timezone.utc)
    minutes = ((now or utc_now()) - then).total_seconds() / 60
    if minutes < MIN_RATE_INTERVAL_MINUTES:
        return None
    return round((temp_c - float(previous_c)) / (minutes / 60), 2)


def assess(shipment: dict, temp_c: float, *, now=None) -> dict:
    """The full verdict on one new reading for one consignment."""
    band = classify(temp_c, shipment.get('temp_min'), shipment.get('temp_max'))
    drift = rate_of_change(shipment.get('last_temp_c'), shipment.get('last_temp_at'),
                           temp_c, now=now)
    breached = band['state'] in ('above', 'below')
    # Only a climb towards trouble counts. A crate cooling fast inside a
    # refrigerated band is a compressor working, not one failing.
    drifting = drift is not None and abs(drift) >= RATE_OF_CHANGE_LIMIT_C_PER_H

    reasons = []
    if breached:
        reasons.append(
            f'{band["deviation_c"]:g} °C {band["state"]} the '
            f'{shipment.get("temp_min")}…{shipment.get("temp_max")} °C band')
    if drifting:
        reasons.append(f'changing at {drift:+g} °C/h')

    return {
        'temp_c': temp_c,
        'band_state': band['state'],
        'deviation_c': band['deviation_c'],
        'rate_c_per_h': drift,
        'breached': breached,
        'drifting': drifting,
        'excursion': breached or drifting,
        'summary': ' and '.join(reasons) if reasons else 'within band',
        'recorded_at': (now or utc_now()).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'
        if now else utc_now_iso(),
    }


def summarise(shipment: dict) -> dict:
    """The cold-chain state of a consignment, for a list or a card.

    `monitored` is false for anything with no band: most cargo has no
    temperature it must be kept at, and a console that showed every crate as
    "no reading" would bury the handful that matter.
    """
    monitored = shipment.get('temp_min') is not None or shipment.get('temp_max') is not None
    if not monitored:
        return {'monitored': False, 'state': 'unmonitored', 'last_temp_c': None,
                'excursion_count': 0, 'breach_summary': None}

    last = shipment.get('last_temp_c')
    excursions = int(shipment.get('excursion_count') or 0)
    if last is None:
        state = 'awaiting_reading'
    else:
        band = classify(last, shipment.get('temp_min'), shipment.get('temp_max'))
        state = 'within' if band['state'] == 'within' else 'out_of_band'

    return {
        'monitored': True,
        'state': state,
        'last_temp_c': last,
        'last_temp_at': shipment.get('last_temp_at'),
        'last_temp_source': shipment.get('last_temp_source'),
        'temp_min': shipment.get('temp_min'),
        'temp_max': shipment.get('temp_max'),
        'excursion_count': excursions,
        # The record that matters on arrival is not "is it cold now" but
        # "was it ever warm", and a crate back inside its band reads as fine
        # unless the history is carried forward.
        'breach_summary': (f'{excursions} excursion(s) recorded in transit'
                           if excursions else None),
    }
