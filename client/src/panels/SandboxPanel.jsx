// client/src/panels/SandboxPanel.jsx
import { useState, useEffect } from "react";

export default function SandboxPanel({ entry, onClose, onSave, onExport }) {
  const [code,      setCode]      = useState(entry?.html||"");
  const [live,      setLive]      = useState(entry?.html||"");
  const [view,      setView]      = useState("split");
  const [exporting, setExporting] = useState(false);

  useEffect(()=>{ if(entry?.html){setCode(entry.html);setLive(entry.html);} },[entry?.html]);

  const apply      = () => setLive(code);
  const save       = async () => { if(onSave) await onSave(code); };
  const downloadHtml = () => {
    const a=document.createElement("a");
    a.href=URL.createObjectURL(new Blob([live],{type:"text/html"}));
    a.download=`Resume_${(entry?.company||"resume").replace(/\s+/g,"_")}.html`;
    a.click();
  };
  const exportPdf = async () => {
    if(!live||exporting) return;
    setExporting(true);
    try { await onExport?.(null,live,entry?.company); }
    catch(e) { alert("PDF export failed: "+e.message); }
    finally { setExporting(false); }
  };

  const vBtn = t => ({...s.vb,...(view===t?s.vbActive:{})});

  return (
    <div style={s.root}>
      <div style={s.toolbar}>
        <span style={s.title}>✏️ Sandbox</span>
        {entry&&<span style={s.sub}>{entry.company} — {entry.title}</span>}
        <div style={{flex:1}}/>
        <div style={s.vgroup}>
          {[["preview","👁"],["split","⊞"],["code","✏️"]].map(([t,i])=>(
            <button key={t} style={vBtn(t)} onClick={()=>setView(t)}>{i} {t}</button>
          ))}
        </div>
        {(view==="code"||view==="split")&&<TB bg="#f59e0b" onClick={apply}>▶ Apply</TB>}
        <TB bg="#8b5cf6" disabled={!live} onClick={save}>💾 Save</TB>
        <TB bg="#10b981" disabled={!live} onClick={downloadHtml}>⬇ HTML</TB>
        <TB bg="#6366f1" disabled={!live||exporting} onClick={exportPdf}>{exporting?"⏳…":"🖨 PDF"}</TB>
        <button onClick={onClose} style={s.close}>✕</button>
      </div>

      {!entry
        ? <div style={s.empty}><div style={{fontSize:36}}>⚡</div><div style={{color:"#64748b",fontWeight:700}}>Generate a resume to populate the sandbox.</div></div>
        : (
          <div style={s.panels}>
            {(view==="code"||view==="split")&&(
              <div style={{flex:view==="split"?"0 0 44%":"1",display:"flex",flexDirection:"column",borderRight:view==="split"?"2px solid #1e293b":"none"}}>
                <div style={s.eHdr}>HTML Editor · Ctrl+Enter to apply</div>
                <textarea value={code} onChange={e=>setCode(e.target.value)}
                  onKeyDown={e=>{if((e.ctrlKey||e.metaKey)&&e.key==="Enter"){e.preventDefault();apply();}}}
                  spellCheck={false} style={s.editor}/>
              </div>
            )}
            {(view==="preview"||view==="split")&&(
              <div style={s.pWrap}>
                <div style={s.pHdr}>Live Preview</div>
                <div style={s.pScroll}>
                  <div style={{width:"100%",maxWidth:800,background:"#fff",boxShadow:"0 2px 12px #0002",borderRadius:3}}>
                    <iframe srcDoc={live} style={{width:"100%",minHeight:900,border:"none",display:"block"}} title="preview" sandbox="allow-same-origin"/>
                  </div>
                </div>
              </div>
            )}
          </div>
        )
      }
    </div>
  );
}

const TB = ({bg,disabled,onClick,children}) => (
  <button style={{background:disabled?"#475569":bg,color:"#fff",border:"none",borderRadius:5,padding:"5px 11px",cursor:disabled?"not-allowed":"pointer",fontSize:11,fontWeight:700,whiteSpace:"nowrap",opacity:disabled?0.5:1}} disabled={disabled} onClick={onClick}>{children}</button>
);

const s = {
  root:    {display:"flex",flexDirection:"column",height:"100%",background:"#0f172a"},
  toolbar: {background:"#1e293b",padding:"7px 12px",display:"flex",alignItems:"center",gap:7,flexShrink:0,borderBottom:"1px solid #334155",flexWrap:"wrap"},
  title:   {fontWeight:800,fontSize:12,color:"#38bdf8"},
  sub:     {fontSize:10,color:"#64748b",borderLeft:"1px solid #334155",paddingLeft:8},
  vgroup:  {display:"flex",background:"#0f172a",borderRadius:5,padding:2,gap:1},
  vb:      {background:"transparent",color:"#94a3b8",border:"none",borderRadius:4,padding:"3px 10px",cursor:"pointer",fontSize:11,fontWeight:700},
  vbActive:{background:"#3b82f6",color:"#fff"},
  close:   {background:"transparent",color:"#64748b",border:"1px solid #334155",borderRadius:4,padding:"3px 8px",cursor:"pointer",fontSize:11},
  panels:  {flex:1,display:"flex",overflow:"hidden"},
  eHdr:    {background:"#0d1117",padding:"4px 10px",fontSize:10,color:"#475569",borderBottom:"1px solid #1e293b",flexShrink:0},
  editor:  {flex:1,background:"#0d1117",color:"#e2e8f0",border:"none",outline:"none",fontFamily:"'Courier New',monospace",fontSize:11,lineHeight:1.6,padding:10,resize:"none",tabSize:2},
  pWrap:   {flex:1,display:"flex",flexDirection:"column",background:"#e2e8f0",overflow:"auto"},
  pHdr:    {background:"#f1f5f9",padding:"4px 10px",fontSize:10,color:"#64748b",borderBottom:"1px solid #cbd5e1",flexShrink:0},
  pScroll: {flex:1,padding:10,display:"flex",justifyContent:"center",overflow:"auto"},
  empty:   {flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:10},
};
