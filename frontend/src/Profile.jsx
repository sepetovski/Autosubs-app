import { useEffect, useState } from "react";
import axios from "axios";

const C = {
  bg:"#111010", surface:"#1a1917", card:"#211f1c", border:"#2a2822",
  accent:"#b45309", amber:"#d97706", green:"#65a30d",
  text:"#d6d3cd", sub:"#8c887d", muted:"#3d3a34", mono:"Courier, monospace",
};

const AVATARS = ["🎬", "🎞️", "🎙️", "✂️", "⚡", "🌙", "🔥", "🎯"];

function StatCard({ label, value }) {
  return (
    <div style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:4,
                  padding:"12px 14px", minWidth:120 }}>
      <div style={{ fontSize:20, fontWeight:"bold", color:C.amber }}>{value}</div>
      <div style={{ fontSize:9, color:C.muted, letterSpacing:1, marginTop:2 }}>{label}</div>
    </div>
  );
}

/**
 * Local, no-login profile: a name + avatar plus usage stats derived from
 * backend events (imports, renders, clips, minutes transcribed), turned
 * into XP/levels, a streak counter and a badge collection — a bit of
 * positive reinforcement for actually using the app, all computed and
 * stored on-device.
 */
export default function Profile({ api }) {
  const [profile, setProfile] = useState({ name: "Editor", avatar: AVATARS[0] });
  const [stats, setStats]     = useState(null);
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput]     = useState("");

  const refresh = () => {
    axios.get(`${api}/profile`).then(r => setProfile(r.data)).catch(() => {});
    axios.get(`${api}/stats`).then(r => setStats(r.data)).catch(() => {});
  };

  useEffect(() => { refresh(); }, [api]);

  const saveName = async () => {
    setEditingName(false);
    if (!nameInput.trim() || nameInput === profile.name) return;
    const r = await axios.patch(`${api}/profile`, { name: nameInput.trim() });
    setProfile(r.data);
  };

  const pickAvatar = async (a) => {
    const r = await axios.patch(`${api}/profile`, { avatar: a });
    setProfile(r.data);
  };

  if (!stats) return <div style={{ padding:20, color:C.muted, fontSize:11 }}>Loading…</div>;

  const ringPct = Math.round((stats.level_progress || 0) * 100);

  return (
    <div style={{ flex:1, overflowY:"auto", padding:24 }}>
      <div style={{ display:"flex", alignItems:"center", gap:20, marginBottom:28 }}>
        <div style={{
          position:"relative", width:84, height:84, borderRadius:"50%",
          background:`conic-gradient(${C.amber} ${ringPct}%, ${C.border} 0)`,
          display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0,
        }}>
          <div style={{ width:70, height:70, borderRadius:"50%", background:C.surface,
                        display:"flex", alignItems:"center", justifyContent:"center",
                        fontSize:34 }}>
            {profile.avatar}
          </div>
        </div>
        <div>
          {editingName ? (
            <input autoFocus value={nameInput} onChange={e => setNameInput(e.target.value)}
                   onKeyDown={e => e.key === "Enter" && saveName()} onBlur={saveName}
                   style={{ background:C.card, border:`1px solid ${C.accent}`, color:C.text,
                             fontFamily:C.mono, fontSize:18, padding:"3px 8px", borderRadius:3 }}/>
          ) : (
            <div style={{ fontSize:20, fontWeight:"bold", cursor:"pointer" }}
                 onClick={() => { setEditingName(true); setNameInput(profile.name); }}>
              {profile.name} <span style={{ fontSize:11, color:C.muted }}>✎</span>
            </div>
          )}
          <div style={{ fontSize:11, color:C.amber, marginTop:4 }}>
            Level {stats.level} · {stats.xp} XP
            <span style={{ color:C.muted }}> ({stats.xp}/{stats.next_level_xp} to next)</span>
          </div>
          <div style={{ display:"flex", gap:4, marginTop:8 }}>
            {AVATARS.map(a => (
              <button key={a} onClick={() => pickAvatar(a)}
                      style={{
                        background: a === profile.avatar ? C.card : "none",
                        border:`1px solid ${a === profile.avatar ? C.amber : "transparent"}`,
                        borderRadius:3, fontSize:15, padding:"2px 5px", cursor:"pointer",
                      }}>{a}</button>
            ))}
          </div>
        </div>
      </div>

      <div style={{ display:"flex", gap:12, flexWrap:"wrap", marginBottom:28 }}>
        <StatCard label="VIDEOS IMPORTED" value={stats.videos_imported}/>
        <StatCard label="RENDERS"         value={stats.renders}/>
        <StatCard label="CLIPS MADE"      value={stats.clips_made}/>
        <StatCard label="MINUTES TRANSCRIBED" value={stats.minutes_transcribed}/>
        <StatCard label="CURRENT STREAK"  value={`${stats.current_streak}d`}/>
        <StatCard label="BEST STREAK"     value={`${stats.best_streak}d`}/>
      </div>

      <div style={{ fontSize:9, color:C.muted, letterSpacing:2, marginBottom:10, fontWeight:"bold" }}>
        BADGES
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(200px, 1fr))",
                    gap:10 }}>
        {stats.badges.map(b => (
          <div key={b.id} style={{
            display:"flex", alignItems:"center", gap:10,
            background: b.unlocked ? C.card : "transparent",
            border:`1px solid ${b.unlocked ? C.accent : C.border}`,
            borderRadius:4, padding:"10px 12px",
            opacity: b.unlocked ? 1 : 0.4,
          }}>
            <span style={{ fontSize:22 }}>{b.emoji}</span>
            <div>
              <div style={{ fontSize:11, fontWeight:"bold" }}>{b.name}</div>
              <div style={{ fontSize:9, color:C.muted }}>{b.desc}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
