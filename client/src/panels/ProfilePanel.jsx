// REVAMP v2 — ProfilePanel.jsx (shadcn UI integrated)
// Changes: single full_name field, phone normaliser, URL normaliser, ZIP normaliser
import { useState, useEffect } from "react";
import { api }      from "../lib/api.js";
import { useTheme } from "../styles/theme.jsx";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Button } from "../components/ui/button";
import { Separator } from "../components/ui/separator";
import { Card, CardContent } from "../components/ui/card";
import { Checkbox } from "../components/ui/checkbox";
import { Switch } from "../components/ui/switch";
import { SectionHeader } from "../components/SectionHeader";

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
    width:"100%", padding:"7px 10px", borderRadius:"10px",
    border:`1px solid ${theme.colorBorder}`, background:theme.colorSurface,
    color:theme.colorText, fontSize:12, outline:"none", boxSizing:"border-box",
  };

  return (
    <div style={{ padding:"18px 24px", overflowY:"auto", height:"100%",
                  boxSizing:"border-box", maxWidth:640, background:theme.gradBg }}>
      <SectionHeader title="👤 Profile" divider/>
      <form onSubmit={save} style={{ marginTop:16 }}>

        {/* ── Personal ── */}
        <PSec title="Personal" theme={theme}>
          <PRow label="Full Name">
            <Input value={form.full_name || ""} onChange={e => set("full_name", e.target.value)}
              placeholder="First Last (or First Middle Last)"
              className="bg-background border-border text-foreground text-xs"/>
            <PHint theme={theme}>Enter your name exactly as it should appear on your resume and applications.</PHint>
          </PRow>
          <PRow label="Email">
            <Input type="email" value={form.email || ""} onChange={e => set("email", e.target.value)}
              placeholder="you@email.com"
              className="bg-background border-border text-foreground text-xs"/>
          </PRow>
          <PRow label="Phone">
            <Input type="tel" value={form.phone || ""}
              onChange={e => set("phone", e.target.value)}
              onBlur={blurPhone}
              placeholder="+1 (555) 000-0000 or 5550001234"
              className="bg-background border-border text-foreground text-xs"/>
            <PHint theme={theme}>Any format accepted — normalised to +1 (XXX) XXX-XXXX on save.</PHint>
          </PRow>
          <PRow label="LinkedIn URL">
            <Input value={form.linkedin_url || ""}
              onChange={e => set("linkedin_url", e.target.value)}
              onBlur={blurLinkedin}
              placeholder="linkedin.com/in/yourhandle"
              className="bg-background border-border text-foreground text-xs"/>
          </PRow>
          <PRow label="GitHub URL">
            <Input value={form.github_url || ""}
              onChange={e => set("github_url", e.target.value)}
              onBlur={blurGithub}
              placeholder="github.com/yourhandle"
              className="bg-background border-border text-foreground text-xs"/>
          </PRow>
        </PSec>

        {/* ── Address ── */}
        <PSec title="Address (for autofill)" theme={theme}>
          <PRow label="Street Address">
            <Input value={form.address_line1 || ""} onChange={e => set("address_line1", e.target.value)}
              placeholder="123 Main St"
              className="bg-background border-border text-foreground text-xs"/>
          </PRow>
          <PRow label="Apt / Suite">
            <Input value={form.address_line2 || ""} onChange={e => set("address_line2", e.target.value)}
              placeholder="Apt 4B"
              className="bg-background border-border text-foreground text-xs"/>
          </PRow>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8 }}>
            <div>
              <PL theme={theme}>City</PL>
              <Input value={form.city || ""} onChange={e => set("city", e.target.value)}
                onBlur={syncLocation} placeholder="Boston"
                style={{ background:theme.colorSurface, borderColor:theme.colorBorder,
                         color:theme.colorText, fontSize:12 }}/>
            </div>
            <div>
              <PL theme={theme}>State</PL>
              <Input value={form.state || ""} onChange={e => set("state", e.target.value)}
                onBlur={() => { blurState(); syncLocation(); }} placeholder="MA"
                style={{ background:theme.colorSurface, borderColor:theme.colorBorder,
                         color:theme.colorText, fontSize:12 }}/>
              <PHint theme={theme}>2-letter code</PHint>
            </div>
            <div>
              <PL theme={theme}>ZIP</PL>
              <Input value={form.zip || ""} onChange={e => set("zip", e.target.value)}
                onBlur={blurZip} placeholder="02101"
                style={{ background:theme.colorSurface, borderColor:theme.colorBorder,
                         color:theme.colorText, fontSize:12 }}/>
            </div>
          </div>
          <div style={{ marginTop:8 }}>
            <PL theme={theme}>Country</PL>
            <select style={selStyle} value={form.country}
              onChange={e => set("country", e.target.value)}>
              <option>United States</option><option>Canada</option>
              <option>United Kingdom</option><option>India</option><option>Other</option>
            </select>
          </div>
        </PSec>

        {/* ── Work Auth ── */}
        <PSec title="Work Authorization" theme={theme}>
          <PRow label="Visa / Immigration Status">
            <select style={selStyle} value={form.visa_type}
              onChange={e => set("visa_type", e.target.value)}>
              <option value="">Select…</option>
              <option>US Citizen</option><option>Green Card / LPR</option>
              <option>H-1B</option><option>OPT</option><option>STEM OPT</option>
              <option>TN Visa</option><option>O-1</option><option>Other</option>
            </select>
          </PRow>
          <PRow label="Work Authorization">
            <select style={selStyle} value={form.work_auth}
              onChange={e => set("work_auth", e.target.value)}>
              <option value="">Select…</option>
              <option>Authorized to work in the US without sponsorship</option>
              <option>Will require sponsorship now or in the future</option>
            </select>
          </PRow>
          <label style={{ display:"flex", alignItems:"center", gap:8,
                          marginBottom:8, cursor:"pointer",
                          fontSize:12, color:theme.colorText }}>
            <Checkbox
              checked={!!form.requires_sponsorship}
              onCheckedChange={v => set("requires_sponsorship", !!v)}
              className="border-primary data-[state=checked]:bg-primary"/>
            Requires visa sponsorship
          </label>
          <label style={{ display:"flex", alignItems:"center", gap:8,
                          marginBottom:8, cursor:"pointer",
                          fontSize:12, color:theme.colorText }}>
            <Checkbox
              checked={!!form.has_clearance}
              onCheckedChange={v => set("has_clearance", !!v)}
              className="border-primary data-[state=checked]:bg-primary"/>
            Active security clearance
          </label>
          {form.has_clearance && (
            <PRow label="Clearance Level">
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
          <p style={{ fontSize:10, color:theme.colorMuted, lineHeight:1.6, marginBottom:10 }}>
            These fields are voluntary and used solely for EEO reporting autofill.
            They do not affect your resume or job search.
          </p>
          <PRow label="Gender">
            <select style={selStyle} value={form.gender}
              onChange={e => set("gender", e.target.value)}>
              <option value="">Prefer not to say</option>
              <option>Male</option><option>Female</option>
              <option>Non-binary / third gender</option>
            </select>
          </PRow>
          <PRow label="Race / Ethnicity">
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
          <PRow label="Veteran Status">
            <select style={selStyle} value={form.veteran_status}
              onChange={e => set("veteran_status", e.target.value)}>
              <option value="">Prefer not to say</option>
              <option>I am a protected veteran</option>
              <option>I am not a protected veteran</option>
            </select>
          </PRow>
          <PRow label="Disability Status">
            <select style={selStyle} value={form.disability_status}
              onChange={e => set("disability_status", e.target.value)}>
              <option value="">Prefer not to say</option>
              <option>Yes, I have a disability</option>
              <option>No, I do not have a disability</option>
            </select>
          </PRow>
        </PSec>

        <div style={{ display:"flex", alignItems:"center", gap:12, marginTop:8 }}>
          <Button type="submit"
            className="bg-primary text-primary-foreground font-bold px-7 py-2 rounded-full hover:bg-primary/90">
            Save Profile
          </Button>
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
const PSec = ({ title, children, theme }) => (
  <div style={{ marginBottom:22 }}>
    <div style={{ fontWeight:800, fontSize:12, color:theme.colorPrimary,
                  textTransform:"uppercase", letterSpacing:"1px",
                  marginBottom:10, paddingBottom:6,
                  borderBottom:`1px solid ${theme.colorBorder}` }}>
      {title}
    </div>
    {children}
  </div>
);

const PRow = ({ label, children }) => (
  <div style={{ display:"flex", flexDirection:"column", marginBottom:8 }}>
    {children}
  </div>
);

const PL = ({ children, theme }) => (
  <span style={{ fontSize:10, color:theme.colorMuted, fontWeight:600,
                 textTransform:"uppercase", letterSpacing:"0.5px", marginBottom:3,
                 display:"block" }}>
    {children}
  </span>
);

const PHint = ({ children, theme }) => (
  <span style={{ fontSize:9, color:theme.colorDim, marginTop:2, lineHeight:1.4, display:"block" }}>
    {children}
  </span>
);
