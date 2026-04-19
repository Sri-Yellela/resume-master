import { createContext, useContext, useCallback, useRef, useState } from "react";

const JobBoardContext = createContext(null);
const PROFILE_UI_CACHE_KEY = "rm_jobs_profile_ui_v1";

export function JobBoardProvider({ children }) {
  const [boardTab,    setBoardTab]    = useState("all");
  const [localSearch, setLocalSearch] = useState("");
  const [sortBy,      setSortBy]      = useState("dateDesc");
  const [activeProfileId, setActiveProfileId] = useState(null);
  const profileCacheRef = useRef(new Map());

  const getProfileCache = useCallback((profileId) => {
    if (profileId == null) return null;
    return profileCacheRef.current.get(String(profileId)) || null;
  }, []);

  const setProfileCache = useCallback((profileId, snapshot) => {
    if (profileId == null || !snapshot) return;
    profileCacheRef.current.set(String(profileId), { ...snapshot, cachedAt: Date.now() });
  }, []);

  const deleteProfileCache = useCallback((profileId) => {
    if (profileId == null) return;
    profileCacheRef.current.delete(String(profileId));
    try {
      const all = JSON.parse(localStorage.getItem(PROFILE_UI_CACHE_KEY) || "{}");
      delete all[String(profileId)];
      localStorage.setItem(PROFILE_UI_CACHE_KEY, JSON.stringify(all));
    } catch {}
  }, []);

  return (
    <JobBoardContext.Provider value={{
      boardTab, setBoardTab, localSearch, setLocalSearch, sortBy, setSortBy,
      activeProfileId, setActiveProfileId, getProfileCache, setProfileCache, deleteProfileCache,
    }}>
      {children}
    </JobBoardContext.Provider>
  );
}

export function useJobBoard() { return useContext(JobBoardContext); }
