import { useEffect, useMemo, useState } from "react";
import axios from "axios";
import ProjectsPanel from "./ProjectsPanel.jsx";

const C = {
  bg:"#111010", surface:"#1a1917", card:"#211f1c", border:"#2a2822",
  accent:"#b45309", amber:"#d97706", green:"#65a30d",
  text:"#d6d3cd", sub:"#8c887d", muted:"#3d3a34", mono:"Courier, monospace",
};

const TABS = [
  { id: "source", label: "SOURCES" },
  { id: "output", label: "OUTPUTS" },
  { id: "clip",   label: "CLIPS"   },
  { id: "__projects", label: "PROJECTS" },
];

function fmtDur(sec) {
  if (!sec) return "";
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  return `${m}:${(s % 60).toString().padStart(2, "0")}`;
}

function fmtSize(bytes) {
  if (!bytes) return "";
  const mb = bytes / 1e6;
  return mb > 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${mb.toFixed(0)} MB`;
}

/**
 * In-app media library — every source video you've loaded/downloaded and
 * every render/clip you've produced shows up here with a thumbnail, so
 * you never have to go dig through the filesystem to find something you
 * made earlier. Also hosts the Projects tab (saved editor state).
 */
export default function Library({ api, onUseAsSource, onOpenProject }) {
  const [tab, setTab]         = useState("source");
  const [items, setItems]     = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch]   = useState("");
  const [sort, setSort]       = useState("date");
  const [preview, setPreview] = useState(null);
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState("");
  const [scanMsg, setScanMsg] = useState("");

  const refresh = () => {
    if (tab === "__projects") return;
    setLoading(true);
    axios.get(`${api}/library`, { params: { kind: tab, search: search || undefined, sort } })
      .then(r => setItems(r.data.items || []))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => { refresh(); }, [api, tab, sort]); // eslint-disable-line
  useEffect(() => {
    axios.post(`${api}/library/thumbs`).then(() => refresh()).catch(() => {});
  }, [api]); // eslint-disable-line
  useEffect(() => {
    const id = setTimeout(refresh, 250); // debounce search
    return () => clearTimeout(id);
  }, [search]); // eslint-disable-line

  const doScan = async () => {
    setScanMsg("Scanning…");
    try {
      const r = await axios.post(`${api}/library/scan`);
      setScanMsg(`Imported ${r.data.added} existing file(s).`);
      refresh();
    } catch {
      setScanMsg("Scan failed.");
    }
    setTimeout(() => setScanMsg(""), 4000);
  };

  const reveal = (path) => axios.post(`${api}/library/reveal`, { path }).catch(() => {});

  const rename = async (id) => {
    if (!renameValue.trim()) { setRenamingId(null); return; }
    await axios.patch(`${api}/library/${id}`, { title: renameValue.trim() });
    setRenamingId(null);
    refresh();
  };

  const remove = async (item, deleteFile) => {
    if (deleteFile && !confirm(`Permanently delete "${item.title}" from disk?`)) return;
    await axios.delete(`${api}/library/${item.id}`, { params: { delete_file: deleteFile } });
    refresh();
  };

  const videoSrc = (path) => `${api}/video?path=${encodeURIComponent(path)}`;

  const emptyMsg = useMemo(() => ({
    source: "No source videos yet — browse a file or paste a URL in the Editor.",
    output: "No rendered outputs yet — render something in the Editor.",
    clip:   "No clips yet — use Find Clips in the Editor.",
  }[tab]), [tab]);

  return (
    <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden", minHeight:0 }}>
      <div style={{ display:"flex", alignItems:"center", gap:8, padding:"10px 16px",
                    borderBottom:`1px solid ${C.border}`, flexShrink:0, flexWrap:"wrap" }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
                  style={{
                    background: tab === t.id ? C.card : "none", border:"none",
                    color: tab === t.id ? C.amber : C.sub, fontFamily:C.mono,
                    fontSize:10, fontWeight:"bold", letterSpacing:1,
                    padding:"5px 12px", borderRadius:3, cursor:"pointer",
                  }}>{t.label}</button>
        ))}
        <div style={{ flex:1 }}/>
        {tab !== "__projects" && (<>
          <input placeholder="Search…" value={search} onChange={e => setSearch(e.target.value)}
                 style={{ background:C.card, border:`1px solid ${C.border}`, color:C.text,
                          padding:"5px 8px", borderRadius:3, fontFamily:C.mono, fontSize:10,
                          width:160 }}/>
          <select value={sort} onChange={e => setSort(e.target.value)}
                  style={{ background:C.card, border:`1px solid ${C.border}`, color:C.text,
                            padding:"5px 6px", borderRadius:3, fontFamily:C.mono, fontSize:10 }}>
            <option value="date">Newest</option>
            <option value="name">Name</option>
            <option value="duration">Duration</option>
          </select>
          <button onClick={doScan}
                  style={{ background:C.card, border:`1px solid ${C.border}`, color:C.sub,
                            padding:"5px 10px", borderRadius:3, fontFamily:C.mono, fontSize:10,
                            cursor:"pointer" }}>
            ↻ Import existing files
          </button>
        </>)}
      </div>

      {scanMsg && (
        <div style={{ padding:"4px 16px", fontSize:9, color:C.green }}>{scanMsg}</div>
      )}

      <div style={{ flex:1, overflowY:"auto" }}>
        {tab === "__projects" ? (
          <ProjectsPanel api={api} onOpenProject={onOpenProject} />
        ) : loading ? (
          <div style={{ padding:20, color:C.muted, fontSize:11 }}>Loading…</div>
        ) : !items.length ? (
          <div style={{ padding:30, textAlign:"center", color:C.muted, fontSize:11 }}>{emptyMsg}</div>
        ) : (
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(220px, 1fr))",
                        gap:12, padding:16 }}>
            {items.map(item => (
              <div key={item.id} style={{ background:C.card, border:`1px solid ${C.border}`,
                                            borderRadius:4, overflow:"hidden" }}>
                <div onClick={() => item.file_exists && setPreview(item)}
                     style={{
                       height:120, background:"#080807", position:"relative",
                       cursor: item.file_exists ? "pointer" : "not-allowed",
                       overflow:"hidden",
                     }}>
                  {item.thumb_path ? (
                    <img src={`${api}/thumb?path=${encodeURIComponent(item.thumb_path)}`}
                         alt=""
                         style={{ width:"100%", height:"100%", objectFit:"cover", display:"block" }}/>
                  ) : (
                    <div style={{ position:"absolute", inset:0, display:"flex",
                                  alignItems:"center", justifyContent:"center",
                                  color:C.border, fontSize:32 }}>▶</div>
                  )}
                  {item.duration != null && (
                    <span style={{ position:"absolute", bottom:4, right:6, fontSize:9,
                                    background:"rgba(0,0,0,0.7)", color:"#fff",
                                    padding:"1px 5px", borderRadius:2 }}>
                      {fmtDur(item.duration)}
                    </span>
                  )}
                  {!item.file_exists && (
                    <span style={{ position:"absolute", top:4, left:4, fontSize:8,
                                    background:"#450a0a", color:"#fca5a5",
                                    padding:"1px 5px", borderRadius:2 }}>MISSING</span>
                  )}
                </div>
                <div style={{ padding:"8px 10px" }}>
                  {renamingId === item.id ? (
                    <input autoFocus value={renameValue} onChange={e => setRenameValue(e.target.value)}
                           onKeyDown={e => e.key === "Enter" && rename(item.id)}
                           onBlur={() => rename(item.id)}
                           style={{ width:"100%", background:C.bg, border:`1px solid ${C.accent}`,
                                     color:C.text, fontFamily:C.mono, fontSize:11,
                                     padding:"3px 5px", borderRadius:2, boxSizing:"border-box" }}/>
                  ) : (
                    <div style={{ fontSize:11, overflow:"hidden", textOverflow:"ellipsis",
                                  whiteSpace:"nowrap" }} title={item.title}>
                      {item.title}
                    </div>
                  )}
                  <div style={{ fontSize:8, color:C.muted, marginTop:2 }}>
                    {fmtSize(item.size_bytes)} {item.width ? `· ${item.width}×${item.height}` : ""}
                  </div>
                  <div style={{ display:"flex", gap:4, marginTop:8, flexWrap:"wrap" }}>
                    <button onClick={() => onUseAsSource(item.path)} disabled={!item.file_exists}
                            title="Use as source in the editor"
                            style={{ ...btnStyle, background:C.amber, color:"#111010",
                                      opacity: item.file_exists ? 1 : 0.4 }}>USE</button>
                    <button onClick={() => reveal(item.path)} disabled={!item.file_exists}
                            title="Reveal in folder"
                            style={{ ...btnStyle, opacity: item.file_exists ? 1 : 0.4 }}>📁</button>
                    <button onClick={() => { setRenamingId(item.id); setRenameValue(item.title); }}
                            title="Rename" style={btnStyle}>✎</button>
                    <button onClick={() => remove(item, false)} title="Remove from library only"
                            style={btnStyle}>−</button>
                    <button onClick={() => remove(item, true)} title="Delete file from disk"
                            style={{ ...btnStyle, color:"#fca5a5" }}>🗑</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {preview && (
        <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.9)", zIndex:1000,
                      display:"flex", flexDirection:"column", alignItems:"center",
                      justifyContent:"center", gap:12 }}
             onClick={() => setPreview(null)}>
          <video src={videoSrc(preview.path)} controls autoPlay playsInline
                 onClick={e => e.stopPropagation()}
                 style={{ maxWidth:"90vw", maxHeight:"80vh", background:"#000",
                          border:`1px solid ${C.border}`, borderRadius:4 }}/>
          <div style={{ fontSize:10, color:C.muted, fontFamily:C.mono }}>{preview.title} — click outside to close</div>
        </div>
      )}
    </div>
  );
}

const btnStyle = {
  background: C.bg, border:`1px solid ${C.border}`, color:C.sub,
  borderRadius:3, padding:"4px 7px", fontFamily:C.mono, fontSize:10,
  cursor:"pointer", flex:"0 0 auto",
};
