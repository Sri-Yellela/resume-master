// AuthSheetReference.jsx — TS-stripped copy of AuthSheet.tsx (reference only, not mounted)
// Original used: supabase auth, react portal, useToast
// These deps are not available in this project — this file is for reference only.
import React, { useState } from 'react';
import { X } from 'lucide-react';

// NOTE: This is a reference-only file. It is NOT imported or rendered anywhere.
export const AuthSheetReference = ({ isOpen, onClose }) => {
  const [isSignUp, setIsSignUp] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const handleAuth = async (e) => {
    e.preventDefault();
    setLoading(true);
    // Original used supabase.auth.signInWithPassword / signUp
    setLoading(false);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-background border border-border rounded-lg p-6 w-full max-w-md">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg font-semibold">{isSignUp ? 'Sign Up' : 'Sign In'}</h2>
          <button onClick={onClose}><X className="h-4 w-4" /></button>
        </div>
        <form onSubmit={handleAuth} className="space-y-4">
          <input
            type="email" value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="Email" className="w-full border rounded p-2"
          />
          <input
            type="password" value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="Password" className="w-full border rounded p-2"
          />
          <button type="submit" disabled={loading} className="w-full bg-primary text-primary-foreground rounded p-2">
            {loading ? 'Loading...' : isSignUp ? 'Sign Up' : 'Sign In'}
          </button>
        </form>
        <button onClick={() => setIsSignUp(!isSignUp)} className="mt-2 text-sm text-muted-foreground">
          {isSignUp ? 'Already have an account? Sign in' : "Don't have an account? Sign up"}
        </button>
      </div>
    </div>
  );
};
