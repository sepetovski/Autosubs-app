import { useState, useRef, useEffect, useCallback } from "react";
import axios from "axios";
import Library from "./Library.jsx";
import Profile from "./Profile.jsx";

// In the packaged app the backend listens on a dynamically-chosen free
// port (see electron/main.js); preload.js exposes it as electronAPI.apiBase.
// Outside Electron (plain browser dev) it falls back to the fixed dev port.
export const API = window.electronAPI?.apiBase || "http://127.0.0.1:8742";

const ASPECT_OPTIONS = [
  { label: "9:16 — Crop Center  (Reels/Shorts)", value: "9:16"     },
  { label: "9:16 — Full Frame + Background",       value: "9:16F"    },
  { label: "1:1 — Square  (Instagram)",           value: "1:1"      },
  { label: "4:5 — Portrait  (Feed)",               value: "4:5"      },
  { label: "16:9 — Landscape  (YouTube)",          value: "16:9"     },
  { label: "4:3 — Classic TV",                     value: "4:3"      },
  { label: "21:9 — Cinematic",                     value: "21:9"     },
  { label: "Original — No Change",                 value: "Original" },
];

const ASPECT_RATIOS = {
  "9:16": 9/16, "1:1": 1, "4:5": 4/5,
  "16:9": 16/9, "4:3": 4/3, "21:9": 21/9,
};

const OUTPUT_DIMS = {
  "9:16":  { w: 1080, h: 1920 },
  "1:1":   { w: 1080, h: 1080 },
  "4:5":   { w: 864,  h: 1080 },
  "16:9":  { w: 1920, h: 1080 },
  "4:3":   { w: 1440, h: 1080 },
  "21:9":  { w: 2560, h: 1080 },
  "9:16F": { w: 1080, h: 1920 },
};

const QUALITIES = ["4K / Best","1080p","720p","480p","360p","240p","Audio (MP3)"];
// CPU-only transcription (the default runtime ships torch-cpu, no CUDA) —
// label the slower models so people don't pick "large" on a full-length
// video and think the app has frozen.
const MODEL_OPTIONS = [
  { value: "tiny",   label: "tiny — fastest" },
  { value: "base",   label: "base — fast" },
  { value: "small",  label: "small — balanced (recommended)" },
  { value: "medium", label: "medium — slow on CPU" },
  { value: "large",  label: "large — very slow on CPU" },
];
const LANGS     = ["English","Spanish","French","German","Italian","Portuguese","Auto-detect"];

// ── Pure helpers ──────────────────────────────────────────────────────────────
function fmtTime(s) {
  if (s == null || isNaN(s)) return "0:00.00";
  const m = Math.floor(s / 60);
  const sec = (s % 60).toFixed(2).padStart(5, "0");
  return `${m}:${sec}`;
}

function fmtElapsed(ms) {
  if (!ms || isNaN(ms) || ms < 0) return "0:00";
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${(s % 60).toString().padStart(2, "0")}`;
}

function containRect(containerW, containerH, contentW, contentH) {
  if (!containerW || !containerH) {
    return { left: 0, top: 0, width: 0, height: 0 };
  }
  if (!contentW || !contentH) {
    return { left: 0, top: 0, width: containerW, height: containerH };
  }
  const containerRatio = containerW / containerH;
  const contentRatio   = contentW / contentH;
  let w, h;
  if (contentRatio > containerRatio) { w = containerW; h = containerW / contentRatio; }
  else                                { h = containerH; w = containerH * contentRatio; }
  return { left: (containerW - w) / 2, top: (containerH - h) / 2, width: w, height: h };
}

function cropFractions(sw, sh, targetRatio) {
  const sourceRatio = sw / sh;
  let fx = 0, fy = 0, fw = 1, fh = 1;
  if (sourceRatio > targetRatio) { fw = targetRatio / sourceRatio; fx = (1 - fw) / 2; }
  else                            { fh = sourceRatio / targetRatio; fy = (1 - fh) / 2; }
  return { fx, fy, fw, fh };
}

function useElementSize(ref) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

// ── Layout helpers ────────────────────────────────────────────────────────────
function Sec({ label, children }) {
  return (
    <div style={{ padding:"10px 14px", borderBottom:`1px solid ${C.border}` }}>
      <div style={{ fontSize:8, color:C.muted, letterSpacing:3,
                    marginBottom:8, fontWeight:"bold" }}>{label}</div>
      {children}
    </div>
  );
}

function Row({ label, children }) {
  return (
    <div style={{ display:"flex", alignItems:"center", gap:6,
                  marginBottom:6, flexWrap:"wrap" }}>
      {label && <span style={{ fontSize:9, color:C.sub, width:48,
                                flexShrink:0, letterSpacing:1 }}>{label}</span>}
      {children}
    </div>
  );
}

// ── Timeline ──────────────────────────────────────────────────────────────────
function Timeline({ duration, inPoint, outPoint, currentTime,
                    thumbnails, loading, onIn, onOut, onSeek }) {
  const ref  = useRef(null);
  const drag = useRef(null);

  const getFrac = useCallback((e) => {
    if (!ref.current) return 0;
    const r = ref.current.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  }, []);

  const onDown = useCallback((e) => {
    e.preventDefault();
    const t   = getFrac(e) * duration;
    const tol = duration * 0.03;
    if      (Math.abs(t - inPoint)  < tol) drag.current = "in";
    else if (Math.abs(t - outPoint) < tol) drag.current = "out";
    else { onSeek(t); drag.current = "seek"; }
  }, [getFrac, duration, inPoint, outPoint, onSeek]);

  useEffect(() => {
    const move = (e) => {
      if (!drag.current) return;
      const t = getFrac(e) * duration;
      if      (drag.current === "in")   onIn(Math.max(0, Math.min(t, outPoint - 0.1)));
      else if (drag.current === "out")  onOut(Math.min(duration, Math.max(t, inPoint + 0.1)));
      else if (drag.current === "seek") onSeek(Math.max(0, Math.min(t, duration)));
    };
    const up = () => { drag.current = null; };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup",   up);
    return () => { window.removeEventListener("mousemove", move);
                   window.removeEventListener("mouseup",   up); };
  }, [duration, inPoint, outPoint, getFrac, onIn, onOut, onSeek]);

  if (!duration) return (
    <div style={{ padding:14, textAlign:"center", color:C.muted,
                  fontSize:10, fontFamily:C.mono }}>
      load a video to see the timeline
    </div>
  );

  const ip = (inPoint     / duration) * 100;
  const op = (outPoint    / duration) * 100;
  const cp = (currentTime / duration) * 100;

  return (
    <div style={{ padding:"8px 12px 10px", background:C.surface,
                  borderTop:`1px solid ${C.border}`, flexShrink:0 }}>
      <div ref={ref} onMouseDown={onDown}
           style={{ position:"relative", height:52, borderRadius:3,
                    overflow:"hidden", cursor:"crosshair",
                    background:"#080807", border:`1px solid ${C.border}`,
                    userSelect:"none" }}>

        <div style={{ display:"flex", height:"100%", pointerEvents:"none" }}>
          {(thumbnails.length ? thumbnails : Array(24).fill(null)).map((th, i) => (
            <div key={i} style={{
              flex:1, backgroundImage: th ? `url(${th})` : "none",
              backgroundSize:"cover", backgroundPosition:"center",
              backgroundColor: th ? undefined : "#0f0e0d",
            }}/>
          ))}
        </div>

        {loading && thumbnails.length === 0 && (
          <div style={{
            position:"absolute", inset:0, display:"flex",
            alignItems:"center", justifyContent:"center",
            fontSize:9, color:C.sub, fontFamily:C.mono,
            letterSpacing:1, pointerEvents:"none", zIndex:30,
            background:"rgba(0,0,0,0.4)",
          }}>
            ⏳ GENERATING PREVIEW FRAMES…
          </div>
        )}

        <div style={{ position:"absolute", top:0, bottom:0, left:0,
                      width:`${ip}%`, background:"rgba(0,0,0,0.68)",
                      pointerEvents:"none" }}/>
        <div style={{ position:"absolute", top:0, bottom:0, left:`${op}%`,
                      right:0, background:"rgba(0,0,0,0.68)",
                      pointerEvents:"none" }}/>

        <div style={{ position:"absolute", top:0, bottom:0, left:`${ip}%`,
                      width:`${op-ip}%`, border:`2px solid ${C.accent}`,
                      boxSizing:"border-box", pointerEvents:"none" }}/>

        <div style={{ position:"absolute", top:0, bottom:0, left:`${cp}%`,
                      transform:"translateX(-50%)", pointerEvents:"none", zIndex:10 }}>
          <div style={{ position:"absolute", top:0, left:"50%",
                        transform:"translateX(-50%)",
                        borderLeft:"5px solid transparent",
                        borderRight:"5px solid transparent",
                        borderTop:"8px solid rgba(255,255,255,0.9)" }}/>
          <div style={{ position:"absolute", top:8, bottom:0, left:"50%",
                        width:1, background:"rgba(255,255,255,0.6)" }}/>
        </div>

        <div style={{ position:"absolute", top:0, bottom:0, left:`${ip}%`,
                      transform:"translateX(-50%)", width:12, zIndex:20,
                      background:"rgba(180,83,9,0.9)",
                      borderRight:`2px solid ${C.amber}`,
                      display:"flex", alignItems:"center", justifyContent:"center",
                      cursor:"ew-resize" }}>
          <span style={{ fontSize:7, color:"#fff", writingMode:"vertical-rl",
                          userSelect:"none" }}>I</span>
        </div>

        <div style={{ position:"absolute", top:0, bottom:0, left:`${op}%`,
                      transform:"translateX(-50%)", width:12, zIndex:20,
                      background:"rgba(180,83,9,0.9)",
                      borderLeft:`2px solid ${C.amber}`,
                      display:"flex", alignItems:"center", justifyContent:"center",
                      cursor:"ew-resize" }}>
          <span style={{ fontSize:7, color:"#fff", writingMode:"vertical-rl",
                          userSelect:"none" }}>O</span>
        </div>
      </div>

      <div style={{ display:"flex", justifyContent:"space-between",
                    padding:"4px 0 0", fontSize:9, fontFamily:C.mono, color:C.sub }}>
        <span>◀ IN  {fmtTime(inPoint)}</span>
        <span style={{ color:C.amber }}>↔  {fmtTime(outPoint - inPoint)}</span>
        <span>OUT  {fmtTime(outPoint)}  ▶</span>
      </div>
    </div>
  );
}

// ── Crop guide overlay ─────────────────────────────────────────────────────────
// Four dimming panels (not a giant box-shadow) so Chromium still composites
// the hardware video layer, and so subtitle/text previews stay visible.
function CropGuide({ rect, label }) {
  if (!rect || !rect.width) return null;
  const dim = {
    position: "absolute", background: "rgba(0,0,0,0.65)",
    pointerEvents: "none", zIndex: 2,
  };
  return (
    <>
      <div style={{ ...dim, left: 0, top: 0, right: 0, height: Math.max(0, rect.top) }} />
      <div style={{ ...dim, left: 0, top: rect.top + rect.height, right: 0, bottom: 0 }} />
      <div style={{ ...dim, left: 0, top: rect.top, width: Math.max(0, rect.left), height: rect.height }} />
      <div style={{ ...dim, left: rect.left + rect.width, top: rect.top, right: 0, height: rect.height }} />
      <div style={{
        position: "absolute", left: rect.left, top: rect.top,
        width: rect.width, height: rect.height,
        border: `2px solid ${C.accent}`,
        boxSizing: "border-box",
        pointerEvents: "none", zIndex: 3,
      }}>
        <div style={{
          position: "absolute", top: 6, left: 6,
          fontSize: 9, color: "#fff", background: "rgba(0,0,0,0.55)",
          padding: "2px 6px", borderRadius: 2, fontFamily: C.mono, letterSpacing: 1,
        }}>{label}</div>
      </div>
    </>
  );
}

// ── Draggable subtitle preview ─────────────────────────────────────────────────
function SubPreview({ stageRect, outputDims, subtitleY, colorBase, colorActive,
                      baseSize, activeSize, onYChange, viewerRef }) {
  const dragging = useRef(false);

  const getFraction = useCallback((e) => {
    if (!viewerRef.current) return subtitleY;
    const pageRect = viewerRef.current.getBoundingClientRect();
    const localY   = e.clientY - pageRect.top - stageRect.top;
    return Math.max(0.04, Math.min(0.97, localY / stageRect.height));
  }, [viewerRef, stageRect, subtitleY]);

  useEffect(() => {
    const move = (e) => { if (dragging.current) onYChange(getFraction(e)); };
    const up   = () => { dragging.current = false; };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup",   up);
    return () => { window.removeEventListener("mousemove", move);
                   window.removeEventListener("mouseup",   up); };
  }, [getFraction, onYChange]);

  if (!stageRect || !stageRect.width) return null;

  const scale  = stageRect.height / outputDims.h;
  const baseFs = Math.max(8,  Math.round(baseSize   * scale));
  const actFs  = Math.max(10, Math.round(activeSize * scale));
  const shadow = "0 0 6px #000, 0 0 12px #000";
  const fnt    = "Impact, Arial Black, sans-serif";

  return (
    <div
      onMouseDown={(e) => { e.preventDefault(); dragging.current = true; }}
      style={{
        position:"absolute", left:stageRect.left, width:stageRect.width,
        top:stageRect.top + subtitleY * stageRect.height,
        textAlign:"center", cursor:"ns-resize", zIndex:5,
        userSelect:"none", padding:"2px 4px",
        pointerEvents:"auto", transform:"translateY(-50%) translateZ(0)",
      }}>
      <span style={{ color:colorBase, fontSize:baseFs, fontWeight:"bold",
                     textShadow:shadow, fontFamily:fnt }}>SAMPLE{" "}</span>
      <span style={{ color:colorActive, fontSize:actFs, fontWeight:"bold",
                     textShadow:shadow, fontFamily:fnt }}>WORD</span>
      <span style={{ color:colorBase, fontSize:baseFs, fontWeight:"bold",
                     textShadow:shadow, fontFamily:fnt }}>{" "}HERE</span>
      <div style={{ fontSize:7, color:"rgba(255,255,255,0.3)", marginTop:1 }}>↕ drag</div>
    </div>
  );
}

// ── Draggable static text overlay preview ──────────────────────────────────────
function TextOverlayPreview({ item, stageRect, outputDims, onYChange, viewerRef }) {
  const dragging = useRef(false);

  const getFraction = useCallback((e) => {
    if (!viewerRef.current) return item.y;
    const pageRect = viewerRef.current.getBoundingClientRect();
    const localY   = e.clientY - pageRect.top - stageRect.top;
    return Math.max(0.02, Math.min(0.98, localY / stageRect.height));
  }, [viewerRef, stageRect, item.y]);

  useEffect(() => {
    const move = (e) => { if (dragging.current) onYChange(getFraction(e)); };
    const up   = () => { dragging.current = false; };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup",   up);
    return () => { window.removeEventListener("mousemove", move);
                   window.removeEventListener("mouseup",   up); };
  }, [getFraction, onYChange]);

  if (!stageRect || !stageRect.width) return null;

  const scale   = stageRect.height / outputDims.h;
  const fs      = Math.max(8, Math.round(item.size * scale));
  const shadow  = "0 0 6px #000, 0 0 12px #000";
  const isEmpty = !item.text.trim();

  return (
    <div
      onMouseDown={(e) => { e.preventDefault(); dragging.current = true; }}
      style={{
        position:"absolute", left:stageRect.left, width:stageRect.width,
        top:stageRect.top + item.y * stageRect.height,
        textAlign:"center", cursor:"ns-resize", zIndex:5,
        userSelect:"none", padding:"2px 4px",
        pointerEvents:"auto", transform:"translateY(-50%) translateZ(0)",
      }}>
      <span style={{
        color: isEmpty ? "rgba(255,255,255,0.4)" : item.color,
        fontSize: fs, fontWeight:"bold",
        fontStyle: isEmpty ? "italic" : "normal",
        textShadow: shadow, fontFamily:"Impact, Arial Black, sans-serif",
      }}>
        {isEmpty ? "Your text" : item.text}
      </span>
    </div>
  );
}

// ── Output player modal ────────────────────────────────────────────────────────
function OutputPlayer({ src, path, onClose }) {
  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.95)",
                  zIndex:1000, display:"flex", flexDirection:"column",
                  alignItems:"center", justifyContent:"center", gap:12 }}>
      <div style={{ display:"flex", alignItems:"center", gap:16,
                    width:"90vw", maxWidth:960 }}>
        <span style={{ fontSize:9, color:C.green, letterSpacing:3,
                       fontFamily:C.mono, fontWeight:"bold" }}>● RENDERED OUTPUT</span>
        <span style={{ flex:1, fontSize:9, color:C.muted, fontFamily:C.mono,
                       overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
          {path}
        </span>
        <button onClick={onClose}
                style={{ background:"none", border:`1px solid ${C.border}`,
                          color:C.sub, fontFamily:C.mono, fontSize:10,
                          padding:"4px 12px", cursor:"pointer", borderRadius:3 }}>
          ✕ CLOSE
        </button>
      </div>
      <video src={src} controls autoPlay
             style={{ maxWidth:"90vw", maxHeight:"74vh", borderRadius:4,
                       border:`1px solid ${C.green}`, background:"#000", outline:"none" }}/>
      <div style={{ fontSize:9, color:C.muted, fontFamily:C.mono }}>
        Click anywhere outside to close
      </div>
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────
export default function App() {
  const [videoPath, setVideoPath]     = useState("");
  const [videoInfo, setVideoInfo]     = useState(null);
  const [thumbnails, setThumbnails]   = useState([]);
  const [thumbsLoading, setThumbsLoading] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying]     = useState(false);
  const [inPoint,  setInPoint]        = useState(0);
  const [outPoint, setOutPoint]       = useState(0);

  const [ytUrl, setYtUrl]             = useState("");
  const [dlQuality, setDlQuality]     = useState("1080p");

  const [addSubtitles, setAddSubtitles] = useState(true);
  const [textOverlays, setTextOverlays] = useState([]);
  const [aspect, setAspect]           = useState("9:16");
  const [bgColor, setBgColor]         = useState("#000000");
  const [videoYOffset, setVideoYOffset] = useState(0.5);
  const [model, setModel]             = useState("small");
  const [language, setLanguage]       = useState("English");
  const [colorBase, setColorBase]     = useState("#ffffff");
  const [colorActive, setColorActive] = useState("#ffd200");
  const [baseSize, setBaseSize]       = useState(55);
  const [activeSize, setActiveSize]   = useState(80);
  const [subtitleY, setSubtitleY]     = useState(0.82);
  const [outputName, setOutputName]   = useState("");

  const [phase, setPhase]             = useState("");
  const [progress, setProgress]       = useState(0);
  const [progressText, setProgressText] = useState("");
  const [logs, setLogs]               = useState([]);
  const [running, setRunning]         = useState(false);
  const [preparing, setPreparing]     = useState(false);
  const [outputPath, setOutputPath]   = useState("");
  const [error, setError]             = useState("");
  const [showLogs, setShowLogs]       = useState(false);
  const [showOutputPlayer, setShowOutputPlayer] = useState(false);
  const [elapsed, setElapsed]         = useState(0);
  const jobStartRef = useRef(null);
  const [backendCrashed, setBackendCrashed] = useState(false);
  const [restartingBackend, setRestartingBackend] = useState(false);
  const [updateInfo, setUpdateInfo]   = useState(null);
  const [view, setView]               = useState("editor"); // editor | library | profile
  const [currentProjectId, setCurrentProjectId] = useState(null);
  const [projectSaveMsg, setProjectSaveMsg] = useState("");
  const [badgeToast, setBadgeToast]   = useState(null);
  const knownBadgesRef = useRef(null);

  // Multi-cut clip finder
  const [clips, setClips]               = useState([]);
  const [selectedClips, setSelectedClips] = useState(new Set());
  const [analyzing, setAnalyzing]       = useState(false);
  const [clipMinLen, setClipMinLen]     = useState(20);
  const [clipMaxLen, setClipMaxLen]     = useState(60);
  const [clipCount, setClipCount]       = useState(6);
  const [batchOutputs, setBatchOutputs] = useState([]);
  const [transcriptPath, setTranscriptPath] = useState("");
  const [clipAddSubtitles, setClipAddSubtitles] = useState(true);
  const [forceRetranscribe, setForceRetranscribe] = useState(false);
  const autoRunRef = useRef(false);

  const videoElRef      = useRef(null);
  const videoCleanupRef = useRef(null);
  const previewCanvasRef = useRef(null);
  const viewerRef  = useRef(null);
  const logsEndRef = useRef(null);
  const evtSrcRef  = useRef(null);

  const viewerSize = useElementSize(viewerRef);

  const addLog = (t) => setLogs(l => [...l.slice(-300), t]);

  useEffect(() => {
    if (showLogs) logsEndRef.current?.scrollIntoView({ behavior:"smooth" });
  }, [logs, showLogs]);

  const setVideoRef = useCallback((node) => {
    if (videoCleanupRef.current) {
      videoCleanupRef.current();
      videoCleanupRef.current = null;
    }
    videoElRef.current = node;
    if (node) {
      const onTime   = () => setCurrentTime(node.currentTime);
      const onPlay   = () => setIsPlaying(true);
      const onPause  = () => setIsPlaying(false);
      const onLoaded = () => {
        if (node.readyState >= 1) {
          node.currentTime = 0.1;
          setCurrentTime(0.1);
        }
      };
      node.addEventListener("timeupdate",     onTime);
      node.addEventListener("play",           onPlay);
      node.addEventListener("pause",          onPause);
      node.addEventListener("loadedmetadata", onLoaded);
      videoCleanupRef.current = () => {
        node.removeEventListener("timeupdate",     onTime);
        node.removeEventListener("play",           onPlay);
        node.removeEventListener("pause",          onPause);
        node.removeEventListener("loadedmetadata", onLoaded);
      };
    }
  }, []);

  const togglePlay = useCallback(() => {
    const v = videoElRef.current;
    if (!v) return;
    if (v.paused) v.play(); else v.pause();
  }, []);

  const stepFrame = useCallback((dir) => {
    const v = videoElRef.current;
    if (!v) return;
    v.pause();
    v.currentTime = Math.max(0, Math.min(
      v.duration, v.currentTime + dir / (videoInfo?.fps || 25)));
  }, [videoInfo]);

  const seekTo = useCallback((t) => {
    const v = videoElRef.current;
    if (v) v.currentTime = t;
    setCurrentTime(t);
  }, []);

  useEffect(() => {
    const onKeyDown = (e) => {
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.code === "Space")       { e.preventDefault(); togglePlay(); }
      else if (e.code === "ArrowLeft")  { e.preventDefault(); stepFrame(-1); }
      else if (e.code === "ArrowRight") { e.preventDefault(); stepFrame(1); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [togglePlay, stepFrame]);

  // ── Text overlay list management ──────────────────────────────────────────
  const addOverlay = () => {
    setTextOverlays(list => [
      ...list,
      { id: Date.now() + Math.random(), text: "", y: 0.12, size: 44, color: "#ffffff" },
    ]);
  };
  const updateOverlay = (id, patch) => {
    setTextOverlays(list => list.map(t => t.id === id ? { ...t, ...patch } : t));
  };
  const removeOverlay = (id) => {
    setTextOverlays(list => list.filter(t => t.id !== id));
  };

  const finishLoadingVideo = async (path) => {
    if (!path) return;
    try {
      const res = await axios.post(`${API}/load-video`, { path });
      if (res.data.error) { setError(res.data.error); return; }
      setVideoPath(path);
      setVideoInfo(res.data);
      setInPoint(0);
      setOutPoint(res.data.duration || 0);
      setCurrentTime(0);
      setOutputPath(""); setError(""); setPhase("");
      setProgress(0); setProgressText(""); setLogs([]);
      setThumbnails([]);
      setClips([]); setSelectedClips(new Set()); setBatchOutputs([]);
      setTranscriptPath("");
      setOutputName((res.data.filename?.replace(/\.[^.]+$/, "") || "output") + "_subtitled");

      setThumbsLoading(true);
      axios.get(`${API}/thumbnails`, { params: { path, count: 24 } })
           .then(r => setThumbnails(r.data.thumbnails || []))
           .catch(() => {})
           .finally(() => setThumbsLoading(false));
    } catch {
      setError("Could not load video — is the backend running?");
    }
  };

  useEffect(() => {
    if (!running && !preparing && !analyzing) return;
    jobStartRef.current = Date.now();
    setElapsed(0);
    const id = setInterval(() => setElapsed(Date.now() - jobStartRef.current), 500);
    return () => clearInterval(id);
  }, [running, preparing, analyzing]);

  useEffect(() => {
    if (!window.electronAPI) return;
    window.electronAPI.onBackendCrashed(() => setBackendCrashed(true));
    window.electronAPI.onUpdateInfo((info) => setUpdateInfo(info));
    window.electronAPI.getUpdateInfo?.().then((info) => { if (info) setUpdateInfo(info); });
  }, []);

  // One-time baseline so badges the user already had before this session
  // don't all "unlock" the first time we check.
  useEffect(() => {
    axios.get(`${API}/stats`).then(r => {
      knownBadgesRef.current = new Set(
        (r.data.badges || []).filter(b => b.unlocked).map(b => b.id)
      );
    }).catch(() => { knownBadgesRef.current = new Set(); });
  }, []);

  const checkNewBadges = async () => {
    try {
      const r = await axios.get(`${API}/stats`);
      const known = knownBadgesRef.current || new Set();
      const newlyUnlocked = (r.data.badges || []).filter(b => b.unlocked && !known.has(b.id));
      if (newlyUnlocked.length) {
        setBadgeToast(newlyUnlocked[0]);
        setTimeout(() => setBadgeToast(null), 5000);
      }
      knownBadgesRef.current = new Set((r.data.badges || []).filter(b => b.unlocked).map(b => b.id));
    } catch { /* non-critical */ }
  };

  const handleRestartBackend = async () => {
    if (!window.electronAPI?.restartBackend) return;
    setRestartingBackend(true);
    const res = await window.electronAPI.restartBackend();
    setRestartingBackend(false);
    if (res?.ok) setBackendCrashed(false);
  };

  const startSSE = () => {
    if (evtSrcRef.current) evtSrcRef.current.close();
    const es = new EventSource(`${API}/progress`);
    es.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === "phase")    setPhase(msg.text);
      if (msg.type === "progress") { setProgress(msg.pct); setProgressText(msg.text); }
      if (msg.type === "log")      addLog(msg.text);
      if (msg.type === "clip_done") {
        setBatchOutputs(list => [...list, msg.output_path]);
      }
      if (msg.type === "done") {
        es.close();
        if (msg.op === "analyze") {
          setAnalyzing(false); setProgress(100);
          const found = msg.clips || [];
          setClips(found);
          setSelectedClips(new Set(found.map((_, i) => i)));
          setTranscriptPath(msg.transcript_path || "");
          if (autoRunRef.current) {
            autoRunRef.current = false;
            if (found.length) {
              setPhase(`✔  ${found.length} clips found — rendering…`);
              renderClipsNow(found, msg.transcript_path || "");
            } else {
              setPhase("No clips found");
            }
          } else {
            setPhase(found.length ? `✔  ${found.length} clips found` : "No clips found");
          }
        } else if (msg.op === "batch") {
          setRunning(false); setProgress(100);
          setBatchOutputs(msg.outputs || []);
          setOutputPath(msg.output_path || "");
          setPhase(`✔  ${(msg.outputs || []).length} clips rendered`);
          checkNewBadges();
        } else if (msg.op === "render") {
          setRunning(false); setProgress(100);
          setOutputPath(msg.output_path || "");
          setPhase("✔  Complete!");
          setShowOutputPlayer(true);
          checkNewBadges();
        } else if (msg.op === "download") {
          setRunning(false); setProgress(100);
          setPhase("✔  Downloaded!");
          if (msg.output_path) finishLoadingVideo(msg.output_path);
        } else if (msg.op === "prepare") {
          setPreparing(false); setProgress(100);
          setPhase("✔  Ready!");
          if (msg.output_path) finishLoadingVideo(msg.output_path);
        }
      }
      if (msg.type === "error") {
        setRunning(false); setPreparing(false); setAnalyzing(false);
        autoRunRef.current = false;
        setError(msg.text); setPhase("✘  Failed"); es.close();
      }
      if (msg.type === "cancelled") {
        setRunning(false); setPreparing(false); setAnalyzing(false);
        autoRunRef.current = false;
        setPhase(msg.text || "Cancelled"); es.close();
      }
    };
    evtSrcRef.current = es;
  };

  const loadVideo = async (path) => {
    if (!path || running || preparing) return;
    setError(""); setOutputPath(""); setLogs([]);
    setPreparing(true); setPhase("Checking video…"); setProgress(0);
    startSSE();
    try {
      await axios.post(`${API}/prepare`, { path });
    } catch {
      setPreparing(false);
      setError("Could not prepare video — is the backend running?");
    }
  };

  const browseFile = async () => {
    if (running || preparing) return;
    try {
      let picked = "";
      if (window.electronAPI && window.electronAPI.browseFile) {
        picked = await window.electronAPI.browseFile();
      } else {
        const res = await axios.get(`${API}/browse`);
        picked = res.data.path;
        if (!picked && res.data.error) { setError(res.data.error); return; }
      }
      if (picked) loadVideo(picked);
    } catch (err) {
      setError(`Could not open file browser: ${err.message || err}`);
    }
  };

  const buildRenderSettings = () => ({
    video_path:     videoPath,
    output_name:    outputName,
    add_subtitles:  addSubtitles,
    text_overlays:  textOverlays.map(t => ({
      text: t.text, y: t.y, size: t.size, color: t.color,
    })),
    aspect,
    bg_color:       bgColor,
    video_y_offset: videoYOffset,
    model, language,
    color_base:     colorBase,
    color_active:   colorActive,
    base_size:      baseSize,
    active_size:    activeSize,
    subtitle_y:     subtitleY,
    // Reuse the full-video transcript from a scan instead of re-running
    // Whisper on every trimmed clip, unless the user explicitly wants
    // a fresh, per-clip transcription (e.g. for higher-quality models).
    transcript_json: (!forceRetranscribe && transcriptPath) ? transcriptPath : null,
  });

  // ── Projects: save the full editor state, reopen it later ────────────────
  const handleSaveProject = async () => {
    if (!videoPath) { setError("Load a video first."); return; }
    const settings = {
      ...buildRenderSettings(),
      inPoint, outPoint,
      clipMinLen, clipMaxLen, clipCount, clipAddSubtitles, forceRetranscribe,
    };
    try {
      const res = await axios.post(`${API}/projects`, {
        id: currentProjectId,
        name: outputName || videoInfo?.filename || "Untitled project",
        settings,
        clips,
        transcript_path: transcriptPath,
      });
      setCurrentProjectId(res.data.id);
      setProjectSaveMsg(`✔ Saved "${res.data.name}"`);
      setTimeout(() => setProjectSaveMsg(""), 3000);
    } catch {
      setError("Could not save project.");
    }
  };

  const handleOpenProject = async (project) => {
    setView("editor");
    const s = project.settings || {};
    if (s.video_path) await finishLoadingVideo(s.video_path);
    setAddSubtitles(s.add_subtitles ?? true);
    setTextOverlays((s.text_overlays || []).map(t => ({ id: Date.now() + Math.random(), ...t })));
    setAspect(s.aspect || "9:16");
    setBgColor(s.bg_color || "#000000");
    setVideoYOffset(s.video_y_offset ?? 0.5);
    setModel(s.model || "small");
    setLanguage(s.language || "English");
    setColorBase(s.color_base || "#ffffff");
    setColorActive(s.color_active || "#ffd200");
    setBaseSize(s.base_size ?? 55);
    setActiveSize(s.active_size ?? 80);
    setSubtitleY(s.subtitle_y ?? 0.82);
    setOutputName(project.name || "");
    if (s.inPoint != null) setInPoint(s.inPoint);
    if (s.outPoint != null) setOutPoint(s.outPoint);
    setClipMinLen(s.clipMinLen ?? 20);
    setClipMaxLen(s.clipMaxLen ?? 60);
    setClipCount(s.clipCount ?? 6);
    setClipAddSubtitles(s.clipAddSubtitles ?? true);
    setForceRetranscribe(s.forceRetranscribe ?? false);
    setClips(project.clips || []);
    setSelectedClips(new Set((project.clips || []).map((_, i) => i)));
    setTranscriptPath(project.transcript_path || "");
    setCurrentProjectId(project.id);
  };

  const handleAnalyze = async () => {
    if (preparing || running || analyzing) return;
    if (!videoPath) { setError("Load a video first."); return; }
    setAnalyzing(true); setError(""); setBatchOutputs([]);
    setPhase("Scanning…"); setProgress(0); setLogs([]);
    startSSE();
    try {
      await axios.post(`${API}/analyze`, {
        path: videoPath, model: "tiny", language,
        min_len: clipMinLen, max_len: clipMaxLen, want: clipCount,
      });
    } catch {
      setAnalyzing(false);
      setError("Could not start scan — is the backend running?");
    }
  };

  const toggleClip = (i) => {
    setSelectedClips(prev => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  };

  const previewClip = (c) => {
    setInPoint(c.start); setOutPoint(c.end); seekTo(c.start);
  };

  // Shared by the manual "Render Selected" button and the one-click Auto
  // Run flow. Takes the clip list explicitly (rather than reading
  // selectedClips state) so Auto Run can render immediately with
  // freshly-scanned clips without waiting on a state-commit round trip.
  const renderClipsNow = async (clipList, tpath) => {
    if (!clipList.length) { setError("No clips to render."); return; }
    setRunning(true); setError(""); setOutputPath(""); setBatchOutputs([]);
    setPhase("Starting batch…"); setProgress(0); setLogs([]);
    startSSE();
    const useTranscript = !forceRetranscribe && (tpath || transcriptPath);
    await axios.post(`${API}/render-batch`, {
      ...buildRenderSettings(),
      add_subtitles:   clipAddSubtitles,
      transcript_json: useTranscript || null,
      clips: clipList.map(c => ({ start: c.start, end: c.end, title: c.title })),
    });
  };

  const handleRenderBatch = () => {
    if (preparing || running || analyzing) return;
    const chosen = clips.filter((_, i) => selectedClips.has(i));
    if (!chosen.length) { setError("Select at least one clip."); return; }
    renderClipsNow(chosen, transcriptPath);
  };

  // One button: scan, then automatically render every clip found — no
  // manual review step. handleAnalyze's own SSE "done" handler checks
  // autoRunRef and calls renderClipsNow() once clips arrive.
  const handleAutoRun = async () => {
    if (preparing || running || analyzing) return;
    if (!videoPath) { setError("Load a video first."); return; }
    autoRunRef.current = true;
    setAnalyzing(true); setError(""); setBatchOutputs([]);
    setPhase("Scanning…"); setProgress(0); setLogs([]);
    startSSE();
    try {
      await axios.post(`${API}/analyze`, {
        path: videoPath, model: "tiny", language,
        min_len: clipMinLen, max_len: clipMaxLen, want: clipCount,
      });
    } catch {
      autoRunRef.current = false;
      setAnalyzing(false);
      setError("Could not start scan — is the backend running?");
    }
  };

  const handleRender = async () => {
    if (preparing) return;
    if (!videoPath) { setError("Load a video first."); return; }
    const eps        = 0.1;
    const shouldTrim = inPoint > eps || (videoInfo && outPoint < videoInfo.duration - eps);
    setRunning(true); setError(""); setOutputPath("");
    setPhase("Starting…"); setProgress(0); setLogs([]);
    startSSE();
    await axios.post(`${API}/render`, {
      ...buildRenderSettings(),
      do_trim:        shouldTrim,
      trim_start:     shouldTrim ? inPoint  : null,
      trim_end:       shouldTrim ? outPoint : null,
    });
  };

  const handleDownload = async () => {
    if (preparing || running) return;
    if (!ytUrl.trim()) { setError("Paste a URL first."); return; }
    setRunning(true); setError(""); setOutputPath("");
    setPhase("Downloading…"); setProgress(0); setLogs([]);
    startSSE();
    await axios.post(`${API}/download`, { url: ytUrl, quality: dlQuality });
  };

  const handleCancel = async () => {
    autoRunRef.current = false;
    setRunning(false); setPreparing(false); setAnalyzing(false); setPhase("Cancelled");
    await axios.post(`${API}/cancel`);
    // The backend also pushes its own "cancelled" SSE message, but we
    // don't wait around for it — close the stream from our side right
    // away so the UI feels instant even if the worker thread is still
    // unwinding a subprocess in the background.
    if (evtSrcRef.current) evtSrcRef.current.close();
  };

  const videoSrc  = videoPath  ? `${API}/video?path=${encodeURIComponent(videoPath)}`  : null;
  const outputSrc = outputPath ? `${API}/video?path=${encodeURIComponent(outputPath)}` : null;

  const isFullFrame = aspect === "9:16F";
  const isCrop       = !isFullFrame && ASPECT_RATIOS[aspect] !== undefined;

  const videoDisplayRect = videoInfo
    ? containRect(viewerSize.width, viewerSize.height, videoInfo.width, videoInfo.height)
    : { left:0, top:0, width:0, height:0 };

  let stageRect = videoDisplayRect;
  if (isCrop && videoInfo) {
    const { fx, fy, fw, fh } = cropFractions(videoInfo.width, videoInfo.height, ASPECT_RATIOS[aspect]);
    stageRect = {
      left:   videoDisplayRect.left + fx * videoDisplayRect.width,
      top:    videoDisplayRect.top  + fy * videoDisplayRect.height,
      width:  videoDisplayRect.width  * fw,
      height: videoDisplayRect.height * fh,
    };
  } else if (isFullFrame) {
    stageRect = containRect(viewerSize.width, viewerSize.height, 9, 16);
  }

  const outputDims = aspect === "Original"
    ? (videoInfo ? { w: videoInfo.width, h: videoInfo.height } : { w: 1920, h: 1080 })
    : (OUTPUT_DIMS[aspect] || { w: 1080, h: 1920 });

  // Paint onto a <canvas>, not the <video> element. Windows Chromium promotes
  // <video> to a hardware overlay that covers every HTML layer (crop frame,
  // subtitles, add-text), so those can never be visible on top of it.
  useEffect(() => {
    const canvas = previewCanvasRef.current;
    if (!canvas || !videoInfo) return;

    const cssW = isFullFrame
      ? Math.max(1, Math.round(stageRect.width))
      : Math.max(1, Math.round(videoDisplayRect.width));
    const cssH = isFullFrame
      ? Math.max(1, Math.round(stageRect.height))
      : Math.max(1, Math.round(videoDisplayRect.height));
    if (canvas.width !== cssW) canvas.width = cssW;
    if (canvas.height !== cssH) canvas.height = cssH;

    let raf = 0;
    const paint = () => {
      const v = videoElRef.current;
      const ctx = canvas.getContext("2d");
      if (v && v.readyState >= 2 && canvas.width && canvas.height) {
        const vw = v.videoWidth || videoInfo.width;
        const vh = v.videoHeight || videoInfo.height;
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        if (isFullFrame) {
          ctx.fillStyle = bgColor || "#000";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          const scale = Math.min(canvas.width / vw, canvas.height / vh);
          const dw = vw * scale;
          const dh = vh * scale;
          const dx = (canvas.width - dw) / 2;
          const dy = (canvas.height - dh) * videoYOffset;
          ctx.drawImage(v, 0, 0, vw, vh, dx, dy, dw, dh);
          ctx.strokeStyle = "#b45309";
          ctx.lineWidth = 2;
          ctx.strokeRect(1, 1, canvas.width - 2, canvas.height - 2);
          const ffLabel = `9:16 FULL FRAME  ·  ${outputDims.w}×${outputDims.h}`;
          ctx.font = "bold 11px Courier, monospace";
          const ffTw = ctx.measureText(ffLabel).width;
          ctx.fillStyle = "rgba(0,0,0,0.55)";
          ctx.fillRect(6, 6, ffTw + 12, 16);
          ctx.fillStyle = "#fff";
          ctx.fillText(ffLabel, 12, 18);
        } else {
          ctx.drawImage(v, 0, 0, vw, vh, 0, 0, canvas.width, canvas.height);
          if (isCrop) {
            const { fx, fy, fw, fh } = cropFractions(vw, vh, ASPECT_RATIOS[aspect]);
            const rx = fx * canvas.width;
            const ry = fy * canvas.height;
            const rw = fw * canvas.width;
            const rh = fh * canvas.height;
            ctx.fillStyle = "rgba(0,0,0,0.65)";
            ctx.fillRect(0, 0, canvas.width, ry);
            ctx.fillRect(0, ry + rh, canvas.width, canvas.height - (ry + rh));
            ctx.fillRect(0, ry, rx, rh);
            ctx.fillRect(rx + rw, ry, canvas.width - (rx + rw), rh);
            ctx.strokeStyle = "#b45309";
            ctx.lineWidth = 2;
            ctx.strokeRect(rx + 1, ry + 1, Math.max(0, rw - 2), Math.max(0, rh - 2));
            ctx.font = "bold 11px Courier, monospace";
            ctx.fillStyle = "#fff";
            const label = `${aspect}  ·  ${outputDims.w}×${outputDims.h}`;
            const pad = 6;
            const tw = ctx.measureText(label).width;
            ctx.fillStyle = "rgba(0,0,0,0.55)";
            ctx.fillRect(rx + 6, ry + 6, tw + pad * 2, 16);
            ctx.fillStyle = "#fff";
            ctx.fillText(label, rx + 6 + pad, ry + 18);
          }
        }
      }
      raf = requestAnimationFrame(paint);
    };
    raf = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(raf);
  }, [
    videoInfo, videoSrc, isFullFrame, isCrop, aspect, bgColor, videoYOffset,
    videoDisplayRect.width, videoDisplayRect.height,
    stageRect.width, stageRect.height,
    outputDims.w, outputDims.h,
  ]);

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100vh", background:C.bg,
                  fontFamily:C.mono, color:C.text, overflow:"hidden" }}>

      {showOutputPlayer && outputSrc && (
        <OutputPlayer src={outputSrc} path={outputPath}
                      onClose={() => setShowOutputPlayer(false)}/>
      )}

      {badgeToast && (
        <div style={{ position:"fixed", top:70, right:20, zIndex:2000,
                      background:C.card, border:`1px solid ${C.amber}`, borderRadius:6,
                      padding:"12px 16px", display:"flex", alignItems:"center", gap:10,
                      boxShadow:"0 4px 20px rgba(0,0,0,0.5)" }}>
          <span style={{ fontSize:26 }}>{badgeToast.emoji}</span>
          <div>
            <div style={{ fontSize:9, color:C.amber, letterSpacing:1, fontWeight:"bold" }}>BADGE UNLOCKED</div>
            <div style={{ fontSize:12, fontWeight:"bold" }}>{badgeToast.name}</div>
            <div style={{ fontSize:9, color:C.muted }}>{badgeToast.desc}</div>
          </div>
        </div>
      )}

      <TopNav view={view} setView={setView}
              backendCrashed={backendCrashed} restartingBackend={restartingBackend}
              onRestartBackend={handleRestartBackend}
              updateInfo={updateInfo}/>

      {view === "library" && (
        <Library api={API}
                 onUseAsSource={(path) => { setView("editor"); loadVideo(path); }}
                 onOpenProject={handleOpenProject}/>
      )}
      {view === "profile" && <Profile api={API} />}

      {view === "editor" && (
      <div style={{ flex:1, display:"flex", overflow:"hidden", minHeight:0 }}>

      {/* ══════════ LEFT PANEL ══════════ */}
      <div style={{ width:288, flexShrink:0, display:"flex", flexDirection:"column",
                    background:C.surface, borderRight:`1px solid ${C.border}`,
                    overflow:"hidden" }}>

        {error && (
          <div style={{ background:"#450a0a", color:"#fca5a5", fontSize:10,
                        flexShrink:0, padding:"7px 14px",
                        display:"flex", justifyContent:"space-between",
                        alignItems:"center" }}>
            ⚠ {error}
            <button onClick={() => setError("")}
                    style={{ background:"none", border:"none",
                              color:"#fca5a5", cursor:"pointer", fontSize:13 }}>✕</button>
          </div>
        )}

        <div style={{ flex:1, overflowY:"auto", overflowX:"hidden" }}>

          <Sec label="ARCHIVE  PULL">
            <input style={ST.inp} placeholder="YouTube / social URL…"
                   value={ytUrl} onChange={e => setYtUrl(e.target.value)}
                   onKeyDown={e => e.key === "Enter" && !running && !preparing && handleDownload()}/>
            <div style={{ display:"flex", gap:6, marginTop:6 }}>
              <select style={{ ...ST.sel, flex:1 }} value={dlQuality}
                      onChange={e => setDlQuality(e.target.value)}>
                {QUALITIES.map(q => <option key={q}>{q}</option>)}
              </select>
              <button style={{ ...ST.btn, ...((running || preparing) ? ST.btnOff : ST.btnAmber) }}
                      onClick={handleDownload} disabled={running || preparing}>⬇</button>
            </div>
          </Sec>

          <Sec label="LOAD  REEL">
            <button style={{ ...ST.btn, ...((running || preparing) ? ST.btnOff : ST.btnGhost), width:"100%" }}
                    onClick={browseFile} disabled={running || preparing}>
              📁  BROWSE FILES…
            </button>
            <div style={{ fontSize:8, color:C.muted, marginTop:5 }}>
              Auto-checked for smooth playback — only converts if needed.
            </div>
            {videoInfo && (
              <div style={{ marginTop:7, padding:"6px 9px", background:C.card,
                            borderRadius:3, border:`1px solid ${C.border}` }}>
                <div style={{ fontSize:11, overflow:"hidden", textOverflow:"ellipsis",
                              whiteSpace:"nowrap", marginBottom:2 }}>
                  {videoInfo.filename}
                </div>
                <div style={{ fontSize:9, color:C.muted }}>
                  {fmtTime(videoInfo.duration)} · {videoInfo.fps} fps · {videoInfo.width}×{videoInfo.height}
                </div>
              </div>
            )}
          </Sec>

          <Sec label="CUT  &  FRAME">
            <Row label="ASPECT">
              <select style={ST.sel} value={aspect} onChange={e => setAspect(e.target.value)}>
                {ASPECT_OPTIONS.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
              </select>
            </Row>
            {aspect === "9:16F" && (<>
              <Row label="BG COL">
                <input type="color" value={bgColor}
                       onChange={e => setBgColor(e.target.value)} style={ST.swatch}/>
                <span style={ST.dim}>{bgColor}</span>
              </Row>
              <Row label="V POS">
                <input type="range" min={0} max={1} step={0.01} value={videoYOffset}
                       onChange={e => setVideoYOffset(+e.target.value)}
                       style={{ flex:1, accentColor:C.amber }}/>
                <span style={{ ...ST.dim, width:28 }}>{Math.round(videoYOffset*100)}%</span>
              </Row>
            </>)}
            {videoInfo && (
              <div style={{ fontSize:9, color:C.muted, marginTop:2 }}>
                Output: {outputDims.w}×{outputDims.h}px
              </div>
            )}
          </Sec>

          <Sec label="FIND  CLIPS">
            <Row label="LENGTH">
              <input type="number" style={ST.num} value={clipMinLen} min={5}
                     onChange={e => setClipMinLen(+e.target.value)}/>
              <span style={ST.dim}>to</span>
              <input type="number" style={ST.num} value={clipMaxLen} min={10}
                     onChange={e => setClipMaxLen(+e.target.value)}/>
              <span style={ST.dim}>sec</span>
            </Row>
            <Row label="COUNT">
              <input type="number" style={ST.num} value={clipCount} min={1} max={20}
                     onChange={e => setClipCount(+e.target.value)}/>
            </Row>
            <Row>
              <label style={{ display:"flex", alignItems:"center", gap:5,
                              fontSize:9, color:C.sub, cursor:"pointer" }}>
                <input type="checkbox" checked={clipAddSubtitles}
                       onChange={e => setClipAddSubtitles(e.target.checked)}
                       style={{ accentColor:C.amber, margin:0 }}/>
                Add subtitles to clips
              </label>
            </Row>
            <Row>
              <label style={{ display:"flex", alignItems:"center", gap:5,
                              fontSize:9, color:C.sub, cursor:"pointer" }}>
                <input type="checkbox" checked={forceRetranscribe}
                       onChange={e => setForceRetranscribe(e.target.checked)}
                       style={{ accentColor:C.amber, margin:0 }}/>
                Re-transcribe each clip (slower, ignores scan cache)
              </label>
            </Row>

            <div style={{ display:"flex", gap:6, marginTop:6, marginBottom:6 }}>
              <button
                style={{ ...ST.btn, ...((running || preparing || analyzing || !videoPath) ? ST.btnOff : ST.btnGhost),
                         flex:1, fontSize:11 }}
                onClick={handleAnalyze}
                disabled={running || preparing || analyzing || !videoPath}>
                {analyzing ? "⟳  SCANNING…" : "🔍  SCAN FOR CLIPS"}
              </button>
              {(analyzing || running) && (
                <button style={{ ...ST.btn, ...ST.btnCancel }} onClick={handleCancel}>✕</button>
              )}
            </div>
            <button
              style={{ ...ST.btn, ...((running || preparing || analyzing || !videoPath) ? ST.btnOff : ST.btnRender),
                       width:"100%", fontSize:11, marginBottom:8 }}
              onClick={handleAutoRun}
              disabled={running || preparing || analyzing || !videoPath}>
              ⚡  AUTO: FIND &amp; RENDER ALL
            </button>
            <div style={{ fontSize:8, color:C.muted, marginBottom:8, marginTop:-4 }}>
              Auto scans, then renders every clip found — no review step.
              Use Scan for Clips instead to pick clips by hand first.
            </div>

            {clips.length > 0 && (<>
              <div style={{ maxHeight:260, overflowY:"auto", marginBottom:8 }}>
                {clips.map((c, i) => {
                  const sel = selectedClips.has(i);
                  return (
                    <div key={i}
                         style={{ background:C.card, borderRadius:3, padding:"7px 8px",
                                  marginBottom:6,
                                  border:`1px solid ${sel ? C.accent : C.border}`,
                                  cursor:"pointer" }}
                         onClick={() => previewClip(c)}>
                      <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                        <input type="checkbox" checked={sel}
                               onClick={e => e.stopPropagation()}
                               onChange={() => toggleClip(i)}
                               style={{ accentColor:C.amber, margin:0, flexShrink:0 }}/>
                        <span style={{ flex:1, fontSize:10, color:C.text,
                                       overflow:"hidden", textOverflow:"ellipsis",
                                       whiteSpace:"nowrap" }}>
                          {c.title || `Clip ${i+1}`}
                        </span>
                        <span style={{ fontSize:9, color:"#111010", background:C.amber,
                                       padding:"1px 5px", borderRadius:2,
                                       fontWeight:"bold", flexShrink:0 }}>{c.score}</span>
                      </div>
                      <div style={{ fontSize:9, color:C.sub, fontFamily:C.mono, marginTop:3 }}>
                        {fmtTime(c.start)} → {fmtTime(c.end)}
                        <span style={{ color:C.amber }}>  ({Math.round(c.end - c.start)}s)</span>
                      </div>
                      <div style={{ fontSize:8, color:C.muted, marginTop:2 }}>{c.reason}</div>
                    </div>
                  );
                })}
              </div>
              <button
                style={{ ...ST.btn, ...((running || preparing || analyzing || selectedClips.size === 0) ? ST.btnOff : ST.btnRender),
                         width:"100%", fontSize:11 }}
                onClick={handleRenderBatch}
                disabled={running || preparing || analyzing || selectedClips.size === 0}>
                🎬  RENDER SELECTED ({selectedClips.size})
              </button>
            </>)}

            {batchOutputs.length > 0 && (
              <div style={{ marginTop:8 }}>
                {batchOutputs.map((p, i) => (
                  <div key={i}
                       style={{ padding:"5px 8px", background:"#162016", borderRadius:3,
                                border:`1px solid ${C.green}`, cursor:"pointer",
                                marginBottom:4, fontSize:9, color:C.green,
                                wordBreak:"break-all" }}
                       onClick={() => { setOutputPath(p); setShowOutputPlayer(true); }}>
                    ✔ {p.split(/[\\/]/).pop()}
                  </div>
                ))}
              </div>
            )}
          </Sec>

          <Sec label="TEXT  OVERLAYS">
            {textOverlays.map((t) => (
              <div key={t.id} style={{
                background:C.card, border:`1px solid ${C.border}`, borderRadius:3,
                padding:"8px 9px", marginBottom:8,
              }}>
                <div style={{ display:"flex", gap:6, marginBottom:6 }}>
                  <input
                    style={{ ...ST.inp, flex:1 }}
                    placeholder="Enter text…"
                    value={t.text}
                    onChange={e => updateOverlay(t.id, { text: e.target.value })}
                  />
                  <button
                    onClick={() => removeOverlay(t.id)}
                    style={{ background:"#450a0a", border:"none", color:"#fca5a5",
                              width:24, borderRadius:3, cursor:"pointer",
                              fontSize:11, flexShrink:0 }}
                  >✕</button>
                </div>
                <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                  <span style={ST.dim}>size</span>
                  <input type="number" style={ST.num} value={t.size}
                         onChange={e => updateOverlay(t.id, { size: +e.target.value })}/>
                  <input type="color" style={ST.swatch} value={t.color}
                         onChange={e => updateOverlay(t.id, { color: e.target.value })}/>
                </div>
              </div>
            ))}
            <button style={{ ...ST.btn, ...ST.btnGhost, width:"100%" }} onClick={addOverlay}>
              ＋  ADD TEXT
            </button>
            {textOverlays.length > 0 && (
              <div style={{ fontSize:9, color:C.muted, marginTop:6 }}>
                Drag any text on the preview to reposition. Shows for the whole clip.
              </div>
            )}
          </Sec>

          <Sec label="SUBTITLES">
            <Row>
              <label style={{ display:"flex", alignItems:"center", gap:8, cursor:"pointer" }}>
                <input type="checkbox" checked={addSubtitles}
                       onChange={e => setAddSubtitles(e.target.checked)}
                       style={{ accentColor:C.amber, width:14, height:14 }}/>
                <span style={{ fontSize:11 }}>Add subtitles to this render</span>
              </label>
            </Row>
            {!addSubtitles && (
              <div style={{ fontSize:9, color:C.muted }}>
                Skips transcription & burning of word-by-word subtitles. Text overlays above still work independently.
              </div>
            )}
          </Sec>

          <div style={{
            opacity: addSubtitles ? 1 : 0.35,
            pointerEvents: addSubtitles ? "auto" : "none",
            transition: "opacity 0.2s",
          }}>
            <Sec label="TRANSCRIPTION">
              <Row label="MODEL">
                <select style={ST.sel} value={model} onChange={e => setModel(e.target.value)}>
                  {MODEL_OPTIONS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
              </Row>
              <Row label="LANG">
                <select style={ST.sel} value={language} onChange={e => setLanguage(e.target.value)}>
                  {LANGS.map(l => <option key={l}>{l}</option>)}
                </select>
              </Row>
            </Sec>

            <Sec label="SUBTITLE  STYLE">
              <Row label="SIZE">
                <span style={ST.dim}>off </span>
                <input style={ST.num} type="number" value={baseSize}
                       onChange={e => setBaseSize(+e.target.value)}/>
                <span style={{ ...ST.dim, marginLeft:8 }}>on </span>
                <input style={ST.num} type="number" value={activeSize}
                       onChange={e => setActiveSize(+e.target.value)}/>
              </Row>
              <Row label="COLOR">
                <span style={ST.dim}>off </span>
                <input type="color" value={colorBase}
                       onChange={e => setColorBase(e.target.value)} style={ST.swatch}/>
                <span style={{ ...ST.dim, marginLeft:8 }}>on </span>
                <input type="color" value={colorActive}
                       onChange={e => setColorActive(e.target.value)} style={ST.swatch}/>
              </Row>
              <Row label="Y POS">
                <input type="range" min={0.05} max={0.97} step={0.01} value={subtitleY}
                       onChange={e => setSubtitleY(+e.target.value)}
                       style={{ flex:1, accentColor:C.amber }}/>
                <span style={{ ...ST.dim, width:28 }}>{Math.round(subtitleY*100)}%</span>
              </Row>
              <div style={{ fontSize:9, color:C.muted }}>
                Drag the preview text on the right to reposition.
              </div>
            </Sec>
          </div>

          <Sec label="RENDER">
            <Row label="NAME">
              <input style={{ ...ST.inp, flex:1 }} placeholder="output filename"
                     value={outputName} onChange={e => setOutputName(e.target.value)}/>
            </Row>
            <div style={{ display:"flex", gap:6, marginBottom:8 }}>
              <button style={{ ...ST.btn, ...((running || preparing) ? ST.btnOff : ST.btnRender), flex:1 }}
                      onClick={handleRender} disabled={running || preparing}>
                🎬  RENDER{!addSubtitles ? " (no subs)" : ""}
              </button>
              {running && (
                <button style={{ ...ST.btn, ...ST.btnCancel }} onClick={handleCancel}>✕</button>
              )}
            </div>

            <button style={{ ...ST.btn, ...ST.btnGhost, width:"100%", marginBottom:8 }}
                    onClick={handleSaveProject} disabled={!videoPath}>
              💾  SAVE PROJECT{currentProjectId ? " (UPDATE)" : ""}
            </button>
            {projectSaveMsg && (
              <div style={{ fontSize:9, color:C.green, marginTop:-4, marginBottom:8 }}>{projectSaveMsg}</div>
            )}

            {(running || preparing || analyzing || progress > 0) && (
              <div style={{ marginBottom:8 }}>
                <div style={{ fontSize:10, color:C.amber,
                              fontWeight:"bold", marginBottom:4 }}>{phase}</div>
                <div style={{ background:C.card, height:5, borderRadius:3, overflow:"hidden" }}>
                  <div style={{ background:C.amber, height:"100%", borderRadius:3,
                                width:`${progress}%`, transition:"width 0.35s ease" }}/>
                </div>
                <div style={{ display:"flex", justifyContent:"space-between",
                              fontSize:9, color:C.muted, marginTop:2 }}>
                  <span>{progressText}</span>
                  <span>
                    {fmtElapsed(elapsed)}
                    {progress > 3 && progress < 100
                      ? ` · ~${fmtElapsed(elapsed * (100 - progress) / progress)} left`
                      : ""}
                  </span>
                </div>
              </div>
            )}

            {outputPath && (
              <div style={{ padding:"7px 10px", background:"#162016",
                            borderRadius:3, border:`1px solid ${C.green}`, cursor:"pointer" }}
                   onClick={() => setShowOutputPlayer(true)}>
                <div style={{ fontSize:8, color:C.green, letterSpacing:2,
                              marginBottom:2 }}>✔ SAVED — CLICK TO PLAY</div>
                <div style={{ fontSize:9, color:C.green, wordBreak:"break-all" }}>{outputPath}</div>
              </div>
            )}
          </Sec>

          <div style={{ padding:"6px 14px", borderBottom:`1px solid ${C.border}`,
                        display:"flex", gap:10 }}>
            <button onClick={() => setShowLogs(v => !v)} style={ST.conBtn}>
              {showLogs ? "▾" : "▸"} CONSOLE
            </button>
            {showLogs && <button onClick={() => setLogs([])} style={ST.conBtn}>CLEAR</button>}
          </div>
          {showLogs && (
            <div style={{ maxHeight:150, overflowY:"auto", background:"#0a0a09", padding:"6px 14px" }}>
              {logs.map((l, i) => (
                <div key={i} style={{ fontSize:9, color:"#92400e", fontFamily:C.mono,
                                      lineHeight:1.7, wordBreak:"break-all" }}>{l}</div>
              ))}
              <div ref={logsEndRef}/>
            </div>
          )}

        </div>
      </div>

      {/* ══════════ RIGHT PANEL ══════════ */}
      <div style={{ flex:1, display:"flex", flexDirection:"column",
                    background:"#0d0c0b", overflow:"hidden" }}>

        <div ref={viewerRef} style={{
          flex:1, position:"relative", overflow:"hidden",
          background:"#080807", minHeight:0,
        }}>
          {videoSrc && videoInfo ? (
            <>
              {isFullFrame && (
                <div style={{
                  position: "absolute",
                  left: stageRect.left, top: stageRect.top,
                  width: stageRect.width, height: stageRect.height,
                  background: bgColor, zIndex: 0, pointerEvents: "none",
                }} />
              )}
              <video
                key={videoPath}
                ref={setVideoRef}
                src={videoSrc}
                playsInline
                preload="auto"
                style={{
                  position: "absolute",
                  width: 1, height: 1, opacity: 0,
                  left: -9999, top: 0, pointerEvents: "none",
                }}
              />
              <canvas
                ref={previewCanvasRef}
                onClick={togglePlay}
                style={{
                  position: "absolute",
                  left: isFullFrame
                    ? stageRect.left
                    : (videoDisplayRect.width ? videoDisplayRect.left : 0),
                  top: isFullFrame
                    ? stageRect.top
                    : (videoDisplayRect.height ? videoDisplayRect.top : 0),
                  width: isFullFrame
                    ? stageRect.width
                    : (videoDisplayRect.width || "100%"),
                  height: isFullFrame
                    ? stageRect.height
                    : (videoDisplayRect.height || "100%"),
                  display: "block",
                  cursor: "pointer",
                  zIndex: 1,
                }}
              />
            </>
          ) : (
            <div style={{ position:"absolute", inset:0, display:"flex",
                          flexDirection:"column", alignItems:"center",
                          justifyContent:"center", gap:8, color:C.muted }}>
              <div style={{ fontSize:52, color:C.border }}>▶</div>
              <div style={{ fontSize:12 }}>
                {preparing ? "Preparing video…" : "No reel loaded"}
              </div>
              {!preparing && (
                <button style={{ ...ST.btn, ...ST.btnGhost, marginTop:8 }}
                        onClick={browseFile}>📁  Browse Files…</button>
              )}
            </div>
          )}

          {videoInfo && (
            <div style={{
              position: "absolute", inset: 0, zIndex: 10,
              transform: "translateZ(0)", isolation: "isolate",
              pointerEvents: "none",
            }}>
              {textOverlays.map(t => (
                <TextOverlayPreview
                  key={t.id}
                  item={t}
                  stageRect={stageRect}
                  outputDims={outputDims}
                  onYChange={(y) => updateOverlay(t.id, { y })}
                  viewerRef={viewerRef}
                />
              ))}

              {addSubtitles && (
                <SubPreview
                  stageRect={stageRect} outputDims={outputDims} subtitleY={subtitleY}
                  colorBase={colorBase} colorActive={colorActive}
                  baseSize={baseSize} activeSize={activeSize}
                  onYChange={setSubtitleY} viewerRef={viewerRef}
                />
              )}
            </div>
          )}
        </div>

        <div style={{ display:"flex", alignItems:"center", gap:6, padding:"6px 12px",
                      background:C.surface, borderTop:`1px solid ${C.border}`, flexShrink:0 }}>
          <button style={ST.ctrlBtn} onClick={() => seekTo(0)}>⏮</button>
          <button style={ST.ctrlBtn} onClick={() => stepFrame(-1)}>◀▌</button>
          <button style={{ ...ST.ctrlBtn, width:36, borderColor:C.sub, color:C.text }}
                  onClick={togglePlay}>{isPlaying ? "⏸" : "▶"}</button>
          <button style={ST.ctrlBtn} onClick={() => stepFrame(1)}>▐▶</button>
          <button style={ST.ctrlBtn}
                  onClick={() => videoInfo && seekTo(videoInfo.duration)}>⏭</button>

          <span style={{ fontSize:12, color:C.text, fontFamily:C.mono, marginLeft:4 }}>
            {fmtTime(currentTime)}
          </span>
          {videoInfo && (<>
            <span style={{ fontSize:11, color:C.muted, fontFamily:C.mono }}>
              {" "}/ {fmtTime(videoInfo.duration)}
            </span>
            <span style={{ fontSize:9, color:C.muted, fontFamily:C.mono, marginLeft:4 }}>
              f{Math.round(currentTime * (videoInfo.fps || 25))}
            </span>
          </>)}

          <span style={{ fontSize:8, color:C.muted, fontFamily:C.mono, marginLeft:10 }}>
            space=play/pause · ←→=step frame
          </span>

          <div style={{ flex:1 }}/>

          <button style={ST.markBtn} onClick={() => setInPoint(currentTime)}>◀ MARK IN</button>
          <span style={{ fontSize:9, color:C.muted, fontFamily:C.mono }}>
            {fmtTime(inPoint)} → {fmtTime(outPoint)}
          </span>
          <button style={ST.markBtn} onClick={() => setOutPoint(currentTime)}>MARK OUT ▶</button>

          {outputPath && (
            <button style={{ ...ST.markBtn, borderColor:C.green, color:C.green, marginLeft:8 }}
                    onClick={() => setShowOutputPlayer(true)}>▶ PLAY OUTPUT</button>
          )}
        </div>

        <Timeline
          duration={videoInfo?.duration || 0}
          inPoint={inPoint} outPoint={outPoint} currentTime={currentTime}
          thumbnails={thumbnails} loading={thumbsLoading}
          onIn={setInPoint} onOut={setOutPoint} onSeek={seekTo}
        />

      </div>
      </div>
      )}
    </div>
  );
}

// ── Top navigation ──────────────────────────────────────────────────────────
function TopNav({ view, setView, backendCrashed, restartingBackend, onRestartBackend, updateInfo }) {
  const tabs = [
    { id: "editor",  label: "EDITOR"  },
    { id: "library", label: "LIBRARY" },
    { id: "profile", label: "PROFILE" },
  ];
  return (
    <div style={{ flexShrink:0 }}>
      <div style={{ display:"flex", alignItems:"center", gap:2,
                    padding:"8px 14px", borderBottom:`3px solid ${C.accent}`,
                    background:C.surface }}>
        <img src="./logo.png" alt=""
             style={{ width:22, height:22, borderRadius:5, marginRight:2, objectFit:"cover" }}/>
        <span style={{ fontSize:16, fontWeight:"bold", marginRight:8 }}>BananaCut</span>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setView(t.id)}
                  style={{
                    background: view === t.id ? C.card : "none",
                    border: "none", color: view === t.id ? C.amber : C.sub,
                    fontFamily: C.mono, fontSize: 10, fontWeight: "bold",
                    letterSpacing: 1, padding: "5px 12px", borderRadius: 3,
                    cursor: "pointer",
                  }}>{t.label}</button>
        ))}
        <div style={{ flex:1 }}/>
        {updateInfo?.available && (
          <button
            onClick={() => window.electronAPI?.installUpdate?.()}
            style={{ background:"#14532d", border:`1px solid ${C.green}`, color:"#bbf7d0",
                      fontFamily:C.mono, fontSize:9, padding:"4px 10px", borderRadius:3,
                      cursor:"pointer", marginRight:8 }}>
            ⇩ {updateInfo.readyToInstall
                  ? `Restart to update (v${updateInfo.version})`
                  : `Update available (v${updateInfo.version}) — click to download`}
          </button>
        )}
        <span style={{ fontSize:9, background:"#1d4ed8", color:"#fff",
                        padding:"2px 8px", borderRadius:3 }}>
          {navigator.platform.toLowerCase().includes("mac") ? "macOS" : "Windows"}
        </span>
      </div>
      {backendCrashed && (
        <div style={{ background:"#450a0a", color:"#fca5a5", fontSize:10,
                      padding:"7px 14px", display:"flex", alignItems:"center",
                      gap:10 }}>
          ⚠ The BananaCut engine stopped unexpectedly.
          <button onClick={onRestartBackend} disabled={restartingBackend}
                  style={{ background:"none", border:"1px solid #fca5a5", color:"#fca5a5",
                            borderRadius:3, padding:"2px 8px", cursor:"pointer", fontSize:9 }}>
            {restartingBackend ? "Restarting…" : "Restart engine"}
          </button>
          <button onClick={() => window.electronAPI?.openBackendLog?.()}
                  style={{ background:"none", border:"1px solid #fca5a5", color:"#fca5a5",
                            borderRadius:3, padding:"2px 8px", cursor:"pointer", fontSize:9 }}>
            Open log
          </button>
        </div>
      )}
    </div>
  );
}

// ── Design tokens ─────────────────────────────────────────────────────────────
const C = {
  bg:"#111010", surface:"#1a1917", card:"#211f1c", border:"#2a2822",
  accent:"#b45309", amber:"#d97706", green:"#65a30d",
  text:"#d6d3cd", sub:"#8c887d", muted:"#3d3a34", mono:"Courier, monospace",
};

const ST = {
  dim:       { fontSize:9, color:"#3d3a34" },
  inp:       { width:"100%", background:"#211f1c", border:"1px solid #2a2822",
               color:"#d6d3cd", padding:"6px 8px", fontFamily:"Courier, monospace",
               fontSize:11, borderRadius:3, boxSizing:"border-box" },
  sel:       { background:"#211f1c", border:"1px solid #2a2822", color:"#d6d3cd",
               padding:"5px 7px", fontFamily:"Courier, monospace",
               fontSize:10, borderRadius:3, minWidth:0 },
  num:       { width:46, background:"#211f1c", border:"1px solid #2a2822",
               color:"#d6d3cd", padding:"4px 5px", fontFamily:"Courier, monospace",
               fontSize:11, borderRadius:3 },
  swatch:    { width:26, height:22, border:"1px solid #2a2822",
               background:"none", cursor:"pointer", borderRadius:3, padding:1 },
  btn:       { border:"none", fontFamily:"Courier, monospace", fontWeight:"bold",
               fontSize:11, cursor:"pointer", borderRadius:3, padding:"7px 12px" },
  btnAmber:  { background:"#b45309", color:"#111010" },
  btnGhost:  { background:"#211f1c", color:"#d6d3cd", border:"1px solid #2a2822",
               fontWeight:"normal" },
  btnRender: { background:"#d97706", color:"#111010", fontSize:13 },
  btnOff:    { background:"#211f1c", color:"#3d3a34", border:"1px solid #2a2822",
               cursor:"not-allowed", fontSize:13 },
  btnCancel: { background:"#450a0a", color:"#fca5a5", width:"auto",
               padding:"7px 10px", fontWeight:"normal" },
  ctrlBtn:   { background:"#211f1c", border:"1px solid #2a2822", color:"#8c887d",
               width:28, height:26, cursor:"pointer", borderRadius:3,
               fontFamily:"Courier, monospace", fontSize:10, flexShrink:0 },
  markBtn:   { background:"#1c1608", border:"1px solid #b45309", color:"#d97706",
               padding:"3px 8px", fontFamily:"Courier, monospace", fontSize:9,
               cursor:"pointer", borderRadius:3, flexShrink:0 },
  conBtn:    { background:"none", border:"none", color:"#3d3a34",
               fontFamily:"Courier, monospace", fontSize:9, cursor:"pointer", padding:0 },
};