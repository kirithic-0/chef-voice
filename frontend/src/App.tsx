import React, { useState, useEffect } from 'react';
import { useVoiceChat } from './hooks/useVoiceChat';
import { useCookingTimers } from './hooks/useCookingTimers';
import {
  fetchRecipes,
  searchRecipes,
  getUserProfile,
  getUserFavorites,
  addFavorite,
  removeFavorite,
  getCookingHistory,
  addCookingHistory,
  createRecipe,
  deleteRecipe,
  importRecipeFromUrl,
  getSession,
  onAuthChange,
  logout
} from './lib/api';
import RecipeCard from './components/RecipeCard';
import AssistantPanel from './components/AssistantPanel';
import ModelSelector from './components/ModelSelector';
import Waveform from './components/Waveform';
import TimerWidget from './components/TimerWidget';
import Auth from './components/Auth';
import UserProfilePanel from './components/UserProfilePanel';
import HistoryPanel from './components/HistoryPanel';
import ChatArea from './components/ChatArea';
import ShoppingListPanel from './components/ShoppingListPanel';
import { Recipe, UserProfile, Favorite, CookingHistoryEntry, AppSession } from './types';

export default function App() {
  // Cooking state hooks
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [searchResults, setSearchResults] = useState<Recipe[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<'home' | 'detail' | 'cooking' | 'admin'>('home');
  const [selectedRecipe, setSelectedRecipe] = useState<Recipe | null>(null);
  const [currentStep, setCurrentStep] = useState(0);
  const [ingredientsChecked, setIngredientsChecked] = useState<Record<string, boolean>>({});
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCuisine, setSelectedCuisine] = useState('All');
  
  // Advanced AI search toggle
  const [useSemanticSearch, setUseSemanticSearch] = useState(false);

  // Authentication & Profile states
  const [session, setSession] = useState<AppSession | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [favorites, setFavorites] = useState<Favorite[]>([]);
  
  // Cooking history and sorting states
  const [cookingHistory, setCookingHistory] = useState<CookingHistoryEntry[]>([]);
  const [sortBy, setSortBy] = useState<'default' | 'recent' | 'time' | 'rating'>('default');
  const [vegFilter, setVegFilter] = useState<'All' | 'Veg' | 'Non-Veg'>('All');
  const [showCompletionModal, setShowCompletionModal] = useState(false);
  const [completionRating, setCompletionRating] = useState<number>(5);
  
  // Modals / Panels
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [showProfilePanel, setShowProfilePanel] = useState(false);
  const [showHistoryPanel, setShowHistoryPanel] = useState(false);
  const [showShoppingList, setShowShoppingList] = useState(false);
  const [shoppingRefreshKey, setShoppingRefreshKey] = useState(0);
  const [importUrl, setImportUrl] = useState('');
  const [importing, setImporting] = useState(false);

  // Text chat input
  const [textInput, setTextInput] = useState('');
  // Home-screen chat assistant (recipe discovery entry point)
  const [showAssistant, setShowAssistant] = useState(false);
  const [assistantSuggestions, setAssistantSuggestions] = useState<Recipe[]>([]);

  // Admin form state
  const [adminTitle, setAdminTitle] = useState('');
  const [adminCuisine, setAdminCuisine] = useState('');
  const [adminTime, setAdminTime] = useState(30);
  const [adminServings, setAdminServings] = useState(4);
  const [adminDifficulty, setAdminDifficulty] = useState('Easy');
  const [adminDietary, setAdminDietary] = useState<string[]>(['Veg']);
  const [adminImageUrl, setAdminImageUrl] = useState('');
  const [adminIngredients, setAdminIngredients] = useState<{ name: string; amount: string; unit: string }[]>([
    { name: '', amount: '', unit: '' }
  ]);
  const [adminSteps, setAdminSteps] = useState<{ text: string; timer_duration: string; safety_alert: string }[]>([
    { text: '', timer_duration: '', safety_alert: '' }
  ]);
  const [adminError, setAdminError] = useState('');
  const [adminSuccess, setAdminSuccess] = useState('');
  const [publishing, setPublishing] = useState(false);

  // Load custom hooks
  const timers = useCookingTimers();
  const voice = useVoiceChat();

  const loadAllRecipes = async () => {
    try {
      setLoading(true);
      const data = await fetchRecipes();
      setRecipes(data);
    } catch (err) {
      console.error('Failed to load recipes:', err);
    } finally {
      setLoading(false);
    }
  };

  // Fetch recipes from the backend when authenticated
  useEffect(() => {
    if (session) {
      loadAllRecipes();
    }
  }, [session]);

  // Monitor local auth state change
  useEffect(() => {
    const currentSession = getSession();
    setSession(currentSession);
    if (currentSession?.user) {
      loadUserProfile(currentSession.user.id);
    }

    const unsubscribe = onAuthChange((nextSession) => {
      setSession(nextSession);
      if (nextSession?.user) {
        loadUserProfile(nextSession.user.id);
      } else {
        setUserProfile(null);
        setFavorites([]);
        setCookingHistory([]);
      }
    });

    return unsubscribe;
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

  const handleLogout = () => {
    logout();
    setCookingHistory([]);
  };

  const handleAddIngredient = () => {
    setAdminIngredients([...adminIngredients, { name: '', amount: '', unit: '' }]);
  };

  const handleRemoveIngredient = (index: number) => {
    setAdminIngredients(adminIngredients.filter((_, i) => i !== index));
  };

  const handleIngredientChange = (index: number, field: string, value: string) => {
    const updated = [...adminIngredients];
    updated[index] = { ...updated[index], [field]: value };
    setAdminIngredients(updated);
  };

  const handleAddStep = () => {
    setAdminSteps([...adminSteps, { text: '', timer_duration: '', safety_alert: '' }]);
  };

  const handleRemoveStep = (index: number) => {
    setAdminSteps(adminSteps.filter((_, i) => i !== index));
  };

  const handleStepChange = (index: number, field: string, value: string) => {
    const updated = [...adminSteps];
    updated[index] = { ...updated[index], [field]: value };
    setAdminSteps(updated);
  };

  const handleDietaryToggle = (tag: string) => {
    if (adminDietary.includes(tag)) {
      setAdminDietary(adminDietary.filter(t => t !== tag));
    } else {
      setAdminDietary([...adminDietary, tag]);
    }
  };

  const handlePublishRecipe = async (e: React.FormEvent) => {
    e.preventDefault();
    setAdminError('');
    setAdminSuccess('');
    
    if (!adminTitle || !adminCuisine) {
      setAdminError('Title and Cuisine are required.');
      return;
    }
    
    const filteredIngredients = adminIngredients.filter(ing => ing.name.trim() !== '');
    if (filteredIngredients.length === 0) {
      setAdminError('Please add at least one ingredient.');
      return;
    }
    
    const filteredSteps = adminSteps
      .filter(step => step.text.trim() !== '')
      .map((step, idx) => ({
        step: idx + 1,
        text: step.text,
        timer_duration: step.timer_duration ? parseInt(step.timer_duration) : null,
        safety_alert: step.safety_alert || null
      }));
      
    if (filteredSteps.length === 0) {
      setAdminError('Please add at least one instruction step.');
      return;
    }
    
    setPublishing(true);
    try {
      const newRecipe = {
        title: adminTitle,
        cuisine: adminCuisine,
        time: adminTime,
        servings: adminServings,
        difficulty: adminDifficulty,
        dietary: adminDietary,
        image_url: adminImageUrl || undefined,
        ingredients: filteredIngredients,
        steps: filteredSteps
      };
      
      await createRecipe(newRecipe);
      setAdminSuccess('Recipe published successfully! Vector embeddings have been generated.');
      
      // Reset form
      setAdminTitle('');
      setAdminCuisine('');
      setAdminTime(30);
      setAdminServings(4);
      setAdminDifficulty('Easy');
      setAdminDietary(['Veg']);
      setAdminImageUrl('');
      setAdminIngredients([{ name: '', amount: '', unit: '' }]);
      setAdminSteps([{ text: '', timer_duration: '', safety_alert: '' }]);
      
      await loadAllRecipes();
    } catch (err: any) {
      console.error(err);
      setAdminError(err.message || 'Failed to publish recipe.');
    } finally {
      setPublishing(false);
    }
  };

  const handleDeleteRecipe = async (id: string) => {
    if (!window.confirm('Are you sure you want to delete this recipe?')) return;
    try {
      await deleteRecipe(id);
      await loadAllRecipes();
    } catch (err: any) {
      alert(err.message || 'Failed to delete recipe.');
    }
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

  // Filter recipes based on category, search query and Veg/Non-Veg filter
  const displayRecipes = React.useMemo(() => {
    let base = useSemanticSearch && searchQuery.trim() !== ''
      ? searchResults
      : recipes.filter((r) => {
          const matchesCuisine = selectedCuisine === 'All' || r.cuisine === selectedCuisine;
          const matchesSearch = 
            r.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
            r.cuisine.toLowerCase().includes(searchQuery.toLowerCase()) ||
            r.ingredients.some(i => i.name.toLowerCase().includes(searchQuery.toLowerCase()));
          return matchesCuisine && matchesSearch;
        });

    if (vegFilter !== 'All') {
      const targetIsVeg = vegFilter === 'Veg';
      base = base.filter(r => {
        const isVeg = r.dietary?.some(d => d.toLowerCase() === 'veg' || d.toLowerCase() === 'vegan') ?? false;
        return targetIsVeg ? isVeg : !isVeg;
      });
    }

    return base;
  }, [recipes, searchResults, useSemanticSearch, searchQuery, selectedCuisine, vegFilter]);

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

    if (sortBy === 'rating') {
      return [...displayRecipes].sort((a, b) => (b.average_rating || 0) - (a.average_rating || 0));
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
      tts_mode: 'web_speech',
      dietary_preferences: userProfile?.dietary_preferences || []
    });
  }, [view, selectedRecipe, currentStep, timers.timers, userProfile]);

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
        if (view === 'cooking') {
          if (typeof params?.step_index === 'number') {
            setCurrentStep(params.step_index);
          } else {
            handleNextStep();
          }
        }
        break;
      case 'prev_step':
        if (view === 'cooking') {
          if (typeof params?.step_index === 'number') {
            setCurrentStep(params.step_index);
          } else {
            handlePrevStep();
          }
        }
        break;
      case 'repeat_step':
        if (view === 'cooking') {
          if (typeof params?.step_index === 'number') {
            setCurrentStep(params.step_index);
          } else {
            handleRepeatStep();
          }
        }
        break;
      case 'set_timer':
        if (params?.duration) {
          timers.addTimer(params.duration, params.label || 'Cooking Timer');
        }
        break;
      case 'cancel_timer':
        // Prefer the exact timer id the backend resolved; fall back to label.
        if (params?.id) {
          timers.removeTimer(params.id);
        } else if (params?.label) {
          const match = timers.timers.find(t => t.label.toLowerCase().includes(params.label!.toLowerCase()));
          if (match) timers.removeTimer(match.id);
        }
        break;
      case 'search_recipes':
        if (view !== 'cooking' && params?.query) {
          setSearchQuery(params.query);
          setUseSemanticSearch(true);
          setSelectedCuisine('All');
          if (params.results && Array.isArray(params.results) && params.results.length > 0) {
            setSearchResults(params.results as Recipe[]);
            // Surface clickable suggestions inside the assistant panel.
            setAssistantSuggestions(params.results as Recipe[]);
          }
          if (!showAssistant) setView('home');
        }
        break;
      case 'select_recipe':
        if (view !== 'cooking' && params?.id) {
          const found = recipes.find(
            r => r.id === params.id || r.title.toLowerCase().includes(params.id!.toLowerCase())
          ) || (params as any).recipe;
          if (found) {
            handleSelectRecipe(found);
          }
        }
        break;
      case 'start_cooking':
        if (view !== 'cooking') handleStartCooking();
        break;
      case 'recipe_imported':
        loadAllRecipes();
        if (params?.recipe) {
          handleSelectRecipe(params.recipe as Recipe);
        } else if (params?.id) {
          const found = recipes.find(r => r.id === params.id);
          if (found) handleSelectRecipe(found);
        }
        break;
      default:
        break;
    }

    voice.setLatestAction(null);
  }, [voice.latestAction, view, selectedRecipe, currentStep, recipes, timers.timers]);

  // Home chat assistant: open starts a voice/text session in discovery context.
  const openAssistant = () => {
    setShowAssistant(true);
    if (voice.status === 'idle') {
      voice.start({
        screen: 'home',
        recipe: null,
        current_step: 0,
        timers: timers.timers,
        dietary_preferences: userProfile?.dietary_preferences || [],
      }).catch((err) => console.error('Failed to start assistant:', err));
    }
  };

  const closeAssistant = () => {
    setShowAssistant(false);
    setAssistantSuggestions([]);
    voice.stop();
  };

  // Explicit user pick (grid card or an assistant suggestion): end discovery,
  // then flow into the normal detail -> cooking screens.
  const handlePickRecipe = (recipe: Recipe) => {
    if (showAssistant) {
      setShowAssistant(false);
      setAssistantSuggestions([]);
      voice.stop();
    }
    handleSelectRecipe(recipe);
  };

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
        speakLocal(text);
      }, 500);
    }

    // Ensure the voice session is live AND pointed at this recipe. If a
    // discovery/home chat session is still open (e.g. you picked a card with the
    // assistant open), we must retarget it to 'cooking' rather than skip — else
    // it stays in 'home' context and cooking commands ("next step", timers) hit
    // the wrong tools and appear dead. If nothing is running, start fresh.
    const cookingState = {
      screen: 'cooking',
      recipe: selectedRecipe,
      current_step: 0,
      timers: timers.timers,
      dietary_preferences: userProfile?.dietary_preferences || [],
    };
    if (voice.status === 'idle') {
      voice.start(cookingState).catch((err) => console.error('Failed to start voice chat:', err));
    } else {
      voice.sendStateUpdate(cookingState);
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

  const handleTextSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!textInput.trim()) return;
    voice.sendTextMessage(textInput.trim());
    setTextInput('');
  };

  if (!session) {
    return (
      <div className="min-h-screen bg-[#FDFCF8] flex flex-col items-center justify-center p-4 selection:bg-[#5D7052]/20 selection:text-[#5D7052]">
        <div className="text-center mb-8 space-y-2">

          <h1 className="text-4xl font-serif font-bold text-[#2C2C24] tracking-tight">ChefVoice</h1>
          <p className="text-[#78786C] text-sm font-sans font-medium">Your hands-free AI-powered kitchen voice assistant</p>
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
    <div className="min-h-screen bg-[#FDFCF8] text-[#2C2C24] flex flex-col font-sans antialiased selection:bg-[#5D7052]/20 selection:text-[#5D7052]">
      {/* Header */}
      {view !== 'cooking' && (
        <header className="bg-[#FEFEFA]/80 backdrop-blur-md border-b border-[#DED8CF]/30 py-4 px-8 sticky top-0 z-40 flex items-center justify-between shadow-soft">
          <div className="flex items-center gap-3 cursor-pointer group" onClick={() => setView('home')}>
            <span className="font-serif font-bold text-2xl tracking-tight text-[#2C2C24] group-hover:text-[#5D7052] transition-colors">
              ChefVoice
            </span>
          </div>

          <div className="flex items-center gap-4">
            <button
              onClick={() => setShowShoppingList(true)}
              className="text-sm font-bold px-4 py-2 rounded-full text-[#78786C] hover:text-[#2C2C24] bg-[#F0EBE5]/50 border border-[#DED8CF] hover:bg-[#F0EBE5] transition-all duration-300 cursor-pointer"
            >
              Shopping List
            </button>
            {/* Admin Portal Toggle */}
            {userProfile?.is_admin && (
              <button
                onClick={() => setView(view === 'admin' ? 'home' : 'admin')}
                className={`text-sm font-bold px-4 py-2 rounded-full transition-all duration-300 cursor-pointer flex items-center gap-2 active:scale-95 ${
                  view === 'admin'
                    ? 'bg-[#5D7052] text-[#F3F4F1] shadow-soft'
                    : 'text-[#78786C] hover:text-[#2C2C24] bg-[#F0EBE5]/50 border border-[#DED8CF] hover:bg-[#F0EBE5]'
                }`}
              >
                Admin Portal
              </button>
            )}

            {/* Auth Trigger / Profile Trigger */}
            {session ? (
              <button
                onClick={() => setShowProfilePanel(true)}
                className="bg-[#F0EBE5]/50 border border-[#DED8CF] hover:border-[#5D7052]/50 text-[#78786C] hover:text-[#2C2C24] text-sm font-bold px-5 py-2.5 rounded-full transition-all duration-300 cursor-pointer flex items-center gap-2 hover:shadow-soft"
              >
                My Profile
              </button>
            ) : (
              <button
                onClick={() => setShowAuthModal(true)}
                className="bg-[#5D7052] hover:bg-[#5D7052]/90 text-[#F3F4F1] text-sm font-bold px-5 py-2.5 rounded-full transition-all cursor-pointer active:scale-95 shadow-soft"
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
          <div className="max-w-7xl w-full mx-auto px-6 py-16 flex-1 flex flex-col gap-16 relative">
            {/* Background Blobs for Hero */}
            <div className="absolute top-0 right-0 w-96 h-96 bg-[#5D7052]/10 blob-1 blur-3xl -z-10 animate-[spin_60s_linear_infinite]" />
            <div className="absolute top-20 left-10 w-72 h-72 bg-[#C18C5D]/10 blob-2 blur-3xl -z-10 animate-[spin_40s_linear_infinite_reverse]" />

            {/* Welcome banner */}
            <div className="relative overflow-hidden rounded-[2rem] rounded-tl-[4rem] rounded-br-[4rem] p-12 bg-white/40 glass-pill border-[#DED8CF]/50 shadow-soft">
              <div className="space-y-6 z-10 max-w-2xl relative mx-auto text-center">
                <h1 className="text-5xl md:text-6xl font-serif text-[#2C2C24] leading-[1.1]">
                  Cook Hands-Free with Voice Commands
                </h1>
                <p className="text-[#78786C] text-lg font-sans leading-relaxed">
                  Select a recipe, place your phone on the counter, and just say <strong className="text-[#5D7052] font-semibold">"next"</strong>, <strong className="text-[#5D7052] font-semibold">"go back"</strong>, or ask <strong className="text-[#5D7052] font-semibold">"what substitute can I use?"</strong>
                </p>
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
                    <h2 className="text-2xl font-serif font-bold text-[#2C2C24]">Explore Recipes</h2>

                    <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 max-w-lg w-full md:w-auto shrink-0">
                      <div className="relative flex-1 md:w-72">
                        <input
                          type="text"
                          placeholder="Search by name or ingredients..."
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                          className="w-full bg-white/70 border border-[#DED8CF] rounded-full py-3.5 pl-12 pr-5 text-sm font-medium focus:outline-none focus:border-[#5D7052] focus:ring-2 focus:ring-[#5D7052]/20 transition-all shadow-sm text-[#2C2C24] placeholder-[#78786C]"
                        />
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5 text-[#78786C] absolute left-4 top-3.5">
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
                        className={`px-5 py-2.5 rounded-full text-xs font-bold whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
                          !useSemanticSearch && selectedCuisine === cuisine 
                            ? 'bg-[#5D7052] text-[#F3F4F1] shadow-soft' 
                            : 'bg-white/60 text-[#78786C] border border-[#DED8CF] hover:border-[#5D7052]/50 hover:bg-white'
                        }`}
                      >
                        {cuisine}
                      </button>
                    ))}
                  </div>

                  {/* Toolbar: Veg/Non-Veg Filter & Sort Selector */}
                  <div className="flex flex-wrap items-center justify-between gap-4 bg-[#F0EBE5]/30 border border-[#DED8CF]/50 p-5 rounded-[2rem]">
                    {/* Left side: Veg / Non-Veg Toggle Buttons */}
                    <div className="flex items-center gap-3">
                      <span className="text-xs font-bold text-[#78786C] uppercase tracking-wider select-none">Type:</span>
                      <div className="flex bg-[#DED8CF]/30 p-1 rounded-full border border-[#DED8CF]">
                        {(['All', 'Veg', 'Non-Veg'] as const).map(type => (
                          <button
                            key={type}
                            onClick={() => setVegFilter(type)}
                            className={`px-4 py-2 rounded-full text-xs font-bold transition-all duration-300 cursor-pointer flex items-center gap-2 ${
                              vegFilter === type
                                ? type === 'Veg'
                                  ? 'bg-[#5D7052] text-[#F3F4F1] shadow-sm'
                                  : type === 'Non-Veg'
                                    ? 'bg-[#A85448] text-white shadow-sm'
                                    : 'bg-[#FEFEFA] text-[#2C2C24] shadow-sm'
                                : 'text-[#78786C] hover:text-[#2C2C24]'
                            }`}
                          >
                            {type === 'Veg' && <span className="w-1.5 h-1.5 rounded-full bg-[#F3F4F1]" />}
                            {type === 'Non-Veg' && <span className="w-1.5 h-1.5 rounded-full bg-white" />}
                            {type}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Right side: Sort Selector */}
                    <div className="flex items-center gap-3">
                      <span className="text-xs font-bold text-[#78786C] uppercase tracking-wider select-none">Sort By:</span>
                      <select
                        value={sortBy}
                        onChange={(e) => setSortBy(e.target.value as any)}
                        className="bg-[#FEFEFA] border border-[#DED8CF] rounded-full px-4 py-2.5 text-xs font-bold text-[#2C2C24] focus:outline-none focus:border-[#5D7052] cursor-pointer shadow-sm appearance-none"
                      >
                        <option value="default">Default (A-Z)</option>
                        <option value="rating">Highest Rated</option>
                        <option value="time">Shortest Cooking Time</option>
                        <option value="recent">Recently Cooked</option>
                      </select>
                    </div>
                  </div>

                </div>

                {/* Recipes Grid */}
                {sortedRecipes.length === 0 ? (
                  <div className="text-center py-20 bg-white/40 border border-[#DED8CF] rounded-[2rem] shadow-sm backdrop-blur-sm">
                    <span className="text-5xl block mb-4 opacity-50">🔍</span>
                    <h3 className="font-serif font-bold text-[#2C2C24] text-xl">No recipes found</h3>
                    <p className="text-[#78786C] text-sm mt-2">Try other search terms or toggle semantic search mode off.</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-6">
                    {sortedRecipes.map((recipe) => {
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
                          onClick={() => handlePickRecipe(recipe)}
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
              <div className="w-full lg:w-80 shrink-0 bg-white/70 border border-[#DED8CF]/50 rounded-[2rem] p-8 shadow-float flex flex-col gap-6 self-stretch lg:self-auto backdrop-blur-md">
                <div className="flex items-center justify-between border-b border-[#DED8CF]/30 pb-4">
                  <h3 className="font-serif font-bold text-[#2C2C24] text-lg flex items-center gap-2">
                    <span>⏱️</span> Recently Made
                  </h3>
                  <span className="text-[10px] font-bold text-[#78786C] bg-[#F0EBE5] px-3 py-1 rounded-full uppercase tracking-wider">
                    Recent Logs
                  </span>
                </div>

                {cookingHistory.length === 0 ? (
                  <div className="text-center py-12 bg-[#F0EBE5]/30 rounded-[1.5rem] border border-[#DED8CF] border-dashed my-2">
                    <span className="text-4xl block mb-3 opacity-50">🧑‍🍳</span>
                    <p className="text-[#4A4A40] text-sm font-bold">No cooked meals yet</p>
                    <p className="text-[#78786C] text-[11px] mt-2 px-6 leading-relaxed">
                      Complete a recipe in voice guided mode to log your achievements here!
                    </p>
                  </div>
                ) : (
                  <div className="flex flex-col gap-4 overflow-y-auto max-h-[500px] pr-2">
                    {cookingHistory.slice(0, 6).map((entry) => {
                      const recipe = recipes.find(r => r.id === entry.recipe_id);
                      if (!recipe) return null;
                      const date = new Date(entry.completed_at);
                      const relativeDate = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

                      return (
                        <div
                          key={entry.id}
                          onClick={() => handlePickRecipe(recipe)}
                          className="group flex items-center gap-4 p-3 hover:bg-[#FEFEFA] rounded-[1.5rem] transition-all duration-300 cursor-pointer border border-transparent hover:border-[#5D7052]/30 hover:shadow-soft"
                        >
                          <div className="w-14 h-14 rounded-xl overflow-hidden bg-[#F0EBE5] shrink-0">
                            <img
                              src={recipe.image_url || 'https://images.unsplash.com/photo-1495521821757-a1efb6729352?w=600&auto=format&fit=crop&q=60'}
                              alt={recipe.title}
                              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                            />
                          </div>

                          <div className="flex-1 min-w-0">
                            <h4 className="font-serif font-bold text-[#2C2C24] text-sm truncate leading-snug group-hover:text-[#5D7052] transition-colors">
                              {recipe.title}
                            </h4>
                            <div className="flex items-center gap-1.5 mt-1 text-[10px] text-[#78786C] font-bold uppercase tracking-wider">
                              <span>{recipe.cuisine}</span>
                              <span className="text-[#DED8CF]">•</span>
                              <span className="text-[#5D7052]">{relativeDate}</span>
                            </div>
                            <div className="flex items-center gap-0.5 mt-1 text-[10px] text-[#C18C5D]">
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
          <div className="max-w-4xl w-full mx-auto px-6 py-8 flex-1 flex flex-col gap-8">
            <button 
              onClick={() => setView('home')}
              className="flex items-center gap-2 text-sm font-bold text-[#78786C] hover:text-[#2C2C24] transition-colors w-max cursor-pointer bg-[#F0EBE5]/50 hover:bg-[#F0EBE5] px-5 py-2.5 rounded-full border border-[#DED8CF]/30 shadow-sm"
            >
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className="w-5 h-5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
              </svg>
              Back to recipes
            </button>

            {/* Detail Card */}
            {selectedRecipe && (
              <>
                <div className="bg-white/70 backdrop-blur-md border border-[#DED8CF]/50 rounded-[2rem] overflow-hidden shadow-float flex flex-col md:flex-row gap-8 p-6 md:p-8 relative">
                  <div className="w-full md:w-5/12 aspect-[4/3] md:aspect-square bg-[#F0EBE5] rounded-[1.5rem] overflow-hidden">
                    <img 
                      src={selectedRecipe.image_url || 'https://images.unsplash.com/photo-1495521821757-a1efb6729352?w=600&auto=format&fit=crop&q=60'} 
                      alt={selectedRecipe.title}
                      className="w-full h-full object-cover"
                    />
                  </div>

                  <div className="flex-1 flex flex-col justify-between">
                    <div>
                      <div className="flex items-center gap-3 mb-3">
                        <span className="bg-[#F0EBE5] text-[#78786C] text-[11px] font-bold px-3 py-1.5 rounded-full uppercase tracking-wider">
                          {selectedRecipe.cuisine}
                        </span>
                        {selectedRecipe.dietary?.some(d => d.toLowerCase() === 'veg' || d.toLowerCase() === 'vegan') ? (
                          <span className="bg-[#5D7052]/10 text-[#5D7052] text-[11px] font-bold px-3 py-1.5 rounded-full flex items-center gap-1.5 select-none uppercase tracking-wider">
                            <span className="w-1.5 h-1.5 rounded-full bg-[#5D7052]" /> Veg
                          </span>
                        ) : (
                          <span className="bg-[#A85448]/10 text-[#A85448] text-[11px] font-bold px-3 py-1.5 rounded-full flex items-center gap-1.5 select-none uppercase tracking-wider">
                            <span className="w-1.5 h-1.5 rounded-full bg-[#A85448]" /> Non-Veg
                          </span>
                        )}
                      </div>

                      <h1 className="text-4xl font-serif font-bold text-[#2C2C24] mb-4 leading-tight">{selectedRecipe.title}</h1>
                      
                      <div className="flex items-center gap-6 text-sm text-[#78786C] font-semibold mb-8">
                        <span className="flex items-center gap-2">{selectedRecipe.time} mins</span>
                        <span className="flex items-center gap-2">{selectedRecipe.servings} servings</span>
                        <span className="flex items-center gap-2">{selectedRecipe.difficulty}</span>
                        <span className="flex items-center gap-1.5 text-[#78786C]">
                          <span className="text-[#C18C5D] text-base">★</span> 
                          <span className="font-bold text-[#4A4A40]">
                            {selectedRecipe.average_rating && selectedRecipe.rating_count && selectedRecipe.rating_count > 0 
                              ? `${selectedRecipe.average_rating.toFixed(1)} (${selectedRecipe.rating_count})` 
                              : 'New'}
                          </span>
                        </span>
                      </div>
                    </div>

                    <button
                      onClick={handleStartCooking}
                      className="w-full bg-[#5D7052] hover:bg-[#5D7052]/90 text-[#F3F4F1] font-bold py-4 rounded-full shadow-soft active:scale-[0.99] transition-all flex items-center justify-center gap-3 cursor-pointer text-base uppercase tracking-wider"
                    >
                      Start Cooking (Voice Guided)
                    </button>
                  </div>
                </div>

                {/* Ingredients checklist */}
                <div className="bg-white/70 backdrop-blur-md border border-[#DED8CF]/50 rounded-[2rem] p-6 md:p-10 shadow-float">
                  <h2 className="text-2xl font-serif font-bold text-[#2C2C24] mb-6 flex items-center justify-between">
                    <span>Ingredients Checklist</span>
                    <span className="text-[11px] font-bold text-[#78786C] bg-[#F0EBE5] px-3 py-1 rounded-full uppercase tracking-wider">Tap to cross off</span>
                  </h2>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    {selectedRecipe.ingredients.map((ing) => (
                      <label 
                        key={ing.name}
                        className={`flex items-start gap-4 p-4 rounded-[1.5rem] border transition-all duration-300 cursor-pointer ${
                          ingredientsChecked[ing.name]
                            ? 'bg-[#F0EBE5]/50 border-[#DED8CF] text-[#78786C] opacity-60 line-through'
                            : 'bg-white border-[#DED8CF]/80 text-[#2C2C24] hover:border-[#5D7052]/50 hover:shadow-soft'
                        }`}
                      >
                        <input 
                          type="checkbox"
                          checked={ingredientsChecked[ing.name] || false}
                          onChange={() => toggleIngredient(ing.name)}
                          className="mt-1 rounded text-[#5D7052] focus:ring-[#5D7052]/30 w-5 h-5 cursor-pointer accent-[#5D7052]"
                        />
                        <div className="text-[15px] font-sans">
                          <span className="font-semibold text-[#78786C]">{ing.amount} {ing.unit}</span> <strong className="font-bold text-[#4A4A40] ml-1">{ing.name}</strong>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        ) : view === 'admin' ? (
          /* Admin Portal: Manage and Create Recipes */
          <div className="max-w-7xl w-full mx-auto px-6 py-8 flex-1 flex flex-col gap-8">
            <div className="flex items-center justify-between">
              <button 
                onClick={() => setView('home')}
                className="flex items-center gap-2 text-sm font-bold text-[#78786C] hover:text-[#2C2C24] transition-colors w-max cursor-pointer bg-[#F0EBE5]/50 hover:bg-[#F0EBE5] px-5 py-2.5 rounded-full border border-[#DED8CF]/30 shadow-sm"
              >
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className="w-5 h-5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
                </svg>
                Back to recipes
              </button>
              <h1 className="text-3xl font-serif font-bold text-[#2C2C24]">Admin Portal</h1>
            </div>

            <div className="bg-white/70 border border-[#DED8CF]/50 rounded-[2rem] p-6 shadow-float flex flex-col md:flex-row gap-4 items-end">
              <div className="flex-1 w-full">
                <label className="block text-xs font-bold uppercase tracking-wider text-[#78786C] mb-2">Import recipe from URL</label>
                <input
                  type="url"
                  value={importUrl}
                  onChange={(e) => setImportUrl(e.target.value)}
                  placeholder="https://…"
                  className="w-full px-5 py-3.5 rounded-full border border-[#DED8CF] focus:border-[#5D7052] focus:ring-2 focus:ring-[#5D7052]/20 focus:outline-none text-sm bg-[#FDFCF8]"
                />
              </div>
              <button
                disabled={importing || !importUrl.trim()}
                onClick={async () => {
                  setImporting(true);
                  setAdminError('');
                  setAdminSuccess('');
                  try {
                    await importRecipeFromUrl(importUrl.trim());
                    setImportUrl('');
                    setAdminSuccess('Recipe imported and embedded.');
                    await loadAllRecipes();
                  } catch (err: any) {
                    setAdminError(err.message || 'Import failed');
                  } finally {
                    setImporting(false);
                  }
                }}
                className="bg-[#5D7052] text-white font-bold px-6 py-3.5 rounded-full disabled:opacity-50 cursor-pointer"
              >
                {importing ? 'Importing…' : 'Import'}
              </button>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
              {/* Recipe Manager List */}
              <div className="lg:col-span-4 bg-white/70 backdrop-blur-md border border-[#DED8CF]/50 rounded-[2rem] p-8 shadow-float flex flex-col gap-6">
                <h2 className="text-xl font-serif font-bold text-[#2C2C24] border-b border-[#DED8CF]/30 pb-4 flex justify-between items-center">
                  <span>Manage Catalog</span>
                  <span className="text-[10px] font-bold text-[#78786C] bg-[#F0EBE5] border border-[#DED8CF] px-3 py-1 rounded-full uppercase tracking-wider">{recipes.length} Recipes</span>
                </h2>
                
                <div className="flex flex-col gap-4 max-h-[600px] overflow-y-auto pr-2">
                  {recipes.map(recipe => (
                    <div key={recipe.id} className="flex items-center justify-between p-4 rounded-[1.5rem] border border-[#DED8CF]/80 hover:border-[#5D7052]/30 bg-white hover:shadow-soft transition-all duration-300 group">
                      <div className="flex items-center gap-4 min-w-0">
                        <div className="w-14 h-14 bg-[#F0EBE5] rounded-xl overflow-hidden shrink-0">
                          <img src={recipe.image_url || 'https://images.unsplash.com/photo-1495521821757-a1efb6729352?w=600&auto=format&fit=crop&q=60'} alt={recipe.title} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" />
                        </div>
                        <div className="min-w-0">
                          <h4 className="text-[15px] font-serif font-bold text-[#2C2C24] truncate group-hover:text-[#5D7052] transition-colors">{recipe.title}</h4>
                          <p className="text-[10px] text-[#78786C] font-bold uppercase tracking-wider mt-1">{recipe.cuisine} • {recipe.time}m</p>
                        </div>
                      </div>
                      <button 
                        onClick={() => handleDeleteRecipe(recipe.id)}
                        className="text-[#78786C] hover:text-[#A85448] p-2.5 rounded-full hover:bg-[#A85448]/10 transition-all cursor-pointer shrink-0"
                        title="Delete recipe"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                        </svg>
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              {/* Recipe Upload Form */}
              <div className="lg:col-span-8 bg-white/70 backdrop-blur-md border border-[#DED8CF]/50 rounded-[2rem] p-8 md:p-10 shadow-float flex flex-col gap-8">
                <h2 className="text-2xl font-serif font-bold text-[#2C2C24] border-b border-[#DED8CF]/30 pb-4">Create New Recipe</h2>
                
                {adminError && <div className="p-4 bg-[#A85448]/10 border border-[#A85448]/30 text-[#A85448] text-[13px] font-semibold rounded-2xl">{adminError}</div>}
                {adminSuccess && <div className="p-4 bg-[#5D7052]/10 border border-[#5D7052]/30 text-[#5D7052] text-[13px] font-semibold rounded-2xl">{adminSuccess}</div>}

                <form onSubmit={handlePublishRecipe} className="flex flex-col gap-8">
                  {/* Basic Metadata */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="flex flex-col gap-2">
                      <label className="text-[11px] font-bold text-[#78786C] uppercase tracking-wider">Recipe Title *</label>
                      <input type="text" value={adminTitle} onChange={e => setAdminTitle(e.target.value)} required className="px-5 py-3.5 rounded-full border border-[#DED8CF] focus:border-[#5D7052] focus:ring-2 focus:ring-[#5D7052]/20 focus:outline-none text-sm bg-[#FDFCF8] text-[#2C2C24] shadow-sm transition-all" placeholder="e.g. Garlic Herb Roast Chicken" />
                    </div>
                    <div className="flex flex-col gap-2">
                      <label className="text-[11px] font-bold text-[#78786C] uppercase tracking-wider">Cuisine *</label>
                      <input type="text" value={adminCuisine} onChange={e => setAdminCuisine(e.target.value)} required className="px-5 py-3.5 rounded-full border border-[#DED8CF] focus:border-[#5D7052] focus:ring-2 focus:ring-[#5D7052]/20 focus:outline-none text-sm bg-[#FDFCF8] text-[#2C2C24] shadow-sm transition-all" placeholder="e.g. French, Indian, Italian" />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
                    <div className="flex flex-col gap-2">
                      <label className="text-[11px] font-bold text-[#78786C] uppercase tracking-wider">Cook Time (Minutes) *</label>
                      <input type="number" min={1} value={adminTime} onChange={e => setAdminTime(parseInt(e.target.value) || 0)} required className="px-5 py-3.5 rounded-full border border-[#DED8CF] focus:border-[#5D7052] focus:ring-2 focus:ring-[#5D7052]/20 focus:outline-none text-sm bg-[#FDFCF8] text-[#2C2C24] shadow-sm transition-all" />
                    </div>
                    <div className="flex flex-col gap-2">
                      <label className="text-[11px] font-bold text-[#78786C] uppercase tracking-wider">Servings *</label>
                      <input type="number" min={1} value={adminServings} onChange={e => setAdminServings(parseInt(e.target.value) || 0)} required className="px-5 py-3.5 rounded-full border border-[#DED8CF] focus:border-[#5D7052] focus:ring-2 focus:ring-[#5D7052]/20 focus:outline-none text-sm bg-[#FDFCF8] text-[#2C2C24] shadow-sm transition-all" />
                    </div>
                    <div className="flex flex-col gap-2">
                      <label className="text-[11px] font-bold text-[#78786C] uppercase tracking-wider">Difficulty *</label>
                      <select value={adminDifficulty} onChange={e => setAdminDifficulty(e.target.value)} className="px-5 py-3.5 rounded-full border border-[#DED8CF] focus:border-[#5D7052] focus:ring-2 focus:ring-[#5D7052]/20 focus:outline-none text-sm bg-[#FDFCF8] text-[#2C2C24] shadow-sm transition-all cursor-pointer appearance-none">
                        <option value="Easy">Easy</option>
                        <option value="Medium">Medium</option>
                        <option value="Hard">Hard</option>
                      </select>
                    </div>
                  </div>

                  <div className="flex flex-col gap-4 bg-[#F0EBE5]/30 border border-[#DED8CF]/50 p-6 rounded-[2rem]">
                    <label className="text-[11px] font-bold text-[#78786C] uppercase tracking-wider">Recipe Image / Thumbnail</label>
                    
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      {/* File Upload from PC */}
                      <div className="flex flex-col gap-2">
                        <span className="text-[10px] font-bold text-[#78786C] uppercase tracking-wider">Upload from PC</span>
                        <input 
                          type="file" 
                          accept="image/*" 
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) {
                              const reader = new FileReader();
                              reader.onloadend = () => {
                                setAdminImageUrl(reader.result as string);
                              };
                              reader.readAsDataURL(file);
                            }
                          }}
                          className="px-4 py-2.5 rounded-full border border-[#DED8CF] text-xs bg-white cursor-pointer focus:outline-none file:mr-3 file:py-1.5 file:px-3 file:rounded-full file:border-0 file:text-[11px] file:font-bold file:bg-[#5D7052]/10 file:text-[#5D7052] hover:file:bg-[#5D7052]/20 file:cursor-pointer file:transition-colors text-[#78786C]"
                        />
                      </div>

                      {/* Paste URL */}
                      <div className="flex flex-col gap-2">
                        <span className="text-[10px] font-bold text-[#78786C] uppercase tracking-wider">Or Paste Image URL</span>
                        <input 
                          type="url" 
                          value={adminImageUrl.startsWith('data:') ? '' : adminImageUrl} 
                          onChange={e => setAdminImageUrl(e.target.value)} 
                          className="px-5 py-3 rounded-full border border-[#DED8CF] focus:border-[#5D7052] focus:ring-2 focus:ring-[#5D7052]/20 focus:outline-none text-xs bg-[#FDFCF8] text-[#2C2C24] transition-all" 
                          placeholder="https://images.unsplash.com/..." 
                        />
                      </div>
                    </div>

                    {/* Preview Thumbnail */}
                    {adminImageUrl && (
                      <div className="mt-4 flex items-center gap-4">
                        <div className="w-16 h-16 bg-[#F0EBE5] rounded-[1rem] overflow-hidden shadow-inner border border-[#DED8CF] shrink-0">
                          <img src={adminImageUrl} alt="Preview" className="w-full h-full object-cover" />
                        </div>
                        <div className="min-w-0">
                          <p className="text-[10px] font-bold text-[#78786C] uppercase tracking-wider">Image Preview</p>
                          <button 
                            type="button" 
                            onClick={() => setAdminImageUrl('')} 
                            className="text-[11px] font-bold text-[#A85448] hover:text-[#2C2C24] cursor-pointer mt-1"
                          >
                            Remove Image
                          </button>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Veg / Non-Veg Toggle */}
                  <div className="flex flex-col gap-2">
                    <label className="text-[11px] font-bold text-[#78786C] uppercase tracking-wider">Recipe Type *</label>
                    <div className="flex gap-4">
                      <button
                        type="button"
                        onClick={() => setAdminDietary(['Veg'])}
                        className={`flex-1 py-3.5 rounded-full border text-sm font-bold transition-all cursor-pointer flex items-center justify-center gap-2 ${
                          adminDietary.includes('Veg')
                            ? 'bg-[#5D7052] border-[#5D7052] text-[#F3F4F1] shadow-soft'
                            : 'bg-white border-[#DED8CF] text-[#78786C] hover:border-[#5D7052]/50 hover:text-[#2C2C24]'
                        }`}
                      >
                        <span className={`w-2.5 h-2.5 rounded-full ${adminDietary.includes('Veg') ? 'bg-[#F3F4F1]' : 'bg-[#5D7052]'}`} /> Veg
                      </button>
                      <button
                        type="button"
                        onClick={() => setAdminDietary(['Non-Veg'])}
                        className={`flex-1 py-3.5 rounded-full border text-sm font-bold transition-all cursor-pointer flex items-center justify-center gap-2 ${
                          adminDietary.includes('Non-Veg')
                            ? 'bg-[#A85448] border-[#A85448] text-white shadow-soft'
                            : 'bg-white border-[#DED8CF] text-[#78786C] hover:border-[#A85448]/50 hover:text-[#2C2C24]'
                        }`}
                      >
                        <span className={`w-2.5 h-2.5 rounded-full ${adminDietary.includes('Non-Veg') ? 'bg-white' : 'bg-[#A85448]'}`} /> Non-Veg
                      </button>
                    </div>
                  </div>

                  {/* Ingredients Section */}
                  <div className="flex flex-col gap-4 border-t border-[#DED8CF]/50 pt-8">
                    <h3 className="text-lg font-serif font-bold text-[#2C2C24] flex justify-between items-center">
                      <span>Ingredients list *</span>
                      <button type="button" onClick={handleAddIngredient} className="text-[11px] font-bold text-[#5D7052] hover:text-[#F3F4F1] bg-[#5D7052]/10 hover:bg-[#5D7052] px-4 py-2 rounded-full transition-all duration-300 cursor-pointer uppercase tracking-wider">
                        + Add Ingredient
                      </button>
                    </h3>
                    
                    <div className="flex flex-col gap-4">
                      {adminIngredients.map((ing, idx) => (
                        <div key={idx} className="flex gap-3 items-center flex-wrap sm:flex-nowrap">
                          <input type="text" value={ing.name} required onChange={e => handleIngredientChange(idx, 'name', e.target.value)} className="flex-1 px-4 py-3 rounded-xl border border-[#DED8CF] focus:border-[#5D7052] focus:ring-2 focus:ring-[#5D7052]/20 focus:outline-none text-[13px] bg-[#FDFCF8] text-[#2C2C24] min-w-[150px]" placeholder="Ingredient Name (e.g. Chicken breast)" />
                          <input type="text" value={ing.amount} required onChange={e => handleIngredientChange(idx, 'amount', e.target.value)} className="w-full sm:w-24 px-4 py-3 rounded-xl border border-[#DED8CF] focus:border-[#5D7052] focus:ring-2 focus:ring-[#5D7052]/20 focus:outline-none text-[13px] bg-[#FDFCF8] text-[#2C2C24]" placeholder="Qty" />
                          <input type="text" value={ing.unit} onChange={e => handleIngredientChange(idx, 'unit', e.target.value)} className="w-full sm:w-28 px-4 py-3 rounded-xl border border-[#DED8CF] focus:border-[#5D7052] focus:ring-2 focus:ring-[#5D7052]/20 focus:outline-none text-[13px] bg-[#FDFCF8] text-[#2C2C24]" placeholder="Unit (e.g. g)" />
                          <button type="button" disabled={adminIngredients.length === 1} onClick={() => handleRemoveIngredient(idx)} className="text-[#78786C] hover:text-[#A85448] p-3 rounded-full disabled:opacity-30 disabled:hover:bg-transparent hover:bg-[#A85448]/10 transition-all cursor-pointer">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Steps Section */}
                  <div className="flex flex-col gap-4 border-t border-[#DED8CF]/50 pt-8">
                    <h3 className="text-lg font-serif font-bold text-[#2C2C24] flex justify-between items-center">
                      <span>Cooking Instructions Steps *</span>
                      <button type="button" onClick={handleAddStep} className="text-[11px] font-bold text-[#5D7052] hover:text-[#F3F4F1] bg-[#5D7052]/10 hover:bg-[#5D7052] px-4 py-2 rounded-full transition-all duration-300 cursor-pointer uppercase tracking-wider">
                        + Add Step
                      </button>
                    </h3>

                    <div className="flex flex-col gap-5">
                      {adminSteps.map((step, idx) => (
                        <div key={idx} className="border border-[#DED8CF] p-6 rounded-[2rem] flex flex-col gap-5 bg-[#F0EBE5]/30 relative">
                          <div className="flex justify-between items-center border-b border-[#DED8CF]/50 pb-3">
                            <span className="text-[11px] font-bold text-[#78786C] uppercase tracking-wider">Step {idx + 1}</span>
                            <button type="button" disabled={adminSteps.length === 1} onClick={() => handleRemoveStep(idx)} className="text-[#A85448] hover:text-white text-[10px] font-bold uppercase tracking-wider hover:bg-[#A85448] px-3 py-1.5 rounded-full transition-all cursor-pointer disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-[#A85448]">
                              Delete Step
                            </button>
                          </div>
                          
                          <div className="flex flex-col gap-2">
                            <label className="text-[11px] font-bold text-[#78786C] uppercase tracking-wider">Instruction Text *</label>
                            <textarea rows={3} required value={step.text} onChange={e => handleStepChange(idx, 'text', e.target.value)} className="w-full px-5 py-4 rounded-xl border border-[#DED8CF] focus:border-[#5D7052] focus:ring-2 focus:ring-[#5D7052]/20 focus:outline-none text-[13px] bg-[#FDFCF8] text-[#2C2C24] resize-y shadow-inner" placeholder="Describe the instruction step detail clearly..." />
                          </div>

                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                            <div className="flex flex-col gap-2">
                              <label className="text-[11px] font-bold text-[#78786C] uppercase tracking-wider">Suggested Timer (Seconds)</label>
                              <input type="number" min={0} value={step.timer_duration} onChange={e => handleStepChange(idx, 'timer_duration', e.target.value)} className="w-full px-4 py-3 rounded-xl border border-[#DED8CF] focus:border-[#5D7052] focus:ring-2 focus:ring-[#5D7052]/20 focus:outline-none text-[13px] bg-[#FDFCF8] text-[#2C2C24]" placeholder="e.g. 300 for 5 minutes" />
                            </div>
                            <div className="flex flex-col gap-2">
                              <label className="text-[11px] font-bold text-[#78786C] uppercase tracking-wider">Safety Alert / warning</label>
                              <input type="text" value={step.safety_alert} onChange={e => handleStepChange(idx, 'safety_alert', e.target.value)} className="w-full px-4 py-3 rounded-xl border border-[#DED8CF] focus:border-[#5D7052] focus:ring-2 focus:ring-[#5D7052]/20 focus:outline-none text-[13px] bg-[#FDFCF8] text-[#2C2C24]" placeholder="e.g. Watch out for splattering hot oil!" />
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <button type="submit" disabled={publishing} className="w-full mt-4 bg-[#5D7052] hover:bg-[#5D7052]/90 text-[#F3F4F1] font-bold py-4 rounded-full shadow-soft active:scale-[0.99] transition-all flex items-center justify-center gap-3 cursor-pointer text-sm uppercase tracking-wider disabled:opacity-50">
                    {publishing ? (
                      <>
                        <div className="w-5 h-5 border-2 border-[#F3F4F1] border-t-transparent rounded-full animate-spin" />
                        Generating Embeddings & Publishing...
                      </>
                    ) : (
                      'Publish Recipe to Catalog'
                    )}
                  </button>
                </form>
              </div>
            </div>
          </div>
        ) : (
          /* Cooking Mode: Clean, Dark, Large Text Kitchen Dashboard */
          selectedRecipe && (
            <div className="h-screen bg-[#1A1A14] text-[#F3F4F1] flex flex-col overflow-hidden relative font-sans">
              {/* Header controls bar */}
              <div className="flex items-center justify-between py-5 px-8 border-b border-[#2C2C24] z-10 bg-[#1A1A14]/80 backdrop-blur-md">
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => {
                      timers.clearAllTimers();
                      voice.stop();
                      setView('detail');
                    }}
                    className="text-[#A0A096] hover:text-[#F3F4F1] p-3 rounded-full hover:bg-[#2C2C24] transition-colors cursor-pointer text-sm font-bold uppercase tracking-wider"
                  >
                    ✕ Close Mode
                  </button>
                </div>

                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-2 bg-[#2C2C24] border border-[#4A4A40] rounded-full px-4 py-2 shadow-inner">
                    <span className="text-[10px] font-bold text-[#A0A096] uppercase tracking-wider">Voice:</span>
                    <span className="text-[10px] font-bold px-3 py-1.5 rounded-full uppercase tracking-wider bg-[#4A4A40] text-[#F3F4F1] shadow-soft">
                      Web Speech
                    </span>
                  </div>
                </div>
              </div>

              {/* Step Content Card / Split Screen with Chat Drawer */}
              <div className="flex-1 flex flex-col md:flex-row overflow-hidden relative max-w-7xl mx-auto w-full z-10">
                {/* Left Side: Cooking steps and visual wave */}
                <div className="flex-1 flex flex-col justify-between p-8 overflow-y-auto min-w-0">
                  <div className="space-y-4">
                    <div className="flex justify-between items-center">
                      <span className="text-xs font-bold text-[#C18C5D] uppercase tracking-wider">
                        Step {currentStep + 1} of {selectedRecipe.steps.length}
                      </span>
                      <span className="text-sm font-serif font-bold text-[#A0A096] truncate max-w-[250px]">
                        {selectedRecipe.title}
                      </span>
                    </div>
                    
                    {/* Progress bar */}
                    <div className="w-full bg-[#2C2C24] h-2.5 rounded-full overflow-hidden flex gap-1 shadow-inner">
                      {selectedRecipe.steps.map((s, idx) => (
                        <div 
                          key={s.step}
                          className={`flex-1 h-full rounded-full transition-all duration-500 ${
                            idx === currentStep 
                              ? 'bg-[#5D7052]' 
                              : idx < currentStep 
                                ? 'bg-[#5D7052]/40' 
                                : 'bg-[#2C2C24]'
                          }`}
                        />
                      ))}
                    </div>
                  </div>



                  {/* Main Instruction */}
                  <div className="flex-1 flex flex-col justify-center gap-8 py-8 text-center">
                    {selectedRecipe.steps[currentStep].safety_alert && (
                      <div className="bg-[#A85448]/20 border border-[#A85448]/50 text-[#F3F4F1] p-4 rounded-[1.5rem] text-xs font-bold flex items-center justify-center gap-2 max-w-xl mx-auto shadow-float backdrop-blur-sm">
                        <span className="tracking-wider uppercase">SAFETY ALERT: {selectedRecipe.steps[currentStep].safety_alert}</span>
                      </div>
                    )}

                    <h2 className="text-4xl md:text-5xl lg:text-6xl font-serif font-bold leading-tight tracking-tight max-w-3xl mx-auto select-text selection:bg-[#5D7052]/40 text-[#F3F4F1]">
                      "{selectedRecipe.steps[currentStep].text}"
                    </h2>

                    {/* Step Ingredients details */}
                    <div className="flex flex-wrap gap-3 justify-center max-w-xl mx-auto mt-6">
                      {selectedRecipe.ingredients.map(ing => {
                        const isMentioned = selectedRecipe.steps[currentStep].text.toLowerCase().includes(ing.name.toLowerCase().split(' ')[0]);
                        if (!isMentioned) return null;
                        return (
                          <span key={ing.name} className="text-sm font-bold bg-[#2C2C24] border border-[#4A4A40] px-4 py-2 rounded-full text-[#DED8CF] shadow-sm">
                            {ing.amount} {ing.unit} {ing.name}
                          </span>
                        );
                      })}
                    </div>

                    {/* Next step overview */}
                    {currentStep < selectedRecipe.steps.length - 1 ? (
                      <div className="mt-8 p-5 bg-[#2C2C24]/60 border border-[#4A4A40] rounded-[1.5rem] max-w-xl mx-auto text-left shadow-inner backdrop-blur-sm">
                        <span className="text-[10px] font-bold text-[#C18C5D] uppercase tracking-wider block mb-2">Up Next:</span>
                        <p className="text-sm text-[#DED8CF] font-serif font-medium line-clamp-2">
                          {selectedRecipe.steps[currentStep + 1].text}
                        </p>
                      </div>
                    ) : (
                      <div className="mt-8 p-5 bg-[#5D7052]/20 border border-[#5D7052]/40 rounded-[1.5rem] max-w-xl mx-auto text-left shadow-inner backdrop-blur-sm">
                        <span className="text-[10px] font-bold text-[#F3F4F1] uppercase tracking-wider block mb-2">Up Next:</span>
                        <p className="text-sm text-[#F3F4F1] font-serif font-bold">
                          Finish and submit your cooking entry!
                        </p>
                      </div>
                    )}

                    {/* Step Navigation Buttons */}
                    <div className="flex items-center justify-center gap-4 mt-8">
                      <button
                        onClick={handlePrevStep}
                        disabled={currentStep === 0}
                        className={`px-5 py-3 rounded-full text-xs font-bold uppercase tracking-wider flex items-center gap-2 transition-all duration-300 select-none ${
                          currentStep === 0
                            ? 'bg-[#2C2C24] text-[#78786C] border border-[#4A4A40] cursor-not-allowed opacity-50'
                            : 'bg-[#2C2C24] border border-[#4A4A40] text-[#DED8CF] hover:text-[#F3F4F1] hover:bg-[#4A4A40] active:scale-95 cursor-pointer shadow-sm'
                        }`}
                      >
                        ← Previous
                      </button>

                      <button
                        onClick={handleRepeatStep}
                        className="px-5 py-3 bg-[#2C2C24] border border-[#4A4A40] text-[#DED8CF] hover:text-[#F3F4F1] hover:bg-[#4A4A40] rounded-full text-xs font-bold uppercase tracking-wider transition-all duration-300 active:scale-95 cursor-pointer select-none shadow-sm"
                        title="Repeat current step instructions"
                      >
                        Repeat
                      </button>

                      {currentStep < selectedRecipe.steps.length - 1 ? (
                        <button
                          onClick={handleNextStep}
                          className="px-6 py-3 bg-[#5D7052] hover:bg-[#5D7052]/90 text-[#F3F4F1] rounded-full text-xs font-bold uppercase tracking-wider flex items-center gap-2 transition-all duration-300 active:scale-95 shadow-soft cursor-pointer select-none"
                        >
                          Next Step →
                        </button>
                      ) : (
                        <button
                          onClick={() => {
                            setCompletionRating(5);
                            setShowCompletionModal(true);
                          }}
                          className="px-6 py-3 bg-gradient-to-r from-[#5D7052] to-[#4A5D40] hover:from-[#4A5D40] hover:to-[#364A2F] text-[#F3F4F1] rounded-full text-xs font-bold uppercase tracking-wider flex items-center gap-2 transition-all duration-300 active:scale-95 shadow-float cursor-pointer select-none animate-pulse"
                        >
                          Submit Completion
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Waveform visualizer */}
                  <div className="space-y-6">
                    <Waveform status={voice.status} analyser={voice.analyser} muted={voice.isMuted} />

                    {/* Mute / unmute the microphone */}
                    <div className="flex justify-center">
                      <button
                        onClick={voice.toggleMute}
                        disabled={voice.status === 'idle' || voice.status === 'connecting'}
                        aria-pressed={voice.isMuted}
                        aria-label={voice.isMuted ? 'Unmute microphone' : 'Mute microphone'}
                        className={`px-6 py-3 rounded-full text-xs font-bold uppercase tracking-wider flex items-center gap-2 transition-all duration-300 active:scale-95 shadow-float cursor-pointer select-none disabled:opacity-40 disabled:cursor-not-allowed ${
                          voice.isMuted
                            ? 'bg-amber-500/90 hover:bg-amber-500 text-[#1A1A14]'
                            : 'bg-[#2C2C24] hover:bg-[#3A3A30] text-[#F3F4F1] border border-[#4A4A40]'
                        }`}
                      >
                        {voice.isMuted ? (
                          <>
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
                              <path d="M13.5 4.06c0-1.336-1.616-2.005-2.56-1.06l-2.72 2.72H6.75A2.75 2.75 0 0 0 4 8.47v7.06a2.75 2.75 0 0 0 2.75 2.75h1.47l2.72 2.72c.944.945 2.56.276 2.56-1.06V4.06Z" />
                              <path d="m17.28 9.22 1.72 1.72 1.72-1.72a.75.75 0 1 1 1.06 1.06L20.06 12l1.72 1.72a.75.75 0 1 1-1.06 1.06L19 13.06l-1.72 1.72a.75.75 0 1 1-1.06-1.06L17.94 12l-1.72-1.72a.75.75 0 1 1 1.06-1.06Z" />
                            </svg>
                            Unmute Mic
                          </>
                        ) : (
                          <>
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
                              <path d="M8.25 4.5a3.75 3.75 0 1 1 7.5 0v8.25a3.75 3.75 0 1 1-7.5 0V4.5Z" />
                              <path d="M6 10.5a.75.75 0 0 1 .75.75v1.5a5.25 5.25 0 1 0 10.5 0v-1.5a.75.75 0 0 1 1.5 0v1.5a6.751 6.751 0 0 1-6 6.709v2.291h3a.75.75 0 0 1 0 1.5h-7.5a.75.75 0 0 1 0-1.5h3v-2.291a6.751 6.751 0 0 1-6-6.709v-1.5A.75.75 0 0 1 6 10.5Z" />
                            </svg>
                            Mute Mic
                          </>
                        )}
                      </button>
                    </div>

                    <div className="text-center text-[10px] text-[#A0A096] font-bold uppercase tracking-wider flex flex-wrap items-center justify-center gap-4 select-none">
                      <span className="bg-[#2C2C24] px-3 py-1.5 rounded-full border border-[#4A4A40]">Speak: "next"</span>
                      <span className="bg-[#2C2C24] px-3 py-1.5 rounded-full border border-[#4A4A40]">"go back"</span>
                      <span className="bg-[#2C2C24] px-3 py-1.5 rounded-full border border-[#4A4A40]">"repeat step"</span>
                      <span className="bg-[#2C2C24] px-3 py-1.5 rounded-full border border-[#4A4A40]">"set 5 minute timer"</span>
                    </div>
                  </div>
                </div>

                {/* Right Side: Conversation Chat Logs & Keyboard Input Drawer */}
                <div className="w-full md:w-96 border-t md:border-t-0 md:border-l border-[#2C2C24] bg-[#1A1A14]/50 backdrop-blur-xl flex flex-col h-[360px] md:h-auto overflow-hidden relative shadow-inner">
                  <div className="px-6 py-4 border-b border-[#2C2C24] bg-[#1A1A14] flex items-center justify-between text-[#A0A096] font-bold text-[11px] uppercase tracking-wider">
                    <span>Chat Drawer</span>
                    <span className="text-[9px] text-[#78786C] font-semibold bg-[#2C2C24] px-2 py-0.5 rounded-full">Keyboard Supported</span>
                  </div>

                  {/* Model selector — same picker as the home assistant, kept in sync */}
                  <div className="px-6 py-3 border-b border-[#2C2C24] bg-[#1A1A14]/60">
                    <ModelSelector value={voice.modelProvider} onChange={voice.setModelProvider} />
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
                  <form onSubmit={handleTextSubmit} className="p-5 border-t border-[#2C2C24] bg-[#1A1A14] flex gap-3">
                    <input
                      type="text"
                      placeholder="Ask recipe questions..."
                      value={textInput}
                      onChange={(e) => setTextInput(e.target.value)}
                      className="flex-1 bg-[#2C2C24] border border-[#4A4A40] rounded-full px-5 py-3 text-sm text-[#F3F4F1] focus:outline-none focus:border-[#5D7052] transition-all duration-300 placeholder:text-[#78786C] shadow-inner"
                    />
                    <button
                      type="submit"
                      className="bg-[#5D7052] hover:bg-[#5D7052]/90 text-[#F3F4F1] font-bold px-5 py-3 rounded-full text-xs uppercase tracking-wider transition-all duration-300 cursor-pointer active:scale-95 shadow-soft"
                    >
                      Send
                    </button>
                  </form>
                </div>
              </div>

              {/* Active Timers overlays */}
              <div className="absolute top-24 right-8 z-30">
                <TimerWidget 
                  timers={timers.timers} 
                  onCancel={timers.removeTimer} 
                  onAddSeconds={timers.addTimeToTimer}
                />
              </div>

              {/* Background ambient lighting */}
              <div className="absolute top-1/4 left-1/4 w-[500px] h-[500px] bg-[#5D7052]/10 rounded-full blur-[120px] pointer-events-none blob-1" />
              <div className="absolute bottom-1/4 right-1/4 w-[500px] h-[500px] bg-[#C18C5D]/10 rounded-full blur-[120px] pointer-events-none blob-2" />
            </div>
          )
        )}
      </main>

      {/* Floating launcher for the home chat assistant */}
      {(view === 'home' || view === 'detail') && !showAssistant && (
        <button
          onClick={openAssistant}
          aria-label="Open ChefVoice assistant"
          className="fixed bottom-6 right-6 z-40 flex items-center gap-2.5 bg-[#5D7052] hover:bg-[#4A5D40] text-[#F3F4F1] pl-4 pr-5 py-3.5 rounded-full shadow-[0_10px_30px_-5px_rgba(93,112,82,0.5)] transition-all active:scale-95 cursor-pointer"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
            <path d="M8.25 4.5a3.75 3.75 0 1 1 7.5 0v8.25a3.75 3.75 0 1 1-7.5 0V4.5Z" />
            <path d="M6 10.5a.75.75 0 0 1 .75.75v1.5a5.25 5.25 0 1 0 10.5 0v-1.5a.75.75 0 0 1 1.5 0v1.5a6.751 6.751 0 0 1-6 6.709v2.291h3a.75.75 0 0 1 0 1.5h-7.5a.75.75 0 0 1 0-1.5h3v-2.291a6.751 6.751 0 0 1-6-6.709v-1.5A.75.75 0 0 1 6 10.5Z" />
          </svg>
          <span className="text-sm font-bold">Ask ChefVoice</span>
        </button>
      )}

      {/* Home chat assistant panel (recipe discovery) */}
      {showAssistant && (
        <AssistantPanel
          voice={voice}
          suggestions={assistantSuggestions}
          onPick={handlePickRecipe}
          onClose={closeAssistant}
        />
      )}

      {/* Auth Modal */}
      {showAuthModal && (
        <Auth 
          onAuthSuccess={() => {
            setShowAuthModal(false);
            const currentSession = getSession();
            if (currentSession?.user) loadUserProfile(currentSession.user.id);
          }}
          onClose={() => setShowAuthModal(false)} 
        />
      )}

      {/* User Profile sliding panel */}
      {session && userProfile && (
        <UserProfilePanel
          userId={session.user.id}
          userEmail={session.user.username}
          recipes={recipes}
          isOpen={showProfilePanel}
          onClose={() => setShowProfilePanel(false)}
          onSelectRecipe={handleSelectRecipe}
          onLogout={handleLogout}
          onProfileUpdate={() => loadUserProfile(session.user.id)}
        />
      )}

      {/* Saved Conversations logs history panel */}
      <HistoryPanel
        isOpen={showHistoryPanel}
        onClose={() => setShowHistoryPanel(false)}
      />

      <ShoppingListPanel
        isOpen={showShoppingList}
        onClose={() => setShowShoppingList(false)}
        refreshKey={shoppingRefreshKey}
      />

      {/* Recipe Completion Star Rating Modal */}
      {showCompletionModal && selectedRecipe && (
        <div className="fixed inset-0 bg-[#1A1A14]/80 backdrop-blur-xl z-50 flex items-center justify-center p-4">
          <div className="bg-[#2C2C24] border border-[#4A4A40] rounded-[2rem] p-8 max-w-sm w-full text-[#F3F4F1] shadow-float relative space-y-6 animate-in fade-in zoom-in-95 duration-300">
            {/* Decorative Icon */}
            <div className="text-center">

              <h3 className="text-2xl font-serif font-bold text-[#F3F4F1]">Recipe Completed!</h3>
              <p className="text-sm text-[#A0A096] mt-2 px-2 leading-relaxed">
                Congratulations on finishing <strong className="text-[#C18C5D] font-bold">{selectedRecipe.title}</strong>! How would you rate your cooking experience?
              </p>
            </div>

            {/* Star Rating Section */}
            <div className="space-y-3 text-center bg-[#1A1A14] py-5 px-4 rounded-[1.5rem] shadow-inner border border-[#4A4A40]/50">
              <div className="flex items-center justify-center gap-3">
                {[1, 2, 3, 4, 5].map((star) => (
                  <button
                    key={star}
                    type="button"
                    onClick={() => setCompletionRating(star)}
                    className={`text-4xl focus:outline-none transition-transform hover:scale-110 cursor-pointer bg-transparent border-none ${
                      star <= completionRating ? 'text-[#C18C5D] drop-shadow-md' : 'text-[#4A4A40]'
                    }`}
                  >
                    {star <= completionRating ? '★' : '☆'}
                  </button>
                ))}
              </div>
              <p className="text-sm text-[#C18C5D] font-bold h-5 uppercase tracking-wider">
                {completionRating === 1 && 'Needs practice'}
                {completionRating === 2 && 'It was okay'}
                {completionRating === 3 && 'Tasted good!'}
                {completionRating === 4 && 'Delicious!'}
                {completionRating === 5 && 'Chef standard!'}
              </p>
            </div>

            {/* Warning if not logged in */}
            {!session && (
              <div className="bg-[#A85448]/20 border border-[#A85448]/40 text-[#F3F4F1] text-[11px] p-4 rounded-2xl font-bold leading-relaxed shadow-sm">
                ⚠️ You are not signed in. Sign in to save this achievement to your kitchen profile, or submit to finish.
              </div>
            )}

            {/* Actions */}
            <div className="flex flex-col gap-3 pt-2">
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
                className="w-full bg-[#5D7052] hover:bg-[#5D7052]/90 text-[#F3F4F1] font-bold py-3.5 rounded-full transition-all duration-300 cursor-pointer text-center text-sm shadow-soft active:scale-95 uppercase tracking-wider"
              >
                {session ? 'Submit & Save' : 'Finish Without Saving'}
              </button>
              
              {!session && (
                <button
                  onClick={() => {
                    setShowCompletionModal(false);
                    setShowAuthModal(true);
                  }}
                  className="w-full bg-[#4A4A40] hover:bg-[#4A4A40]/80 text-[#F3F4F1] font-bold py-3.5 rounded-full transition-all duration-300 cursor-pointer text-center text-sm shadow-sm active:scale-95 uppercase tracking-wider"
                >
                  Sign In to Save
                </button>
              )}

              <button
                onClick={() => setShowCompletionModal(false)}
                className="w-full bg-transparent border border-[#4A4A40] hover:border-[#78786C] text-[#A0A096] hover:text-[#F3F4F1] font-bold py-3.5 rounded-full transition-all duration-300 cursor-pointer text-center text-sm active:scale-95 uppercase tracking-wider"
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
