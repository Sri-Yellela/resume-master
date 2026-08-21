import { createContext, useContext, useCallback, useRef, useState } from "react";

const JobBoardContext = createContext(null);
const PROFILE_UI_CACHE_KEY = "rm_jobs_profile_ui_v1";

// Every field UnifiedSearchBar publishes. Spread over the incoming object on every apply, so a
// cleared control arrives as "" and actually clears the board's filter rather than leaving the
// previous value behind — the failure mode a partial update would produce.
const EMPTY_BAR_FILTERS = { query: "", location: "", experience: "", domain: "", status: "" };

export function JobBoardProvider({ children }) {
  const [boardTab,    setBoardTab]    = useState("all");
  const [localSearch, setLocalSearch] = useState("");
  const [sortBy,      setSortBy]      = useState("dateDesc");
  const [activeProfileId, setActiveProfileId] = useState(null);
  const [selectedJob, setSelectedJob] = useState(null);
  const [selectedJobMeta, setSelectedJobMeta] = useState(null);
  const profileCacheRef = useRef(new Map());

  // -- The search bar's published filter set ------------------------------------------------
  //
  // UnifiedSearchBar is rendered by App.jsx, ABOVE the board, and the board's filter state lives
  // inside JobsPanel — so the bar had no way to reach it and was handed `onSearch={() => {}}` /
  // `onLocalFilter={() => {}}`. Measured before this: typing a keyword, both Search clicks, and all
  // three selects produced ZERO /api/jobs requests between them, while the sort select, NEW IN 24H,
  // the FILTERS drawer and the collapsed pill (which are JobsPanel-owned, or reach it through this
  // same context) each fired correctly. Every control on the app's most prominent surface was inert.
  //
  // This is the channel, and it is deliberately the SHAPE THE BAR ALREADY PUBLISHES — the same
  // { query, location, experience, domain, status } object LandingPage's handlers already destructure
  // — so there is one vocabulary between the two consumers rather than a second one invented here.
  // JobsPanel maps it onto its own committed filter state, which feeds buildParams; nothing bypasses
  // buildParams, so there is still exactly one param builder.
  const [barFilters, setBarFilters] = useState(EMPTY_BAR_FILTERS);
  // Bumped only by the SECOND click (the live half of the double-click local->live pattern). It is a
  // counter rather than a boolean because two consecutive live searches for the same terms must both
  // run — a boolean would latch and the second would be a no-op.
  const [liveSearchTick, setLiveSearchTick] = useState(0);

  const applyBarFilters = useCallback((params, { live = false } = {}) => {
    setBarFilters({ ...EMPTY_BAR_FILTERS, ...(params || {}) });
    if (live) setLiveSearchTick(t => t + 1);
  }, []);

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
      selectedJob, setSelectedJob, selectedJobMeta, setSelectedJobMeta,
      barFilters, applyBarFilters, liveSearchTick,
    }}>
      {children}
    </JobBoardContext.Provider>
  );
}

export function useJobBoard() { return useContext(JobBoardContext); }
