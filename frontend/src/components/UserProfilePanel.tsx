import React, { useState, useEffect } from 'react';
import { supabase, getUserProfile, updateUserProfile, getUserFavorites, getCookingHistory } from '../lib/supabase';
import { UserProfile, Favorite, CookingHistoryEntry, Recipe } from '../types';

interface UserProfilePanelProps {
  userId: string;
  userEmail: string;
  recipes: Recipe[];
  isOpen: boolean;
  onClose: () => void;
  onSelectRecipe: (recipe: Recipe) => void;
  onLogout: () => void;
}

const COMMON_ALLERGENS = [
  'Peanuts',
  'Dairy',
  'Egg',
  'Gluten',
  'Soy',
  'Tree Nuts',
  'Fish',
  'Shellfish'
];

export default function UserProfilePanel({
  userId,
  userEmail,
  recipes,
  isOpen,
  onClose,
  onSelectRecipe,
  onLogout
}: UserProfilePanelProps) {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [favorites, setFavorites] = useState<Favorite[]>([]);
  const [history, setHistory] = useState<CookingHistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<'allergies' | 'favorites' | 'history'>('allergies');

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

  const handleAllergyToggle = async (allergen: string) => {
    if (!profile) return;
    
    let nextAllergies = [...profile.allergies];
    if (nextAllergies.includes(allergen)) {
      nextAllergies = nextAllergies.filter(a => a !== allergen);
    } else {
      nextAllergies.push(allergen);
    }

    try {
      await updateUserProfile(userId, nextAllergies, profile.dietary_preferences);
      setProfile({
        ...profile,
        allergies: nextAllergies
      });
    } catch (err) {
      console.error('Failed to update allergies:', err);
      alert('Error updating allergies list.');
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
        className="fixed inset-0 bg-neutral-900/40 z-40 backdrop-blur-[2px]"
        onClick={onClose}
      />

      {/* Sliding Panel */}
      <div className="fixed top-0 right-0 h-full w-full max-w-lg bg-white border-l border-neutral-200 z-50 shadow-2xl transition-transform duration-300 flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-neutral-100 bg-neutral-50/50">
          <div>
            <h2 className="text-xl font-black text-neutral-900">Your Kitchen Profile</h2>
            <p className="text-xs text-neutral-400 font-medium">{userEmail.split('@')[0]}</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onLogout}
              className="text-xs font-bold text-red-500 hover:text-red-600 bg-red-50 hover:bg-red-100 px-3 py-1.5 rounded-lg transition-colors cursor-pointer"
            >
              Sign Out
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-full hover:bg-neutral-100 transition-colors text-neutral-400 hover:text-neutral-600 cursor-pointer"
            >
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className="w-5 h-5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Tab Selection */}
        <div className="flex border-b border-neutral-100 text-sm font-semibold select-none bg-neutral-50/20">
          {(['allergies', 'favorites', 'history'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`flex-1 py-3 text-center border-b-2 transition-all cursor-pointer capitalize ${
                activeTab === tab
                  ? 'border-amber-500 text-amber-600 font-bold bg-white'
                  : 'border-transparent text-neutral-450 hover:text-neutral-700'
              }`}
            >
              {tab === 'allergies' ? '🛡️ Allergies' : tab === 'favorites' ? '❤️ Favorites' : '⏱️ History'}
            </button>
          ))}
        </div>

        {/* Tab Body */}
        <div className="flex-1 overflow-y-auto p-6">
          {loading ? (
            <div className="flex flex-col items-center justify-center h-48 gap-2">
              <div className="w-8 h-8 border-3 border-amber-500 border-t-transparent rounded-full animate-spin" />
              <span className="text-neutral-400 text-xs font-semibold animate-pulse">Loading profile data...</span>
            </div>
          ) : (
            <>
              {/* 1. Allergies Tab */}
              {activeTab === 'allergies' && profile && (
                <div className="space-y-4">
                  <div className="bg-amber-50/60 border border-amber-100 p-4 rounded-2xl">
                    <p className="text-xs text-amber-800 leading-relaxed font-medium">
                      Select any food allergies you have. The voice assistant will automatically check ingredients and warn you during active cooking steps!
                    </p>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    {COMMON_ALLERGENS.map((allergen) => {
                      const isChecked = profile.allergies.includes(allergen);
                      return (
                        <button
                          key={allergen}
                          onClick={() => handleAllergyToggle(allergen)}
                          className={`flex items-center justify-between p-3.5 rounded-2xl border text-sm font-semibold transition-all cursor-pointer ${
                            isChecked
                              ? 'bg-amber-50 border-amber-300 text-amber-900 shadow-sm shadow-amber-100/50'
                              : 'bg-white border-neutral-150 text-neutral-600 hover:border-neutral-200'
                          }`}
                        >
                          <span>{allergen}</span>
                          {isChecked ? (
                            <span className="text-amber-600 text-xs">🛡️</span>
                          ) : (
                            <span className="w-1.5 h-1.5 rounded-full bg-neutral-200" />
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* 2. Favorites Tab */}
              {activeTab === 'favorites' && (
                <div className="space-y-3">
                  {favorites.length === 0 ? (
                    <div className="text-center py-10 bg-neutral-50/50 rounded-2xl border border-neutral-100 border-dashed">
                      <span className="text-3xl block mb-2">❤️</span>
                      <p className="text-neutral-450 text-xs font-semibold">No favorite recipes yet</p>
                      <p className="text-neutral-400 text-[10px] mt-0.5">Click the heart icon on any recipe card to save it here.</p>
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
                          className="flex items-center gap-3 p-3 bg-white border border-neutral-150 hover:border-neutral-300 rounded-2xl transition-all cursor-pointer hover:shadow-sm"
                        >
                          <img
                            src={recipe.image_url || 'https://images.unsplash.com/photo-1495521821757-a1efb6729352?w=600&auto=format&fit=crop&q=60'}
                            alt={recipe.title}
                            className="w-12 h-12 rounded-xl object-cover"
                          />
                          <div className="flex-1 min-w-0">
                            <h4 className="font-bold text-neutral-850 text-sm truncate leading-snug">{recipe.title}</h4>
                            <p className="text-[10px] text-neutral-400 font-semibold uppercase">{recipe.cuisine} • {recipe.time} mins</p>
                          </div>
                          <span className="text-neutral-300 group-hover:text-amber-500 transition-colors">➔</span>
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
                    <div className="text-center py-10 bg-neutral-50/50 rounded-2xl border border-neutral-100 border-dashed">
                      <span className="text-3xl block mb-2">⏱️</span>
                      <p className="text-neutral-450 text-xs font-semibold">No cooking history yet</p>
                      <p className="text-neutral-400 text-[10px] mt-0.5">Your completed meals will appear here as achievements!</p>
                    </div>
                  ) : (
                    history.map((entry) => {
                      const recipe = entry.recipe;
                      if (!recipe) return null;
                      return (
                        <div
                          key={entry.id}
                          className="p-4 bg-white border border-neutral-150 rounded-2xl flex flex-col gap-2 relative shadow-sm"
                        >
                          <div className="flex items-center justify-between gap-3">
                            <h4 className="font-bold text-neutral-850 text-sm line-clamp-1">{recipe.title}</h4>
                            <span className="text-[10px] font-bold bg-neutral-50 border border-neutral-100 text-neutral-500 px-2 py-0.5 rounded-md whitespace-nowrap">
                              {formatRelativeDate(entry.completed_at)}
                            </span>
                          </div>
                          <div className="flex items-center justify-between text-[11px] text-neutral-400 font-semibold pt-1 border-t border-neutral-50">
                            <span>✅ Completed</span>
                            <span className="text-amber-500">{"★".repeat(entry.rating || 5)}</span>
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
