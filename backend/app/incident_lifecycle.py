"""The stages an incident passes through, and what may follow what.

`open` and `resolved` were the whole vocabulary. That is enough to answer "is
anyone dealing with this", and nothing else: an incident declared four minutes
ago that nobody has seen looked identical to one with a snowcat already on the
ice. During a callout the difference between those two is the only thing worth
knowing.

The stages are the ones a response actually passes through, and each is
timestamped when it is entered, so the record afterwards says how long the
station took to acknowledge and how long to get moving — the two figures a
debrief is built on.

`open` is still accepted from callers and still means "not resolved". It was
the only word older consoles and scripts knew, and breaking them to rename a
constant would be a poor trade.
"""

DECLARED = 'declared'
ACKNOWLEDGED = 'acknowledged'
RESPONDING = 'responding'
CONTAINED = 'contained'
RESOLVED = 'resolved'

# In order. Position in this tuple is what "forward" means below.
LIFECYCLE = (DECLARED, ACKNOWLEDGED, RESPONDING, CONTAINED, RESOLVED)

# Everything that is not over. Used wherever the old code asked `== 'open'`.
ACTIVE_STATUSES = (DECLARED, ACKNOWLEDGED, RESPONDING, CONTAINED)

# The same set, for SQL.
#
# `normalise` happens on the way out, so the *database* can still hold the
# literal 'open' — a row from a backup that predates the migration, or one
# written by an older build against the same file. A query listing only the
# five stage names would count such a row as closed and drop a live incident
# off the reset preview and the roster's hazard check, which is the one place
# a silently missing incident is dangerous.
ACTIVE_STATUSES_SQL = ACTIVE_STATUSES + ('open',)

# What each stage means, in the words the console shows an operator.
DESCRIPTIONS = {
    DECLARED: 'Raised. Nobody has picked it up yet.',
    ACKNOWLEDGED: 'Someone has it and is assessing.',
    RESPONDING: 'Assets are committed and moving.',
    CONTAINED: 'Under control; not yet stood down.',
    RESOLVED: 'Closed, with everyone accounted for.',
}

# The timestamp column each stage stamps on entry.
STAGE_TIMESTAMP = {
    ACKNOWLEDGED: 'acknowledged_at',
    RESPONDING: 'responding_at',
    CONTAINED: 'contained_at',
    RESOLVED: 'resolved_at',
}


def normalise(status: str | None) -> str | None:
    """Map the legacy word onto a stage. `open` meant "just declared"."""
    if status is None:
        return None
    return DECLARED if status == 'open' else status


def is_active(status: str | None) -> bool:
    return normalise(status) in ACTIVE_STATUSES


def rank(status: str) -> int:
    stage = normalise(status)
    return LIFECYCLE.index(stage) if stage in LIFECYCLE else -1


def can_transition(current: str, target: str) -> tuple[bool, str | None]:
    """Whether a response may move from one stage to another, and why not.

    Forward is always allowed, including skipping a stage: an incident that is
    contained the moment it is declared should not need three clicks to say
    so, and a station in the middle of a callout is the worst place to make
    someone satisfy a state machine.

    Backwards is not, with one exception — a resolved incident can be
    reopened, which lands on `responding` because somebody is dealing with it
    again. Rolling `contained` back to `declared` would erase a timestamp the
    debrief needs and describes nothing that happens in a real response.
    """
    current, target = normalise(current), normalise(target)
    if target not in LIFECYCLE:
        return False, f'{target} is not a stage of an incident response.'
    if current == target:
        return True, None
    if current == RESOLVED:
        return (True, None) if target == RESPONDING else (
            False,
            'A resolved incident can only be reopened, which puts it back into '
            'responding. Declare a new incident if this is a different event.')
    if rank(target) < rank(current):
        return False, (f'An incident cannot go from {current} back to {target}. '
                       f'Reopening a resolved incident is the only way back.')
    return True, None
