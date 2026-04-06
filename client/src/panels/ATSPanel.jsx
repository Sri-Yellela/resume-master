// ─────────────────────────────────────────────────────────────
// FILE: client/src/panels/ATSPanel.jsx
// ─────────────────────────────────────────────────────────────
export function ATSPanel({ report, score }) {
  if (!report) return <div style={{padding:16,color:"#94a3b8",fontSize:12}}>Generate a resume to see the ATS report.</div>;
  const bg=score>=80?"#dcfce7":score>=60?"#fef9c3":"#fee2e2";
  const fg=score>=80?"#166534":score>=60?"#854d0e":"#991b1b";
  return (
    <div style={{padding:"12px 14px",fontSize:12,display:"flex",flexDirection:"column",gap:10,overflowY:"auto",height:"100%",boxSizing:"border-box"}}>
      <div style={{display:"flex",alignItems:"center",gap:10}}>
        <div style={{background:bg,color:fg,borderRadius:"50%",width:50,height:50,display:"flex",alignItems:"center",justifyContent:"center",fontWeight:900,fontSize:17,flexShrink:0}}>{score??"-"}</div>
        <div style={{color:"#475569",fontStyle:"italic",lineHeight:1.5,fontSize:11}}>{report.verdict}</div>
      </div>
      {report.tier1_matched?.length>0&&<TagSection title="✓ Matched" color="#166534" bg="#dcfce7" items={report.tier1_matched}/>}
      {report.tier1_missing?.length>0 &&<TagSection title="✗ Missing"  color="#991b1b" bg="#fee2e2" items={report.tier1_missing}/>}
      {report.strengths?.length>0     &&<ListSection title="💪 Strengths"    color="#1d4ed8" items={report.strengths}/>}
      {report.improvements?.length>0  &&<ListSection title="🔧 Improvements" color="#92400e" items={report.improvements}/>}
    </div>
  );
}

function TagSection({title,color,bg,items}){
  return <div><div style={{fontWeight:700,color,marginBottom:3,fontSize:11}}>{title}</div><div style={{display:"flex",flexWrap:"wrap",gap:3}}>{items.map(k=><span key={k} style={{background:bg,color,padding:"2px 7px",borderRadius:7,fontSize:10}}>{k}</span>)}</div></div>;
}
function ListSection({title,color,items}){
  return <div><div style={{fontWeight:700,color,marginBottom:3,fontSize:11}}>{title}</div><ul style={{margin:0,paddingLeft:16,color:"#374151",lineHeight:1.7}}>{items.map((t,i)=><li key={i}>{t}</li>)}</ul></div>;
}