import React from 'react';
import { CookingHistoryEntry, Recipe } from '../types';

interface HistoryPanelProps {
  isOpen: boolean;
  onClose: () => void;
  entries: CookingHistoryEntry[];
  recipes: Recipe[];
  onSelectRecipe: (recipe: Recipe) => void;
}

const FALLBACK_IMAGE =
  'https://images.unsplash.com/photo-1495521821757-a1efb6729352?w=600&auto=format&fit=crop&q=60';

function formatRelativeDate(dateString: string) {
  const date = new Date(dateString);
  const diffMs = Date.now() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatDuration(minutes: number) {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/**
 * What you have actually cooked — one row per finished recipe, with how long it
 * took and how you rated it. This used to list saved voice transcripts, which
 * told you nothing you would come back for.
 */
export default function HistoryPanel({ isOpen, onClose, entries, recipes, onSelectRecipe }: HistoryPanelProps) {
  const totalMinutes = entries.reduce((sum, e) => sum + (e.duration_minutes || 0), 0);
  const ratings = entries.map(e => e.rating).filter((r): r is number => typeof r === 'number' && r > 0);
  const averageRating = ratings.length
    ? ratings.reduce((sum, r) => sum + r, 0) / ratings.length
    : null;

  return (
    <>
      {isOpen && (
        <div
          className="fixed inset-0 bg-[#191712]/25 z-40 transition-opacity duration-300"
          onClick={onClose}
        />
      )}

      <div
        className={`fixed top-0 right-0 h-full w-full max-w-[480px] bg-[#FBF8F1] border-l border-[#E4DDD0] z-50 transition-transform duration-400 ease-out ${
          isOpen ? 'translate-x-0' : 'translate-x-full'
        } flex flex-col font-sans`}
      >
        <div className="flex items-center justify-between px-9 h-[72px] shrink-0 border-b border-[#E4DDD0]">
          <h2 className="font-serif text-[27px] tracking-[-0.4px] text-[#211E19]">History</h2>
          <button
            onClick={onClose}
            aria-label="Close history"
            className="text-[#8A8378] hover:text-[#211E19] transition-colors cursor-pointer"
          >
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5">
              <path strokeLinecap="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {entries.length > 0 && (
          <div className="flex items-stretch px-9 py-6 shrink-0 border-b border-[#E4DDD0]">
            <div className="pr-7">
              <div className="font-serif text-[32px] leading-none">{entries.length}</div>
              <div className="text-[10px] font-bold tracking-[0.14em] uppercase text-[#8A8378] mt-2">
                {entries.length === 1 ? 'Cook' : 'Cooks'}
              </div>
            </div>
            <div className="px-7 border-l border-[#E4DDD0]">
              <div className="font-serif text-[32px] leading-none">{formatDuration(totalMinutes)}</div>
              <div className="text-[10px] font-bold tracking-[0.14em] uppercase text-[#8A8378] mt-2">At the stove</div>
            </div>
            {averageRating !== null && (
              <div className="pl-7 border-l border-[#E4DDD0]">
                <div className="font-serif text-[32px] leading-none">{averageRating.toFixed(1)}</div>
                <div className="text-[10px] font-bold tracking-[0.14em] uppercase text-[#8A8378] mt-2">Avg rating</div>
              </div>
            )}
          </div>
        )}

        <div className="flex-1 min-h-0 overflow-y-auto px-9">
          {entries.length === 0 ? (
            <div className="py-16">
              <h3 className="font-serif text-[24px] text-[#211E19]">Nothing cooked yet</h3>
              <p className="text-sm text-[#6A6459] leading-relaxed mt-3">
                Finish a recipe in voice-guided mode and rate it — it lands here with how long it
                actually took you, not how long the recipe claims.
              </p>
            </div>
          ) : (
            entries.map(entry => {
              const recipe = recipes.find(r => r.id === entry.recipe_id);

              return (
                <div
                  key={entry.id}
                  onClick={() => recipe && onSelectRecipe(recipe)}
                  className={`group flex items-center gap-4 py-5 border-b border-[#EDE7DB] ${
                    recipe ? 'cursor-pointer' : ''
                  }`}
                >
                  <div className="w-14 h-14 rounded-[3px] bg-[#EAE3D4] overflow-hidden shrink-0">
                    {recipe && (
                      <img
                        src={recipe.image_url || FALLBACK_IMAGE}
                        alt={recipe.title}
                        onError={(e) => {
                          const img = e.currentTarget;
                          if (img.src !== FALLBACK_IMAGE) img.src = FALLBACK_IMAGE;
                        }}
                        className="w-full h-full object-cover"
                      />
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className={`font-serif text-[19px] leading-tight truncate ${
                      recipe ? 'text-[#211E19] group-hover:text-[#46573F] transition-colors' : 'text-[#8A8378]'
                    }`}>
                      {recipe ? recipe.title : 'Recipe no longer in the catalogue'}
                    </div>

                    <div className="flex items-center gap-2.5 text-[13px] text-[#6A6459] mt-1.5">
                      {recipe && (
                        <>
                          <span>{recipe.cuisine}</span>
                          <span className="text-[#D6CDBC]">/</span>
                        </>
                      )}
                      <span className={entry.duration_minutes ? 'font-bold text-[#211E19]' : ''}>
                        {entry.duration_minutes ? formatDuration(entry.duration_minutes) : 'Time not logged'}
                      </span>
                      <span className="text-[#D6CDBC]">/</span>
                      <span>{formatRelativeDate(entry.completed_at)}</span>
                    </div>
                  </div>

                  <div className="shrink-0 text-right">
                    {entry.rating ? (
                      <span className="text-[13px] text-[#B4643A] tracking-[1px]">
                        {'★'.repeat(entry.rating)}
                        <span className="text-[#DED6C7]">{'★'.repeat(5 - entry.rating)}</span>
                      </span>
                    ) : (
                      <span className="text-xs text-[#B9B1A2]">Not rated</span>
                    )}
                  </div>
                </div>
              );
            })
          )}

          <div className="h-8" />
        </div>
      </div>
    </>
  );
}
