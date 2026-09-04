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
  saveConversation,
  createRecipe,
  deleteRecipe,
  importRecipeFromUrl,
  getSession,
  onAuthChange,
  logout
} from './lib/api';
import { getPreferredVoice } from './lib/speech';
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
  
  // Smart search: sends the typed query to the backend's hybrid pipeline (embeddings + keyword
  // matching, fused) with the veg/category chips applied as real filters. Off falls back to
  // plain substring matching over the already-loaded list, which is better when you know the
  // exact name and want instant feedback.
  const [useSemanticSearch, setUseSemanticSearch] = useState(true);
  const [searching, setSearching] = useState(false);

  // Authentication & Profile states
  const [session, setSession] = useState<AppSession | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [favorites, setFavorites] = useState<Favorite[]>([]);
  
  // Cooking history and sorting states
  const [cookingHistory, setCookingHistory] = useState<CookingHistoryEntry[]>([]);
  const [sortBy, setSortBy] = useState<'default' | 'recent' | 'time' | 'rating'>('default');
  const [vegFilter, setVegFilter] = useState<'All' | 'Veg' | 'Non-Veg'>('All');
  const [showCompletionModal, setShowCompletionModal] = useState(false);
  // 0 = not rated yet. This used to default to 5, so anyone who hit "Submit &
  // Save" without touching the stars silently recorded a five-star review — which
  // is why every rated recipe in the catalogue sat at exactly 5.0 and the
  // "Highest Rated" sort meant nothing. Rating is optional; 0 sends none.
  const [completionRating, setCompletionRating] = useState<number>(0);
  // Wall-clock ms when this cook began, so the history log records how long it
  // actually took. Persisted with the resume state so it survives a reload.
  const [cookStartedAt, setCookStartedAt] = useState<number | null>(null);
  
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

  // Offer to resume an in-progress cook found in localStorage after a reload.
  const [resumeCook, setResumeCook] = useState<{ recipe: Recipe; step: number; startedAt?: number } | null>(null);
  const resumeCheckedRef = React.useRef(false);

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

  // Semantic search runs on the backend, and so do its filters. Re-running when vegFilter
  // changes is the point: the server ranks within the recipes that match, instead of handing
  // back a fixed six that we then whittle down to one or two.
  useEffect(() => {
    const query = searchQuery.trim();
    // Below two characters there is nothing for either retriever to work with, and firing on
    // the first keystroke just burns a request per letter.
    if (!useSemanticSearch || query.length < 2) {
      setSearchResults([]);
      setSearching(false);
      return;
    }

    setSearching(true);
    let cancelled = false;

    const delayDebounce = setTimeout(async () => {
      try {
        const results = await searchRecipes(query, {
          is_veg: vegFilter === 'All' ? undefined : vegFilter === 'Veg',
          category: selectedCuisine === 'All' ? undefined : selectedCuisine,
          limit: 12,
        });
        // A slow response for an old query must not overwrite a newer one.
        if (!cancelled) setSearchResults(results);
      } catch (err) {
        console.error("Semantic search failed:", err);
        if (!cancelled) setSearchResults([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 350);

    return () => {
      cancelled = true;
      clearTimeout(delayDebounce);
    };
  }, [searchQuery, useSemanticSearch, vegFilter, selectedCuisine]);

  // Filter recipes based on category, search query and Veg/Non-Veg filter.
  //
  // Semantic results arrive already filtered by the server, so they are passed straight
  // through. Only the plain browse list is filtered here.
  const displayRecipes = React.useMemo(() => {
    // Must match the effect's condition exactly, or a one-character query renders an empty
    // grid: the effect declines to search, and this branch has nothing to show.
    const isSemantic = useSemanticSearch && searchQuery.trim().length >= 2;
    if (isSemantic) return searchResults;

    let base = recipes.filter((r) => {
      const bucket = r.category ?? r.cuisine;
      const matchesCuisine = selectedCuisine === 'All' || bucket === selectedCuisine;
      const needle = searchQuery.toLowerCase();
      const matchesSearch =
        r.title.toLowerCase().includes(needle) ||
        r.cuisine.toLowerCase().includes(needle) ||
        bucket.toLowerCase().includes(needle) ||
        r.ingredients.some(i => i.name.toLowerCase().includes(needle));
      return matchesCuisine && matchesSearch;
    });

    if (vegFilter !== 'All') {
      const targetIsVeg = vegFilter === 'Veg';
      base = base.filter(r => {
        // The server materializes is_veg; fall back to the tags only for older payloads.
        const isVeg = r.is_veg
          ?? (r.dietary?.some(d => d.toLowerCase() === 'veg' || d.toLowerCase() === 'vegan') ?? false);
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

  // Explore leads with one dish and grids the rest behind it.
  const featureRecipe = sortedRecipes[0] ?? null;

  // Latest cook date per recipe, formatted for the card badge.
  const cookedDates = React.useMemo(() => {
    const latest: Record<string, string> = {};
    cookingHistory.forEach(entry => {
      const current = latest[entry.recipe_id];
      if (!current || new Date(entry.completed_at) > new Date(current)) {
        latest[entry.recipe_id] = entry.completed_at;
      }
    });
    const formatted: Record<string, string> = {};
    Object.entries(latest).forEach(([id, iso]) => {
      formatted[id] = new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    });
    return formatted;
  }, [cookingHistory]);

  // How many times each recipe has been finished — drives the feature eyebrow.
  const cookCounts = React.useMemo(() => {
    const counts: Record<string, number> = {};
    cookingHistory.forEach(entry => {
      counts[entry.recipe_id] = (counts[entry.recipe_id] || 0) + 1;
    });
    return counts;
  }, [cookingHistory]);

  // One voice indicator for cooking mode to share between the header dot, the
  // waveform and the mute control, so they can never disagree.
  const voiceState = voice.isMuted
    ? { label: 'Mic muted', color: '#A29A88' }
    : voice.status === 'recording'
      ? { label: 'Listening', color: '#7E9270' }
      : voice.status === 'isAiThinking'
        ? { label: 'Thinking', color: '#A29A88' }
        : voice.status === 'isAiSpeaking'
          ? { label: 'Speaking', color: '#C97A46' }
          : voice.status === 'connecting'
            ? { label: 'Connecting', color: '#C97A46' }
            : { label: 'Mic off', color: '#6E6858' };

  // Ingredients the current step actually mentions, matched on the first word
  // of the ingredient name.
  const stepIngredients = React.useMemo(() => {
    if (!selectedRecipe) return [];
    const text = selectedRecipe.steps[currentStep]?.text.toLowerCase() ?? '';
    return selectedRecipe.ingredients.filter(ing =>
      text.includes(ing.name.toLowerCase().split(' ')[0])
    );
  }, [selectedRecipe, currentStep]);

  // Wall-clock minutes in cooking mode. Timers re-render every second when one
  // is running, but a cook with no timer would otherwise show a frozen count.
  const [nowTick, setNowTick] = useState(Date.now());
  useEffect(() => {
    if (view !== 'cooking' || !cookStartedAt) return;
    setNowTick(Date.now());
    const id = setInterval(() => setNowTick(Date.now()), 30000);
    return () => clearInterval(id);
  }, [view, cookStartedAt]);
  const elapsedMinutes = cookStartedAt
    ? Math.max(0, Math.floor((nowTick - cookStartedAt) / 60000))
    : null;

  // Sync cooking state to backend WebSocket
  useEffect(() => {
    voice.sendStateUpdate({
      screen: view,
      recipe: selectedRecipe,
      current_step: currentStep,
      timers: timers.timers,
      tts_mode: 'web_speech',
    });
  }, [view, selectedRecipe, currentStep, timers.timers, userProfile]);

  // Local Web Speech synthesis for UI-triggered reading
  const speakLocal = (text: string) => {
    if (!window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    const voiceObj = getPreferredVoice();
    if (voiceObj) utterance.voice = voiceObj;
    window.speechSynthesis.speak(utterance);
  };

  // A short title for a saved discovery chat: the first thing the user asked.
  const discoveryTitle = () => {
    const firstUser = voice.messages.find((m) => m.role === 'user');
    return firstUser ? firstUser.text.slice(0, 60) : 'Recipe chat';
  };

  // Persist the current voice transcript (minus tool chips) as a saved
  // conversation, then tear the session down. Called at genuine end-of-session
  // points so the History panel has something to show. Best-effort: reads the
  // messages before voice.stop() clears them, and never blocks or throws.
  const endVoiceSession = (title: string) => {
    const msgs = voice.messages
      .filter((m) => m.role !== 'tool')
      .map((m) => ({ role: m.role, text: m.text }));
    if (session?.user && msgs.length > 0) {
      saveConversation(title || 'Voice session', msgs).catch((err) =>
        console.error('Failed to save conversation:', err),
      );
    }
    voice.stop();
  };

  // localStorage key holding an in-progress cook so it can be resumed after a reload.
  const ACTIVE_COOK_KEY = 'chefvoice_active_cook';
  const clearActiveCook = () => {
    try {
      localStorage.removeItem(ACTIVE_COOK_KEY);
    } catch {
      /* ignore */
    }
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
        // The assistant's results stay in the assistant. It used to also drive the
        // browse grid — typing its query into the search box, forcing Smart search
        // on, and clearing the category filter — which was both intrusive and
        // wrong: writing to searchQuery tripped the debounced search effect, which
        // then re-queried with its own limit and overwrote the grid with a
        // DIFFERENT result set than the chat was showing. That is why asking for
        // Italian listed two recipes in the chat and three in the menu.
        //
        // The two searches have different jobs anyway: the assistant answers a
        // question, the grid is the user's own browsing state. Leave the grid alone.
        if (view !== 'cooking' && params?.query) {
          if (params.results && Array.isArray(params.results) && params.results.length > 0) {
            // Hand them to the voice hook, which attaches them to the reply the
            // model is still composing, so each answer owns its own results.
            voice.attachRecipes(params.results as Recipe[]);
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
      }).catch((err) => console.error('Failed to start assistant:', err));
    }
  };

  const closeAssistant = () => {
    setShowAssistant(false);
    endVoiceSession(discoveryTitle());
  };

  // Explicit user pick (grid card or an assistant suggestion): end discovery,
  // then flow into the normal detail -> cooking screens.
  const handlePickRecipe = (recipe: Recipe) => {
    if (showAssistant) {
      setShowAssistant(false);
      endVoiceSession(discoveryTitle());
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

  // `recipeArg` lets Explore start a cook in one tap without a detour through
  // the detail screen. Reading state straight after setSelectedRecipe would see
  // the stale value, so the caller hands the recipe in and everything below —
  // the spoken step, the agent's cooking context — uses that local copy.
  // Callers wired to onClick must call it as `() => handleStartCooking()`, or
  // React passes the click event in as the recipe.
  const handleStartCooking = (recipeArg?: Recipe) => {
    const recipe = recipeArg ?? selectedRecipe;
    if (!recipe) return;

    if (recipeArg) {
      setSelectedRecipe(recipeArg);
      const checks: Record<string, boolean> = {};
      recipeArg.ingredients.forEach(i => {
        checks[i.name] = false;
      });
      setIngredientsChecked(checks);
    }

    // The discovery assistant (general AI) has its own floating panel and voice
    // session. Cooking mode is a separate full-screen experience with its own
    // agent context, so close the assistant before handing off.
    if (showAssistant) {
      setShowAssistant(false);
    }

    setView('cooking');
    setCurrentStep(0);
    setCookStartedAt(Date.now());

    // Auto-read first step
    if (recipe.steps.length > 0) {
      setTimeout(() => {
        const text = `Let's start cooking ${recipe.title}. Step 1: ${recipe.steps[0].text}`;
        speakLocal(text);
      }, 500);
    }

    // Always (re)establish a voice session dedicated to cooking so the recipe
    // agent connects with a clean 'cooking' context. If a discovery/home session
    // is still live, tear it down first — otherwise cooking would ride the stale
    // 'home' socket, the backend never logs a connection for the recipe agent,
    // and the handoff appears dead. The onclose guard in useVoiceChat makes this
    // stop()->start() handoff safe (the old socket's close is ignored).
    const cookingState = {
      screen: 'cooking',
      recipe,
      current_step: 0,
      timers: timers.timers,
    };
    if (voice.status !== 'idle') {
      // A live session here is the discovery chat we're handing off from — save
      // it before tearing it down so the conversation isn't lost.
      endVoiceSession(discoveryTitle());
    }
    voice.start(cookingState).catch((err) => console.error('Failed to start voice chat:', err));
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
      setCompletionRating(0);
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

  // Resume a previously interrupted cook at the saved step.
  const handleResumeCook = () => {
    if (!resumeCook) return;
    const { recipe, step, startedAt } = resumeCook;
    setResumeCook(null);

    setSelectedRecipe(recipe);
    const checks: Record<string, boolean> = {};
    recipe.ingredients.forEach((i) => {
      checks[i.name] = false;
    });
    setIngredientsChecked(checks);
    const safeStep = Math.min(Math.max(step, 0), recipe.steps.length - 1);
    setCurrentStep(safeStep);
    setView('cooking');
    setCookStartedAt(startedAt ?? Date.now());

    if (recipe.steps[safeStep]) {
      setTimeout(() => {
        speakLocal(`Resuming ${recipe.title} at step ${safeStep + 1}. ${recipe.steps[safeStep].text}`);
      }, 500);
    }

    const cookingState = {
      screen: 'cooking',
      recipe,
      current_step: safeStep,
      timers: timers.timers,
    };
    if (voice.status !== 'idle') {
      voice.stop();
    }
    voice.start(cookingState).catch((err) => console.error('Failed to start voice chat:', err));
  };

  const handleDismissResume = () => {
    setResumeCook(null);
    clearActiveCook();
  };

  // Keyboard step navigation in cook mode: →/Space next, ← prev, R repeat.
  // Ignored while typing in the chat drawer input so text entry still works.
  useEffect(() => {
    if (view !== 'cooking') return;

    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable) return;

      switch (e.key) {
        case 'ArrowRight':
        case ' ':
        case 'Spacebar':
          e.preventDefault();
          handleNextStep();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          handlePrevStep();
          break;
        case 'r':
        case 'R':
          handleRepeatStep();
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view, currentStep, selectedRecipe]);

  // Persist the in-progress cook so a reload can offer to resume it.
  useEffect(() => {
    if (view !== 'cooking' || !selectedRecipe) return;
    try {
      localStorage.setItem(
        ACTIVE_COOK_KEY,
        JSON.stringify({ recipeId: selectedRecipe.id, currentStep, startedAt: cookStartedAt }),
      );
    } catch {
      /* ignore */
    }
  }, [view, selectedRecipe, currentStep, cookStartedAt]);

  // Once recipes + session are loaded, offer to resume a saved cook (once).
  useEffect(() => {
    if (resumeCheckedRef.current) return;
    if (!session || recipes.length === 0) return;
    resumeCheckedRef.current = true;

    // Don't interrupt if the user is already mid-cook this session.
    if (view === 'cooking') return;
    try {
      const raw = localStorage.getItem(ACTIVE_COOK_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as { recipeId?: string; currentStep?: number; startedAt?: number };
      const recipe = recipes.find((r) => r.id === saved.recipeId);
      if (recipe && typeof saved.currentStep === 'number' && saved.currentStep > 0) {
        setResumeCook({ recipe, step: saved.currentStep, startedAt: saved.startedAt });
      } else {
        clearActiveCook();
      }
    } catch {
      clearActiveCook();
    }
  }, [session, recipes, view]);

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
    <div className="min-h-screen bg-[#FBF8F1] text-[#211E19] flex flex-col font-sans antialiased selection:bg-[#46573F]/15 selection:text-[#46573F]">
      {/* Header */}
      {view !== 'cooking' && (
        <header className="sticky top-0 z-40 bg-[#FBF8F1] border-b border-[#E4DDD0] h-[72px] px-8 xl:px-20 flex items-center justify-between gap-6">
          <button
            onClick={() => setView('home')}
            className="font-serif text-[27px] tracking-[-0.4px] text-[#211E19] hover:text-[#46573F] transition-colors cursor-pointer shrink-0"
          >
            ChefVoice
          </button>

          <nav className="hidden md:flex items-center gap-[30px] text-sm">
            <button
              onClick={() => setView('home')}
              className={`cursor-pointer transition-colors pb-[3px] ${
                view === 'home'
                  ? 'font-bold text-[#211E19] border-b-[1.5px] border-[#B4643A]'
                  : 'font-medium text-[#6A6459] hover:text-[#211E19]'
              }`}
            >
              Explore
            </button>
            <button
              onClick={() => setShowShoppingList(true)}
              className="font-medium text-[#6A6459] hover:text-[#211E19] transition-colors cursor-pointer"
            >
              Shopping list
            </button>
            <button
              onClick={() => setShowHistoryPanel(true)}
              className="font-medium text-[#6A6459] hover:text-[#211E19] transition-colors cursor-pointer"
            >
              History
            </button>
          </nav>

          <div className="flex items-center gap-[18px] shrink-0">
            {userProfile?.is_admin && (
              <>
                <button
                  onClick={() => setView(view === 'admin' ? 'home' : 'admin')}
                  className={`text-[11px] font-bold tracking-[0.13em] uppercase transition-colors cursor-pointer pb-[3px] ${
                    view === 'admin'
                      ? 'text-[#211E19] border-b-[1.5px] border-[#B4643A]'
                      : 'text-[#6A6459] hover:text-[#211E19]'
                  }`}
                >
                  Admin
                </button>
                <span className="w-px h-5 bg-[#E4DDD0]" />
              </>
            )}

            {session ? (
              <button
                onClick={() => setShowProfilePanel(true)}
                className="group flex items-center gap-2.5 cursor-pointer"
              >
                <span className="w-8 h-8 rounded-full bg-[#46573F] text-[#FBF8F1] text-[13px] font-bold flex items-center justify-center">
                  {session.user.username.charAt(0).toUpperCase()}
                </span>
                <span className="hidden sm:inline text-sm font-medium text-[#211E19] group-hover:text-[#46573F] transition-colors">
                  {session.user.username}
                </span>
              </button>
            ) : (
              <button
                onClick={() => setShowAuthModal(true)}
                className="bg-[#46573F] text-[#FBF8F1] text-sm font-bold px-6 py-2.5 rounded-full cursor-pointer active:scale-[0.98] transition-transform"
              >
                Sign in
              </button>
            )}
          </div>
        </header>
      )}

      {/* Main Container */}
      <main className="flex-1 flex flex-col">
        {loading ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="w-9 h-9 border-2 border-[#46573F] border-t-transparent rounded-full animate-spin" />
          </div>
        ) : view === 'home' ? (
          /* Explore. Type carries the hierarchy and hairlines do the dividing —
             no glass panels, and the one filled pill on the page is the primary
             action on the featured dish. */
          <div className="w-full max-w-[1600px] mx-auto px-8 xl:px-20 flex-1 flex flex-col">

            {/* Masthead */}
            <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-10 pt-14 pb-10">
              <div className="max-w-[700px]">
                <div className="text-[11px] font-bold tracking-[0.14em] uppercase text-[#8A8378]">
                  {recipes.length} {recipes.length === 1 ? 'recipe' : 'recipes'} &middot; hands-free
                </div>
                <h1 className="font-serif text-[52px] md:text-[68px] leading-[0.98] tracking-[-1.5px] mt-2.5">Explore</h1>
                <p className="text-base leading-relaxed text-[#6A6459] mt-3.5 max-w-[460px]">
                  Say what you feel like eating. ChefVoice finds the dish, then reads it out step by step while your hands stay busy.
                </p>
              </div>

              <div className="w-full lg:w-[460px] shrink-0">
                {/* Ruled input rather than a boxed one: the search line reads as
                    part of the page, not as another floating control. */}
                <div className="flex items-center gap-3.5 border-b-[1.5px] border-[#211E19] pb-3">
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-[19px] h-[19px] text-[#211E19] shrink-0">
                    <path strokeLinecap="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                  <input
                    type="text"
                    placeholder={useSemanticSearch ? 'spicy creamy curry' : 'search by name or ingredient'}
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="flex-1 min-w-0 bg-transparent text-[17px] text-[#211E19] placeholder-[#B9B1A2] focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setUseSemanticSearch(v => !v)}
                    aria-pressed={useSemanticSearch}
                    title={useSemanticSearch
                      ? 'Smart search on — meaning + keywords, filtered on the server'
                      : 'Smart search off — plain name and ingredient matching'}
                    className="flex items-center gap-2.5 shrink-0 cursor-pointer"
                  >
                    <span className={`w-[34px] h-[19px] rounded-full flex items-center px-[3px] transition-colors ${
                      useSemanticSearch ? 'bg-[#46573F] justify-end' : 'bg-[#DED6C7] justify-start'
                    }`}>
                      <span className="w-[13px] h-[13px] rounded-full bg-[#FBF8F1]" />
                    </span>
                    <span className={`text-[10px] font-bold tracking-[0.13em] transition-colors ${
                      useSemanticSearch ? 'text-[#46573F]' : 'text-[#8A8378]'
                    }`}>
                      SMART
                    </span>
                  </button>
                </div>

                <div role="status" aria-live="polite" className="text-xs text-[#8A8378] mt-2.5 h-4">
                  {searching
                    ? 'Searching…'
                    : useSemanticSearch
                      ? (searchQuery.trim().length >= 2
                        ? `${sortedRecipes.length} close ${sortedRecipes.length === 1 ? 'match' : 'matches'}`
                        : 'Meaning-based search — type it or say it')
                      : 'Matching on name and ingredients'}
                </div>
              </div>
            </div>

            {/* Filters — one line of text controls, no chips competing with the CTA */}
            <div className="flex flex-wrap items-center justify-between gap-y-4 gap-x-8 pb-4 border-b border-[#E4DDD0]">
              {/* Scrolls rather than widening the page: six cuisines do not fit
                  a phone, and letting them stretch the row made the whole
                  document scroll sideways. */}
              <div className="flex items-center gap-7 text-sm min-w-0 max-w-full overflow-x-auto scrollbar-none">
                {['All', 'Indian', 'Italian', 'Quick Meals', 'Healthy', 'Desserts'].map(cuisine => (
                  <button
                    key={cuisine}
                    onClick={() => setSelectedCuisine(cuisine)}
                    className={`whitespace-nowrap cursor-pointer transition-colors pb-1.5 ${
                      selectedCuisine === cuisine
                        ? 'font-bold text-[#211E19] border-b-2 border-[#B4643A]'
                        : 'font-medium text-[#6A6459] hover:text-[#211E19]'
                    }`}
                  >
                    {cuisine}
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-6 text-[13px] text-[#6A6459]">
                <div className="flex items-center gap-4">
                  {([['Veg', 'Veg'], ['Non-Veg', 'Non-veg'], ['All', 'Both']] as const).map(([value, label]) => (
                    <button
                      key={value}
                      onClick={() => setVegFilter(value)}
                      className={`flex items-center gap-2 cursor-pointer transition-colors ${
                        vegFilter === value ? 'font-bold text-[#211E19]' : 'font-medium hover:text-[#211E19]'
                      }`}
                    >
                      {vegFilter === value && (
                        <span className={`w-[7px] h-[7px] rounded-full ${
                          value === 'Non-Veg' ? 'bg-[#A85448]' : 'bg-[#46573F]'
                        }`} />
                      )}
                      {label}
                    </button>
                  ))}
                </div>

                <span className="w-px h-4 bg-[#E4DDD0]" />

                <label className="flex items-center gap-2 cursor-pointer">
                  <span>Sort:</span>
                  <span className="relative flex items-center">
                    {/* "default" keeps whatever order the server sent — alphabetical when
                        browsing, relevance-ranked when searching. */}
                    <select
                      value={sortBy}
                      onChange={(e) => setSortBy(e.target.value as any)}
                      className="appearance-none bg-transparent font-bold text-[#211E19] pr-5 cursor-pointer focus:outline-none"
                    >
                      <option value="default">
                        {useSemanticSearch && searchQuery.trim().length >= 2 ? 'Best match' : 'A–Z'}
                      </option>
                      <option value="rating">Highest rated</option>
                      <option value="time">Quickest</option>
                      <option value="recent">Recently cooked</option>
                    </select>
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.4} stroke="currentColor" className="w-[11px] h-[11px] text-[#211E19] absolute right-0 pointer-events-none">
                      <path strokeLinecap="round" d="M6 9l6 6 6-6" />
                    </svg>
                  </span>
                </label>
              </div>
            </div>

            {/* Results */}
            {sortedRecipes.length === 0 ? (
              <div className="py-24 text-center">
                <h3 className="font-serif text-[30px] text-[#211E19]">No recipes found</h3>
                {/* Smart search returns nothing when no recipe is a real match, rather than
                    padding the page out with the least-bad options. Say which of the two
                    knobs is responsible so the empty page is actionable. */}
                <p className="text-sm text-[#6A6459] mt-3 max-w-md mx-auto leading-relaxed">
                  {useSemanticSearch && searchQuery.trim().length >= 2
                    ? (vegFilter !== 'All' || selectedCuisine !== 'All')
                      ? <>Nothing matched <strong className="text-[#211E19]">“{searchQuery.trim()}”</strong> within the current filters. Try clearing the {vegFilter !== 'All' ? `${vegFilter} ` : ''}{selectedCuisine !== 'All' ? `${selectedCuisine} ` : ''}filter, or rephrase.</>
                      : <>Nothing in the catalogue is a close match for <strong className="text-[#211E19]">“{searchQuery.trim()}”</strong>. Try describing the dish differently.</>
                    : 'Try other search terms, or clear the filters above.'}
                </p>
              </div>
            ) : (
              <>
                <div className="flex flex-col xl:flex-row gap-10 pt-11">
                  {/* Featured dish. One recipe gets the room to be photographed
                      and started in a single tap; the rest grid out beside it. */}
                  {featureRecipe && (
                    <div className="w-full xl:w-[620px] shrink-0 flex flex-col">
                      <div
                        onClick={() => handlePickRecipe(featureRecipe)}
                        className="group relative h-[300px] xl:h-[372px] rounded-[4px] bg-[#EAE3D4] overflow-hidden cursor-pointer"
                      >
                        <img
                          src={featureRecipe.image_url || 'https://images.unsplash.com/photo-1495521821757-a1efb6729352?w=600&auto=format&fit=crop&q=60'}
                          alt={featureRecipe.title}
                          onError={(e) => {
                            const img = e.currentTarget;
                            const fallback = 'https://images.unsplash.com/photo-1495521821757-a1efb6729352?w=600&auto=format&fit=crop&q=60';
                            if (img.src !== fallback) img.src = fallback;
                          }}
                          className="w-full h-full object-cover group-hover:scale-[1.02] transition-transform duration-700"
                        />
                        <span className="absolute top-5 left-5 bg-[#FBF8F1] text-[#211E19] text-[10px] font-bold tracking-[0.14em] uppercase px-3 py-1.5 rounded-[2px]">
                          {featureRecipe.cuisine}
                        </span>
                        {cookedDates[featureRecipe.id] && (
                          <span className="absolute bottom-5 left-5 bg-[#FBF8F1] text-[#B4643A] text-[10px] font-bold tracking-[0.12em] uppercase px-3 py-1.5 rounded-[2px]">
                            Cooked {cookedDates[featureRecipe.id]}
                          </span>
                        )}
                        <button
                          onClick={(e) => handleFavoriteToggle(e, featureRecipe.id)}
                          className="absolute top-4 right-4 w-9 h-9 rounded-full bg-[#FBF8F1] text-[#B4643A] flex items-center justify-center cursor-pointer focus:outline-none focus-visible:ring-2 ring-[#46573F]/30"
                          aria-label={favorites.some(f => f.recipe_id === featureRecipe.id) ? 'Remove from favourites' : 'Add to favourites'}
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" fill={favorites.some(f => f.recipe_id === featureRecipe.id) ? 'currentColor' : 'none'} viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor" className="w-[18px] h-[18px]">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M12 20s-7.5-4.6-7.5-9.6A4.4 4.4 0 0 1 12 7.4a4.4 4.4 0 0 1 7.5 3c0 5-7.5 9.6-7.5 9.6Z" />
                          </svg>
                        </button>
                      </div>

                      <div className="text-[11px] font-bold tracking-[0.14em] uppercase text-[#B4643A] mt-6">
                        {cookCounts[featureRecipe.id] > 1
                          ? `Featured · you made this ${cookCounts[featureRecipe.id]} times`
                          : useSemanticSearch && searchQuery.trim().length >= 2
                            ? 'Best match'
                            : 'Featured'}
                      </div>

                      <h2
                        onClick={() => handlePickRecipe(featureRecipe)}
                        className="font-serif text-[36px] xl:text-[43px] leading-[1.05] tracking-[-0.6px] mt-2.5 cursor-pointer hover:text-[#46573F] transition-colors"
                      >
                        {featureRecipe.title}
                      </h2>

                      <div className="flex items-center flex-wrap gap-3.5 text-sm text-[#6A6459] mt-3.5">
                        <span>{featureRecipe.time} min</span>
                        <span className="text-[#D6CDBC]">/</span>
                        <span>{featureRecipe.servings} {featureRecipe.servings === 1 ? 'serving' : 'servings'}</span>
                        <span className="text-[#D6CDBC]">/</span>
                        <span>{featureRecipe.difficulty}</span>
                        <span className="text-[#D6CDBC]">/</span>
                        <span className="flex items-center gap-1.5 font-bold text-[#211E19]">
                          <svg viewBox="0 0 24 24" fill="#B4643A" className="w-3.5 h-3.5">
                            <path d="M12 2l2.9 6.3 6.8.8-5 4.7 1.3 6.8L12 17.3 6 20.6l1.3-6.8-5-4.7 6.8-.8z" />
                          </svg>
                          {featureRecipe.average_rating && featureRecipe.rating_count
                            ? <>{featureRecipe.average_rating.toFixed(1)} <span className="font-normal text-[#8A8378]">({featureRecipe.rating_count})</span></>
                            : 'New'}
                        </span>
                      </div>

                      <div className="flex items-center flex-wrap gap-6 mt-6">
                        <button
                          onClick={() => handleStartCooking(featureRecipe)}
                          className="flex items-center gap-2.5 bg-[#46573F] hover:bg-[#3C4A36] text-[#FBF8F1] text-[15px] font-bold px-[30px] py-[15px] rounded-full cursor-pointer active:scale-[0.98] transition-all"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-[17px] h-[17px]">
                            <rect x="9" y="2.5" width="6" height="11.5" rx="3" />
                            <path strokeLinecap="round" d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3.5" />
                          </svg>
                          Start voice guided
                        </button>
                        <button
                          onClick={() => handlePickRecipe(featureRecipe)}
                          className="text-sm font-bold text-[#211E19] border-b-[1.5px] border-[#211E19] pb-0.5 cursor-pointer hover:text-[#46573F] hover:border-[#46573F] transition-colors"
                        >
                          View recipe
                        </button>
                      </div>
                    </div>
                  )}

                  {sortedRecipes.length > 1 && (
                    <div className="flex-1 min-w-0 grid grid-cols-1 sm:grid-cols-2 gap-9 content-start">
                      {sortedRecipes.slice(1, 5).map(recipe => (
                        <RecipeCard
                          key={recipe.id}
                          recipe={recipe}
                          onClick={() => handlePickRecipe(recipe)}
                          isFavorite={favorites.some(f => f.recipe_id === recipe.id)}
                          onFavoriteToggle={(e) => handleFavoriteToggle(e, recipe.id)}
                          cookedDate={cookedDates[recipe.id]}
                        />
                      ))}
                    </div>
                  )}
                </div>

                {sortedRecipes.length > 5 && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-x-9 gap-y-12 mt-14 pt-14 border-t border-[#E4DDD0]">
                    {sortedRecipes.slice(5).map(recipe => (
                      <RecipeCard
                        key={recipe.id}
                        recipe={recipe}
                        onClick={() => handlePickRecipe(recipe)}
                        isFavorite={favorites.some(f => f.recipe_id === recipe.id)}
                        onFavoriteToggle={(e) => handleFavoriteToggle(e, recipe.id)}
                        cookedDate={cookedDates[recipe.id]}
                      />
                    ))}
                  </div>
                )}
              </>
            )}

            {/* Recently made — a strip along the bottom rather than a column
                competing with the grid for the same eye path. */}
            {cookingHistory.length > 0 && (
              <div className="mt-16 pt-7 border-t border-[#E4DDD0]">
                <div className="flex items-baseline justify-between">
                  <h2 className="font-serif text-[25px]">Recently made</h2>
                  <button
                    onClick={() => setShowProfilePanel(true)}
                    className="text-[13px] font-bold text-[#211E19] border-b-[1.5px] border-[#211E19] pb-0.5 cursor-pointer hover:text-[#46573F] hover:border-[#46573F] transition-colors"
                  >
                    View all
                  </button>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-8 mt-5">
                  {cookingHistory.slice(0, 4).map(entry => {
                    const recipe = recipes.find(r => r.id === entry.recipe_id);
                    if (!recipe) return null;
                    const date = new Date(entry.completed_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

                    return (
                      <div
                        key={entry.id}
                        onClick={() => handlePickRecipe(recipe)}
                        className="group flex items-center gap-3.5 cursor-pointer"
                      >
                        <div className="w-14 h-14 rounded-[3px] bg-[#EAE3D4] overflow-hidden shrink-0">
                          <img
                            src={recipe.image_url || 'https://images.unsplash.com/photo-1495521821757-a1efb6729352?w=600&auto=format&fit=crop&q=60'}
                            alt={recipe.title}
                            className="w-full h-full object-cover"
                          />
                        </div>
                        <div className="min-w-0">
                          <div className="text-sm font-bold text-[#211E19] truncate group-hover:text-[#46573F] transition-colors">
                            {recipe.title}
                          </div>
                          <div className="text-xs text-[#8A8378] mt-0.5">{recipe.cuisine} &middot; {date}</div>
                          <div className="text-[11px] text-[#B4643A] tracking-[1px] mt-0.5">
                            {'★'.repeat(entry.rating || 5)}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="h-20" />
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
                      onClick={() => handleStartCooking()}
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
          /* Cooking mode — the mic-live surface. One instruction sized for
             arm's length on the left; everything that answers a question
             (timer, what's coming, the transcript) parked in one rail. */
          selectedRecipe && (
            <div className="h-screen bg-[#191712] text-[#F4EFE7] flex flex-col overflow-hidden font-sans">

              <div className="h-[68px] shrink-0 flex items-center justify-between gap-6 px-6 md:px-11 border-b border-[#2E2A22]">
                <button
                  onClick={() => {
                    timers.clearAllTimers();
                    clearActiveCook();
                    endVoiceSession(`Cooking: ${selectedRecipe?.title ?? 'recipe'}`);
                    setView('detail');
                  }}
                  className="flex items-center gap-2.5 text-[13px] font-bold text-[#A29A88] hover:text-[#F4EFE7] transition-colors cursor-pointer shrink-0"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.2} stroke="currentColor" className="w-[15px] h-[15px]">
                    <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
                  </svg>
                  Leave cooking mode
                </button>

                <span className="font-serif text-xl truncate">{selectedRecipe.title}</span>

                <span className="flex items-center gap-2.5 text-[11px] font-bold tracking-[0.1em] uppercase shrink-0" style={{ color: voiceState.color }}>
                  <span className="w-[7px] h-[7px] rounded-full" style={{ backgroundColor: voiceState.color }} />
                  {voiceState.label}
                </span>
              </div>

              <div className="flex-1 min-h-0 flex flex-col lg:flex-row">

                <div className="flex-1 min-w-0 flex flex-col px-6 md:px-12 py-8 overflow-y-auto">

                  <div className="flex items-center gap-4 shrink-0">
                    <span className="text-[11px] font-bold tracking-[0.16em] text-[#C97A46] shrink-0">
                      STEP {currentStep + 1} OF {selectedRecipe.steps.length}
                    </span>
                    <span className="flex-1 flex gap-1.5">
                      {selectedRecipe.steps.map((s, idx) => (
                        <span
                          key={s.step}
                          className={`flex-1 h-[2px] transition-colors duration-500 ${
                            idx <= currentStep ? 'bg-[#7E9270]' : 'bg-[#322D24]'
                          }`}
                        />
                      ))}
                    </span>
                    {elapsedMinutes !== null && (
                      <span className="text-xs text-[#6E6858] shrink-0">{elapsedMinutes} min elapsed</span>
                    )}
                  </div>

                  {/* A rule rather than a red pill: it reads as part of the page
                      and still stops the eye before the instruction. */}
                  {selectedRecipe.steps[currentStep].safety_alert && (
                    <div className="flex items-center gap-3 mt-8 py-3.5 border-y border-[#4A3323] shrink-0">
                      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4 text-[#C97A46] shrink-0">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 4l9 16H3z" />
                        <path strokeLinecap="round" d="M12 10v4M12 17.2v.2" />
                      </svg>
                      <span className="text-[13px] font-bold text-[#C97A46]">
                        {selectedRecipe.steps[currentStep].safety_alert}
                      </span>
                    </div>
                  )}

                  <h2 className="font-serif text-[30px] md:text-[42px] xl:text-[54px] leading-[1.12] tracking-[-0.8px] mt-9 max-w-[820px] select-text">
                    {selectedRecipe.steps[currentStep].text}
                  </h2>

                  {stepIngredients.length > 0 && (
                    <div className="flex items-center flex-wrap gap-y-3 mt-9 shrink-0">
                      <span className="text-[11px] font-bold tracking-[0.14em] text-[#6E6858] pr-6">IN THIS STEP</span>
                      {stepIngredients.map(ing => (
                        <span key={ing.name} className="flex items-baseline gap-2 px-6 border-l border-[#2E2A22]">
                          <span className="font-serif text-[22px]">{ing.amount} {ing.unit}</span>
                          <span className="text-sm text-[#A29A88]">{ing.name}</span>
                        </span>
                      ))}
                    </div>
                  )}

                  <span className="flex-1 min-h-8" />

                  <div className="flex items-center flex-wrap gap-6 shrink-0">
                    <button
                      onClick={handlePrevStep}
                      disabled={currentStep === 0}
                      className="flex items-center gap-2 text-sm font-bold text-[#A29A88] hover:text-[#F4EFE7] disabled:opacity-30 disabled:hover:text-[#A29A88] disabled:cursor-not-allowed transition-colors cursor-pointer"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.2} stroke="currentColor" className="w-[15px] h-[15px]">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15 6l-6 6 6 6" />
                      </svg>
                      Previous
                    </button>

                    <button
                      onClick={handleRepeatStep}
                      className="text-sm font-bold text-[#A29A88] hover:text-[#F4EFE7] transition-colors cursor-pointer"
                      title="Read this step again"
                    >
                      Repeat
                    </button>

                    {currentStep < selectedRecipe.steps.length - 1 ? (
                      <button
                        onClick={handleNextStep}
                        className="flex items-center gap-2.5 bg-[#C97A46] hover:bg-[#D6874F] text-[#191712] text-[15px] font-bold px-[30px] py-[15px] rounded-full cursor-pointer active:scale-[0.98] transition-all"
                      >
                        Next step
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.4} stroke="currentColor" className="w-4 h-4">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M9 6l6 6-6 6" />
                        </svg>
                      </button>
                    ) : (
                      <button
                        onClick={() => {
                          setCompletionRating(0);
                          setShowCompletionModal(true);
                        }}
                        className="flex items-center gap-2.5 bg-[#46573F] hover:bg-[#52664A] text-[#F4EFE7] text-[15px] font-bold px-[30px] py-[15px] rounded-full cursor-pointer active:scale-[0.98] transition-all"
                      >
                        Finish and rate
                      </button>
                    )}

                    <span className="flex-1" />

                    <div className="flex items-center gap-4">
                      <Waveform
                        status={voice.status}
                        analyser={voice.analyser}
                        muted={voice.isMuted}
                        className="w-28 h-9"
                        hideLabel
                      />
                      <button
                        onClick={voice.toggleMute}
                        disabled={voice.status === 'idle' || voice.status === 'connecting'}
                        aria-pressed={voice.isMuted}
                        className="flex items-center gap-2.5 text-sm font-bold text-[#A29A88] hover:text-[#F4EFE7] disabled:opacity-30 disabled:cursor-not-allowed transition-colors cursor-pointer"
                      >
                        {voice.isMuted ? (
                          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4">
                            <rect x="9" y="2.5" width="6" height="11.5" rx="3" />
                            <path strokeLinecap="round" d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3.5M4 3l16 18" />
                          </svg>
                        ) : (
                          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4">
                            <rect x="9" y="2.5" width="6" height="11.5" rx="3" />
                            <path strokeLinecap="round" d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3.5" />
                          </svg>
                        )}
                        {voice.isMuted ? 'Unmute' : 'Mute'}
                      </button>
                    </div>
                  </div>

                  <div className="text-[13px] text-[#6E6858] mt-4 shrink-0">
                    Say <span className="text-[#F4EFE7] font-bold">“next”</span>,{' '}
                    <span className="text-[#F4EFE7] font-bold">“go back”</span>,{' '}
                    <span className="text-[#F4EFE7] font-bold">“repeat that”</span> or{' '}
                    <span className="text-[#F4EFE7] font-bold">“set a 5 minute timer”</span> — you can interrupt mid-sentence.
                  </div>
                </div>

                <div className="w-full lg:w-[380px] shrink-0 border-t lg:border-t-0 lg:border-l border-[#2E2A22] flex flex-col min-h-0">

                  <div className="px-9 pt-8 pb-7 shrink-0">
                    {timers.timers.length > 0 ? (
                      <TimerWidget
                        timers={timers.timers}
                        onCancel={timers.removeTimer}
                        onAddSeconds={timers.addTimeToTimer}
                      />
                    ) : (
                      <>
                        <div className="text-[11px] font-bold tracking-[0.14em] text-[#6E6858]">TIMER</div>
                        <div className="text-sm text-[#A29A88] leading-relaxed mt-3">
                          Nothing running. Say <span className="text-[#F4EFE7] font-bold">“set a 10 minute timer”</span> and it appears here.
                        </div>
                      </>
                    )}
                  </div>

                  <div className="px-9 py-7 border-t border-[#2E2A22] shrink-0">
                    <div className="text-[11px] font-bold tracking-[0.14em] text-[#6E6858]">UP NEXT</div>
                    {currentStep < selectedRecipe.steps.length - 1 ? (
                      <div className="font-serif text-[21px] leading-[1.3] text-[#CFC7B6] mt-3">
                        {selectedRecipe.steps[currentStep + 1].text}
                      </div>
                    ) : (
                      <div className="font-serif text-[21px] leading-[1.3] text-[#CFC7B6] mt-3">
                        Last step — then rate how it went and it lands in your cooking log.
                      </div>
                    )}
                  </div>

                  <div className="flex-1 min-h-0 border-t border-[#2E2A22] flex flex-col">
                    <div className="px-9 pt-7 pb-1 text-[11px] font-bold tracking-[0.14em] text-[#6E6858] shrink-0">
                      CONVERSATION
                    </div>
                    <div className="flex-1 min-h-0">
                      <ChatArea
                        messages={voice.messages}
                        isAiThinking={voice.isAiThinking}
                        interimTranscript={voice.interimTranscript}
                        emptyHint={
                          <div className="h-full flex items-start px-4 md:px-8 pt-2">
                            <p className="text-sm text-[#6E6858] leading-relaxed">
                              Ask anything as you cook — a substitution, a timing, or “add cream to my list”. Questions and replies land here.
                            </p>
                          </div>
                        }
                      />
                    </div>
                  </div>

                  <div className="px-9 py-6 border-t border-[#2E2A22] shrink-0 flex flex-col gap-5">
                    <ModelSelector value={voice.modelProvider} onChange={voice.setModelProvider} hideHint />

                    <form onSubmit={handleTextSubmit} className="flex items-center gap-3">
                      <input
                        type="text"
                        placeholder="Ask a question"
                        value={textInput}
                        onChange={(e) => setTextInput(e.target.value)}
                        className="flex-1 min-w-0 bg-transparent border-b border-[#3A342A] focus:border-[#7E9270] pb-2.5 text-sm text-[#F4EFE7] placeholder-[#6E6858] focus:outline-none transition-colors"
                      />
                      <button
                        type="submit"
                        aria-label="Send"
                        className="w-9 h-9 rounded-full bg-[#46573F] hover:bg-[#52664A] flex items-center justify-center shrink-0 cursor-pointer transition-colors"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4 text-[#F4EFE7]">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M4 12h15M13 6l6 6-6 6" />
                        </svg>
                      </button>
                    </form>

                    <div className="text-[10px] font-bold tracking-[0.13em] text-[#4A4436] uppercase">
                      Spoken with Web Speech
                    </div>
                  </div>
                </div>
              </div>
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
        entries={cookingHistory}
        recipes={recipes}
        onSelectRecipe={(recipe) => {
          setShowHistoryPanel(false);
          handlePickRecipe(recipe);
        }}
      />

      <ShoppingListPanel
        isOpen={showShoppingList}
        onClose={() => setShowShoppingList(false)}
        refreshKey={shoppingRefreshKey}
      />

      {/* Resume-cooking prompt: offered once on load if a cook was left unfinished */}
      {resumeCook && (
        <div className="fixed inset-0 bg-[#1A1A14]/80 backdrop-blur-xl z-50 flex items-center justify-center p-4">
          <div className="bg-[#2C2C24] border border-[#4A4A40] rounded-[2rem] p-8 max-w-sm w-full text-[#F3F4F1] shadow-float space-y-6 animate-in fade-in zoom-in-95 duration-300">
            <div className="text-center">
              <h3 className="text-2xl font-serif font-bold text-[#F3F4F1]">Resume cooking?</h3>
              <p className="text-sm text-[#A0A096] mt-2 px-2 leading-relaxed">
                You left <strong className="text-[#C18C5D] font-bold">{resumeCook.recipe.title}</strong> at step {resumeCook.step + 1}. Pick up where you left off?
              </p>
            </div>
            <div className="flex flex-col gap-3">
              <button
                onClick={handleResumeCook}
                className="w-full bg-[#5D7052] hover:bg-[#5D7052]/90 text-[#F3F4F1] font-bold py-3.5 rounded-full transition-all duration-300 cursor-pointer text-center text-sm shadow-soft active:scale-95 uppercase tracking-wider"
              >
                Resume at step {resumeCook.step + 1}
              </button>
              <button
                onClick={handleDismissResume}
                className="w-full bg-transparent border border-[#4A4A40] hover:border-[#78786C] text-[#A0A096] hover:text-[#F3F4F1] font-bold py-3.5 rounded-full transition-all duration-300 cursor-pointer text-center text-sm active:scale-95 uppercase tracking-wider"
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      )}

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
                    // Tapping the active star again clears the rating, so a
                    // mis-tap does not force you to submit a score.
                    onClick={() => setCompletionRating(r => (r === star ? 0 : star))}
                    aria-label={`${star} star${star > 1 ? 's' : ''}`}
                    className={`text-4xl focus:outline-none transition-transform hover:scale-110 cursor-pointer bg-transparent border-none ${
                      star <= completionRating ? 'text-[#C18C5D] drop-shadow-md' : 'text-[#4A4A40]'
                    }`}
                  >
                    {star <= completionRating ? '★' : '☆'}
                  </button>
                ))}
              </div>
              <p className="text-sm text-[#C18C5D] font-bold h-5 uppercase tracking-wider">
                {completionRating === 0 && <span className="text-[#A0A096]">Tap to rate — optional</span>}
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
                      // Elapsed wall-clock minutes in cook mode, not
                      // selectedRecipe.time — that was the recipe's advertised
                      // duration, so a 30-second run still logged "40 mins".
                      // Falls back to the advertised time if the start stamp is
                      // missing (e.g. a cook resumed from an older session).
                      const elapsedMinutes = cookStartedAt
                        ? Math.max(1, Math.round((Date.now() - cookStartedAt) / 60000))
                        : selectedRecipe.time;
                      await addCookingHistory(
                        session.user.id,
                        selectedRecipe.id,
                        elapsedMinutes,
                        completionRating > 0 ? completionRating : undefined,
                      );
                      // Reload profile to keep history in sync
                      await loadUserProfile(session.user.id);
                    }
                    timers.clearAllTimers();
                    clearActiveCook();
                    setCookStartedAt(null);
                    endVoiceSession(`Cooking: ${selectedRecipe?.title ?? 'recipe'}`);
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
