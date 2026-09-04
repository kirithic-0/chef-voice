import React from 'react';
import { Recipe } from '../types';

interface RecipeCardProps {
  recipe: Recipe;
  onClick: () => void;
  isFavorite?: boolean;
  onFavoriteToggle?: (e: React.MouseEvent) => void;
  cookedDate?: string;
}

export default function RecipeCard({ recipe, onClick, isFavorite = false, onFavoriteToggle, cookedDate }: RecipeCardProps) {
  const { title, cuisine, time, difficulty, servings, dietary, image_url } = recipe;
  const isVeg = dietary?.some(d => d.toLowerCase() === 'veg' || d.toLowerCase() === 'vegan');
  const rated = recipe.rating_count && recipe.rating_count > 0;

  return (
    <div onClick={onClick} className="group flex flex-col cursor-pointer">
      {/* Media. No card chrome around the whole thing — the image block is the
          only filled surface, everything below it sits on the paper. */}
      <div className="relative aspect-[16/10] rounded-[4px] bg-[#EAE3D4] overflow-hidden">
        <img
          src={image_url || 'https://images.unsplash.com/photo-1495521821757-a1efb6729352?w=600&auto=format&fit=crop&q=60'}
          alt={title}
          onError={(e) => {
            const img = e.currentTarget;
            const fallback = 'https://images.unsplash.com/photo-1495521821757-a1efb6729352?w=600&auto=format&fit=crop&q=60';
            if (img.src !== fallback) img.src = fallback;
          }}
          className="w-full h-full object-cover group-hover:scale-[1.03] transition-transform duration-700"
        />

        <span className="absolute top-3.5 left-3.5 bg-[#FBF8F1] text-[#211E19] text-[9px] font-bold tracking-[0.13em] uppercase px-2.5 py-1.5 rounded-[2px]">
          {cuisine}
        </span>

        {cookedDate && (
          <span className="absolute bottom-3.5 left-3.5 bg-[#FBF8F1] text-[#B4643A] text-[9px] font-bold tracking-[0.12em] uppercase px-2.5 py-1.5 rounded-[2px]">
            Cooked {cookedDate}
          </span>
        )}

        {onFavoriteToggle && (
          <button
            onClick={onFavoriteToggle}
            className="absolute top-3 right-3 w-8 h-8 rounded-full bg-[#FBF8F1] text-[#B4643A] flex items-center justify-center opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity cursor-pointer focus:outline-none focus-visible:ring-2 ring-[#46573F]/30"
            aria-label={isFavorite ? 'Remove from favourites' : 'Add to favourites'}
            style={isFavorite ? { opacity: 1 } : undefined}
          >
            <svg xmlns="http://www.w3.org/2000/svg" fill={isFavorite ? 'currentColor' : 'none'} viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor" className="w-4 h-4">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 20s-7.5-4.6-7.5-9.6A4.4 4.4 0 0 1 12 7.4a4.4 4.4 0 0 1 7.5 3c0 5-7.5 9.6-7.5 9.6Z" />
            </svg>
          </button>
        )}
      </div>

      <h3 className="font-serif text-[21px] leading-[1.15] text-[#211E19] mt-4 group-hover:text-[#46573F] transition-colors">
        {title}
      </h3>

      <div className="flex items-center gap-2.5 text-[13px] text-[#6A6459] mt-2">
        <span
          className={`w-1.5 h-1.5 rounded-full shrink-0 ${isVeg ? 'bg-[#46573F]' : 'bg-[#A85448]'}`}
          title={isVeg ? 'Vegetarian' : 'Non-vegetarian'}
        />
        <span>{time} min</span>
        <span className="text-[#D6CDBC]">/</span>
        <span>{servings} {servings === 1 ? 'serving' : 'servings'}</span>
        <span className="text-[#D6CDBC]">/</span>
        <span>{difficulty}</span>

        {rated ? (
          <span className="ml-auto flex items-center gap-1.5 font-bold text-[#211E19]">
            <svg viewBox="0 0 24 24" fill="#B4643A" className="w-3 h-3">
              <path d="M12 2l2.9 6.3 6.8.8-5 4.7 1.3 6.8L12 17.3 6 20.6l1.3-6.8-5-4.7 6.8-.8z" />
            </svg>
            {recipe.average_rating ? recipe.average_rating.toFixed(1) : '0.0'}
          </span>
        ) : (
          <span className="ml-auto text-[12px] text-[#8A8378]">New</span>
        )}
      </div>
    </div>
  );
}
