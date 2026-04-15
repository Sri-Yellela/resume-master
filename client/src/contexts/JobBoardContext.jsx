import { createContext, useContext, useState } from "react";

const JobBoardContext = createContext(null);

export function JobBoardProvider({ children }) {
  const [boardTab,    setBoardTab]    = useState("all");
  const [localSearch, setLocalSearch] = useState("");
  const [sortBy,      setSortBy]      = useState("dateDesc");
  return (
    <JobBoardContext.Provider value={{ boardTab, setBoardTab, localSearch, setLocalSearch, sortBy, setSortBy }}>
      {children}
    </JobBoardContext.Provider>
  );
}

export function useJobBoard() { return useContext(JobBoardContext); }
