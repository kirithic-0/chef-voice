import React, { useEffect, useState } from 'react';
import { ShoppingListItem } from '../types';
import {
  addShoppingListItem,
  deleteShoppingListItem,
  fetchShoppingList,
  patchShoppingListItem,
} from '../lib/supabase';

interface ShoppingListPanelProps {
  isOpen: boolean;
  onClose: () => void;
  refreshKey?: number;
}

export default function ShoppingListPanel({ isOpen, onClose, refreshKey = 0 }: ShoppingListPanelProps) {
  const [items, setItems] = useState<ShoppingListItem[]>([]);
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const data = await fetchShoppingList();
      setItems(data || []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) load();
  }, [isOpen, refreshKey]);

  if (!isOpen) return null;

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      await addShoppingListItem({ name: name.trim() });
      setName('');
      await load();
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
      <aside
        className="w-full max-w-md h-full bg-[#FDFCF8] shadow-2xl p-6 overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-2xl font-serif font-bold text-[#2C2C24]">Shopping List</h2>
          <button onClick={onClose} className="text-[#78786C] hover:text-[#2C2C24] font-bold">
            Close
          </button>
        </div>

        <form onSubmit={handleAdd} className="flex gap-2 mb-6">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Add an item…"
            className="flex-1 border border-[#E5E2D9] rounded-xl px-3 py-2 text-sm"
          />
          <button type="submit" className="bg-[#5D7052] text-white px-4 py-2 rounded-xl text-sm font-bold">
            Add
          </button>
        </form>

        {loading ? (
          <p className="text-sm text-[#78786C]">Loading…</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-[#78786C]">List is empty. Ask ChefVoice to add eggs, or type above.</p>
        ) : (
          <ul className="space-y-2">
            {items.map((item) => (
              <li key={item.id} className="flex items-center gap-3 bg-white border border-[#E5E2D9] rounded-xl px-3 py-2">
                <input
                  type="checkbox"
                  checked={item.checked}
                  onChange={async () => {
                    await patchShoppingListItem(item.id, { checked: !item.checked });
                    await load();
                  }}
                />
                <span className={`flex-1 text-sm ${item.checked ? 'line-through text-[#A0A096]' : 'text-[#2C2C24]'}`}>
                  {item.quantity ? `${item.quantity} ` : ''}
                  {item.unit ? `${item.unit} ` : ''}
                  {item.name}
                </span>
                <button
                  className="text-xs text-[#A85448] font-bold"
                  onClick={async () => {
                    await deleteShoppingListItem(item.id);
                    await load();
                  }}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>
    </div>
  );
}
