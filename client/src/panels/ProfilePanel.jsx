// client/src/panels/ProfilePanel.jsx — v2
// Changes: single full_name field, phone normaliser, URL normaliser, ZIP normaliser
import { useState, useEffect } from "react";
import { api } from "../lib/api.js";

// ── Field normalisers ─────────────────────────────────────────
// Phone: strips everything non-digit, then formats as +1XXXXXXXXXX
// Accepts: 9999999999 / +19999999999 / +1 (909) 999-9999 / (909) 999-9999
function normalisePhone(raw) {
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  // Strip leading country code 1 if present and result is 11 digits
  const local = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (local.length !== 10) return raw; // can't normalise — return as-is
  return `+1 (${local.slice(0,3)}) ${local.slice(3,6)}-${local.slice(6)}`;
}

// URL: ensure linkedin/github URLs start with https://
function normaliseUrl(raw) {
  if (!raw) return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return trimmed;
  return "https://" + trimmed;
}

// ZIP: digits only, max 5 (US) or 6 (CA)
function normaliseZip(raw) {
  if (!raw) return "";
  return raw.replace(/[^\dA-Z\s-]/gi, "").trim().slice(0, 7);
}

// State: uppercase 2-letter abbreviation
function normaliseState(raw) {
  if (!raw) return "";
  return raw.trim().toUpperCase().slice(0, 2);
}

export function ProfilePanel() {
  const BLANK = {
    full_name:"", email:"", phone:"",
    linkedin_url:"", github_url:"",
    location:"", address_line1:"", address_line2:"",
    city:"", state:"", zip:"", country:"United States",
    gender:"", ethnicity:"", veteran_status:"", disability_status:"",
    requires_sponsorship:false, has_clearance:false,
    clearance_level:"", visa_type:"", work_auth:"",
  };

  const [form,   setForm]   = useState(BLANK);
  const [status, setStatus] = useState("");

  useEffect(() => {
    api("/api/profile")
      .then(d => setForm(f => ({
        ...f, ...d,
        requires_sponsorship: !!d.requires_sponsorship,
        has_clearance:        !!d.has_clearance,
      })))
      .catch(() => {});
  }, []);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  // Normalise on blur for fields that benefit from it
  const blurPhone    = () => set("phone",        normalisePhone(form.phone));
  const blurLinkedin = () => set("linkedin_url", normaliseUrl(form.linkedin_url));
  const blurGithub   = () => set("github_url",   normaliseUrl(form.github_url));
  const blurZip      = () => set("zip",          normaliseZip(form.zip));
  const blurState    = () => set("state",        normaliseState(form.state));

  // Auto-populate location from city+state
  const syncLocation = () => {
    if (form.city || form.state) {
      set("location", [form.city, form.state].filter(Boolean).join(", "));
    }
  };

  const save = async e => {
    e.preventDefault();
    // Final normalisation pass before saving
    const cleaned = {
      ...form,
      phone:        normalisePhone(form.phone),
      linkedin_url: normaliseUrl(form.linkedin_url),
      github_url:   normaliseUrl(form.github_url),
      zip:          normaliseZip(form.zip),
      state:        normaliseState(form.state),
      location:     form.city && form.state
                      ? `${form.city}, ${form.state}`
                      : (form.city || form.state || form.location || ""),
    };
    try {
      await api("/api/profile", { method:"POST", body:JSON.stringify(cleaned) });
      setForm(cleaned);
      setStatus("✓ Saved");
      setTimeout(() => setStatus(""), 3000);
    } catch { setStatus("✗ Save failed"); }
  };

  return (
    <div style={{ padding:"18px 24px", overflowY:"auto", height:"100%",
                  boxSizing:"border-box", maxWidth:640 }}>
      <h2 style={{ fontWeight:800, fontSize:15, color:"#38bdf8", marginBottom:18 }}>
        👤 Profile
      </h2>
      <form onSubmit={save}>

        {/* ── Personal ── */}
        <PSec title="Personal">
          {/* Single full name field — autofill engine splits first/last internally */}
          <PRow label="Full Name">
            <PI value={form.full_name} onChange={v => set("full_name", v)}
              placeholder="First Last (or First Middle Last)"/>
            <PHint>Enter your name exactly as it should appear on your resume and applications.</PHint>
          </PRow>
          <PRow label="Email">
            <PI type="email" value={form.email} onChange={v => set("email", v)}
              placeholder="you@email.com"/>
          </PRow>
          <PRow label="Phone">
            <PI type="tel" value={form.phone}
              onChange={v => set("phone", v)}
              onBlur={blurPhone}
              placeholder="+1 (555) 000-0000 or 5550001234"/>
            <PHint>Any format accepted — normalised to +1 (XXX) XXX-XXXX on save.</PHint>
          </PRow>
          <PRow label="LinkedIn URL">
            <PI value={form.linkedin_url}
              onChange={v => set("linkedin_url", v)}
              onBlur={blurLinkedin}
              placeholder="linkedin.com/in/yourhandle"/>
          </PRow>
          <PRow label="GitHub URL">
            <PI value={form.github_url}
              onChange={v => set("github_url", v)}
              onBlur={blurGithub}
              placeholder="github.com/yourhandle"/>
          </PRow>
        </PSec>

        {/* ── Address ── */}
        <PSec title="Address (for autofill)">
          <PRow label="Street Address">
            <PI value={form.address_line1} onChange={v => set("address_line1", v)}
              placeholder="123 Main St"/>
          </PRow>
          <PRow label="Apt / Suite">
            <PI value={form.address_line2} onChange={v => set("address_line2", v)}
              placeholder="Apt 4B"/>
          </PRow>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8 }}>
            <div>
              <PL>City</PL>
              <PI value={form.city}
                onChange={v => set("city", v)}
                onBlur={syncLocation}
                placeholder="Boston"/>
            </div>
            <div>
              <PL>State</PL>
              <PI value={form.state}
                onChange={v => set("state", v)}
                onBlur={() => { blurState(); syncLocation(); }}
                placeholder="MA"/>
              <PHint>2-letter code</PHint>
            </div>
            <div>
              <PL>ZIP</PL>
              <PI value={form.zip}
                onChange={v => set("zip", v)}
                onBlur={blurZip}
                placeholder="02101"/>
            </div>
          </div>
          <div style={{ marginTop:8 }}>
            <PL>Country</PL>
            <select style={inpStyle} value={form.country}
              onChange={e => set("country", e.target.value)}>
              <option>United States</option><option>Canada</option>
              <option>United Kingdom</option><option>India</option>
              <option>Other</option>
            </select>
          </div>
        </PSec>

        {/* ── Work Auth ── */}
        <PSec title="Work Authorization">
          <PRow label="Visa / Immigration Status">
            <select style={inpStyle} value={form.visa_type}
              onChange={e => set("visa_type", e.target.value)}>
              <option value="">Select…</option>
              <option>US Citizen</option><option>Green Card / LPR</option>
              <option>H-1B</option><option>OPT</option><option>STEM OPT</option>
              <option>TN Visa</option><option>O-1</option><option>Other</option>
            </select>
          </PRow>
          <PRow label="Work Authorization">
            <select style={inpStyle} value={form.work_auth}
              onChange={e => set("work_auth", e.target.value)}>
              <option value="">Select…</option>
              <option>Authorized to work in the US without sponsorship</option>
              <option>Will require sponsorship now or in the future</option>
            </select>
          </PRow>
          <label style={chkStyle}>
            <input type="checkbox" checked={form.requires_sponsorship}
              onChange={e => set("requires_sponsorship", e.target.checked)}
              style={{ accentColor:"#38bdf8" }}/>
            Requires visa sponsorship
          </label>
          <label style={chkStyle}>
            <input type="checkbox" checked={form.has_clearance}
              onChange={e => set("has_clearance", e.target.checked)}
              style={{ accentColor:"#38bdf8" }}/>
            Active security clearance
          </label>
          {form.has_clearance && (
            <PRow label="Clearance Level">
              <select style={inpStyle} value={form.clearance_level}
                onChange={e => set("clearance_level", e.target.value)}>
                <option value="">Select…</option>
                <option>Public Trust</option><option>Secret</option>
                <option>Top Secret</option><option>TS/SCI</option>
                <option>TS/SCI + Poly</option>
              </select>
            </PRow>
          )}
        </PSec>

        {/* ── EEO ── */}
        <PSec title="Voluntary Self-Identification (EEO)">
          <p style={{ fontSize:10, color:"#475569", lineHeight:1.6, marginBottom:10 }}>
            These fields are voluntary and used solely for EEO reporting autofill.
            They do not affect your resume or job search.
          </p>
          <PRow label="Gender">
            <select style={inpStyle} value={form.gender}
              onChange={e => set("gender", e.target.value)}>
              <option value="">Prefer not to say</option>
              <option>Male</option><option>Female</option>
              <option>Non-binary / third gender</option>
            </select>
          </PRow>
          <PRow label="Race / Ethnicity">
            <select style={inpStyle} value={form.ethnicity}
              onChange={e => set("ethnicity", e.target.value)}>
              <option value="">Prefer not to say</option>
              <option>Hispanic or Latino</option>
              <option>White (not Hispanic or Latino)</option>
              <option>Black or African American</option>
              <option>Asian</option>
              <option>Native Hawaiian or Other Pacific Islander</option>
              <option>American Indian or Alaska Native</option>
              <option>Two or more races</option>
            </select>
          </PRow>
          <PRow label="Veteran Status">
            <select style={inpStyle} value={form.veteran_status}
              onChange={e => set("veteran_status", e.target.value)}>
              <option value="">Prefer not to say</option>
              <option>I am a protected veteran</option>
              <option>I am not a protected veteran</option>
            </select>
          </PRow>
          <PRow label="Disability Status">
            <select style={inpStyle} value={form.disability_status}
              onChange={e => set("disability_status", e.target.value)}>
              <option value="">Prefer not to say</option>
              <option>Yes, I have a disability</option>
              <option>No, I do not have a disability</option>
            </select>
          </PRow>
        </PSec>

        <div style={{ display:"flex", alignItems:"center", gap:12, marginTop:8 }}>
          <button type="submit"
            style={{ background:"#3b82f6", color:"#fff", border:"none",
                     borderRadius:6, padding:"8px 20px", cursor:"pointer",
                     fontWeight:700, fontSize:12 }}>
            Save Profile
          </button>
          {status && (
            <span style={{ fontSize:11,
              color:status.startsWith("✓") ? "#86efac" : "#fca5a5" }}>
              {status}
            </span>
          )}
        </div>
      </form>
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────
const PSec = ({ title, children }) => (
  <div style={{ marginBottom:22 }}>
    <div style={{ fontWeight:700, fontSize:11, color:"#38bdf8",
                  textTransform:"uppercase", letterSpacing:"0.8px",
                  marginBottom:10, paddingBottom:6, borderBottom:"1px solid #1e293b" }}>
      {title}
    </div>
    {children}
  </div>
);

const PRow = ({ label, children }) => (
  <div style={{ display:"flex", flexDirection:"column", marginBottom:8 }}>
    <PL>{label}</PL>
    {children}
  </div>
);

const PL = ({ children }) => (
  <span style={{ fontSize:10, color:"#64748b", fontWeight:600,
                 textTransform:"uppercase", letterSpacing:"0.5px", marginBottom:3 }}>
    {children}
  </span>
);

const PHint = ({ children }) => (
  <span style={{ fontSize:9, color:"#334155", marginTop:2, lineHeight:1.4 }}>
    {children}
  </span>
);

const inpStyle = {
  width:"100%", padding:"7px 10px", borderRadius:5,
  border:"1px solid #1e293b", background:"#0f172a",
  color:"#f8fafc", fontSize:12, outline:"none", boxSizing:"border-box",
};

// Generic input with optional onBlur normaliser
function PI({ value, onChange, onBlur, type="text", placeholder }) {
  return (
    <input
      style={inpStyle}
      type={type}
      value={value || ""}
      onChange={e => onChange(e.target.value)}
      onBlur={onBlur}
      placeholder={placeholder}
    />
  );
}

const chkStyle = {
  display:"flex", alignItems:"center", gap:8,
  marginBottom:8, cursor:"pointer", fontSize:12, color:"#cbd5e1",
};
