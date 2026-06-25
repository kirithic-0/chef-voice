import React, { useState, useEffect } from 'react';
import { fetchConversations } from '../lib/supabase';

interface HistoryPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

interface Conversation {
  id: string;
  title: string;
  messages: Array<{ role: string; text: string }>;
  created_at: string;
}

export default function HistoryPanel({ isOpen, onClose }: HistoryPanelProps) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      loadHistory();
    }
  }, [isOpen]);

  const loadHistory = async () => {
    setLoading(true);
    try {
      const data = await fetchConversations();
      setConversations(data);
    } catch (err) {
      console.error("Error loading conversations history:", err);
    } finally {
      setLoading(false);
    }
  };

  const toggleExpand = (id: string) => {
    setExpandedId(expandedId === id ? null : id);
  };

  const formatRelativeDate = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };

  return (
    <>
      {/* Backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-neutral-900/10 z-40 backdrop-blur-[1px] transition-opacity duration-300"
          onClick={onClose}
        />
      )}

      {/* Sliding Panel */}
      <div
        className={`fixed top-0 right-0 h-full w-full max-w-md bg-white border-l border-neutral-200 z-50 shadow-2xl transition-transform duration-300 ease-in-out transform ${
          isOpen ? 'translate-x-0' : 'translate-x-full'
        } flex flex-col`}
      >
        {/* Panel Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-neutral-100">
          <h2 className="text-lg font-semibold text-neutral-800">History</h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-full hover:bg-neutral-100 transition-colors text-neutral-400 hover:text-neutral-600 cursor-pointer"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={2}
              stroke="currentColor"
              className="w-5 h-5"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Panel Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {loading ? (
            <div className="flex justify-center py-10">
              <span className="text-neutral-400 text-sm animate-pulse font-light">Loading history...</span>
            </div>
          ) : conversations.length === 0 ? (
            <div className="text-center py-10">
              <p className="text-neutral-400 text-sm font-light">No saved sessions found.</p>
            </div>
          ) : (
            conversations.map((conv) => {
              const isExpanded = expandedId === conv.id;
              return (
                <div
                  key={conv.id}
                  className={`border border-neutral-200 rounded-xl overflow-hidden transition-all duration-200 bg-white ${
                    isExpanded ? 'shadow-sm border-neutral-300' : 'hover:border-neutral-300'
                  }`}
                >
                  {/* Card Trigger */}
                  <button
                    onClick={() => toggleExpand(conv.id)}
                    className="w-full text-left px-5 py-4 flex flex-col justify-between items-start gap-1 cursor-pointer focus:outline-none"
                  >
                    <div className="flex justify-between items-start w-full gap-2">
                      <span className="font-medium text-neutral-800 text-[14px] leading-tight line-clamp-1">
                        {conv.title || 'Untitled Session'}
                      </span>
                      <span className="text-[11px] text-neutral-400 whitespace-nowrap">
                        {formatRelativeDate(conv.created_at)}
                      </span>
                    </div>
                  </button>

                  {/* Card Inline Expanded Content */}
                  {isExpanded && (
                    <div className="px-5 pb-5 pt-1 border-t border-neutral-100 bg-neutral-50/30">
                      <div className="space-y-3 max-h-60 overflow-y-auto pr-1">
                        {conv.messages && conv.messages.length > 0 ? (
                          conv.messages.map((msg, index) => {
                            const isMsgUser = msg.role === 'user' || msg.role === 'client';
                            return (
                              <div
                                key={index}
                                className={`flex flex-col ${
                                  isMsgUser ? 'items-end' : 'items-start'
                                }`}
                              >
                                <span className="text-[9px] text-neutral-400 font-semibold mb-0.5 uppercase tracking-wider">
                                  {isMsgUser ? 'You' : 'AI'}
                                </span>
                                <div
                                  className={`rounded-lg px-3 py-2 text-[12px] max-w-[85%] leading-relaxed ${
                                    isMsgUser
                                      ? 'bg-neutral-800 text-white rounded-tr-none'
                                      : 'bg-neutral-200/50 text-neutral-800 rounded-tl-none'
                                  }`}
                                >
                                  {msg.text}
                                </div>
                              </div>
                            );
                          })
                        ) : (
                          <p className="text-xs text-neutral-400 italic">No messages in this session.</p>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </>
  );
}
