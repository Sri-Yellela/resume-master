// client/src/panels/ProfilePanel.jsx — Design System v4
import { useState, useEffect } from "react";
import { api }      from "../lib/api.js";
import { useTheme } from "../styles/theme.jsx";

// ── Field normalisers ─────────────────────────────────────────
function normalisePhone(raw) {
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  const local = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (local.length !== 10) return raw;
  return `+1 (${local.slice(0,3)}) ${local.slice(3,6)}-${local.slice(6)}`;
}
function normaliseUrl(raw) {
  if (!raw) return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return trimmed;
  return "https://" + trimmed;
}
function normaliseZip(raw) {
  if (!raw) return "";
  return raw.replace(/[^\dA-Z\s-]/gi, "").trim().slice(0, 7);
}
function normaliseState(raw) {
  if (!raw) return "";
  return raw.trim().toUpperCase().slice(0, 2);
}

// ── Sub-components ─────────────────────────────────────────────
function PSec({ title, children, theme }) {
  return (
    <div style={{ marginBottom:20 }}>
      <div className="rm-section-label">{title}</div>
      <div style={{ background:theme.surface, border:`1px solid ${theme.border}`,
                    borderRadius:16, padding:"20px 24px",
                    boxShadow:theme.shadowSm }}>
        {children}
      </div>
    </div>
  );
}

const labelStyle = {
  fontSize:11, fontWeight:600, textTransform:"uppercase",
  letterSpacing:"0.05em", display:"block", marginBottom:4,
};

const PRow = ({ label, children, theme }) => (
  <div style={{ display:"flex", flexDirection:"column", marginBottom:12 }}>
    <span style={{ ...labelStyle, color:theme.textMuted }}>{label}</span>
    {children}
  </div>
);

const PHint = ({ children, theme }) => (
  <span style={{ fontSize:10, color:theme.textDim, marginTop:3, lineHeight:1.4, display:"block" }}>
    {children}
  </span>
);

export function ProfilePanel() {
  const { theme } = useTheme();

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

  const blurPhone    = () => set("phone",        normalisePhone(form.phone));
  const blurLinkedin = () => set("linkedin_url", normaliseUrl(form.linkedin_url));
  const blurGithub   = () => set("github_url",   normaliseUrl(form.github_url));
  const blurZip      = () => set("zip",          normaliseZip(form.zip));
  const blurState    = () => set("state",        normaliseState(form.state));

  const syncLocation = () => {
    if (form.city || form.state) {
      set("location", [form.city, form.state].filter(Boolean).join(", "));
    }
  };

  const save = async e => {
    e.preventDefault();
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

  const selStyle = {
    width:"100%", height:40, padding:"0 12px", borderRadius:10,
    border:`1px solid ${theme.border}`, background:theme.surface,
    color:theme.text, fontSize:13, outline:"none", boxSizing:"border-box",
  };

  return (
    <div style={{ maxWidth:680, margin:"0 auto", padding:"32px 24px",
                  overflowY:"auto", height:"100%", boxSizing:"border-box" }}>
      <div style={{ fontWeight:900, fontSize:22, color:theme.text,
                    letterSpacing:"-0.5px", marginBottom:24 }}>
        Profile
      </div>
      <form onSubmit={save}>

        {/* ── Personal ── */}
        <PSec title="Personal" theme={theme}>
          <PRow label="Full Name" theme={theme}>
            <input className="rm-input" value={form.full_name || ""}
              onChange={e => set("full_name", e.target.value)}
              placeholder="First Last (or First Middle Last)"/>
            <PHint theme={theme}>Enter your name exactly as it should appear on your resume and applications.</PHint>
          </PRow>
          <PRow label="Email" theme={theme}>
            <input className="rm-input" type="email" value={form.email || ""}
              onChange={e => set("email", e.target.value)}
              placeholder="you@email.com"/>
          </PRow>
          <PRow label="Phone" theme={theme}>
            <input className="rm-input" type="tel" value={form.phone || ""}
              onChange={e => set("phone", e.target.value)}
              onBlur={blurPhone}
              placeholder="+1 (555) 000-0000 or 5550001234"/>
            <PHint theme={theme}>Any format accepted — normalised to +1 (XXX) XXX-XXXX on save.</PHint>
          </PRow>
          <PRow label="LinkedIn URL" theme={theme}>
            <input className="rm-input" value={form.linkedin_url || ""}
              onChange={e => set("linkedin_url", e.target.value)}
              onBlur={blurLinkedin}
              placeholder="linkedin.com/in/yourhandle"/>
          </PRow>
          <PRow label="GitHub URL" theme={theme}>
            <input className="rm-input" value={form.github_url || ""}
              onChange={e => set("github_url", e.target.value)}
              onBlur={blurGithub}
              placeholder="github.com/yourhandle"/>
          </PRow>
        </PSec>

        {/* ── Address ── */}
        <PSec title="Address (for autofill)" theme={theme}>
          <PRow label="Street Address" theme={theme}>
            <input className="rm-input" value={form.address_line1 || ""}
              onChange={e => set("address_line1", e.target.value)}
              placeholder="123 Main St"/>
          </PRow>
          <PRow label="Apt / Suite" theme={theme}>
            <input className="rm-input" value={form.address_line2 || ""}
              onChange={e => set("address_line2", e.target.value)}
              placeholder="Apt 4B"/>
          </PRow>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:12 }}>
            <PRow label="City" theme={theme}>
              <input className="rm-input" value={form.city || ""}
                onChange={e => set("city", e.target.value)}
                onBlur={syncLocation} placeholder="Boston"/>
            </PRow>
            <PRow label="State" theme={theme}>
              <input className="rm-input" value={form.state || ""}
                onChange={e => set("state", e.target.value)}
                onBlur={() => { blurState(); syncLocation(); }} placeholder="MA"/>
              <PHint theme={theme}>2-letter code</PHint>
            </PRow>
            <PRow label="ZIP" theme={theme}>
              <input className="rm-input" value={form.zip || ""}
                onChange={e => set("zip", e.target.value)}
                onBlur={blurZip} placeholder="02101"/>
            </PRow>
          </div>
          <PRow label="Country" theme={theme}>
            <select style={selStyle} value={form.country}
              onChange={e => set("country", e.target.value)}>
              <option>United States</option><option>Canada</option>
              <option>United Kingdom</option><option>India</option><option>Other</option>
            </select>
          </PRow>
        </PSec>

        {/* ── Work Auth ── */}
        <PSec title="Work Authorization" theme={theme}>
          <PRow label="Visa / Immigration Status" theme={theme}>
            <select style={selStyle} value={form.visa_type}
              onChange={e => set("visa_type", e.target.value)}>
              <option value="">Select…</option>
              <option>US Citizen</option><option>Green Card / LPR</option>
              <option>H-1B</option><option>OPT</option><option>STEM OPT</option>
              <option>TN Visa</option><option>O-1</option><option>Other</option>
            </select>
          </PRow>
          <PRow label="Work Authorization" theme={theme}>
            <select style={selStyle} value={form.work_auth}
              onChange={e => set("work_auth", e.target.value)}>
              <option value="">Select…</option>
              <option>Authorized to work in the US without sponsorship</option>
              <option>Will require sponsorship now or in the future</option>
            </select>
          </PRow>
          <label style={{ display:"flex", alignItems:"center", gap:8,
                          marginBottom:10, cursor:"pointer",
                          fontSize:13, color:theme.text }}>
            <input type="checkbox" checked={!!form.requires_sponsorship}
              onChange={e => set("requires_sponsorship", e.target.checked)}
              style={{ accentColor:theme.accent, width:16, height:16 }}/>
            Requires visa sponsorship
          </label>
          <label style={{ display:"flex", alignItems:"center", gap:8,
                          marginBottom:10, cursor:"pointer",
                          fontSize:13, color:theme.text }}>
            <input type="checkbox" checked={!!form.has_clearance}
              onChange={e => set("has_clearance", e.target.checked)}
              style={{ accentColor:theme.accent, width:16, height:16 }}/>
            Active security clearance
          </label>
          {form.has_clearance && (
            <PRow label="Clearance Level" theme={theme}>
              <select style={selStyle} value={form.clearance_level}
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
        <PSec title="Voluntary Self-Identification (EEO)" theme={theme}>
          <p style={{ fontSize:12, color:theme.textMuted, lineHeight:1.6, marginBottom:14 }}>
            These fields are voluntary and used solely for EEO reporting autofill.
            They do not affect your resume or job search.
          </p>
          <PRow label="Gender" theme={theme}>
            <select style={selStyle} value={form.gender}
              onChange={e => set("gender", e.target.value)}>
              <option value="">Prefer not to say</option>
              <option>Male</option><option>Female</option>
              <option>Non-binary / third gender</option>
            </select>
          </PRow>
          <PRow label="Race / Ethnicity" theme={theme}>
            <select style={selStyle} value={form.ethnicity}
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
          <PRow label="Veteran Status" theme={theme}>
            <select style={selStyle} value={form.veteran_status}
              onChange={e => set("veteran_status", e.target.value)}>
              <option value="">Prefer not to say</option>
              <option>I am a protected veteran</option>
              <option>I am not a protected veteran</option>
            </select>
          </PRow>
          <PRow label="Disability Status" theme={theme}>
            <select style={selStyle} value={form.disability_status}
              onChange={e => set("disability_status", e.target.value)}>
              <option value="">Prefer not to say</option>
              <option>Yes, I have a disability</option>
              <option>No, I do not have a disability</option>
            </select>
          </PRow>
        </PSec>

        <div style={{ display:"flex", justifyContent:"flex-end", alignItems:"center",
                      gap:14, marginTop:8 }}>
          {status && (
            <span style={{ fontSize:12,
              color:status.startsWith("✓") ? theme.success : theme.danger }}>
              {status}
            </span>
          )}
          <button type="submit" className="rm-btn rm-btn-primary"
            style={{ padding:"10px 28px", fontSize:14 }}>
            Save Profile
          </button>
        </div>
      </form>
    </div>
  );
}
