'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, Check, CloudSnow, Loader2, Minus, PackageMinus, Plus, Siren, UserCheck,
} from 'lucide-react';
import { api, isQueued } from '@/lib/api';
import { offlineQueue } from '@/lib/offlineQueue';
import { useStation } from '@/components/StationProvider';
import { useToast } from '@/components/Toast';
import {
  loadFieldOperator, saveConsolePreference, saveFieldOperator, type FieldOperator,
} from '@/lib/fieldOperator';
import type { InventoryItem, Personnel } from '@/lib/types';

/**
 * Field mode — the console for someone outside, in gloves, on a phone.
 *
 * The full console is a dense telemetry board, which is right at a desk and
 * wrong at arm's length in a wind chill. Out there an operator does three
 * things: records what they used, says they are back, or calls for help.
 * Everything else can wait until they are indoors.
 *
 * Design rules this page follows and the full console does not:
 *
 * * **One action per screen.** No side-by-side anything. A wrong tap in a
 *   blizzard costs more than a second screen does.
 * * **Targets sized for a gloved thumb**, well past the 44px floor the rest
 *   of the console uses.
 * * **Nothing destructive on a single tap.** Consumption is confirmed
 *   against what the station understood; SOS needs a deliberate hold.
 * * **The link state is always on screen.** Out here it is the difference
 *   between "recorded" and "recorded on this handset until we get back",
 *   and the operator has to be told which.
 */

type Screen = 'home' | 'consume' | 'checkin' | 'sos';

export default function FieldPage() {
  const { station, stationId, ready } = useStation();
  const { addToast } = useToast();
  const [operator, setOperator] = useState<FieldOperator | null>(null);
  const [roster, setRoster] = useState<Personnel[]>([]);
  const [screen, setScreen] = useState<Screen>('home');
  const [pending, setPending] = useState(0);
  const [offline, setOffline] = useState(false);

  useEffect(() => { setOperator(loadFieldOperator()); }, []);

  useEffect(() => {
    const sync = () => {
      setPending(offlineQueue.pendingCount);
      setOffline(offlineQueue.isOffline);
    };
    const unsubscribe = offlineQueue.subscribe(sync);
    sync();
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!ready) return;
    api.listPersonnel(stationId).then(setRoster).catch(() => setRoster([]));
  }, [stationId, ready]);

  const choose = (person: Personnel) => {
    const next = { id: person.id, name: person.name, station: person.station };
    saveFieldOperator(next);
    setOperator(next);
  };

  if (!ready) {
    return (
      <div className="min-h-[70vh] grid place-items-center">
        <Loader2 size={28} className="animate-spin text-arctic-500" aria-hidden="true" />
      </div>
    );
  }

  // Who is holding the phone. Asked once, because all three actions are
  // about a person and an anonymous SOS is a much worse artefact.
  if (!operator) {
    return <OperatorPicker roster={roster} stationLabel={station.label} onChoose={choose} />;
  }

  return (
    <div className="max-w-xl mx-auto pb-12">
      <FieldHeader operator={operator} stationLabel={station.label}
                   offline={offline} pending={pending}
                   onSwitchOperator={() => { saveFieldOperator(null); setOperator(null); }} />

      {screen === 'home' && <Home onPick={setScreen} />}
      {screen === 'consume' && (
        <LogConsumption stationId={stationId} stationLabel={station.label}
                        operator={operator} addToast={addToast}
                        onDone={() => setScreen('home')} />
      )}
      {screen === 'checkin' && (
        <CheckIn operator={operator} addToast={addToast}
                 onDone={() => setScreen('home')} />
      )}
      {screen === 'sos' && (
        <Sos operator={operator} addToast={addToast} onDone={() => setScreen('home')} />
      )}
    </div>
  );
}

// ── Chrome ─────────────────────────────────────────────────────────────────

function FieldHeader({ operator, stationLabel, offline, pending, onSwitchOperator }: {
  operator: FieldOperator; stationLabel: string;
  offline: boolean; pending: number; onSwitchOperator: () => void;
}) {
  return (
    <div className="mb-5">
      {/* Out here this is not a status chip, it is the difference between
          "the station knows" and "this handset knows". */}
      <div className={`rounded-xl border px-4 py-3 mb-4 ${offline || pending > 0
        ? 'border-alert-edge bg-alert-tint text-alert'
        : 'border-nominal-edge bg-nominal-tint text-nominal'}`}>
        <p className="font-bold text-15">
          {offline
            ? 'No link to the station'
            : pending > 0 ? 'Sending held work' : 'Connected to the station'}
        </p>
        <p className="text-13 mt-0.5 opacity-90">
          {pending > 0
            ? `${pending} entr${pending === 1 ? 'y' : 'ies'} saved on this handset, `
              + 'waiting to be sent.'
            : offline
              ? 'Anything you record is kept here and sent when the link returns.'
              : 'Everything you record goes straight to the station.'}
        </p>
      </div>

      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="overline">Field mode · {stationLabel}</p>
          <p className="text-lg font-extrabold text-arctic-900 truncate">{operator.name}</p>
        </div>
        <button type="button" onClick={onSwitchOperator}
                className="btn-secondary !min-h-0 !px-3 !py-2 text-13 shrink-0">
          Not me
        </button>
      </div>
    </div>
  );
}

function OperatorPicker({ roster, stationLabel, onChoose }: {
  roster: Personnel[]; stationLabel: string; onChoose: (p: Personnel) => void;
}) {
  return (
    <div className="max-w-xl mx-auto pb-12">
      <h1 className="text-2xl font-extrabold text-arctic-900">Who has this handset?</h1>
      <p className="text-15 text-frost-muted mt-1 mb-6">
        An SOS has to say who is in trouble, so field mode asks once. This is
        remembered on this device only — it is not a sign-in.
      </p>
      {roster.length === 0 ? (
        <p className="text-15 text-frost-muted">
          No roster for {stationLabel} yet. Connect to the station and reopen this page.
        </p>
      ) : (
        <ul className="space-y-3">
          {roster.map((person) => (
            <li key={person.id}>
              <button type="button" onClick={() => onChoose(person)}
                      className="w-full text-left rounded-xl border border-frost-border
                                 bg-white px-5 py-4 hover:border-arctic-600
                                 transition-colors">
                <span className="block text-lg font-bold text-arctic-900">{person.name}</span>
                <span className="block text-13 text-frost-muted">{person.role}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A glove-sized action. Deliberately not `btn-primary`: those are sized for
 *  a mouse, and this is the whole screen's worth of target. */
function BigButton({ tone, icon: Icon, label, hint, onClick }: {
  tone: 'neutral' | 'danger'; icon: typeof Siren; label: string; hint: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full min-h-[132px] rounded-2xl border-2 px-6 py-6 text-left
                  transition-colors ${tone === 'danger'
                    ? 'border-rose-600 bg-rose-600 text-white hover:bg-rose-700'
                    : 'border-arctic-200 bg-white text-arctic-900 hover:border-arctic-600'}`}
    >
      <Icon size={34} aria-hidden="true" className="mb-2" />
      <span className="block text-2xl font-extrabold leading-tight">{label}</span>
      <span className={`block text-13 mt-1 ${tone === 'danger'
        ? 'text-rose-100' : 'text-frost-muted'}`}>{hint}</span>
    </button>
  );
}

function Home({ onPick }: { onPick: (s: Screen) => void }) {
  return (
    <div className="space-y-4">
      <BigButton tone="neutral" icon={PackageMinus} label="Log consumption"
                 hint="Record what you have used" onClick={() => onPick('consume')} />
      <BigButton tone="neutral" icon={UserCheck} label="Check in"
                 hint="Tell the station you are back" onClick={() => onPick('checkin')} />
      <BigButton tone="danger" icon={Siren} label="SOS"
                 hint="Hold to raise an emergency at your position"
                 onClick={() => onPick('sos')} />

      <Link href="/" onClick={() => saveConsolePreference('full')}
            className="flex items-center justify-center gap-2 text-13 text-frost-muted
                       py-4 hover:text-arctic-900">
        <ArrowLeft size={14} aria-hidden="true" />
        Full console
      </Link>
    </div>
  );
}

function BackBar({ onDone, title }: { onDone: () => void; title: string }) {
  return (
    <div className="flex items-center gap-3 mb-5">
      <button type="button" onClick={onDone}
              className="btn-secondary !min-h-0 !px-3 !py-2.5 text-13">
        <ArrowLeft size={16} aria-hidden="true" /> Back
      </button>
      <h1 className="text-xl font-extrabold text-arctic-900">{title}</h1>
    </div>
  );
}

// ── 1. Log consumption ─────────────────────────────────────────────────────

function LogConsumption({ stationId, stationLabel, operator, addToast, onDone }: {
  stationId: string; stationLabel: string; operator: FieldOperator;
  addToast: (m: string, t: 'success' | 'warning' | 'alert' | 'info') => void;
  onDone: () => void;
}) {
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [chosen, setChosen] = useState<InventoryItem | null>(null);
  const [amount, setAmount] = useState(0);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.listInventory({ station: stationId }).then(setItems).catch(() => setItems([]));
  }, [stationId]);

  // A sensible step per unit, so a gloved thumb is not tapping +1 for fuel.
  const step = useCallback((item: InventoryItem | null) => {
    const unit = (item?.unit ?? '').toLowerCase();
    if (unit === 'l' || unit === 'kg') return 10;
    return 1;
  }, []);

  const submit = async () => {
    if (!chosen || amount <= 0) return addToast('Choose an item and an amount', 'warning');
    setSaving(true);
    try {
      // Composed into the same plain-language command the desk console
      // uses, so field entries land in the ledger identically — same
      // parser, same reason, same audit line.
      const transcript = `Removed ${amount} ${chosen.unit ?? 'units'} of ${chosen.name}`;
      const result = await api.stockCommand(transcript, stationId, false);
      if (isQueued(result)) {
        addToast('Held on this handset — it will be sent when the link returns.', 'info');
      } else {
        addToast(`${amount} ${chosen.unit ?? ''} of ${chosen.name} logged at ${stationLabel}`
          .replace(/\s+/g, ' '), 'success');
      }
      onDone();
    } catch (e) {
      addToast(e instanceof Error ? e.message : 'Could not log that', 'alert');
    } finally { setSaving(false); }
  };

  if (!chosen) {
    return (
      <div>
        <BackBar onDone={onDone} title="What did you use?" />
        <ul className="space-y-3">
          {items.map((item) => (
            <li key={item.id}>
              <button type="button"
                      onClick={() => { setChosen(item); setAmount(step(item)); }}
                      className="w-full text-left rounded-xl border border-frost-border
                                 bg-white px-5 py-5 hover:border-arctic-600
                                 transition-colors">
                <span className="block text-lg font-bold text-arctic-900">{item.name}</span>
                <span className="block text-13 text-frost-muted">
                  {item.quantity} {item.unit} on the shelf
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  const delta = step(chosen);
  return (
    <div>
      <BackBar onDone={() => setChosen(null)} title={chosen.name} />
      <div className="rounded-2xl border border-frost-border bg-white p-6 text-center">
        <p className="overline">How much did you use?</p>
        <p className="metric text-5xl text-arctic-900 my-5">
          {amount} <span className="text-2xl text-frost-muted">{chosen.unit}</span>
        </p>
        <div className="flex items-center justify-center gap-4">
          <button type="button" aria-label={`Less ${chosen.unit ?? ''}`.trim()}
                  onClick={() => setAmount((a) => Math.max(0, a - delta))}
                  className="w-20 h-20 rounded-2xl border-2 border-arctic-200 bg-white
                             grid place-items-center hover:border-arctic-600">
            <Minus size={30} aria-hidden="true" />
          </button>
          <button type="button" aria-label={`More ${chosen.unit ?? ''}`.trim()}
                  onClick={() => setAmount((a) => a + delta)}
                  className="w-20 h-20 rounded-2xl border-2 border-arctic-200 bg-white
                             grid place-items-center hover:border-arctic-600">
            <Plus size={30} aria-hidden="true" />
          </button>
        </div>
        <p className="text-13 text-frost-muted mt-4">
          Steps of {delta} {chosen.unit}. Recorded against {operator.name}.
        </p>
      </div>

      <button type="button" disabled={saving || amount <= 0} onClick={() => void submit()}
              className="w-full min-h-[76px] mt-5 rounded-2xl bg-arctic-600 text-white
                         text-xl font-extrabold disabled:opacity-40 hover:bg-arctic-700
                         transition-colors">
        {saving ? 'Logging…' : `Log ${amount} ${chosen.unit ?? ''}`.trim()}
      </button>
    </div>
  );
}

// ── 2. Check in ────────────────────────────────────────────────────────────

function CheckIn({ operator, addToast, onDone }: {
  operator: FieldOperator;
  addToast: (m: string, t: 'success' | 'warning' | 'alert' | 'info') => void;
  onDone: () => void;
}) {
  const [saving, setSaving] = useState(false);

  const report = async (status: 'returned' | 'field') => {
    setSaving(true);
    try {
      const result = await api.updatePersonnelStatus(operator.id, status);
      if (isQueued(result)) {
        addToast('Held on this handset — it will be sent when the link returns.', 'info');
      } else {
        addToast(status === 'returned'
          ? `${operator.name} checked in at the station`
          : `${operator.name} reported out in the field`, 'success');
      }
      onDone();
    } catch (e) {
      addToast(e instanceof Error ? e.message : 'Could not report that', 'alert');
    } finally { setSaving(false); }
  };

  return (
    <div>
      <BackBar onDone={onDone} title="Where are you?" />
      <p className="text-15 text-frost-muted mb-5">
        Only people confirmed at the station count as safe in a head-count, so
        this is what closes an incident.
      </p>
      <div className="space-y-4">
        <button type="button" disabled={saving} onClick={() => void report('returned')}
                className="w-full min-h-[110px] rounded-2xl border-2 border-nominal-edge
                           bg-nominal-tint px-6 text-left disabled:opacity-40">
          <Check size={30} aria-hidden="true" className="mb-1 text-nominal" />
          <span className="block text-xl font-extrabold text-arctic-900">
            Back at the station
          </span>
          <span className="block text-13 text-frost-muted">Counts as accounted for</span>
        </button>
        <button type="button" disabled={saving} onClick={() => void report('field')}
                className="w-full min-h-[110px] rounded-2xl border-2 border-alert-edge
                           bg-alert-tint px-6 text-left disabled:opacity-40">
          <CloudSnow size={30} aria-hidden="true" className="mb-1 text-alert" />
          <span className="block text-xl font-extrabold text-arctic-900">
            Still out in the field
          </span>
          <span className="block text-13 text-frost-muted">
            Keeps you on the outstanding list
          </span>
        </button>
      </div>
    </div>
  );
}

// ── 3. SOS ─────────────────────────────────────────────────────────────────

/** How long the SOS button must be held. Long enough that a knock against a
 *  parka cannot raise a station-wide emergency; short enough that somebody
 *  in trouble is not fighting the interface. */
const SOS_HOLD_MS = 1500;

function Sos({ operator, addToast, onDone }: {
  operator: FieldOperator;
  addToast: (m: string, t: 'success' | 'warning' | 'alert' | 'info') => void;
  onDone: () => void;
}) {
  const [held, setHeld] = useState(0);
  const [sending, setSending] = useState(false);

  const fire = useCallback(async () => {
    setSending(true);
    try {
      const result = await api.triggerSOS(operator.id);
      if (isQueued(result)) {
        // The one place this console must not be optimistic.
        addToast('NO LINK — the station has NOT been told. This is held on the handset '
          + 'and will send when the link returns. Raise the alarm by radio now.', 'alert');
      } else {
        addToast(`SOS raised for ${operator.name}. The station has been alerted.`, 'alert');
      }
      onDone();
    } catch (e) {
      addToast(e instanceof Error ? e.message : 'Could not raise the SOS', 'alert');
    } finally { setSending(false); }
  }, [operator, addToast, onDone]);

  useEffect(() => {
    if (held === 0 || sending) return undefined;
    const started = Date.now();
    const tick = window.setInterval(() => {
      if (Date.now() - started >= SOS_HOLD_MS) {
        window.clearInterval(tick);
        void fire();
      }
    }, 50);
    return () => window.clearInterval(tick);
  }, [held, sending, fire]);

  return (
    <div>
      <BackBar onDone={onDone} title="Raise an SOS" />
      <p className="text-15 text-frost-muted mb-5">
        This declares a critical incident at your last known position and counts
        everyone nearby. Hold the button for {SOS_HOLD_MS / 1000} seconds.
      </p>
      <button
        type="button"
        disabled={sending}
        onPointerDown={() => setHeld(Date.now())}
        onPointerUp={() => setHeld(0)}
        onPointerLeave={() => setHeld(0)}
        onPointerCancel={() => setHeld(0)}
        aria-label={`Hold for ${SOS_HOLD_MS / 1000} seconds to raise an SOS for `
          + `${operator.name}`}
        className={`w-full min-h-[220px] rounded-3xl border-4 text-white font-extrabold
                    text-3xl transition-colors ${held
                      ? 'bg-rose-800 border-rose-900' : 'bg-rose-600 border-rose-700'}`}
      >
        {sending ? 'Sending…' : held ? 'Keep holding…' : 'HOLD FOR SOS'}
      </button>
      <p className="text-13 text-frost-muted mt-4 text-center">
        Raised as {operator.name}.
      </p>
    </div>
  );
}
