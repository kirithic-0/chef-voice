import React, { useState } from 'react';
import { login, signup } from '../lib/api';

interface AuthProps {
  onAuthSuccess: () => void;
  onClose?: () => void;
}

export default function Auth({ onAuthSuccess, onClose }: AuthProps) {
  const [isRegister, setIsRegister] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setErrorMsg('');
    setSuccessMsg('');

    const cleanUsername = username.trim().toLowerCase();

    try {
      if (isRegister) {
        await signup(cleanUsername, password);
        setSuccessMsg('Account created successfully! Logging you in...');
        setTimeout(() => {
          onAuthSuccess();
          onClose?.();
        }, 1200);
      } else {
        await login(cleanUsername, password);
        setSuccessMsg('Logged in successfully!');
        setTimeout(() => {
          onAuthSuccess();
          onClose?.();
        }, 800);
      }
    } catch (err: any) {
      console.error('Auth error:', err);
      setErrorMsg(err.message || 'Authentication failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-[#2C2C24]/30 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-[#FEFEFA] rounded-[2rem] w-full max-w-md shadow-float overflow-hidden border border-[#DED8CF]/50 flex flex-col p-10 relative animate-in fade-in zoom-in-95 duration-500">
        
        {/* Close Button */}
        {onClose && (
          <button
            onClick={onClose}
            className="absolute top-6 right-6 text-[#78786C] hover:text-[#2C2C24] transition-colors p-2 rounded-full hover:bg-[#F0EBE5] cursor-pointer"
          >
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className="w-5 h-5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}

        {/* Title */}
        <div className="mb-8 space-y-2 text-center">
          <h2 className="text-3xl font-serif font-bold text-[#2C2C24]">
            {isRegister ? 'Create Account' : 'Welcome Back'}
          </h2>
          <p className="text-[#78786C] text-sm font-sans">
            {isRegister ? 'Choose a username to customize recipes' : 'Sign in to access your kitchen profile'}
          </p>
        </div>

        {/* Success/Error Alerts */}
        {errorMsg && (
          <div className="bg-[#A85448]/10 border border-[#A85448]/20 text-[#A85448] px-5 py-3 rounded-[1.5rem] text-sm font-semibold mb-6">
            {errorMsg}
          </div>
        )}
        {successMsg && (
          <div className="bg-[#5D7052]/10 border border-[#5D7052]/20 text-[#5D7052] px-5 py-3 rounded-[1.5rem] text-sm font-semibold mb-6">
            {successMsg}
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <label className="block text-xs font-bold text-[#78786C] uppercase tracking-wider mb-2 pl-4">
              Username
            </label>
            <input
              type="text"
              required
              placeholder="e.g. kirithic"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full bg-white/50 border border-[#DED8CF] focus:border-transparent focus:ring-2 focus:ring-[#5D7052]/30 rounded-full h-12 px-6 text-sm font-sans focus:outline-none transition-all shadow-sm"
            />
          </div>

          <div>
            <label className="block text-xs font-bold text-[#78786C] uppercase tracking-wider mb-2 pl-4">
              Password
            </label>
            <input
              type="password"
              required
              minLength={6}
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-white/50 border border-[#DED8CF] focus:border-transparent focus:ring-2 focus:ring-[#5D7052]/30 rounded-full h-12 px-6 text-sm font-sans focus:outline-none transition-all shadow-sm"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-[#5D7052] text-[#F3F4F1] font-bold h-12 rounded-full shadow-soft hover:shadow-hover hover:scale-105 active:scale-95 transition-all duration-300 flex items-center justify-center gap-2 cursor-pointer mt-8 px-8"
          >
            {loading ? (
              <div className="w-5 h-5 border-2 border-[#F3F4F1] border-t-transparent rounded-full animate-spin" />
            ) : (
              isRegister ? 'Sign Up' : 'Sign In'
            )}
          </button>
        </form>

        {/* Toggle Switch */}
        <div className="mt-8 text-center">
          <button
            onClick={() => {
              setIsRegister(!isRegister);
              setErrorMsg('');
              setSuccessMsg('');
            }}
            className="text-sm text-[#C18C5D] hover:text-[#A85448] font-bold transition-colors cursor-pointer"
          >
            {isRegister ? 'Already have an account? Sign In' : "Don't have an account? Sign Up"}
          </button>
        </div>
      </div>
    </div>
  );
}
