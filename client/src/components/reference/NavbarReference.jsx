// NavbarReference.jsx — TS-stripped copy of Navbar.tsx (reference only, not mounted)
// Original used: supabase auth, react-router Link/useNavigate, AuthSheet, Menu/X icons
// These deps are not available in this project — this file is for reference only.
import React, { useState } from 'react';
import { Menu, X } from 'lucide-react';

// NOTE: This is a reference-only file. It is NOT imported or rendered anywhere.
// Supabase, routing, and AuthSheet have been removed.
export const NavbarReference = () => {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 bg-background/80 backdrop-blur-sm border-b border-border">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between h-16">
          <div className="flex items-center">
            <span className="text-xl font-bold text-foreground">App</span>
          </div>
          <div className="flex items-center gap-4">
            <button
              className="md:hidden"
              onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
            >
              {isMobileMenuOpen ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
            </button>
          </div>
        </div>
      </div>
    </nav>
  );
};
