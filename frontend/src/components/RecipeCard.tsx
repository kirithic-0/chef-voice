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

  return (
    <div 
      onClick={onClick}
      className="group bg-[#FEFEFA] rounded-[2rem] rounded-tr-[4rem] border border-[#DED8CF]/50 shadow-[0_4px_20px_-2px_rgba(93,112,82,0.15)] hover:shadow-[0_20px_40px_-10px_rgba(93,112,82,0.15)] transition-all duration-500 overflow-hidden cursor-pointer flex flex-col h-full hover:-translate-y-1 active:scale-95 relative"
    >
      {/* Recipe Image & Cuisine Badge */}
      <div className="relative aspect-[16/10] bg-[#F0EBE5] overflow-hidden p-2">
        <img
          src={image_url || 'https://images.unsplash.com/photo-1495521821757-a1efb6729352?w=600&auto=format&fit=crop&q=60'}
          alt={title}
          onError={(e) => {
            const img = e.currentTarget;
            const fallback = 'https://images.unsplash.com/photo-1495521821757-a1efb6729352?w=600&auto=format&fit=crop&q=60';
            if (img.src !== fallback) img.src = fallback;
          }}
          className="w-full h-full object-cover rounded-[1.5rem] group-hover:scale-105 transition-transform duration-700"
        />
        <div className="absolute top-5 left-5 bg-[#5D7052]/90 backdrop-blur-md text-[#F3F4F1] text-xs font-semibold px-3 py-1.5 rounded-full uppercase tracking-wider">
          {cuisine}
        </div>

        {/* Cooked Badge */}
        {cookedDate && (
          <div className="absolute bottom-5 left-5 bg-[#C18C5D]/90 backdrop-blur-md text-white text-[10px] font-bold px-3 py-1.5 rounded-full flex items-center gap-1 shadow-sm select-none z-10">
            <span>✓ Cooked {cookedDate}</span>
          </div>
        )}
        
        {/* Favorite Heart Button */}
        {onFavoriteToggle && (
          <button
            onClick={onFavoriteToggle}
            className="absolute top-5 right-5 p-2 rounded-full bg-white/80 hover:bg-white text-[#A85448] transition-colors shadow-soft focus:outline-none focus-visible:ring-2 ring-[#5D7052]/30"
            aria-label={isFavorite ? "Remove from favorites" : "Add to favorites"}
          >
            <svg 
              xmlns="http://www.w3.org/2000/svg" 
              fill={isFavorite ? "currentColor" : "none"} 
              viewBox="0 0 24 24" 
              strokeWidth={2} 
              stroke="currentColor" 
              className="w-5 h-5"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12z" />
            </svg>
          </button>
        )}
      </div>

      {/* Card Content */}
      <div className="p-6 flex-1 flex flex-col">
        <div className="flex flex-wrap gap-2 mb-3">
          {dietary?.some(d => d.toLowerCase() === 'veg' || d.toLowerCase() === 'vegan') ? (
            <span className="text-[10px] font-bold bg-[#5D7052]/10 text-[#5D7052] border border-[#5D7052]/20 px-2.5 py-1 rounded-full flex items-center gap-1.5 select-none">
              <span className="w-1.5 h-1.5 rounded-full bg-[#5D7052]" /> Veg
            </span>
          ) : (
            <span className="text-[10px] font-bold bg-[#A85448]/10 text-[#A85448] border border-[#A85448]/20 px-2.5 py-1 rounded-full flex items-center gap-1.5 select-none">
              <span className="w-1.5 h-1.5 rounded-full bg-[#A85448]" /> Non-Veg
            </span>
          )}
        </div>

        {recipe.rating_count && recipe.rating_count > 0 ? (
          <div className="flex items-center gap-1 mb-2 text-xs font-bold text-[#C18C5D]">
            <span className="text-[#C18C5D] text-sm">★</span>
            <span>{recipe.average_rating ? recipe.average_rating.toFixed(1) : '0.0'}</span>
            <span className="text-[#78786C] font-normal text-[10px]">({recipe.rating_count})</span>
          </div>
        ) : (
          <div className="flex items-center gap-1 mb-2 text-xs font-medium text-[#78786C]">
            <span className="text-[#DED8CF]">★</span>
            <span className="text-[10px]">New</span>
          </div>
        )}

        <h3 className="font-serif font-semibold text-[#2C2C24] text-xl leading-snug mb-4 group-hover:text-[#5D7052] transition-colors">
          {title}
        </h3>

        {/* Stats Row */}
        <div className="mt-auto pt-4 border-t border-[#DED8CF]/30 flex items-center justify-between text-[#78786C] text-xs font-medium">
          <div className="flex items-center gap-1.5">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span>{time} min</span>
          </div>

          <div className="flex items-center gap-1.5">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4">
              <path strokeLinecap="round" strokeLinejoin="round" d="M18 18.72a9.094 9.094 0 003.741-.479 3 3 0 00-4.682-2.72m.94 3.198.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0112 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 016 18.719m12 0a5.971 5.971 0 00-.941-3.197m0 0A5.995 5.995 0 0012 12.75a5.995 5.995 0 00-5.058 2.772m0 0a3 3 0 00-4.681 2.72 8.986 8.986 0 003.74.477m.079-13.137a3 3 0 116 0 3 3 0 01-6 0zm6 0a3 3 0 116 0 3 3 0 01-6 0z" />
            </svg>
            <span>{servings} p</span>
          </div>

          <span className="px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider bg-[#F0EBE5] text-[#4A4A40]">
            {difficulty}
          </span>
        </div>
      </div>
    </div>
  );
}
