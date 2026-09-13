'use client';
import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import { useWebSocket } from '@/components/WebSocketProvider';
import { useToast } from '@/components/Toast';

export default function InventoryPage() {
  const { lastMessage } = useWebSocket();
  const { addToast } = useToast();
  const [inventory, setInventory] = useState<any[]>([]);
  const [filter, setFilter] = useState('All');
  const [transcript, setTranscript] = useState('');
  const [selectedItem, setSelectedItem] = useState<any | null>(null);
  const [exactCount, setExactCount] = useState<any | null>(null);
  const [loadingExact, setLoadingExact] = useState(false);

  useEffect(() => {
    loadInventory();
  }, [filter]);

  useEffect(() => {
    if (lastMessage && (lastMessage.type === 'inventory_update' || lastMessage.type === 'blizzard_update')) {
      loadInventory();
    }
  }, [lastMessage]);

  const loadInventory = () => {
    api.listInventory(filter !== 'All' ? { station: filter } : {}).then(data => {
      const items = Array.isArray(data) ? data : [];
      setInventory(items);
      if (selectedItem) {
        const updated = items.find(i => i.id === selectedItem.id);
        if (updated) setSelectedItem(updated);
      }
    });
  };

  const handleVoice = async () => {
    if (!transcript) return;
    try {
      const res = await api.voiceCommand(transcript);
      if (res.applied) {
        addToast(`${res.item_name} updated to ${res.new_quantity}`, 'success');
      } else {
        addToast(res.error || 'Voice command parsed but no item matched', 'warning');
      }
      setTranscript('');
      loadInventory();
    } catch (e) {
      addToast('Voice command failed', 'alert');
    }
  };

  const handleExactCount = async () => {
    setLoadingExact(true);
    try {
      const res = await api.getExactCount('Maitri', 'fuel');
      setExactCount(res);
    } catch (e) {
      addToast('Exact count query failed', 'alert');
    } finally {
      setLoadingExact(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="glass-card p-6">
        <h2 className="text-xl font-bold mb-4 text-white">Voice Command Input</h2>
        <div className="flex gap-4">
          <input
            type="text"
            placeholder="e.g. Removed 4 thermal blankets from Shed 2"
            value={transcript}
            onChange={e => setTranscript(e.target.value)}
          />
          <button className="btn-primary whitespace-nowrap" onClick={handleVoice}>Process</button>
        </div>
      </div>

      <div className="glass-card p-4 flex items-center justify-between">
        <div>
          <h3 className="font-bold text-white">Exact Fuel Count (Maitri)</h3>
          <p className="text-xs text-polar-400 mt-1">Exact SQL count, not vector/RAG approximation</p>
        </div>
        <div className="flex items-center gap-4">
          {exactCount && (
            <span className="font-mono text-lg text-safe font-bold">
              {exactCount.quantity} {exactCount.unit}
            </span>
          )}
          <button className="btn-secondary" onClick={handleExactCount} disabled={loadingExact}>
            {loadingExact ? 'Querying...' : 'Get Exact Count'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className={`glass-card p-6 ${selectedItem ? 'lg:col-span-2' : 'lg:col-span-3'}`}>
          <div className="flex justify-between items-center mb-6">
            <h2 className="text-xl font-bold text-white">Inventory Levels</h2>
            <div className="flex gap-2 bg-polar-900 p-1 rounded-lg">
              {['All', 'Maitri', 'Bharati'].map(s => (
                <button
                  key={s}
                  onClick={() => setFilter(s)}
                  className={`px-4 py-2 rounded-md font-medium transition-colors ${filter === s ? 'bg-polar-700 text-white' : 'text-polar-400 hover:text-white'}`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-polar-700/50 text-polar-400 text-sm">
                  <th className="pb-3 font-medium">Item</th>
                  <th className="pb-3 font-medium">Category</th>
                  <th className="pb-3 font-medium">Station</th>
                  <th className="pb-3 font-medium">Quantity</th>
                  <th className="pb-3 font-medium">Depletion Rate</th>
                  <th className="pb-3 font-medium">Days of Cover</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-polar-800/50">
                {inventory.map(item => (
                  <tr
                    key={item.id}
                    onClick={() => setSelectedItem(item)}
                    className={`hover:bg-polar-800/20 transition-colors cursor-pointer ${selectedItem?.id === item.id ? 'bg-polar-800/40' : ''}`}
                  >
                    <td className="py-4 font-medium text-white">{item.name}</td>
                    <td className="py-4">
                      <span className={`status-badge status-${item.category === 'consumable' ? 'warning' : 'info'}`}>
                        {item.category}
                      </span>
                    </td>
                    <td className="py-4 text-polar-300">{item.station}</td>
                    <td className="py-4 font-mono text-polar-200">{item.quantity} {item.unit}</td>
                    <td className="py-4 font-mono text-polar-400">
                      {typeof item.depletion_rate === 'number' ? `${item.depletion_rate.toFixed(1)} /day` : '-'}
                    </td>
                    <td className="py-4">
                      {typeof item.days_of_cover === 'number' ? (
                        <span className={`font-bold ${item.days_of_cover > 30 ? 'text-safe' : item.days_of_cover > 15 ? 'text-warning' : 'text-danger'}`}>
                          {item.days_of_cover.toFixed(1)} days
                        </span>
                      ) : (
                        <span className="text-polar-500">n/a</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {selectedItem && (
          <div className="glass-card p-6 lg:col-span-1">
            <div className="flex justify-between items-start mb-4">
              <h2 className="text-xl font-bold text-white">Item Detail</h2>
              <button className="text-polar-400 hover:text-white text-sm" onClick={() => setSelectedItem(null)}>Close</button>
            </div>
            <div className="space-y-3 text-sm">
              <div>
                <span className="text-polar-400">Name</span>
                <p className="font-bold text-white text-lg">{selectedItem.name}</p>
              </div>
              <div>
                <span className="text-polar-400">Quantity</span>
                <p className="font-mono text-white">{selectedItem.quantity} {selectedItem.unit}</p>
              </div>
              <div>
                <span className="text-polar-400">Base Burn Rate</span>
                <p className="font-mono text-white">{selectedItem.base_burn_rate ?? 'n/a'} /day</p>
              </div>
              <div>
                <span className="text-polar-400">Beta (β)</span>
                <p className="font-mono text-white">{selectedItem.beta ?? 'n/a'}</p>
              </div>
              <div>
                <span className="text-polar-400">Current ΔT</span>
                <p className="font-mono text-white">{selectedItem.delta_t ?? 0}°C</p>
              </div>
              <div>
                <span className="text-polar-400">Depletion Rate</span>
                <p className="font-mono text-white">
                  {typeof selectedItem.depletion_rate === 'number' ? `${selectedItem.depletion_rate.toFixed(2)} /day` : 'n/a'}
                </p>
              </div>
              <div>
                <span className="text-polar-400">Days of Cover</span>
                <p className={`font-bold text-lg ${selectedItem.days_of_cover > 30 ? 'text-safe' : selectedItem.days_of_cover > 15 ? 'text-warning' : 'text-danger'}`}>
                  {typeof selectedItem.days_of_cover === 'number' ? `${selectedItem.days_of_cover.toFixed(1)} days` : 'n/a'}
                </p>
              </div>
            </div>
            <div className="mt-6 p-4 bg-polar-900/60 rounded-lg border border-polar-700/50">
              <p className="text-xs text-polar-400 mb-2">Depletion Formula</p>
              <code className="text-sm text-polar-200 break-all">
                days_of_cover = quantity / (base_burn_rate * (1 + beta * delta_T))
              </code>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
