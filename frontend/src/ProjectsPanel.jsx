import { useEffect, useState } from "react";
import axios from "axios";

const C = {
  bg:"#111010", surface:"#1a1917", card:"#211f1c", border:"#2a2822",
  accent:"#b45309", amber:"#d97706", green:"#65a30d",
  text:"#d6d3cd", sub:"#8c887d", muted:"#3d3a34", mono:"Courier, monospace",
};

function fmtDate(iso) {
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

/**
 * Lists saved "projects" — a project remembers everything needed to
 * reopen and re-render a source video: crop/aspect, colors/sizes, in/out
 * points, text overlays, scanned clips and the transcript path. Opening
 * one hands its full settings blob back to the editor.
 */
export default function ProjectsPanel({ api, onOpenProject }) {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading]   = useState(true);

  const refresh = () => {
    setLoading(true);
    axios.get(`${api}/projects`)
      .then(r => setProjects(r.data.items || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { refresh(); }, [api]);

  const remove = async (id) => {
    if (!confirm("Delete this saved project? (Video files are not touched.)")) return;
    await axios.delete(`${api}/projects/${id}`);
    refresh();
  };

  if (loading) return <div style={{ padding:20, color:C.muted, fontSize:11 }}>Loading projects…</div>;

  if (!projects.length) {
    return (
      <div style={{ padding:30, textAlign:"center", color:C.muted, fontSize:11 }}>
        No saved projects yet. Click <b>Save project</b> in the editor's Render section
        to remember a video's settings for later.
      </div>
    );
  }

  return (
    <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(240px, 1fr))",
                  gap:12, padding:16 }}>
      {projects.map(p => (
        <div key={p.id} style={{ background:C.card, border:`1px solid ${C.border}`,
                                  borderRadius:4, padding:12 }}>
          <div style={{ fontSize:12, fontWeight:"bold", marginBottom:4,
                        overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
            {p.name}
          </div>
          <div style={{ fontSize:9, color:C.muted, marginBottom:10 }}>
            Updated {fmtDate(p.updated_at)} · {(p.clips || []).length} clip(s)
          </div>
          <div style={{ display:"flex", gap:6 }}>
            <button onClick={() => onOpenProject(p)}
                    style={{ flex:1, background:C.amber, color:"#111010", border:"none",
                              borderRadius:3, padding:"6px 0", fontFamily:C.mono,
                              fontSize:10, fontWeight:"bold", cursor:"pointer" }}>
              OPEN
            </button>
            <button onClick={() => remove(p.id)}
                    style={{ background:"#450a0a", color:"#fca5a5", border:"none",
                              borderRadius:3, padding:"6px 10px", fontFamily:C.mono,
                              fontSize:10, cursor:"pointer" }}>
              ✕
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
