import React, { useState, useEffect } from 'react';
import { fetchConversations } from '../lib/api';

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
          className="fixed inset-0 bg-[#2C2C24]/30 z-40 backdrop-blur-sm transition-opacity duration-500"
          onClick={onClose}
        />
      )}

      {/* Sliding Panel */}
      <div
        className={`fixed top-0 right-0 h-full w-full max-w-md bg-[#FEFEFA] border-l border-[#DED8CF]/50 z-50 shadow-float transition-transform duration-500 ease-in-out transform ${
          isOpen ? 'translate-x-0' : 'translate-x-full'
        } flex flex-col font-sans`}
      >
        {/* Panel Header */}
        <div className="flex items-center justify-between px-8 py-6 border-b border-[#DED8CF]/30 bg-[#FDFCF8]">
          <h2 className="text-2xl font-serif font-bold text-[#2C2C24]">History</h2>
          <button
            onClick={onClose}
            className="p-2 rounded-full hover:bg-[#F0EBE5] transition-colors text-[#78786C] hover:text-[#2C2C24] cursor-pointer"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={2}
              stroke="currentColor"
              className="w-6 h-6"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Panel Body */}
        <div className="flex-1 overflow-y-auto p-8 space-y-5 relative">
          <div className="absolute top-10 right-0 w-64 h-64 bg-[#5D7052]/5 blob-1 blur-3xl -z-10" />

          {loading ? (
            <div className="flex justify-center py-12">
              <span className="text-[#78786C] text-sm animate-pulse font-semibold">Loading history...</span>
            </div>
          ) : conversations.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-[#78786C] text-sm font-semibold">No saved sessions found.</p>
            </div>
          ) : (
            conversations.map((conv) => {
              const isExpanded = expandedId === conv.id;
              return (
                <div
                  key={conv.id}
                  className={`border border-[#DED8CF]/50 rounded-[2rem] overflow-hidden transition-all duration-300 bg-white/60 ${
                    isExpanded ? 'shadow-soft border-[#5D7052]/30' : 'hover:border-[#5D7052]/30'
                  }`}
                >
                  {/* Card Trigger */}
                  <button
                    onClick={() => toggleExpand(conv.id)}
                    className="w-full text-left px-6 py-5 flex flex-col justify-between items-start gap-2 cursor-pointer focus:outline-none"
                  >
                    <div className="flex justify-between items-start w-full gap-3">
                      <span className="font-serif font-bold text-[#2C2C24] text-base leading-tight line-clamp-1">
                        {conv.title || 'Untitled Session'}
                      </span>
                      <span className="text-[11px] font-bold text-[#78786C] bg-[#F0EBE5] px-3 py-1 rounded-full whitespace-nowrap">
                        {formatRelativeDate(conv.created_at)}
                      </span>
                    </div>
                  </button>

                  {/* Card Inline Expanded Content */}
                  {isExpanded && (
                    <div className="px-6 pb-6 pt-2 border-t border-[#DED8CF]/30 bg-[#FDFCF8]/50">
                      <div className="space-y-4 max-h-60 overflow-y-auto pr-1 mt-2">
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
                                <span className="text-[9px] text-[#78786C] font-bold mb-1 uppercase tracking-wider">
                                  {isMsgUser ? 'You' : 'AI'}
                                </span>
                                <div
                                  className={`rounded-[1.5rem] px-4 py-3 text-[13px] max-w-[85%] leading-relaxed ${
                                    isMsgUser
                                      ? 'bg-[#5D7052] text-[#F3F4F1] rounded-tr-sm shadow-soft'
                                      : 'bg-[#F0EBE5] text-[#2C2C24] rounded-tl-sm shadow-sm'
                                  }`}
                                >
                                  {msg.text}
                                </div>
                              </div>
                            );
                          })
                        ) : (
                          <p className="text-sm text-[#78786C] italic">No messages in this session.</p>
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
