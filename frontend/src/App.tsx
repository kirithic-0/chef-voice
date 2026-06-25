import React, { useState, useEffect } from 'react';
import { useVoiceChat } from './hooks/useVoiceChat';
import { useCookingTimers } from './hooks/useCookingTimers';
import { 
  fetchRecipes, 
  searchRecipes,
  saveConversation, 
  supabase, 
  getUserProfile, 
  getUserFavorites, 
  addFavorite, 
  removeFavorite,
  getCookingHistory,
  addCookingHistory 
} from './lib/supabase';
import RecipeCard from './components/RecipeCard';
import Waveform from './components/Waveform';
import TimerWidget from './components/TimerWidget';
import Auth from './components/Auth';
import UserProfilePanel from './components/UserProfilePanel';
import HistoryPanel from './components/HistoryPanel';
import ChatArea from './components/ChatArea';
import { Recipe, UserProfile, Favorite, CookingHistoryEntry } from './types';
import { Session } from '@supabase/supabase-js';

export default function App() {
  // Cooking state hooks
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [searchResults, setSearchResults] = useState<Recipe[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<'home' | 'detail' | 'cooking'>('home');
  const [selectedRecipe, setSelectedRecipe] = useState<Recipe | null>(null);
  const [currentStep, setCurrentStep] = useState(0);
  const [ingredientsChecked, setIngredientsChecked] = useState<Record<string, boolean>>({});
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCuisine, setSelectedCuisine] = useState('All');
  
  // Advanced AI search toggle
  const [useSemanticSearch, setUseSemanticSearch] = useState(false);

  // Authentication & Profile states
  const [session, setSession] = useState<Session | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [favorites, setFavorites] = useState<Favorite[]>([]);
  
  // Cooking history and sorting states
  const [cookingHistory, setCookingHistory] = useState<CookingHistoryEntry[]>([]);
  const [sortBy, setSortBy] = useState<'default' | 'recent' | 'time'>('default');
  const [showCompletionModal, setShowCompletionModal] = useState(false);
  const [completionRating, setCompletionRating] = useState<number>(5);
  
  // Modals / Panels
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [showProfilePanel, setShowProfilePanel] = useState(false);
  const [showHistoryPanel, setShowHistoryPanel] = useState(false);

  // Text chat input
  const [textInput, setTextInput] = useState('');

  // Load custom hooks
  const timers = useCookingTimers();
  const voice = useVoiceChat();

  // Fetch recipes from Supabase when authenticated
  useEffect(() => {
    async function loadData() {
      if (!session) return;
      try {
        setLoading(true);
        const data = await fetchRecipes();
        setRecipes(data);
      } catch (err) {
        console.error('Failed to load recipes:', err);
      } finally {
        setLoading(false);
      }
    }
    loadData();
  }, [session]);

  // Monitor Supabase Auth state change
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session: currentSession } }) => {
      setSession(currentSession);
      if (currentSession?.user) {
        loadUserProfile(currentSession.user.id);
      }
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, currentSession) => {
      setSession(currentSession);
      if (currentSession?.user) {
        loadUserProfile(currentSession.user.id);
      } else {
        setUserProfile(null);
        setFavorites([]);
        setCookingHistory([]);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  const loadUserProfile = async (uid: string) => {
    try {
      const prof = await getUserProfile(uid);
      setUserProfile(prof);
      const favs = await getUserFavorites(uid);
      setFavorites(favs);
      const hist = await getCookingHistory(uid);
      setCookingHistory(hist);
    } catch (e) {
      console.error("Failed to load user profile", e);
    }
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    setShowProfilePanel(false);
    setUserProfile(null);
    setFavorites([]);
    setCookingHistory([]);
  };

  const handleFavoriteToggle = async (e: React.MouseEvent, recipeId: string) => {
    e.stopPropagation();
    if (!session?.user) {
      setShowAuthModal(true);
      return;
    }

    const isFav = favorites.some(f => f.recipe_id === recipeId);
    try {
      if (isFav) {
        await removeFavorite(session.user.id, recipeId);
        setFavorites(prev => prev.filter(f => f.recipe_id !== recipeId));
      } else {
        const added = await addFavorite(session.user.id, recipeId);
        setFavorites(prev => [...prev, added]);
      }
    } catch (err) {
      console.error("Failed to toggle favorite:", err);
    }
  };

  // Perform Semantic Vector Search via Backend
  useEffect(() => {
    if (!useSemanticSearch || !searchQuery.trim()) {
      setSearchResults([]);
      return;
    }

    const delayDebounce = setTimeout(async () => {
      try {
        const results = await searchRecipes(searchQuery);
        setSearchResults(results);
      } catch (err) {
        console.error("Semantic search failed:", err);
      }
    }, 400);

    return () => clearTimeout(delayDebounce);
  }, [searchQuery, useSemanticSearch]);

  // Filter recipes based on category and search query (fallback to local if not semantic)
  const displayRecipes = useSemanticSearch && searchQuery.trim() !== ''
    ? searchResults
    : recipes.filter((r) => {
        const matchesCuisine = selectedCuisine === 'All' || r.cuisine === selectedCuisine;
        const matchesSearch = 
          r.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
          r.cuisine.toLowerCase().includes(searchQuery.toLowerCase()) ||
          r.ingredients.some(i => i.name.toLowerCase().includes(searchQuery.toLowerCase()));
        return matchesCuisine && matchesSearch;
      });

  // Sort recipes based on sortBy state
  const sortedRecipes = React.useMemo(() => {
    if (sortBy === 'recent') {
      const completionMap: Record<string, string> = {};
      cookingHistory.forEach(entry => {
        if (!completionMap[entry.recipe_id]) {
          completionMap[entry.recipe_id] = entry.completed_at;
        }
      });

      return [...displayRecipes].sort((a, b) => {
        const dateA = completionMap[a.id];
        const dateB = completionMap[b.id];

        if (dateA && dateB) {
          return new Date(dateB).getTime() - new Date(dateA).getTime();
        }
        if (dateA) return -1;
        if (dateB) return 1;
        return 0;
      });
    }

    if (sortBy === 'time') {
      return [...displayRecipes].sort((a, b) => a.time - b.time);
    }

    return displayRecipes;
  }, [displayRecipes, sortBy, cookingHistory]);

  // Sync cooking state to backend WebSocket
  useEffect(() => {
    voice.sendStateUpdate({
      screen: view,
      recipe: selectedRecipe,
      current_step: currentStep,
      timers: timers.timers,
      tts_mode: voice.ttsMode,
      allergies: userProfile?.allergies || [],
      dietary_preferences: userProfile?.dietary_preferences || []
    });
  }, [view, selectedRecipe, currentStep, timers.timers, voice.ttsMode, userProfile]);

  // Local Web Speech synthesis for UI-triggered reading
  const speakLocal = (text: string) => {
    if (!window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    const voices = window.speechSynthesis.getVoices();
    const voiceObj = voices.find(v => v.lang.startsWith('en') && v.name.includes('Google')) || 
                     voices.find(v => v.lang.startsWith('en')) || 
                     null;
    if (voiceObj) utterance.voice = voiceObj;
    window.speechSynthesis.speak(utterance);
  };

  // Handle voice actions received from LLM
  useEffect(() => {
    if (!voice.latestAction) return;

    const { type, params } = voice.latestAction;
    console.log(`Executing Voice Action: ${type}`, params);

    switch (type) {
      case 'next_step':
        if (view === 'cooking') handleNextStep();
        break;
      case 'prev_step':
        if (view === 'cooking') handlePrevStep();
        break;
      case 'repeat_step':
        if (view === 'cooking') handleRepeatStep();
        break;
      case 'set_timer':
        if (view === 'cooking' && params?.duration) {
          timers.addTimer(params.duration, params.label || 'Cooking Timer');
        }
        break;
      case 'cancel_timer':
        if (view === 'cooking' && params?.label) {
          const match = timers.timers.find(t => t.label.toLowerCase().includes(params.label!.toLowerCase()));
          if (match) timers.removeTimer(match.id);
        }
        break;
      case 'search_recipes':
        if (view !== 'cooking' && params?.query) {
          setSearchQuery(params.query);
          setUseSemanticSearch(true);
          setSelectedCuisine('All');
          setView('home');
        }
        break;
      case 'select_recipe':
        if (view !== 'cooking' && params?.id) {
          const found = recipes.find(
            r => r.id === params.id || r.title.toLowerCase().includes(params.id!.toLowerCase())
          );
          if (found) {
            handleSelectRecipe(found);
          }
        }
        break;
      case 'start_cooking':
        if (view !== 'cooking') handleStartCooking();
        break;
      default:
        break;
    }

    voice.setLatestAction(null);
  }, [voice.latestAction, view, selectedRecipe, currentStep, recipes, timers.timers]);

  // Navigation handlers
  const handleSelectRecipe = (recipe: Recipe) => {
    setSelectedRecipe(recipe);
    setCurrentStep(0);
    const checks: Record<string, boolean> = {};
    recipe.ingredients.forEach(i => {
      checks[i.name] = false;
    });
    setIngredientsChecked(checks);
    setView('detail');
  };

  const handleStartCooking = () => {
    setView('cooking');
    setCurrentStep(0);
    
    // Auto-read first step
    if (selectedRecipe && selectedRecipe.steps.length > 0) {
      setTimeout(() => {
        const text = `Let's start cooking ${selectedRecipe.title}. Step 1: ${selectedRecipe.steps[0].text}`;
        
        // Allergen warnings check on start
        const allergensInRecipe = selectedRecipe.ingredients.filter(ing => 
          userProfile?.allergies.some(all => ing.name.toLowerCase().includes(all.toLowerCase()))
        );
        let warnText = '';
        if (allergensInRecipe.length > 0) {
          warnText = ` Warning: This recipe contains allergen items: ${allergensInRecipe.map(i => i.name).join(', ')}.`;
        }

        if (voice.ttsMode === 'web_speech') {
          speakLocal(text + warnText);
        }
      }, 500);
    }

    // Auto-start recording mic
    if (voice.status === 'idle') {
      voice.start({
        screen: 'cooking',
        recipe: selectedRecipe,
        current_step: 0,
        timers: timers.timers,
        allergies: userProfile?.allergies || []
      }).catch((err) => console.error('Failed to start voice chat:', err));
    }
  };

  const handleNextStep = () => {
    if (!selectedRecipe) return;
    if (currentStep < selectedRecipe.steps.length - 1) {
      const nextIdx = currentStep + 1;
      setCurrentStep(nextIdx);
      const stepText = selectedRecipe.steps[nextIdx].text;
      if (voice.status === 'idle') {
        speakLocal(`Step ${nextIdx + 1}: ${stepText}`);
      }
    } else {
      // Show manual submission rating modal
      setCompletionRating(5);
      setShowCompletionModal(true);
      const finishText = `Congratulations! You have completed the recipe for ${selectedRecipe.title}. Please submit your rating.`;
      if (voice.status === 'idle') {
        speakLocal(finishText);
      }
    }
  };

  const handlePrevStep = () => {
    if (!selectedRecipe) return;
    if (currentStep > 0) {
      const prevIdx = currentStep - 1;
      setCurrentStep(prevIdx);
      const stepText = selectedRecipe.steps[prevIdx].text;
      if (voice.status === 'idle') {
        speakLocal(`Step ${prevIdx + 1}: ${stepText}`);
      }
    }
  };

  const handleRepeatStep = () => {
    if (!selectedRecipe) return;
    const stepText = selectedRecipe.steps[currentStep].text;
    if (voice.status === 'idle') {
      speakLocal(`Step ${currentStep + 1}: ${stepText}`);
    } else {
      voice.sendStateUpdate({ trigger_read: true });
    }
  };

  const toggleIngredient = (name: string) => {
    setIngredientsChecked(prev => ({
      ...prev,
      [name]: !prev[name]
    }));
  };

  const selectRandomRecipe = () => {
    if (recipes.length === 0) return;
    const randIdx = Math.floor(Math.random() * recipes.length);
    handleSelectRecipe(recipes[randIdx]);
  };

  const toggleTtsMode = () => {
    voice.setTtsMode(prev => prev === 'web_speech' ? 'elevenlabs' : 'web_speech');
  };

  const handleTextSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!textInput.trim()) return;
    voice.sendTextMessage(textInput.trim());
    setTextInput('');
  };

  if (!session) {
    return (
      <div className="min-h-screen bg-neutral-950 flex flex-col items-center justify-center p-4 selection:bg-amber-100 selection:text-amber-900">
        <div className="text-center mb-8 space-y-2">
          <span className="text-5xl block animate-bounce">🧑‍🍳</span>
          <h1 className="text-3xl font-black text-white tracking-tight">ChefVoice</h1>
          <p className="text-neutral-400 text-sm font-light">Your hands-free AI-powered kitchen voice assistant</p>
        </div>
        <Auth 
          onAuthSuccess={() => {
            // session state will update via listener
          }} 
        />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900 flex flex-col font-sans antialiased selection:bg-amber-100 selection:text-amber-900">
      {/* Header */}
      {view !== 'cooking' && (
        <header className="bg-white border-b border-neutral-100 py-4 px-6 sticky top-0 z-40 flex items-center justify-between shadow-sm">
          <div className="flex items-center gap-3 cursor-pointer" onClick={() => setView('home')}>
            <span className="text-2xl animate-spin duration-1000">🧑‍🍳</span>
            <span className="font-extrabold text-xl tracking-tight bg-gradient-to-r from-amber-600 to-orange-500 bg-clip-text text-transparent">
              ChefVoice
            </span>
          </div>

          <div className="flex items-center gap-3">
            {/* History Trigger */}
            <button
              onClick={() => setShowHistoryPanel(true)}
              className="text-sm font-semibold text-neutral-600 hover:text-neutral-950 px-3 py-2 rounded-xl transition-colors cursor-pointer"
            >
              📜 Saved Logs
            </button>

            {/* Auth Trigger / Profile Trigger */}
            {session ? (
              <button
                onClick={() => setShowProfilePanel(true)}
                className="bg-amber-50 border border-amber-100 hover:border-amber-200 text-amber-700 text-sm font-bold px-4 py-2 rounded-xl transition-all cursor-pointer flex items-center gap-1.5"
              >
                <span>🛡️</span> My Profile
              </button>
            ) : (
              <button
                onClick={() => setShowAuthModal(true)}
                className="bg-neutral-900 hover:bg-neutral-800 text-white text-sm font-bold px-4 py-2 rounded-xl transition-all cursor-pointer active:scale-95 shadow-sm"
              >
                Sign In
              </button>
            )}
          </div>
        </header>
      )}

      {/* Main Container */}
      <main className="flex-1 flex flex-col">
        {loading ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="w-10 h-10 border-4 border-amber-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : view === 'home' ? (
          /* Home Screen view */
          <div className="max-w-7xl w-full mx-auto px-6 py-8 flex-1 flex flex-col gap-8">
            {/* Welcome banner */}
            <div className="bg-gradient-to-br from-neutral-900 to-neutral-800 rounded-3xl p-8 md:p-12 text-white shadow-xl flex flex-col md:flex-row items-center justify-between gap-6 relative overflow-hidden">
              <div className="absolute -right-10 -bottom-10 text-9xl opacity-10 pointer-events-none select-none">🍳</div>
              <div className="space-y-3 z-10 max-w-lg">
                <h1 className="text-3xl md:text-4xl font-black leading-tight">
                  Cook Hands-Free with Voice Commands
                </h1>
                <p className="text-neutral-300 text-sm md:text-base font-light">
                  Select a recipe, place your phone on the counter, and just say <strong className="text-amber-400">"next"</strong>, <strong className="text-amber-400">"go back"</strong>, or ask <strong className="text-amber-400">"what substitute can I use?"</strong>
                </p>
              </div>
              <div className="flex flex-col sm:flex-row gap-3 w-full md:w-auto z-10">
                <button
                  onClick={selectRandomRecipe}
                  className="bg-amber-500 hover:bg-amber-600 text-white font-bold px-6 py-3.5 rounded-2xl transition-colors shadow-lg shadow-amber-500/20 active:scale-95 text-sm cursor-pointer"
                >
                  🎲 Surprise Me!
                </button>
              </div>
            </div>

            {/* Main Flex Columns Layout */}
            <div className="flex flex-col lg:flex-row gap-8 items-start w-full">
              
              {/* Left Side: Search, Filters and Recipe Grid */}
              <div className="flex-1 flex flex-col gap-6 w-full min-w-0">
                
                {/* Filters Row */}
                <div className="flex flex-col gap-4">
                  
                  {/* Top Row: Explore Recipes Title & Search Controls */}
                  <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 w-full">
                    <h2 className="text-xl font-bold text-neutral-850">Explore Recipes</h2>

                    <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 max-w-lg w-full md:w-auto shrink-0">
                      {/* AI Semantic Toggle */}
                      <button
                        onClick={() => setUseSemanticSearch(prev => !prev)}
                        className={`text-xs font-bold px-4 py-3 rounded-2xl border transition-all cursor-pointer whitespace-nowrap flex items-center justify-center gap-1.5 ${
                          useSemanticSearch 
                            ? 'bg-amber-50 border-amber-300 text-amber-700 font-bold shadow-sm' 
                            : 'bg-white border-neutral-200 text-neutral-500 hover:border-neutral-300'
                        }`}
                        title="Search recipes semantically using AI embeddings"
                      >
                        ✨ AI Semantic Search
                      </button>

                      <div className="relative flex-1 md:w-64">
                        <input
                          type="text"
                          placeholder={useSemanticSearch ? "Type e.g., 'sweet dairy-free treat'..." : "Search by name or ingredients..."}
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                          className="w-full bg-white border border-neutral-200 rounded-2xl py-3 pl-11 pr-4 text-sm font-medium focus:outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-100 transition-all shadow-sm"
                        />
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4 text-neutral-400 absolute left-4 top-3.5">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                        </svg>
                      </div>
                    </div>
                  </div>

                  {/* Bottom Row: Cuisine Filter Tags spanning full width */}
                  <div className="flex items-center gap-2 overflow-x-auto pb-2 scrollbar-none w-full">
                    {['All', 'Indian', 'Italian', 'Quick Meals', 'Healthy', 'Desserts'].map(cuisine => (
                      <button
                        key={cuisine}
                        onClick={() => {
                          setSelectedCuisine(cuisine);
                          setUseSemanticSearch(false); // disable semantic when clicking cuisines
                        }}
                        className={`px-4 py-2 rounded-full text-xs font-bold whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
                          !useSemanticSearch && selectedCuisine === cuisine 
                            ? 'bg-amber-500 text-white shadow-sm' 
                            : 'bg-white text-neutral-600 border border-neutral-100 hover:border-neutral-200'
                        }`}
                      >
                        {cuisine}
                      </button>
                    ))}
                  </div>

                </div>

                {/* Recipes Grid */}
                {displayRecipes.length === 0 ? (
                  <div className="text-center py-20 bg-white border border-neutral-100 rounded-3xl">
                    <span className="text-4xl block mb-3">🔍</span>
                    <h3 className="font-bold text-neutral-800 text-lg">No recipes found</h3>
                    <p className="text-neutral-450 text-sm mt-1">Try other search terms or toggle semantic search mode off.</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-6">
                    {displayRecipes.map((recipe) => {
                      const historyEntries = cookingHistory.filter(h => h.recipe_id === recipe.id);
                      let cookedDateStr = undefined;
                      if (historyEntries.length > 0) {
                        const latest = historyEntries.reduce((latest, current) => {
                          return new Date(current.completed_at) > new Date(latest.completed_at) ? current : latest;
                        }, historyEntries[0]);
                        const date = new Date(latest.completed_at);
                        cookedDateStr = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
                      }

                      return (
                        <RecipeCard 
                          key={recipe.id} 
                          recipe={recipe} 
                          onClick={() => handleSelectRecipe(recipe)}
                          isFavorite={favorites.some(f => f.recipe_id === recipe.id)}
                          onFavoriteToggle={(e) => handleFavoriteToggle(e, recipe.id)}
                          cookedDate={cookedDateStr}
                        />
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Right Side: Recently Made Sidebar */}
              <div className="w-full lg:w-80 shrink-0 bg-white border border-neutral-100 rounded-3xl p-6 shadow-sm flex flex-col gap-4 self-stretch lg:self-auto">
                <div className="flex items-center justify-between border-b border-neutral-100 pb-3">
                  <h3 className="font-extrabold text-neutral-900 text-sm flex items-center gap-1.5">
                    <span>⏱️</span> Recently Made
                  </h3>
                  <span className="text-[9px] font-bold text-neutral-400 bg-neutral-50 border border-neutral-100 px-2 py-0.5 rounded-full uppercase tracking-wider">
                    Recent Logs
                  </span>
                </div>

                {cookingHistory.length === 0 ? (
                  <div className="text-center py-10 bg-neutral-50/50 rounded-2xl border border-neutral-100 border-dashed my-2">
                    <span className="text-3xl block mb-2">🧑‍🍳</span>
                    <p className="text-neutral-550 text-xs font-bold text-neutral-700">No cooked meals yet</p>
                    <p className="text-neutral-400 text-[10px] mt-1 px-4 leading-relaxed">
                      Complete a recipe in voice guided mode to log your achievements here!
                    </p>
                  </div>
                ) : (
                  <div className="flex flex-col gap-3.5 overflow-y-auto max-h-[500px] pr-1">
                    {cookingHistory.slice(0, 6).map((entry) => {
                      const recipe = recipes.find(r => r.id === entry.recipe_id);
                      if (!recipe) return null;
                      const date = new Date(entry.completed_at);
                      const relativeDate = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

                      return (
                        <div
                          key={entry.id}
                          onClick={() => handleSelectRecipe(recipe)}
                          className="group flex items-center gap-3 p-2 hover:bg-neutral-50/80 rounded-2xl transition-all cursor-pointer border border-transparent hover:border-neutral-100/50"
                        >
                          <div className="w-11 h-11 rounded-xl overflow-hidden bg-neutral-150 shrink-0 shadow-inner">
                            <img
                              src={recipe.image_url || 'https://images.unsplash.com/photo-1495521821757-a1efb6729352?w=600&auto=format&fit=crop&q=60'}
                              alt={recipe.title}
                              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                            />
                          </div>

                          <div className="flex-1 min-w-0">
                            <h4 className="font-extrabold text-neutral-850 text-xs truncate leading-snug group-hover:text-amber-600 transition-colors">
                              {recipe.title}
                            </h4>
                            <div className="flex items-center gap-1.5 mt-0.5 text-[9px] text-neutral-400 font-bold uppercase tracking-wide">
                              <span>{recipe.cuisine}</span>
                              <span className="text-neutral-350">•</span>
                              <span className="text-emerald-600">{relativeDate}</span>
                            </div>
                            <div className="flex items-center gap-0.5 mt-1 text-[9px] text-amber-500">
                              {"★".repeat(entry.rating || 5)}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : view === 'detail' ? (
          /* Recipe Detail Screen */
          <div className="max-w-4xl w-full mx-auto px-6 py-8 flex-1 flex flex-col gap-6">
            <button 
              onClick={() => setView('home')}
              className="flex items-center gap-1.5 text-sm font-bold text-neutral-550 hover:text-neutral-900 transition-colors w-max cursor-pointer"
            >
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className="w-4 h-4">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
              </svg>
              Back to recipes
            </button>

            {/* Detail Card */}
            {selectedRecipe && (
              <>
                <div className="bg-white border border-neutral-100 rounded-3xl overflow-hidden shadow-sm flex flex-col md:flex-row gap-8 p-6 md:p-8 relative">
                  <div className="w-full md:w-5/12 aspect-[4/3] md:aspect-square bg-neutral-100 rounded-2xl overflow-hidden shadow-inner">
                    <img 
                      src={selectedRecipe.image_url || 'https://images.unsplash.com/photo-1495521821757-a1efb6729352?w=600&auto=format&fit=crop&q=60'} 
                      alt={selectedRecipe.title}
                      className="w-full h-full object-cover"
                    />
                  </div>

                  <div className="flex-1 flex flex-col justify-between">
                    <div>
                      <div className="flex items-center gap-2 mb-2">
                        <span className="bg-neutral-100 text-neutral-700 text-xs font-bold px-2.5 py-1 rounded-full uppercase tracking-wider">
                          {selectedRecipe.cuisine}
                        </span>
                        {selectedRecipe.dietary?.map(d => (
                          <span key={d} className="bg-emerald-50 text-emerald-700 text-xs font-semibold px-2.5 py-1 rounded-full">
                            {d}
                          </span>
                        ))}
                      </div>

                      <h1 className="text-3xl font-black text-neutral-900 mb-3">{selectedRecipe.title}</h1>
                      
                      <div className="flex items-center gap-5 text-sm text-neutral-500 font-medium mb-6">
                        <span className="flex items-center gap-1.5">⏱️ {selectedRecipe.time} minutes</span>
                        <span className="flex items-center gap-1.5">🍽️ {selectedRecipe.servings} servings</span>
                        <span className="flex items-center gap-1.5">📈 {selectedRecipe.difficulty}</span>
                      </div>
                    </div>

                    <button
                      onClick={handleStartCooking}
                      className="w-full bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-white font-bold py-4 rounded-2xl shadow-lg shadow-orange-500/10 active:scale-[0.99] transition-all flex items-center justify-center gap-2 cursor-pointer text-base"
                    >
                      <span>🧑‍🍳</span> Start Cooking (Voice Guided)
                    </button>
                  </div>
                </div>

                {/* Ingredients checklist */}
                <div className="bg-white border border-neutral-100 rounded-3xl p-6 md:p-8 shadow-sm">
                  <h2 className="text-lg font-bold text-neutral-900 mb-4 flex items-center justify-between">
                    <span>Ingredients Checklists</span>
                    <span className="text-xs font-semibold text-neutral-400">Tap to cross off</span>
                  </h2>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    {selectedRecipe.ingredients.map((ing) => (
                      <label 
                        key={ing.name}
                        className={`flex items-start gap-3 p-3.5 rounded-2xl border transition-all cursor-pointer ${
                          ingredientsChecked[ing.name]
                            ? 'bg-neutral-50/50 border-neutral-100 text-neutral-400 line-through'
                            : 'bg-white border-neutral-150 text-neutral-800 hover:border-neutral-200'
                        }`}
                      >
                        <input 
                          type="checkbox"
                          checked={ingredientsChecked[ing.name] || false}
                          onChange={() => toggleIngredient(ing.name)}
                          className="mt-1 rounded text-amber-500 focus:ring-amber-500 w-4 h-4 cursor-pointer"
                        />
                        <div className="text-sm font-medium">
                          <span>{ing.amount} {ing.unit}</span> <strong className="text-neutral-700 font-semibold">{ing.name}</strong>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        ) : (
          /* Cooking Mode: Clean, Dark, Large Text Kitchen Dashboard */
          selectedRecipe && (
            <div className="h-screen bg-neutral-950 text-white flex flex-col overflow-hidden relative">
              {/* Header controls bar */}
              <div className="flex items-center justify-between py-4 px-6 border-b border-neutral-900 z-10 bg-neutral-950/80 backdrop-blur-md">
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => {
                      timers.clearAllTimers();
                      voice.stop();
                      setView('detail');
                    }}
                    className="text-neutral-400 hover:text-white p-2 rounded-xl hover:bg-neutral-900 transition-colors cursor-pointer text-sm font-semibold"
                  >
                    ✕ Close Mode
                  </button>
                </div>

                <div className="flex items-center gap-4">
                  {/* Voice Premium toggle switch */}
                  <div className="flex items-center gap-2 bg-neutral-900 border border-neutral-800 rounded-full px-3 py-1.5">
                    <span className="text-[10px] font-bold text-neutral-400 uppercase tracking-wider">Voice:</span>
                    <button 
                      onClick={toggleTtsMode}
                      className={`text-[10px] font-bold px-2.5 py-1 rounded-full uppercase tracking-wider transition-colors cursor-pointer ${
                        voice.ttsMode === 'web_speech' 
                          ? 'bg-neutral-800 text-white' 
                          : 'text-neutral-500 hover:text-white'
                      }`}
                    >
                      Standard
                    </button>
                    <button 
                      onClick={toggleTtsMode}
                      className={`text-[10px] font-bold px-2.5 py-1 rounded-full uppercase tracking-wider transition-colors cursor-pointer ${
                        voice.ttsMode === 'elevenlabs' 
                          ? 'bg-amber-500 text-neutral-900' 
                          : 'text-neutral-500 hover:text-white'
                      }`}
                    >
                      Premium
                    </button>
                  </div>
                </div>
              </div>

              {/* Step Content Card / Split Screen with Chat Drawer */}
              <div className="flex-1 flex flex-col md:flex-row overflow-hidden relative max-w-7xl mx-auto w-full z-10">
                {/* Left Side: Cooking steps and visual wave */}
                <div className="flex-1 flex flex-col justify-between p-6 overflow-y-auto min-w-0">
                  <div className="space-y-3">
                    <div className="flex justify-between items-center">
                      <span className="text-xs font-bold text-amber-500 uppercase tracking-wider">
                        Step {currentStep + 1} of {selectedRecipe.steps.length}
                      </span>
                      <span className="text-xs text-neutral-450 truncate max-w-[200px]">
                        {selectedRecipe.title}
                      </span>
                    </div>
                    
                    {/* Progress bar */}
                    <div className="w-full bg-neutral-900 h-2 rounded-full overflow-hidden flex gap-1">
                      {selectedRecipe.steps.map((s, idx) => (
                        <div 
                          key={s.step}
                          className={`flex-1 h-full rounded-full transition-all duration-300 ${
                            idx === currentStep 
                              ? 'bg-amber-500' 
                              : idx < currentStep 
                                ? 'bg-neutral-700' 
                                : 'bg-neutral-900'
                          }`}
                        />
                      ))}
                    </div>
                  </div>

                  {/* Allergen Warning placed separately on the left side, not centered! */}
                  {selectedRecipe.ingredients.some(ing => 
                    userProfile?.allergies.some(all => ing.name.toLowerCase().includes(all.toLowerCase())) &&
                    selectedRecipe.steps[currentStep].text.toLowerCase().includes(ing.name.toLowerCase().split(' ')[0])
                  ) && (
                    <div className="mt-4 bg-amber-500/10 border border-amber-500/30 text-amber-400 p-4 rounded-2xl text-xs font-bold flex items-start gap-2.5 max-w-md w-full text-left shadow-lg select-none">
                      <span className="text-sm mt-0.5">🛡️</span>
                      <div>
                        <span className="font-extrabold uppercase block mb-0.5 tracking-wider text-amber-500">Allergen Warning</span>
                        <span className="text-neutral-300 font-medium">This step contains an allergen ({
                          selectedRecipe.ingredients.filter(ing => 
                            userProfile?.allergies.some(all => ing.name.toLowerCase().includes(all.toLowerCase())) &&
                            selectedRecipe.steps[currentStep].text.toLowerCase().includes(ing.name.toLowerCase().split(' ')[0])
                          ).map(i => i.name).join(', ')
                        }) violating your profile!</span>
                      </div>
                    </div>
                  )}

                  {/* Main Instruction */}
                  <div className="flex-1 flex flex-col justify-center gap-6 py-6 text-center">
                    {selectedRecipe.steps[currentStep].safety_alert && (
                      <div className="bg-red-500/10 border border-red-500/30 text-red-400 p-4 rounded-2xl text-xs font-semibold flex items-center gap-2 max-w-xl mx-auto">
                        <span>⚠️</span>
                        <span>SAFETY ALERT: {selectedRecipe.steps[currentStep].safety_alert}</span>
                      </div>
                    )}

                    <h2 className="text-3xl md:text-5xl font-black leading-tight tracking-tight max-w-2xl mx-auto select-text selection:bg-amber-500/30">
                      "{selectedRecipe.steps[currentStep].text}"
                    </h2>

                    {/* Step Ingredients details */}
                    <div className="flex flex-wrap gap-2 justify-center max-w-lg mx-auto mt-4">
                      {selectedRecipe.ingredients.map(ing => {
                        const isMentioned = selectedRecipe.steps[currentStep].text.toLowerCase().includes(ing.name.toLowerCase().split(' ')[0]);
                        if (!isMentioned) return null;
                        return (
                          <span key={ing.name} className="text-xs bg-neutral-900 border border-neutral-850 px-3 py-1.5 rounded-xl text-neutral-300">
                            🥛 {ing.amount} {ing.unit} {ing.name}
                          </span>
                        );
                      })}
                    </div>

                    {/* Next step overview */}
                    {currentStep < selectedRecipe.steps.length - 1 ? (
                      <div className="mt-6 p-4 bg-neutral-900/60 border border-neutral-850 rounded-2xl max-w-xl mx-auto text-left shadow-inner">
                        <span className="text-[10px] font-bold text-amber-500 uppercase tracking-wider block mb-1">Up Next:</span>
                        <p className="text-xs text-neutral-300 font-medium line-clamp-2">
                          {selectedRecipe.steps[currentStep + 1].text}
                        </p>
                      </div>
                    ) : (
                      <div className="mt-6 p-4 bg-emerald-950/20 border border-emerald-500/20 rounded-2xl max-w-xl mx-auto text-left shadow-inner">
                        <span className="text-[10px] font-bold text-emerald-400 uppercase tracking-wider block mb-1">Up Next:</span>
                        <p className="text-xs text-emerald-250 font-medium">
                          🎉 Finish and submit your cooking entry!
                        </p>
                      </div>
                    )}

                    {/* Step Navigation Buttons */}
                    <div className="flex items-center justify-center gap-3 mt-6">
                      <button
                        onClick={handlePrevStep}
                        disabled={currentStep === 0}
                        className={`px-4 py-2.5 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-all select-none ${
                          currentStep === 0
                            ? 'bg-neutral-900 text-neutral-600 border border-neutral-850 cursor-not-allowed opacity-40'
                            : 'bg-neutral-900 border border-neutral-800 text-neutral-300 hover:text-white hover:bg-neutral-850 active:scale-95 cursor-pointer'
                        }`}
                      >
                        ← Previous
                      </button>

                      <button
                        onClick={handleRepeatStep}
                        className="px-4 py-2.5 bg-neutral-900 border border-neutral-800 text-neutral-350 hover:text-neutral-100 hover:bg-neutral-850 rounded-xl text-xs font-semibold transition-all active:scale-95 cursor-pointer select-none"
                        title="Repeat current step instructions"
                      >
                        🔊 Repeat
                      </button>

                      {currentStep < selectedRecipe.steps.length - 1 ? (
                        <button
                          onClick={handleNextStep}
                          className="px-5 py-2.5 bg-amber-500 hover:bg-amber-600 text-neutral-950 rounded-xl text-xs font-black flex items-center gap-1.5 transition-all active:scale-95 shadow-md shadow-amber-500/10 cursor-pointer select-none"
                        >
                          Next Step →
                        </button>
                      ) : (
                        <button
                          onClick={() => {
                            setCompletionRating(5);
                            setShowCompletionModal(true);
                          }}
                          className="px-5 py-2.5 bg-gradient-to-r from-emerald-500 to-green-500 hover:from-emerald-600 hover:to-green-600 text-white rounded-xl text-xs font-black flex items-center gap-1.5 transition-all active:scale-95 shadow-md shadow-emerald-500/15 cursor-pointer select-none animate-pulse"
                        >
                          Submit Completion 🎉
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Waveform visualizer */}
                  <div className="space-y-4">
                    <Waveform status={voice.status} analyser={voice.analyser} />
                    <div className="text-center text-[10px] text-neutral-500 font-bold uppercase tracking-wider flex items-center justify-center gap-6 select-none">
                      <span>🎤 Speak: "next"</span>
                      <span>"go back"</span>
                      <span>"repeat step"</span>
                      <span>"set 5 minute timer"</span>
                    </div>
                  </div>
                </div>

                {/* Right Side: Conversation Chat Logs & Keyboard Input Drawer */}
                <div className="w-full md:w-80 border-t md:border-t-0 md:border-l border-neutral-900 bg-neutral-950 flex flex-col h-[320px] md:h-auto overflow-hidden relative">
                  <div className="px-4 py-3 border-b border-neutral-900 bg-neutral-950 flex items-center justify-between text-neutral-400 font-bold text-xs uppercase tracking-wider">
                    <span>Chat Drawer</span>
                    <span className="text-[10px] lowercase text-neutral-500 font-normal">Keyboard supported</span>
                  </div>

                  {/* Chat conversations area */}
                  <div className="flex-1 overflow-hidden">
                    <ChatArea 
                      messages={voice.messages} 
                      isAiThinking={voice.isAiThinking} 
                      interimTranscript={voice.interimTranscript} 
                    />
                  </div>

                  {/* Manual Text Input form */}
                  <form onSubmit={handleTextSubmit} className="p-4 border-t border-neutral-900 bg-neutral-950 flex gap-2">
                    <input
                      type="text"
                      placeholder="Ask recipe questions..."
                      value={textInput}
                      onChange={(e) => setTextInput(e.target.value)}
                      className="flex-1 bg-neutral-900 border border-neutral-800 rounded-xl px-4 py-2.5 text-xs text-white focus:outline-none focus:border-amber-500 transition-all placeholder:text-neutral-600"
                    />
                    <button
                      type="submit"
                      className="bg-amber-500 hover:bg-amber-600 text-neutral-950 font-bold px-4 py-2.5 rounded-xl text-xs transition-colors cursor-pointer active:scale-95"
                    >
                      Send
                    </button>
                  </form>
                </div>
              </div>

              {/* Active Timers overlays */}
              <div className="absolute top-20 right-6 z-30">
                <TimerWidget 
                  timers={timers.timers} 
                  onCancel={timers.removeTimer} 
                  onAddSeconds={timers.addTimeToTimer}
                />
              </div>

              {/* Background ambient lighting */}
              <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-amber-500/5 rounded-full blur-[120px] pointer-events-none" />
              <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-red-500/5 rounded-full blur-[120px] pointer-events-none" />
            </div>
          )
        )}
      </main>

      {/* Auth Modal */}
      {showAuthModal && (
        <Auth 
          onAuthSuccess={() => {
            setShowAuthModal(false);
            supabase.auth.getUser().then(({ data: { user } }) => {
              if (user) loadUserProfile(user.id);
            });
          }} 
          onClose={() => setShowAuthModal(false)} 
        />
      )}

      {/* User Profile sliding panel */}
      {session && userProfile && (
        <UserProfilePanel
          userId={session.user.id}
          userEmail={session.user.email || ''}
          recipes={recipes}
          isOpen={showProfilePanel}
          onClose={() => setShowProfilePanel(false)}
          onSelectRecipe={handleSelectRecipe}
          onLogout={handleLogout}
        />
      )}

      {/* Saved Conversations logs history panel */}
      <HistoryPanel 
        isOpen={showHistoryPanel} 
        onClose={() => setShowHistoryPanel(false)} 
      />

      {/* Recipe Completion Star Rating Modal */}
      {showCompletionModal && selectedRecipe && (
        <div className="fixed inset-0 bg-neutral-950/85 backdrop-blur-md z-50 flex items-center justify-center p-4">
          <div className="bg-neutral-900 border border-neutral-800 rounded-3xl p-6 max-w-sm w-full text-white shadow-2xl relative space-y-5 animate-in fade-in zoom-in-95 duration-200">
            {/* Decorative Icon */}
            <div className="text-center">
              <span className="text-5xl block animate-bounce mb-2">🏆</span>
              <h3 className="text-lg font-black text-neutral-100">Recipe Completed!</h3>
              <p className="text-xs text-neutral-400 mt-1 px-4 leading-relaxed">
                Congratulations on finishing <strong className="text-amber-400">{selectedRecipe.title}</strong>! How would you rate your cooking experience?
              </p>
            </div>

            {/* Star Rating Section */}
            <div className="space-y-2 text-center">
              <div className="flex items-center justify-center gap-2">
                {[1, 2, 3, 4, 5].map((star) => (
                  <button
                    key={star}
                    type="button"
                    onClick={() => setCompletionRating(star)}
                    className="text-3xl focus:outline-none transition-transform hover:scale-125 cursor-pointer text-amber-400 bg-transparent border-none"
                  >
                    {star <= completionRating ? '★' : '☆'}
                  </button>
                ))}
              </div>
              <p className="text-xs text-amber-500 font-semibold h-4">
                {completionRating === 1 && 'Needs practice 😅'}
                {completionRating === 2 && 'It was okay 🙂'}
                {completionRating === 3 && 'Tasted good! 😋'}
                {completionRating === 4 && 'Delicious! 😍'}
                {completionRating === 5 && 'Chef standard! 👨‍🍳🔥'}
              </p>
            </div>

            {/* Warning if not logged in */}
            {!session && (
              <div className="bg-amber-500/10 border border-amber-500/20 text-amber-400 text-[11px] p-3 rounded-xl font-medium leading-relaxed">
                ⚠️ You are not signed in. Sign in to save this achievement to your kitchen profile, or submit to finish.
              </div>
            )}

            {/* Actions */}
            <div className="flex flex-col gap-2 pt-2">
              <button
                onClick={async () => {
                  try {
                    if (session?.user) {
                      await addCookingHistory(session.user.id, selectedRecipe.id, selectedRecipe.time, completionRating);
                      // Reload profile to keep history in sync
                      await loadUserProfile(session.user.id);
                    }
                    timers.clearAllTimers();
                    voice.stop();
                    setShowCompletionModal(false);
                    setView('home');
                  } catch (err) {
                    console.error("Failed to submit cooking history:", err);
                    alert("Something went wrong saving your cooking log.");
                  }
                }}
                className="w-full bg-amber-500 hover:bg-amber-600 text-neutral-950 font-black py-3 rounded-xl transition-all cursor-pointer text-center text-xs shadow-lg shadow-amber-500/10 active:scale-95"
              >
                {session ? 'Submit & Save' : 'Finish Without Saving'}
              </button>
              
              {!session && (
                <button
                  onClick={() => {
                    setShowCompletionModal(false);
                    setShowAuthModal(true);
                  }}
                  className="w-full bg-neutral-850 hover:bg-neutral-800 text-white font-bold py-2.5 rounded-xl transition-all cursor-pointer text-center text-xs active:scale-95"
                >
                  Sign In to Save
                </button>
              )}

              <button
                onClick={() => setShowCompletionModal(false)}
                className="w-full bg-transparent border border-neutral-800 hover:bg-neutral-800 text-neutral-400 hover:text-white font-semibold py-2.5 rounded-xl transition-all cursor-pointer text-center text-xs active:scale-95"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
