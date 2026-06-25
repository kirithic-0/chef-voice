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
      className="group bg-white rounded-2xl border border-neutral-100 hover:border-neutral-200 shadow-sm hover:shadow-md transition-all duration-300 overflow-hidden cursor-pointer flex flex-col h-full active:scale-[0.99] relative"
    >
      {/* Recipe Image & Cuisine Badge */}
      <div className="relative aspect-[16/10] bg-neutral-100 overflow-hidden">
        <img 
          src={image_url || 'https://images.unsplash.com/photo-1495521821757-a1efb6729352?w=600&auto=format&fit=crop&q=60'} 
          alt={title}
          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
        />
        <div className="absolute top-3 left-3 bg-black/60 backdrop-blur-md text-white text-xs font-semibold px-2.5 py-1 rounded-full uppercase tracking-wider">
          {cuisine}
        </div>

        {/* Cooked Badge */}
        {cookedDate && (
          <div className="absolute bottom-3 left-3 bg-emerald-600/90 backdrop-blur-md text-white text-[10px] font-bold px-2.5 py-1 rounded-lg flex items-center gap-1 shadow-sm select-none z-10">
            <span>✓ Cooked {cookedDate}</span>
          </div>
        )}
        
        {/* Favorite Heart Button */}
        {onFavoriteToggle && (
          <button
            onClick={onFavoriteToggle}
            className="absolute top-3 right-3 p-2 rounded-full bg-white/80 hover:bg-white text-red-500 hover:text-red-600 transition-colors shadow-sm focus:outline-none"
            aria-label={isFavorite ? "Remove from favorites" : "Add to favorites"}
          >
            <svg 
              xmlns="http://www.w3.org/2000/svg" 
              fill={isFavorite ? "currentColor" : "none"} 
              viewBox="0 0 24 24" 
              strokeWidth={2} 
              stroke="currentColor" 
              className="w-4 h-4"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12z" />
            </svg>
          </button>
        )}
      </div>

      {/* Card Content */}
      <div className="p-5 flex-1 flex flex-col">
        <div className="flex flex-wrap gap-1.5 mb-2">
          {dietary && dietary.map(d => (
            <span key={d} className="text-[10px] font-semibold bg-emerald-50 text-emerald-700 px-2 py-0.5 rounded-md">
              {d}
            </span>
          ))}
        </div>

        <h3 className="font-semibold text-neutral-900 text-lg leading-snug mb-3 group-hover:text-amber-600 transition-colors">
          {title}
        </h3>

        {/* Stats Row */}
        <div className="mt-auto pt-4 border-t border-neutral-50 flex items-center justify-between text-neutral-500 text-xs font-medium">
          <div className="flex items-center gap-1">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-3.5 h-3.5 text-neutral-400">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span>{time} min</span>
          </div>

          <div className="flex items-center gap-1">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-3.5 h-3.5 text-neutral-400">
              <path strokeLinecap="round" strokeLinejoin="round" d="M18 18.72a9.094 9.094 0 003.741-.479 3 3 0 00-4.682-2.72m.94 3.198.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0112 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 016 18.719m12 0a5.971 5.971 0 00-.941-3.197m0 0A5.995 5.995 0 0012 12.75a5.995 5.995 0 00-5.058 2.772m0 0a3 3 0 00-4.681 2.72 8.986 8.986 0 003.74.477m.079-13.137a3 3 0 116 0 3 3 0 01-6 0zm6 0a3 3 0 116 0 3 3 0 01-6 0z" />
            </svg>
            <span>{servings} servings</span>
          </div>

          <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${
            difficulty === 'Easy' ? 'bg-blue-50 text-blue-700' : 'bg-amber-50 text-amber-700'
          }`}>
            {difficulty}
          </span>
        </div>
      </div>
    </div>
  );
}
