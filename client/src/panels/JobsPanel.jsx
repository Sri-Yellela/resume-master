import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api.js";
import { useTheme } from "../styles/theme.jsx";

function sourceLabel(source) {
  if (source === "indeed") return "via Indeed";
  if (source === "adzuna") return "via Adzuna";
  return source ? `via ${source}` : "";
}

function JobCard({ job, theme }) {
  const applyUrl = job.applyUrl || job.apply_url || job.url;
  return (
    <article style={{ border:`1px solid ${theme.border}`, background:theme.surface, borderRadius:8, padding:16, display:"flex", flexDirection:"column", gap:10 }}>
      <div style={{ display:"flex", justifyContent:"space-between", gap:12, alignItems:"flex-start" }}>
        <div style={{ minWidth:0 }}>
          <div style={{ fontWeight:800, color:theme.text, fontSize:16 }}>{job.title || "Untitled role"}</div>
          <div style={{ color:theme.textMuted, fontSize:13, marginTop:2 }}>{job.company || "Company unavailable"}</div>
        </div>
        {job.matchScore != null && (
          <span style={{ background:theme.surfaceHigh, color:theme.text, border:`1px solid ${theme.border}`, borderRadius:6, padding:"4px 8px", fontSize:12, fontWeight:800 }}>
            {job.matchScore}%
          </span>
        )}
      </div>
      <div style={{ color:theme.textMuted, fontSize:12, display:"flex", flexWrap:"wrap", gap:8 }}>
        {job.location && <span>{job.location}</span>}
        {job.salaryDisplay && <span>{job.salaryDisplay}</span>}
        {job.contractType && <span>{job.contractType}</span>}
      </div>
      {job.description && (
        <p style={{ color:theme.textMuted, fontSize:12, lineHeight:1.5, margin:0, maxHeight:54, overflow:"hidden" }}>
          {job.description}
        </p>
      )}
      <div style={{ display:"flex", justifyContent:"space-between", gap:12, alignItems:"center", marginTop:2 }}>
        <span className="attribution" style={{ color:theme.textMuted, fontSize:11 }}>{sourceLabel(job.source)}</span>
        {applyUrl && (
          <a href={applyUrl} target="_blank" rel="noopener noreferrer" style={{ textDecoration:"none", background:theme.accent, color:"#0f0f0f", borderRadius:6, padding:"8px 12px", fontSize:12, fontWeight:800 }}>
            Apply
          </a>
        )}
      </div>
    </article>
  );
}

export default function JobsPanel() {
  const { theme } = useTheme();
  const [searchQuery, setSearchQuery] = useState("");
  const [location, setLocation] = useState("");
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const fetchJobs = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await api(`/api/jobs?q=${encodeURIComponent(searchQuery)}&location=${encodeURIComponent(location)}`);
      setJobs(Array.isArray(data?.jobs) ? data.jobs : []);
    } catch (e) {
      setError(e.message || "Could not load jobs.");
      setJobs([]);
    } finally {
      setLoading(false);
    }
  }, [searchQuery, location]);

  useEffect(() => { fetchJobs(); }, [fetchJobs]);

  return (
    <div style={{ flex:1, overflowY:"auto", background:theme.bg, padding:"28px 24px 44px" }}>
      <div style={{ maxWidth:1100, margin:"0 auto", display:"flex", flexDirection:"column", gap:18 }}>
        <div style={{ display:"flex", justifyContent:"space-between", gap:16, alignItems:"flex-end", flexWrap:"wrap" }}>
          <div>
            <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:30, fontWeight:800, letterSpacing:"0.06em", textTransform:"uppercase", color:theme.text }}>
              Jobs
            </div>
            <div style={{ color:theme.textMuted, fontSize:13 }}>Official job listings from Adzuna and Indeed.</div>
          </div>
          <form onSubmit={(e) => { e.preventDefault(); fetchJobs(); }} style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
            <input value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Role or keyword" style={{ height:36, minWidth:220, border:`1px solid ${theme.border}`, borderRadius:6, background:theme.surface, color:theme.text, padding:"0 10px" }}/>
            <input value={location} onChange={e => setLocation(e.target.value)} placeholder="Location" style={{ height:36, minWidth:180, border:`1px solid ${theme.border}`, borderRadius:6, background:theme.surface, color:theme.text, padding:"0 10px" }}/>
            <button type="submit" style={{ height:36, border:"none", borderRadius:6, background:theme.accent, color:"#0f0f0f", padding:"0 14px", fontWeight:800, cursor:"pointer" }}>
              Search
            </button>
          </form>
        </div>

        {error && <div style={{ border:`1px solid ${theme.danger}55`, background:`${theme.danger}12`, color:theme.danger, borderRadius:8, padding:12, fontSize:13 }}>{error}</div>}
        {loading && <div style={{ color:theme.textMuted, fontSize:13 }}>Loading jobs...</div>}

        {!loading && jobs.length === 0 && !error && (
          <div style={{ border:`1px solid ${theme.border}`, background:theme.surface, borderRadius:8, padding:28, textAlign:"center", color:theme.textMuted, fontSize:14 }}>
            Job feed coming soon. We're connecting to live job listings from Adzuna and Indeed.
          </div>
        )}

        {jobs.length > 0 && (
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(300px, 1fr))", gap:14 }}>
            {jobs.map(job => <JobCard key={job.id || job.jobId || job.applyUrl} job={job} theme={theme}/>) }
          </div>
        )}
      </div>
    </div>
  );
}
