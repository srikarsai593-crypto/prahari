'use client';

import { useCallback, useEffect, useState } from 'react';
import { ClipboardList, Ship, TriangleAlert } from 'lucide-react';
import { api, isQueued, queuedMessage } from '@/lib/api';
import { useToast } from '@/components/Toast';
import type { PurchaseOrder } from '@/lib/types';

/**
 * What the station has on order, before anything is on a vessel.
 *
 * The cargo board starts at the dock. A station's exposure starts weeks
 * earlier, when someone orders the fuel — so "the tanker has not been
 * ordered yet" and "the tanker is three days out" looked identical from
 * the board: absent. This is that leg.
 *
 * Dispatching an order here creates the consignment below it. The two are
 * one chain, not two lists that happen to name the same cargo.
 */

const STATUS_STYLE: Record<string, string> = {
  ordered: 'bg-frost-subtle border-frost-border text-frost-muted',
  confirmed: 'bg-sky-50 border-sky-200 text-sky-800',
  shipped: 'bg-nominal-tint border-nominal-edge text-nominal',
  cancelled: 'bg-frost-subtle border-frost-border text-frost-muted line-through',
};

const STATUS_HINT: Record<string, string> = {
  ordered: 'Raised with the vendor, not yet acknowledged',
  confirmed: 'Vendor has acknowledged it — ready to dispatch',
  shipped: 'On the cargo board below',
  cancelled: 'Called off',
};

export function ProcurementBoard({ stationId, stationLabel, onDispatched }: {
  stationId: string;
  stationLabel: string;
  /** The cargo board below needs to refetch once an order becomes a crate. */
  onDispatched: () => void;
}) {
  const { addToast } = useToast();
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setOrders(await api.listPurchaseOrders(stationId));
    } catch {
      setOrders([]);
    } finally { setLoading(false); }
  }, [stationId]);

  useEffect(() => { setLoading(true); void load(); }, [load]);

  const confirm = async (order: PurchaseOrder) => {
    setBusy(order.id);
    try {
      const result = await api.updatePurchaseOrder(order.id, { status: 'confirmed' });
      addToast(isQueued(result)
        ? queuedMessage(`Confirmation of ${order.reference}`)
        : `${order.reference} confirmed with ${order.vendor}`,
        isQueued(result) ? 'info' : 'success');
      await load();
    } catch (e) {
      addToast(e instanceof Error ? e.message : 'Could not confirm that order', 'alert');
    } finally { setBusy(null); }
  };

  const dispatch = async (order: PurchaseOrder) => {
    // Shipping weight is the one thing the order does not carry: it is what
    // the vessel is loaded with, not what the crate contains. Asking beats
    // inventing a figure the risk model then scores.
    const entered = window.prompt(
      `Shipping weight for ${order.reference} (${order.item_name}), in kg:`, '1000');
    if (entered === null) return;
    const weight = Number(entered);
    if (!Number.isFinite(weight) || weight <= 0) {
      return addToast('Enter the shipping weight in kilograms', 'warning');
    }

    setBusy(order.id);
    try {
      const result = await api.dispatchPurchaseOrder(order.id, weight);
      if (isQueued(result)) {
        addToast(queuedMessage(`Dispatch of ${order.reference}`), 'info');
      } else {
        addToast(`${order.reference} dispatched as ${result.shipment.barcode_id} — `
          + 'now tracked on the cargo board', 'success');
      }
      await load();
      onDispatched();
    } catch (e) {
      addToast(e instanceof Error ? e.message : 'Could not dispatch that order', 'alert');
    } finally { setBusy(null); }
  };

  const outstanding = orders.filter((o) => o.status !== 'cancelled');
  const slipped = outstanding.filter((o) => o.is_overdue).length;

  return (
    <div className="subview-card rounded-2xl p-6">
      <div className="flex items-start justify-between gap-3 mb-1">
        <h2 className="text-base font-bold text-arctic-900 flex items-center gap-2">
          <ClipboardList size={16} className="text-arctic-600" aria-hidden="true" />
          Inbound Procurement
        </h2>
        {slipped > 0 && (
          <span data-compact
                className="px-2 py-0.5 rounded-full border border-emergency-edge
                           bg-emergency-tint text-emergency text-2xs font-bold shrink-0">
            {slipped} vendor{slipped === 1 ? '' : 's'} late
          </span>
        )}
      </div>
      <p className="text-xs text-frost-muted mb-4">
        What {stationLabel} has on order. Dispatching an order puts a real crate
        on the board below.
      </p>

      {loading ? (
        <p className="text-13 text-frost-muted">Loading…</p>
      ) : outstanding.length === 0 ? (
        <p className="text-13 text-frost-muted">
          Nothing on order for {stationLabel}.
        </p>
      ) : (
        <ul className="divide-y divide-frost-border">
          {outstanding.map((order) => (
            <li key={order.id} className="py-3 first:pt-0 last:pb-0">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-bold text-arctic-900 text-13">
                    {order.item_name}
                    {order.quantity != null && (
                      <span className="font-normal text-frost-muted">
                        {' '}· {order.quantity} {order.unit}
                      </span>
                    )}
                  </p>
                  <p className="text-2xs text-frost-muted">
                    <span className="font-mono">{order.reference}</span> · {order.vendor}
                  </p>
                </div>
                <span data-compact title={STATUS_HINT[order.status]}
                      className={`shrink-0 px-2 py-0.5 rounded-full border text-2xs
                                  font-semibold font-mono ${STATUS_STYLE[order.status]
                                    ?? STATUS_STYLE.ordered}`}>
                  {order.status}
                </span>
              </div>

              {order.is_overdue && order.slip_warning && (
                <p className="text-2xs text-emergency mt-1 flex items-start gap-1">
                  <TriangleAlert size={11} className="shrink-0 mt-0.5" aria-hidden="true" />
                  {order.slip_warning}
                </p>
              )}

              <div className="flex flex-wrap gap-2 mt-2">
                {order.status === 'ordered' && (
                  <button type="button" data-compact disabled={busy === order.id}
                          onClick={() => void confirm(order)}
                          className="btn-secondary !min-h-0 !px-2.5 !py-1 text-2xs">
                    Vendor confirmed
                  </button>
                )}
                {order.status === 'confirmed' && (
                  <button type="button" data-compact disabled={busy === order.id}
                          onClick={() => void dispatch(order)}
                          className="btn-secondary !min-h-0 !px-2.5 !py-1 text-2xs">
                    <Ship size={11} aria-hidden="true" />
                    {busy === order.id ? 'Dispatching…' : 'Dispatch as consignment'}
                  </button>
                )}
                {order.status === 'shipped' && (
                  <span className="text-2xs text-frost-muted">
                    Now tracked on the cargo board.
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
