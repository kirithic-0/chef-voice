import React, { useState, useEffect } from 'react';
import { getUserProfile, getUserFavorites, getCookingHistory, updateAdminStatus } from '../lib/api';
import { UserProfile, Favorite, CookingHistoryEntry, Recipe } from '../types';

interface UserProfilePanelProps {
  userId: string;
  userEmail: string;
  recipes: Recipe[];
  isOpen: boolean;
  onClose: () => void;
  onSelectRecipe: (recipe: Recipe) => void;
  onLogout: () => void;
  onProfileUpdate?: () => void;
}



export default function UserProfilePanel({
  userId,
  userEmail,
  recipes,
  isOpen,
  onClose,
  onSelectRecipe,
  onLogout,
  onProfileUpdate
}: UserProfilePanelProps) {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [favorites, setFavorites] = useState<Favorite[]>([]);
  const [history, setHistory] = useState<CookingHistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<'favorites' | 'history'>('favorites');

  useEffect(() => {
    if (isOpen && userId) {
      loadProfileData();
    }
  }, [isOpen, userId]);

  const loadProfileData = async () => {
    setLoading(true);
    try {
      const userProf = await getUserProfile(userId);
      setProfile(userProf);

      const userFavs = await getUserFavorites(userId);
      setFavorites(userFavs);

      const userHist = await getCookingHistory(userId);
      setHistory(userHist);
    } catch (err) {
      console.error('Error loading user profile details:', err);
    } finally {
      setLoading(false);
    }
  };



  const handleAdminToggle = async () => {
    if (!profile) return;
    const nextAdmin = !profile.is_admin;
    try {
      await updateAdminStatus(userId, nextAdmin);
      setProfile({
        ...profile,
        is_admin: nextAdmin
      });
      if (onProfileUpdate) {
        onProfileUpdate();
      }
    } catch (err) {
      console.error('Failed to update admin status:', err);
      alert('Error updating admin status.');
    }
  };

  const formatRelativeDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  };

  if (!isOpen) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-[#2C2C24]/30 z-40 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Sliding Panel */}
      <div className="fixed top-0 right-0 h-full w-full max-w-lg bg-[#FEFEFA] border-l border-[#DED8CF]/50 z-50 shadow-float transition-transform duration-500 flex flex-col font-sans">
        {/* Header */}
        <div className="flex items-center justify-between px-8 py-6 border-b border-[#DED8CF]/30 bg-[#FDFCF8]">
          <div>
            <h2 className="text-2xl font-serif font-bold text-[#2C2C24]">Your Kitchen Profile</h2>
            <p className="text-sm text-[#78786C] font-medium">{userEmail.split('@')[0]}</p>
            {profile && (
              <label className="flex items-center gap-2 mt-3 cursor-pointer select-none">
                <input 
                  type="checkbox" 
                  checked={profile.is_admin || false} 
                  onChange={handleAdminToggle}
                  className="rounded text-[#C18C5D] focus:ring-[#C18C5D]/30 w-4 h-4 cursor-pointer accent-[#C18C5D]"
                />
                <span className="text-[11px] font-bold uppercase tracking-wider text-[#C18C5D]">Admin Mode</span>
              </label>
            )}
          </div>
          <div className="flex items-center gap-4">
            <button
              onClick={onLogout}
              className="text-xs font-bold text-[#A85448] hover:text-white bg-[#A85448]/10 hover:bg-[#A85448] px-4 py-2 rounded-full transition-colors cursor-pointer"
            >
              Sign Out
            </button>
            <button
              onClick={onClose}
              className="p-2 rounded-full hover:bg-[#F0EBE5] transition-colors text-[#78786C] hover:text-[#2C2C24] cursor-pointer"
            >
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className="w-6 h-6">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Tab Selection */}
        <div className="flex border-b border-[#DED8CF]/30 text-sm font-semibold select-none bg-[#F0EBE5]/30">
          {(['favorites', 'history'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`flex-1 py-4 text-center border-b-2 transition-all duration-300 cursor-pointer capitalize ${
                activeTab === tab
                  ? 'border-[#5D7052] text-[#5D7052] font-bold bg-[#FEFEFA]'
                  : 'border-transparent text-[#78786C] hover:text-[#2C2C24]'
              }`}
            >
              {tab}
            </button>
          ))}
        </div>

        {/* Tab Body */}
        <div className="flex-1 overflow-y-auto p-8 relative">
          <div className="absolute top-0 right-0 w-64 h-64 bg-[#C18C5D]/5 blob-3 blur-3xl -z-10" />
          
          {loading ? (
            <div className="flex flex-col items-center justify-center h-48 gap-3">
              <div className="w-8 h-8 border-3 border-[#5D7052] border-t-transparent rounded-full animate-spin" />
              <span className="text-[#78786C] text-sm font-semibold animate-pulse">Loading profile data...</span>
            </div>
          ) : (
            <>


              {/* 2. Favorites Tab */}
              {activeTab === 'favorites' && (
                <div className="space-y-4">
                  {favorites.length === 0 ? (
                    <div className="text-center py-12 bg-[#F0EBE5]/30 rounded-[2rem] border border-[#DED8CF] border-dashed">
                      <p className="text-[#4A4A40] text-sm font-semibold">No favorite recipes yet</p>
                      <p className="text-[#78786C] text-xs mt-1">Click the heart icon on any recipe card to save it here.</p>
                    </div>
                  ) : (
                    favorites.map((fav) => {
                      const recipe = recipes.find(r => r.id === fav.recipe_id);
                      if (!recipe) return null;
                      return (
                        <div
                          key={fav.id}
                          onClick={() => {
                            onSelectRecipe(recipe);
                            onClose();
                          }}
                          className="flex items-center gap-4 p-4 bg-white/60 border border-[#DED8CF]/50 hover:border-[#5D7052]/50 rounded-[2rem] rounded-tl-[1rem] transition-all duration-300 cursor-pointer hover:shadow-soft group"
                        >
                          <img
                            src={recipe.image_url || 'https://images.unsplash.com/photo-1495521821757-a1efb6729352?w=600&auto=format&fit=crop&q=60'}
                            alt={recipe.title}
                            className="w-16 h-16 rounded-[1rem] object-cover group-hover:scale-105 transition-transform duration-500"
                          />
                          <div className="flex-1 min-w-0">
                            <h4 className="font-serif font-bold text-[#2C2C24] text-base truncate">{recipe.title}</h4>
                            <p className="text-xs text-[#78786C] font-semibold uppercase mt-1 tracking-wider">{recipe.cuisine} • {recipe.time} mins</p>
                          </div>
                          <span className="text-[#DED8CF] group-hover:text-[#5D7052] transition-colors pr-2">➔</span>
                        </div>
                      );
                    })
                  )}
                </div>
              )}

              {/* 3. History Tab */}
              {activeTab === 'history' && (
                <div className="space-y-4">
                  {history.length === 0 ? (
                    <div className="text-center py-12 bg-[#F0EBE5]/30 rounded-[2rem] border border-[#DED8CF] border-dashed">
                      <p className="text-[#4A4A40] text-sm font-semibold">No cooking history yet</p>
                      <p className="text-[#78786C] text-xs mt-1">Your completed meals will appear here as achievements!</p>
                    </div>
                  ) : (
                    history.map((entry) => {
                      const recipe = entry.recipe;
                      if (!recipe) return null;
                      return (
                        <div
                          key={entry.id}
                          className="p-5 bg-white/60 border border-[#DED8CF]/50 rounded-[2rem] flex flex-col gap-3 relative shadow-sm"
                        >
                          <div className="flex items-center justify-between gap-3">
                            <h4 className="font-serif font-bold text-[#2C2C24] text-base line-clamp-1">{recipe.title}</h4>
                            <span className="text-[10px] font-bold bg-[#E6DCCD]/30 text-[#4A4A40] px-3 py-1 rounded-full whitespace-nowrap">
                              {formatRelativeDate(entry.completed_at)}
                            </span>
                          </div>
                          <div className="flex items-center justify-between text-xs text-[#78786C] font-semibold pt-3 border-t border-[#DED8CF]/30">
                            <span className="text-[#5D7052]">Completed</span>
                            <span className="text-[#C18C5D]">{"★".repeat(entry.rating || 5)}</span>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
