import { useState, useCallback, useEffect } from "react";

// ── Appels API (Flask proxy → SQLite + MusicBrainz) ───────────────────────────
const API = "http://localhost:5000";

async function apiGet(path) {
  const r = await fetch(API + path);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function apiPost(path, body) {
  const r = await fetch(API + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function apiPatch(path, body) {
  const r = await fetch(API + path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function apiDelete(path) {
  const r = await fetch(API + path, { method: "DELETE" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// ── Composants réutilisables ──────────────────────────────────────────────────
function extractDeezerId(url) {
  if (!url) return null;
  const m = url.match(/\/album\/(\d+)/);
  return m ? m[1] : null;
}

function fmtUnits(n) {
  if (!n) return null;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} Md`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} k`;
  return String(Math.round(n));
}

function fmtDur(s) {
  if (!s) return "";
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function Stars({ value = 0, onChange }) {
  return (
    <div style={{ display: "flex", gap: 4 }}>
      {[1,2,3,4,5].map(n => (
        <span key={n} onClick={() => onChange && onChange(n === value ? 0 : n)} style={{
          fontSize: 22, cursor: onChange ? "pointer" : "default",
          color: n <= value ? "#f5a623" : "#333",
          transition: "color .15s", userSelect: "none",
        }}>★</span>
      ))}
    </div>
  );
}

function Badge({ label, onRemove }) {
  return (
    <span style={{
      position: "relative",
      background: "rgba(245,166,35,.14)", color: "#f5a623",
      border: "1px solid rgba(245,166,35,.28)",
      borderRadius: 20, padding: "2px 10px",
      fontSize: 11, fontWeight: 600, letterSpacing: .4, whiteSpace: "nowrap",
    }}>
      {label}
      {onRemove && (
        <button onClick={onRemove} aria-label={`Retirer le genre ${label}`} title="Retirer ce genre" style={{
          position: "absolute", top: -7, right: -7,
          width: 16, height: 16, borderRadius: "50%", padding: 0,
          background: "#2a2a2a", border: "1px solid #444", color: "#ccc",
          fontSize: 10, lineHeight: "14px", textAlign: "center",
        }}>×</button>
      )}
    </span>
  );
}

function Cover({ src, size = 64, radius = 8 }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);

  return (
    <div style={{
      width: size, height: size, borderRadius: radius, flexShrink: 0,
      background: "#1a1a1a", overflow: "hidden",
      display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      {src && !failed
        ? <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        : <span style={{ fontSize: size * 0.38, opacity: .25 }}>🎵</span>
      }
    </div>
  );
}

function Spinner() {
  return (
    <div style={{ display: "flex", justifyContent: "center", padding: "48px 0" }}>
      <div style={{
        width: 32, height: 32, border: "3px solid #1e1e1e",
        borderTopColor: "#f5a623", borderRadius: "50%",
        animation: "spin .8s linear infinite",
      }} />
    </div>
  );
}

function SectionLabel({ children }) {
  return (
    <div style={{
      fontSize: 10, letterSpacing: 2.5, color: "#444",
      fontWeight: 700, textTransform: "uppercase", marginBottom: 12,
    }}>{children}</div>
  );
}

// Décalage d'animation plafonné : au-delà des 15 premières cartes, tout apparaît d'un coup
function cardDelay(i, step) {
  return `${Math.min(i, 15) * step}ms`;
}

function Toast({ msg, onClose }) {
  useEffect(() => {
    const t = setTimeout(onClose, 4000);
    return () => clearTimeout(t);
  }, [msg, onClose]);

  return (
    <div onClick={onClose} style={{
      position: "fixed", bottom: 84, left: "50%", transform: "translateX(-50%)",
      width: "calc(100% - 32px)", maxWidth: 448, zIndex: 500,
      background: "#2a0d0d", border: "1px solid #5a1a1a", borderRadius: 12,
      padding: "12px 16px", color: "#ffb4b4", fontSize: 13, cursor: "pointer",
      animation: "fadeUp .2s ease both",
    }}>{msg}</div>
  );
}

function ErrorBox({ msg }) {
  return (
    <div style={{
      background: "#160e00", border: "1px solid #3a2500", borderRadius: 12,
      padding: "14px 16px", color: "#f5a623", fontSize: 13,
      whiteSpace: "pre-line", lineHeight: 1.7,
    }}>{msg}</div>
  );
}

// ── App principale ────────────────────────────────────────────────────────────
export default function App() {
  const [tab,        setTab]        = useState("search");
  const [collection, setCollection] = useState([]);
  const [colLoading, setColLoading] = useState(true);
  const [toast,      setToast]      = useState(null);
  const closeToast = useCallback(() => setToast(null), []);

  // Chargement initial depuis SQLite
  useEffect(() => {
    apiGet("/collection")
      .then(data => setCollection(data.albums || []))
      .catch(() => {
        setCollection([]);
        setToast("Impossible de charger la collection. Le proxy (proxy.py) est-il lancé ?");
      })
      .finally(() => setColLoading(false));
  }, []);

  // Les trois fonctions renvoient true si l'opération a réussi
  const addAlbum = useCallback(async (album) => {
    if (collection.find(a => a.id === album.id)) return true;
    try {
      await apiPost("/collection", album);
      setCollection(prev => [{ ...album }, ...prev]);
      return true;
    } catch (e) {
      console.error("Erreur ajout album", e);
      setToast("L'album n'a pas pu être ajouté.");
      return false;
    }
  }, [collection]);

  const updateAlbum = useCallback(async (id, patch) => {
    try {
      await apiPatch(`/collection/${id}`, patch);
      setCollection(prev => prev.map(a => a.id === id ? { ...a, ...patch } : a));
      return true;
    } catch (e) {
      console.error("Erreur mise à jour", e);
      setToast("La modification n'a pas été enregistrée.");
      return false;
    }
  }, []);

  const removeAlbum = useCallback(async (id) => {
    try {
      await apiDelete(`/collection/${id}`);
      setCollection(prev => prev.filter(a => a.id !== id));
      return true;
    } catch (e) {
      console.error("Erreur suppression", e);
      setToast("L'album n'a pas pu être supprimé.");
      return false;
    }
  }, []);

  return (
    <div style={{
      minHeight: "100vh", background: "#0d0d0d", color: "#f0ece4",
      fontFamily: "'DM Sans','Helvetica Neue',sans-serif",
      maxWidth: 480, margin: "0 auto",
      display: "flex", flexDirection: "column", paddingBottom: 72,
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;600;700&family=Playfair+Display:wght@700;900&display=swap');
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 0; }
        input, textarea { outline: none; font-family: inherit; }
        button { cursor: pointer; font-family: inherit; }
        @keyframes fadeUp { from { opacity:0; transform:translateY(14px); } to { opacity:1; transform:none; } }
        @keyframes spin   { to { transform: rotate(360deg); } }
        .card { animation: fadeUp .28s ease both; }
      `}</style>

      {/* Header */}
      <header style={{
        padding: "28px 20px 16px", borderBottom: "1px solid #191919",
        background: "linear-gradient(180deg,#111 0%,#0d0d0d 100%)",
      }}>
        <div style={{ fontSize: 10, letterSpacing: 3, color: "#f5a623", fontWeight: 700, textTransform: "uppercase", marginBottom: 2 }}>
          Ma Discothèque
        </div>
        <div style={{ fontFamily: "'Playfair Display',serif", fontSize: 28, fontWeight: 900 }}>Vinylothek</div>
        <div style={{ fontSize: 12, color: "#555", marginTop: 4 }}>
          {colLoading ? "Chargement…" : `${collection.length} album${collection.length !== 1 ? "s" : ""} · SQLite`}
        </div>
      </header>

      <main style={{ flex: 1, overflowY: "auto" }}>
        {tab === "search"     && <SearchTab     onAdd={addAlbum} collection={collection} setTab={setTab} />}
        {tab === "collection" && <CollectionTab collection={collection} loading={colLoading} onUpdate={updateAlbum} onRemove={removeAlbum} />}
        {tab === "stats"      && <StatsTab      collection={collection} />}
      </main>

      {toast && <Toast msg={toast} onClose={closeToast} />}

      {/* Bottom nav */}
      <nav style={{
        position: "fixed", bottom: 0, left: "50%", transform: "translateX(-50%)",
        width: "100%", maxWidth: 480, background: "#0f0f0f",
        borderTop: "1px solid #191919", display: "flex", zIndex: 100,
      }}>
        {[
          { key: "search",     icon: "🔍", label: "Chercher" },
          { key: "collection", icon: "🎵", label: "Collection" },
          { key: "stats",      icon: "📊", label: "Stats" },
        ].map(({ key, icon, label }) => (
          <button key={key} onClick={() => setTab(key)} style={{
            flex: 1, padding: "10px 0 12px", border: "none", background: "none",
            color: tab === key ? "#f5a623" : "#444", fontSize: 20,
            display: "flex", flexDirection: "column", alignItems: "center",
            gap: 2, transition: "color .2s",
          }}>
            <span>{icon}</span>
            <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: .5, textTransform: "uppercase" }}>{label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// ONGLET RECHERCHE
// ══════════════════════════════════════════════════════════════════════════════
function SearchTab({ onAdd, collection, setTab }) {
  const [query,   setQuery]   = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState(null);
  const [detail,  setDetail]  = useState(null);
  const [addModal, setAddModal] = useState(null);

  const search = async () => {
    if (!query.trim()) return;
    setLoading(true); setError(null); setResults([]);
    try {
      const data = await apiGet(`/search?q=${encodeURIComponent(query)}`);
      setResults(data.results || []);
      if (!data.results?.length) setError("Aucun résultat trouvé.");
    } catch {
      setError("Impossible de contacter le proxy.\nLance proxy.py dans un terminal.");
    } finally { setLoading(false); }
  };

  const openDetail = async (album) => {
    setDetail({ ...album, loading: true });
    try {
      const [det, cov] = await Promise.all([
        apiGet(`/album/${album.id}`),
        apiGet(`/cover/${album.id}`),
      ]);
      setDetail({ ...det, cover: cov.url, loading: false });
    } catch {
      setDetail(d => ({ ...d, loading: false, error: "Erreur de chargement." }));
    }
  };

  const alreadyIn = (id) => collection.some(a => a.id === id);

  return (
    <div style={{ padding: "16px 16px 0" }}>
      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => e.key === "Enter" && search()}
          placeholder="Artiste, album…"
          style={{
            flex: 1, background: "#161616", border: "1px solid #242424",
            borderRadius: 12, padding: "12px 16px", color: "#f0ece4", fontSize: 15,
          }}
        />
        <button onClick={search} style={{
          background: "#f5a623", border: "none", borderRadius: 12,
          width: 48, fontSize: 18, color: "#0d0d0d",
        }}>🔍</button>
      </div>

      {loading && <Spinner />}
      {error   && <ErrorBox msg={error} />}

      {results.map((album, i) => (
        <div key={album.id} className="card" style={{ animationDelay: cardDelay(i, 35) }}>
          <ResultCard album={album} inCollection={alreadyIn(album.id)} onOpen={() => openDetail(album)} />
        </div>
      ))}

      {detail && (
        <DetailModal
          album={detail}
          inCollection={alreadyIn(detail.id)}
          onAdd={() => setAddModal(detail)}
          onClose={() => setDetail(null)}
        />
      )}

      {addModal && <AddModal album={addModal} onAdd={async (rating, comment) => {
        if (!await onAdd({ ...addModal, rating, comment })) return;
        setAddModal(null);
        setDetail(null);
        setTab("collection");
      }} onCancel={() => setAddModal(null)} />}
    </div>
  );
}

function ResultCard({ album, inCollection, onOpen }) {
  return (
    <div onClick={onOpen} style={{
      display: "flex", gap: 12, alignItems: "center",
      padding: "11px 0", borderBottom: "1px solid #181818", cursor: "pointer",
    }}>
      <Cover src={`https://coverartarchive.org/release-group/${album.id}/front-250`} size={56} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: 14, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {album.title}
        </div>
        <div style={{ color: "#666", fontSize: 12, marginTop: 2 }}>
          {album.artist}{album.year ? ` · ${album.year}` : ""}
        </div>
      </div>
      {inCollection && <span style={{ fontSize: 15 }}>✅</span>}
      <span style={{ color: "#333", fontSize: 20 }}>›</span>
    </div>
  );
}

function WikidataP2723Button({ qid, deezerUrl, onSuccess }) {
  const deezerId = extractDeezerId(deezerUrl);
  const [open,      setOpen]      = useState(false);
  const [user,      setUser]      = useState(() => localStorage.getItem("wd_user") || "");
  const [pwd,       setPwd]       = useState("");
  const [busy,      setBusy]      = useState(false);
  const [err,       setErr]       = useState(null);
  const [done,      setDone]      = useState(false);
  const [checking,  setChecking]  = useState(true);
  const [p2723Exists, setP2723Exists] = useState(false);

  useEffect(() => {
    if (!qid || !deezerId) { setChecking(false); return; }
    setChecking(true);
    apiGet(`/wikidata/check-p2723/${qid}`)
      .then(d => setP2723Exists(d.exists))
      .catch(() => setP2723Exists(false))
      .finally(() => setChecking(false));
  }, [qid, deezerId]);

  if (!qid || !deezerId || checking || p2723Exists) return null;
  if (done) return (
    <div style={{ fontSize: 13, color: "#4caf50", marginTop: 12, textAlign: "center" }}>
      ✅ ID Deezer ajouté sur Wikidata ({deezerId})
    </div>
  );

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      localStorage.setItem("wd_user", user);
      await apiPost("/wikidata/add-p2723", { qid, deezer_id: deezerId, username: user, password: pwd });
      setDone(true);
      setOpen(false);
      onSuccess?.(deezerId);
    } catch (e) {
      setErr(e.message || "Erreur lors de l'ajout.");
    } finally {
      setBusy(false); setPwd("");
    }
  };

  return (
    <>
      <button onClick={() => setOpen(true)} style={{
        width: "100%", marginTop: 12, background: "transparent",
        border: "1px solid rgba(245,166,35,.35)", borderRadius: 12, padding: 12,
        color: "#f5a623", fontWeight: 600, fontSize: 13,
        display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
      }}>
        ＋ Ajouter l'ID Deezer sur Wikidata (P2723)
      </button>

      {open && (
        <div style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,.88)",
          zIndex: 400, display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
        }}>
          <div style={{
            background: "#161616", borderRadius: 14, padding: 24,
            width: "100%", maxWidth: 360, border: "1px solid #2a2a2a",
          }}>
            <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 4 }}>Ajouter sur Wikidata</div>
            <div style={{ fontSize: 12, color: "#555", marginBottom: 8 }}>
              Propriété P2723 · Valeur : <span style={{ color: "#f5a623" }}>{deezerId}</span>
            </div>
            <div style={{ fontSize: 11, color: "#555", marginBottom: 20, lineHeight: 1.5 }}>
              Conseil : utilise un{" "}
              <a href="https://www.wikidata.org/wiki/Special:BotPasswords" target="_blank" rel="noreferrer" style={{ color: "#f5a623" }}>
                mot de passe de bot
              </a>{" "}
              (identifiant « Utilisateur@NomDuBot ») plutôt que ton vrai mot de passe.
            </div>
            {[["Nom d'utilisateur", user, setUser, "text"], ["Mot de passe", pwd, setPwd, "password"]].map(([label, val, set, type]) => (
              <div key={label} style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 12, color: "#888", marginBottom: 6 }}>{label}</div>
                <input type={type} value={val} onChange={e => set(e.target.value)}
                  style={{
                    width: "100%", background: "#0d0d0d", border: "1px solid #2a2a2a",
                    borderRadius: 8, padding: "10px 12px", color: "#f0ece4", fontSize: 14,
                  }} />
              </div>
            ))}
            {err && <ErrorBox msg={err} />}
            <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
              <button onClick={() => { setOpen(false); setErr(null); setPwd(""); }} style={{
                flex: 1, background: "#222", border: "none", borderRadius: 10,
                padding: "11px 0", color: "#f0ece4", fontWeight: 600,
              }}>Annuler</button>
              <button onClick={submit} disabled={busy || !user || !pwd} style={{
                flex: 1, background: busy || !user || !pwd ? "#333" : "#f5a623",
                border: "none", borderRadius: 10, padding: "11px 0",
                color: busy || !user || !pwd ? "#888" : "#0d0d0d", fontWeight: 700,
              }}>{busy ? "Envoi…" : "Confirmer"}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function DeezerSearchNote() {
  return (
    <div style={{ textAlign: "center", color: "#555", fontSize: 12, marginTop: 10 }}>
      Lien trouvé par recherche sur Deezer : vérifie que c&apos;est le bon album avant de l&apos;ajouter sur Wikidata.
    </div>
  );
}

function DetailModal({ album, inCollection, onAdd, onClose }) {
  return (
    <div style={{
      position: "fixed", inset: 0, background: "#0d0d0d",
      zIndex: 200, overflowY: "auto", maxWidth: 480, margin: "0 auto",
    }}>
      <div style={{ position: "relative" }}>
        {album.cover
          ? <img src={album.cover} alt="" style={{ width: "100%", aspectRatio: "1", objectFit: "cover", display: "block" }} />
          : <div style={{ width: "100%", aspectRatio: "1", background: "#141414", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <span style={{ fontSize: 90, opacity: .15 }}>🎵</span>
            </div>
        }
        <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg,transparent 50%,#0d0d0d 100%)" }} />
        <button onClick={onClose} style={{
          position: "absolute", top: 16, left: 16, background: "rgba(0,0,0,.75)",
          border: "none", borderRadius: "50%", width: 38, height: 38, color: "#fff", fontSize: 20,
        }}>‹</button>
      </div>

      <div style={{ padding: "0 20px 48px", marginTop: -44, position: "relative" }}>
        {album.loading && <Spinner />}
        {album.error   && <ErrorBox msg={album.error} />}

        {!album.loading && !album.error && <>
          <div style={{ fontFamily: "'Playfair Display',serif", fontSize: 24, fontWeight: 900, lineHeight: 1.2 }}>
            {album.title}
          </div>
          <div style={{ color: "#f5a623", fontWeight: 600, marginTop: 4 }}>{album.artist}</div>

          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 12 }}>
            {album.year && <Badge label={album.year} />}
            {album.nb_tracks > 0 && <Badge label={`${album.nb_tracks} titres`} />}
            {album.duration  > 0 && <Badge label={`${Math.round(album.duration / 60)} min`} />}
            {(album.genres || []).map(g => <Badge key={g} label={g} />)}
          </div>

          {album.discogs_rating && (
            <div style={{ marginTop: 16 }}>
              <SectionLabel>Note communautaire (Discogs)</SectionLabel>
              <div style={{ fontSize: 14, color: "#f0ece4" }}>
                {Number(album.discogs_rating).toFixed(1)} / 5 ⭐
              </div>
            </div>
          )}

          {album.units_sold && (
            <div style={{ marginTop: 16 }}>
              <SectionLabel>Exemplaires vendus</SectionLabel>
              <div style={{ fontSize: 14, color: "#f0ece4" }}>{fmtUnits(album.units_sold)}</div>
            </div>
          )}

          {album.work_language && (
            <div style={{ marginTop: 16 }}>
              <SectionLabel>Langue</SectionLabel>
              <div style={{ fontSize: 14, color: "#f0ece4" }}>{album.work_language}</div>
            </div>
          )}

          {album.tracks?.length > 0 && (
            <div style={{ marginTop: 22 }}>
              <SectionLabel>Titres</SectionLabel>
              {album.tracks.map((t, i) => (
                <div key={i} style={{
                  display: "flex", gap: 8, padding: "7px 0",
                  borderBottom: "1px solid #181818", fontSize: 13,
                }}>
                  <span style={{ color: "#444", minWidth: 22, flexShrink: 0 }}>{t.position || i + 1}.</span>
                  <span style={{ flex: 1 }}>{t.title}</span>
                  <span style={{ color: "#555", flexShrink: 0 }}>{fmtDur(t.duration)}</span>
                </div>
              ))}
            </div>
          )}

          <div style={{ display: "flex", gap: 10, marginTop: 28 }}>
            {album.deezer_url && (
              <button onClick={() => window.open(album.deezer_url, "_blank")} style={{
                flex: 1, background: "#161616", border: "1px solid #242424",
                borderRadius: 12, padding: 14, color: "#f0ece4",
                fontWeight: 600, fontSize: 14,
                display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
              }}>🎧 Écouter sur Deezer</button>
            )}
            <button onClick={onAdd} disabled={inCollection} style={{
              flex: 1, background: inCollection ? "#161616" : "#f5a623",
              border: "none", borderRadius: 12, padding: 14,
              color: inCollection ? "#444" : "#0d0d0d", fontWeight: 700, fontSize: 14,
            }}>
              {inCollection ? "✅ Dans ma collection" : "＋ Ajouter"}
            </button>
          </div>

          {!album.deezer_url && (
            <div style={{ textAlign: "center", color: "#555", fontSize: 12, marginTop: 10 }}>
              Album introuvable sur Deezer
            </div>
          )}

          {album.deezer_found_by_search && <DeezerSearchNote />}

          {album.deezer_url && album.wikidata_id && (
            <WikidataP2723Button qid={album.wikidata_id} deezerUrl={album.deezer_url} />
          )}
        </>}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// MODAL AJOUT
// ══════════════════════════════════════════════════════════════════════════════
function AddModal({ album, onAdd, onCancel }) {
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState("");

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.8)",
      zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center",
      padding: 20,
    }}>
      <div style={{
        background: "#161616", borderRadius: 12, padding: 20, maxWidth: 400, width: "100%",
        border: "1px solid #242424",
      }}>
        <h3 style={{ margin: 0, marginBottom: 16, fontSize: 18, fontWeight: 700, color: "#f0ece4" }}>
          Ajouter à ma collection
        </h3>
        <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8, color: "#f0ece4" }}>
          {album.title} - {album.artist}
        </div>
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 14, marginBottom: 8, color: "#f0ece4" }}>Note :</div>
          <Stars value={rating} onChange={setRating} />
        </div>
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 14, marginBottom: 8, color: "#f0ece4" }}>Impressions :</div>
          <textarea
            value={comment}
            onChange={e => setComment(e.target.value)}
            placeholder="Vos commentaires..."
            style={{
              width: "100%", background: "#0d0d0d", border: "1px solid #242424",
              borderRadius: 8, padding: 10, color: "#f0ece4", fontSize: 14,
              minHeight: 80, resize: "vertical", fontFamily: "inherit",
            }}
          />
        </div>
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button onClick={onCancel} style={{
            background: "#333", border: "none", borderRadius: 8, padding: "10px 16px",
            color: "#f0ece4", fontSize: 14, fontWeight: 600, cursor: "pointer",
          }}>Annuler</button>
          <button onClick={() => onAdd(rating, comment)} style={{
            background: "#f5a623", border: "none", borderRadius: 8, padding: "10px 16px",
            color: "#0d0d0d", fontSize: 14, fontWeight: 600, cursor: "pointer",
          }}>OK</button>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// ONGLET COLLECTION
// ══════════════════════════════════════════════════════════════════════════════
// État mémorisé dans le navigateur : conservé entre les onglets et après rechargement
function usePersistentState(key, initial) {
  const [value, setValue] = useState(() => {
    try {
      const saved = localStorage.getItem(key);
      return saved !== null ? JSON.parse(saved) : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* stockage indisponible */ }
  }, [key, value]);
  return [value, setValue];
}

// Minuscules et sans accents, pour une recherche tolérante
function fold(s) {
  return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function decadeOf(year) {
  const y = parseInt(year, 10);
  return Number.isFinite(y) ? Math.floor(y / 10) * 10 : null;
}

function decadeLabel(d) {
  return `${String(d).slice(2)}s`;
}

function toggleIn(list, item) {
  return list.includes(item) ? list.filter(x => x !== item) : [...list, item];
}

const SORTS = [
  { key: "date",   label: "Ajout récent", dir: "desc" },
  { key: "artist", label: "Artiste",      dir: "asc"  },
  { key: "title",  label: "Titre",        dir: "asc"  },
  { key: "year",   label: "Année",        dir: "desc" },
  { key: "rating", label: "Note",         dir: "desc" },
];

const TOP_GENRES = 10;
const RANDOM_COUNT = 10;

// Hachage déterministe (FNV-1a) : un même tirage reste stable entre deux affichages
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Tire RANDOM_COUNT albums, ou un album pour chacun de RANDOM_COUNT artistes
function pickRandom(albums, { mode, seed }) {
  const byHash = (key) => (a, b) => hash(seed + key(a)) - hash(seed + key(b));
  if (mode === "albums") {
    return [...albums].sort(byHash(a => a.id)).slice(0, RANDOM_COUNT);
  }
  const byArtist = new Map();
  albums.forEach(a => {
    const k = fold(a.artist);
    if (!byArtist.has(k)) byArtist.set(k, []);
    byArtist.get(k).push(a);
  });
  return [...byArtist.keys()]
    .sort(byHash(k => k))
    .slice(0, RANDOM_COUNT)
    .map(k => [...byArtist.get(k)].sort(byHash(a => a.id))[0]);
}

function Chip({ active, onClick, children, title }) {
  return (
    <button onClick={onClick} title={title} style={{
      background: active ? "#f5a623" : "#161616",
      border: `1px solid ${active ? "#f5a623" : "#262626"}`,
      borderRadius: 20, padding: "6px 12px",
      color: active ? "#0d0d0d" : "#aaa",
      fontSize: 12, fontWeight: 600, whiteSpace: "nowrap", flexShrink: 0,
    }}>{children}</button>
  );
}

function ChipCount({ n }) {
  return <span style={{ marginLeft: 5, opacity: .6, fontWeight: 400 }}>{n}</span>;
}

function GenrePicker({ genreCounts, selected, onToggle, onClose }) {
  const [q, setQ] = useState("");
  const shown = genreCounts.filter(([g]) => fold(g).includes(fold(q)));

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,.8)", zIndex: 300,
      display: "flex", alignItems: "flex-end", justifyContent: "center",
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: "#141414", width: "100%", maxWidth: 480, maxHeight: "80vh",
        borderRadius: "16px 16px 0 0", border: "1px solid #242424",
        display: "flex", flexDirection: "column",
      }}>
        <div style={{ padding: "16px 16px 10px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <div style={{ fontWeight: 700, fontSize: 16 }}>Genres</div>
            <button onClick={onClose} style={{
              background: "#f5a623", border: "none", borderRadius: 10,
              padding: "7px 16px", color: "#0d0d0d", fontWeight: 700, fontSize: 13,
            }}>Terminé</button>
          </div>
          <input
            autoFocus value={q} onChange={e => setQ(e.target.value)}
            placeholder={`Chercher parmi ${genreCounts.length} genres…`}
            style={{
              width: "100%", background: "#0d0d0d", border: "1px solid #2a2a2a",
              borderRadius: 10, padding: "10px 12px", color: "#f0ece4", fontSize: 14,
            }}
          />
        </div>
        <div style={{ overflowY: "auto", padding: "0 16px 16px" }}>
          {shown.map(([g, n]) => (
            <label key={g} style={{
              display: "flex", alignItems: "center", gap: 10,
              padding: "9px 0", borderBottom: "1px solid #1c1c1c", fontSize: 14, cursor: "pointer",
            }}>
              <input type="checkbox" checked={selected.includes(g)} onChange={() => onToggle(g)}
                style={{ accentColor: "#f5a623", width: 16, height: 16 }} />
              <span style={{ flex: 1 }}>{g}</span>
              <span style={{ color: "#555", fontSize: 12 }}>{n}</span>
            </label>
          ))}
          {shown.length === 0 && (
            <div style={{ color: "#555", fontSize: 13, padding: "16px 0", textAlign: "center" }}>Aucun genre.</div>
          )}
        </div>
      </div>
    </div>
  );
}

function CollectionTab({ collection, loading, onUpdate, onRemove }) {
  const [q,        setQ]        = usePersistentState("vt_q", "");
  const [genres,   setGenres]   = usePersistentState("vt_genres", []);
  const [decades,  setDecades]  = usePersistentState("vt_decades", []);
  const [unrated,  setUnrated]  = usePersistentState("vt_unrated", false);
  const [sort,     setSort]     = usePersistentState("vt_sort", { key: "date", dir: "desc" });
  const [selected, setSelected] = useState(null);
  const [picker,   setPicker]   = useState(false);
  const [random,   setRandom]   = useState(null); // { mode: "albums" | "artists", seed }
  const newSeed = () => String(Math.random());

  // Genres triés par nombre d'albums ; les genres sélectionnés restent toujours visibles
  const countMap = {};
  collection.forEach(a => (a.genres || []).forEach(g => { countMap[g] = (countMap[g] || 0) + 1; }));
  const genreCounts = Object.entries(countMap).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const topGenres = genreCounts.slice(0, TOP_GENRES).map(([g]) => g);
  const visibleGenres = [...genres.filter(g => !topGenres.includes(g)), ...topGenres];

  const decadeCounts = {};
  collection.forEach(a => { const d = decadeOf(a.year); if (d) decadeCounts[d] = (decadeCounts[d] || 0) + 1; });
  const allDecades = Object.keys(decadeCounts).map(Number).sort((a, b) => a - b);
  const unratedCount = collection.filter(a => !a.rating).length;

  const s = fold(q.trim());
  const filtered = collection.filter(a =>
    (!s || fold(a.title).includes(s) || fold(a.artist).includes(s))
    && (!genres.length  || (a.genres || []).some(g => genres.includes(g)))
    && (!decades.length || decades.includes(decadeOf(a.year)))
    && (!unrated || !a.rating)
  );

  // Tri ; les albums sans année / sans note vont toujours à la fin
  const order = new Map(collection.map((a, i) => [a.id, i]));
  const sign = sort.dir === "asc" ? 1 : -1;
  const byText = (x, y) => (x || "").localeCompare(y || "", "fr", { sensitivity: "base" });
  const sorted = [...filtered].sort((a, b) => {
    switch (sort.key) {
      case "artist": return sign * byText(a.artist, b.artist) || byText(a.title, b.title);
      case "title":  return sign * byText(a.title, b.title);
      case "year": {
        const ya = parseInt(a.year, 10), yb = parseInt(b.year, 10);
        if (!ya || !yb) return (!ya) - (!yb);
        return sign * (ya - yb) || byText(a.artist, b.artist);
      }
      case "rating":
        if (!a.rating || !b.rating) return (!a.rating) - (!b.rating);
        return sign * (a.rating - b.rating) || byText(a.artist, b.artist);
      default:
        // La collection arrive de la plus récente à la plus ancienne
        return -sign * (order.get(a.id) - order.get(b.id));
    }
  });

  // En mode aléatoire, le tirage se fait parmi les albums filtrés
  const shown = random ? pickRandom(filtered, random) : sorted;

  const activeFilters = [
    ...(s ? [`« ${q.trim()} »`] : []),
    ...(genres.length ? [genres.join(" ou ")] : []),
    ...(decades.length ? [[...decades].sort().map(decadeLabel).join(" ou ")] : []),
    ...(unrated ? ["non notés"] : []),
  ];
  const clearFilters = () => { setQ(""); setGenres([]); setDecades([]); setUnrated(false); };

  const changeSort = (key) => {
    const def = SORTS.find(x => x.key === key);
    setSort({ key, dir: def.dir });
  };
  const flipSort = () => setSort(prev => ({ ...prev, dir: prev.dir === "asc" ? "desc" : "asc" }));

  if (loading) return <Spinner />;

  const rowStyle = { display: "flex", gap: 6, marginBottom: 10 };

  return (
    <div style={{ padding: "16px 16px 0" }}>
      {/* Recherche texte */}
      <div style={{ position: "relative", marginBottom: 12 }}>
        <input
          value={q} onChange={e => setQ(e.target.value)}
          placeholder="Rechercher un titre ou un artiste…"
          style={{
            width: "100%", background: "#161616", border: "1px solid #242424",
            borderRadius: 12, padding: "12px 40px 12px 16px", color: "#f0ece4", fontSize: 15,
          }}
        />
        {q && (
          <button onClick={() => setQ("")} aria-label="Vider la recherche" style={{
            position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)",
            background: "#2a2a2a", border: "none", borderRadius: "50%",
            width: 24, height: 24, color: "#ccc", fontSize: 14, lineHeight: "24px", padding: 0,
          }}>×</button>
        )}
      </div>

      {/* Genres */}
      {genreCounts.length > 0 && (
        <div style={{ ...rowStyle, overflowX: "auto", paddingBottom: 2 }}>
          <Chip active={false} onClick={() => setPicker(true)} title="Voir tous les genres">
            ☰ Tous les genres{genres.length > 0 && ` (${genres.length})`}
          </Chip>
          {visibleGenres.map(g => (
            <Chip key={g} active={genres.includes(g)} onClick={() => setGenres(toggleIn(genres, g))}>
              {g}<ChipCount n={countMap[g] || 0} />
            </Chip>
          ))}
        </div>
      )}

      {/* Décennies + non noté */}
      <div style={{ ...rowStyle, flexWrap: "wrap" }}>
        {allDecades.map(d => (
          <Chip key={d} active={decades.includes(d)} onClick={() => setDecades(toggleIn(decades, d))}>
            {decadeLabel(d)}<ChipCount n={decadeCounts[d]} />
          </Chip>
        ))}
        <Chip active={unrated} onClick={() => setUnrated(!unrated)}>
          ☆ Non noté<ChipCount n={unratedCount} />
        </Chip>
      </div>

      {/* État + tri */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
        padding: "10px 0", marginBottom: 6, borderTop: "1px solid #191919", borderBottom: "1px solid #191919",
      }}>
        <div style={{ flex: 1, minWidth: 0, fontSize: 12, color: "#888", lineHeight: 1.5 }}>
          <span style={{ color: "#f0ece4", fontWeight: 600 }}>
            {random
              ? `🎲 ${shown.length} ${random.mode === "albums" ? "album" : "artiste"}${shown.length !== 1 ? "s" : ""} au hasard`
              : `${sorted.length} album${sorted.length !== 1 ? "s" : ""}`}
          </span>
          {random && <> parmi {filtered.length}</>}
          {activeFilters.length > 0 && <> · {activeFilters.join(" · ")}</>}
          {activeFilters.length > 0 && (
            <button onClick={clearFilters} style={{
              background: "none", border: "none", padding: 0, marginLeft: 8,
              color: "#f5a623", fontSize: 12, fontWeight: 600, textDecoration: "underline",
            }}>Effacer filtres</button>
          )}
        </div>
        {random ? (
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <div style={{ display: "flex", border: "1px solid #262626", borderRadius: 8, overflow: "hidden" }}>
              {[["albums", "Albums"], ["artists", "Artistes"]].map(([m, l]) => (
                <button key={m} onClick={() => setRandom({ mode: m, seed: newSeed() })} style={{
                  background: random.mode === m ? "#f5a623" : "#161616", border: "none",
                  padding: "6px 10px", color: random.mode === m ? "#0d0d0d" : "#aaa",
                  fontSize: 12, fontWeight: 600,
                }}>{l}</button>
              ))}
            </div>
            <button onClick={() => setRandom({ ...random, seed: newSeed() })} title="Nouveau tirage" style={{
              background: "#161616", border: "1px solid #262626", borderRadius: 8,
              height: 30, padding: "0 10px", color: "#f5a623", fontSize: 12, fontWeight: 600,
            }}>🎲 Relancer</button>
            <button onClick={() => setRandom(null)} aria-label="Quitter le mode aléatoire" title="Revenir à la liste" style={{
              background: "#161616", border: "1px solid #262626", borderRadius: 8,
              width: 30, height: 30, color: "#ccc", fontSize: 14, padding: 0,
            }}>×</button>
          </div>
        ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <button onClick={() => setRandom({ mode: "albums", seed: newSeed() })} title="Piocher 10 albums au hasard" style={{
            background: "#161616", border: "1px solid #262626", borderRadius: 8,
            height: 30, padding: "0 10px", color: "#f0ece4", fontSize: 12, fontWeight: 600,
          }}>🎲 Aléatoire</button>
          <select value={sort.key} onChange={e => changeSort(e.target.value)} aria-label="Trier par" style={{
            background: "#161616", border: "1px solid #262626", borderRadius: 8,
            padding: "6px 8px", color: "#f0ece4", fontSize: 12,
          }}>
            {SORTS.map(o => <option key={o.key} value={o.key}>Trier : {o.label}</option>)}
          </select>
          <button onClick={flipSort} title={sort.dir === "asc" ? "Ordre croissant" : "Ordre décroissant"}
            aria-label="Inverser l'ordre" style={{
              background: "#161616", border: "1px solid #262626", borderRadius: 8,
              width: 30, height: 30, color: "#f5a623", fontSize: 14, padding: 0,
            }}>{sort.dir === "asc" ? "↑" : "↓"}</button>
        </div>
        )}
      </div>

      {shown.length === 0 && (
        <div style={{ textAlign: "center", color: "#555", marginTop: 60, fontSize: 14, lineHeight: 2, whiteSpace: "pre-line" }}>
          {collection.length === 0
            ? "Ta collection est vide.\nCherche des albums pour commencer !"
            : "Aucun album ne correspond à ces filtres."}
        </div>
      )}

      {shown.map((album, i) => (
        <div key={random ? `${random.seed}-${album.id}` : album.id} className="card" style={{ animationDelay: cardDelay(i, 30) }}>
          <CollectionCard album={album} onOpen={() => setSelected(album)} />
        </div>
      ))}

      {picker && (
        <GenrePicker
          genreCounts={genreCounts}
          selected={genres}
          onToggle={g => setGenres(prev => toggleIn(prev, g))}
          onClose={() => setPicker(false)}
        />
      )}

      {selected && (
        <CollectionDetailModal
          album={selected}
          onClose={() => setSelected(null)}
          onUpdate={async patch => {
            const ok = await onUpdate(selected.id, patch);
            if (ok) setSelected(a => ({ ...a, ...patch }));
            return ok;
          }}
          onRemove={async () => {
            if (await onRemove(selected.id)) setSelected(null);
          }}
        />
      )}
    </div>
  );
}

function CollectionCard({ album, onOpen }) {
  return (
    <div onClick={onOpen} style={{
      display: "flex", gap: 12, alignItems: "center",
      padding: "10px 0", borderBottom: "1px solid #181818", cursor: "pointer",
    }}>
      <Cover src={album.cover} size={56} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: 14, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {album.title}
        </div>
        <div style={{ color: "#666", fontSize: 12, marginTop: 1 }}>
          {album.artist}{album.year ? ` · ${album.year}` : ""}
        </div>
        <Stars value={album.rating} />
      </div>
      <span style={{ color: "#2a2a2a", fontSize: 20 }}>›</span>
    </div>
  );
}

function CollectionDetailModal({ album, onClose, onUpdate, onRemove }) {
  const [comment,    setComment]    = useState(album.comment || "");
  const [confirmDel, setConfirmDel] = useState(false);
  const [fetchProgress, setFetchProgress] = useState(0);
  const [fetchError, setFetchError] = useState(null);
  const [fetching, setFetching] = useState(false);

  const knownDeezerUrl = album.deezer_url || (album.wikidata_deezer_id ? `https://www.deezer.com/album/${album.wikidata_deezer_id}` : null);
  const [searchedDeezerUrl, setSearchedDeezerUrl] = useState(null);
  const deezerUrl = knownDeezerUrl || searchedDeezerUrl;

  // Pas de lien connu : recherche sur Deezer (résultat mis en cache par le proxy)
  useEffect(() => {
    if (knownDeezerUrl || !album.artist || !album.title) return;
    const params = new URLSearchParams({ artist: album.artist, title: album.title });
    apiGet(`/deezer/search?${params}`)
      .then(d => setSearchedDeezerUrl(d.url))
      .catch(() => {});
  }, [knownDeezerUrl, album.artist, album.title]);
  const canFetchMissing = album.id && (!album.tracks?.length || (!album.units_sold && !album.work_language));

  const fetchMissingDetails = async () => {
    if (!canFetchMissing || fetching) return;
    try {
      setFetching(true);
      setFetchError(null);
      setFetchProgress(15);

      // refresh=1 : clic explicite sur la pochette, on ignore le cache du proxy
      const detail = await apiGet(`/album/${album.id}?refresh=1`);
      setFetchProgress(45);
      const cover = await apiGet(`/cover/${album.id}?refresh=1`);
      setFetchProgress(75);

      const patch = {
        title: detail.title,
        artist: detail.artist,
        year: detail.year,
        // Ne pas faire réapparaître les genres retirés à la main
        genres: album.genres?.length ? album.genres : detail.genres,
        nb_tracks: detail.nb_tracks,
        duration: detail.duration,
        tracks: detail.tracks,
        deezer_url: detail.deezer_url,
        wikidata_id: detail.wikidata_id,
        wikidata_deezer_id: detail.wikidata_deezer_id,
        work_language: detail.work_language,
        review_score: detail.review_score,
        units_sold: detail.units_sold,
        cover: cover.url,
        discogs_rating: detail.discogs_rating,
      };

      if (!await onUpdate(patch)) throw new Error("Enregistrement impossible");
      setFetchProgress(100);
      window.setTimeout(() => setFetchProgress(0), 500);
    } catch (e) {
      setFetchError("Impossible de récupérer les titres depuis MusicBrainz.");
      setFetchProgress(0);
    } finally {
      setFetching(false);
    }
  };

  return (
    <div style={{
      position: "fixed", inset: 0, background: "#0d0d0d",
      zIndex: 200, overflowY: "auto", maxWidth: 480, margin: "0 auto",
    }}>
      <div style={{ position: "relative", cursor: canFetchMissing ? "pointer" : "default" }} onClick={canFetchMissing ? fetchMissingDetails : undefined}>
        {album.cover
          ? <img src={album.cover} alt="" style={{ width: "100%", aspectRatio: "1", objectFit: "cover", display: "block" }} />
          : <div style={{ width: "100%", aspectRatio: "1", background: "#141414", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <span style={{ fontSize: 90, opacity: .15 }}>🎵</span>
            </div>
        }
        <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg,transparent 50%,#0d0d0d 100%)" }} />
        <button onClick={e => { e.stopPropagation(); onClose(); }} style={{
          position: "absolute", top: 16, left: 16, background: "rgba(0,0,0,.75)",
          border: "none", borderRadius: "50%", width: 38, height: 38, color: "#fff", fontSize: 20,
        }}>‹</button>
      </div>

      <div style={{ padding: "0 20px 48px", marginTop: -44, position: "relative" }}>
        <div style={{ fontFamily: "'Playfair Display',serif", fontSize: 22, fontWeight: 900 }}>{album.title}</div>
        <div style={{ color: "#f5a623", fontWeight: 600, marginTop: 3 }}>{album.artist}</div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
          {album.year && <Badge label={album.year} />}
          {(album.genres || []).map(g => (
            <Badge key={g} label={g} onRemove={() => onUpdate({ genres: album.genres.filter(x => x !== g) })} />
          ))}
          {album.nb_tracks > 0 && <Badge label={`${album.nb_tracks} titres`} />}
        </div>

        {canFetchMissing && (
          <div style={{ marginTop: 12, color: "#f0ece4", fontSize: 13, lineHeight: 1.5 }}>
            {!album.tracks?.length ? "Pas de titres enregistrés." : "Métadonnées incomplètes (langue, ventes…)."}
            <span style={{ display: "block", marginTop: 6, color: "#f5a623" }}>Cliquez sur la pochette pour récupérer depuis MusicBrainz.</span>
          </div>
        )}

        {fetching && (
          <div style={{ marginTop: 18 }}>
            <div style={{ fontSize: 13, color: "#f0ece4", marginBottom: 8 }}>Téléchargement des données&nbsp;: {fetchProgress}%</div>
            <div style={{ width: "100%", height: 8, background: "#111", borderRadius: 999 }}>
              <div style={{ width: `${fetchProgress}%`, height: "100%", background: "#f5a623", borderRadius: 999, transition: "width .2s ease" }} />
            </div>
          </div>
        )}

        {fetchError && (
          <ErrorBox msg={fetchError} />
        )}

        {album.tracks?.length > 0 && (
          <div style={{ marginTop: 20 }}>
            <SectionLabel>Titres</SectionLabel>
            {album.tracks.map((t, i) => (
              <div key={i} style={{
                display: "flex", gap: 8, padding: "6px 0",
                borderBottom: "1px solid #181818", fontSize: 12,
              }}>
                <span style={{ color: "#444", minWidth: 22 }}>{t.position || i + 1}.</span>
                <span style={{ flex: 1 }}>{t.title}</span>
                <span style={{ color: "#555" }}>{fmtDur(t.duration)}</span>
              </div>
            ))}
          </div>
        )}

        <div style={{ marginTop: 24 }}>
          <SectionLabel>Ma Note</SectionLabel>
          <Stars value={album.rating} onChange={r => onUpdate({ rating: r })} />
        </div>

        {album.discogs_rating && (
          <div style={{ marginTop: 16 }}>
            <SectionLabel>Note communautaire (Discogs)</SectionLabel>
            <div style={{ fontSize: 14, color: "#f0ece4" }}>
              {Number(album.discogs_rating).toFixed(1)} / 5 ⭐
            </div>
          </div>
        )}

        {album.units_sold && (
          <div style={{ marginTop: 16 }}>
            <SectionLabel>Exemplaires vendus</SectionLabel>
            <div style={{ fontSize: 14, color: "#f0ece4" }}>{fmtUnits(album.units_sold)}</div>
          </div>
        )}

        {album.work_language && (
          <div style={{ marginTop: 16 }}>
            <SectionLabel>Langue</SectionLabel>
            <div style={{ fontSize: 14, color: "#f0ece4" }}>{album.work_language}</div>
          </div>
        )}

        <div style={{ marginTop: 20 }}>
          <SectionLabel>Mon Commentaire</SectionLabel>
          <textarea
            value={comment}
            onChange={e => setComment(e.target.value)}
            onBlur={() => onUpdate({ comment })}
            placeholder="Tes impressions sur cet album…"
            rows={3}
            style={{
              width: "100%", background: "#161616", border: "1px solid #242424",
              borderRadius: 10, padding: "10px 14px", color: "#f0ece4",
              fontSize: 14, resize: "none",
            }}
          />
        </div>

        {deezerUrl && (
          <button onClick={() => window.open(deezerUrl, "_blank")} style={{
            width: "100%", marginTop: 16, background: "#161616",
            border: "1px solid #242424", borderRadius: 12, padding: 14,
            color: "#f0ece4", fontWeight: 600, fontSize: 14,
            display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
          }}>🎧 Écouter sur Deezer</button>
        )}

        {!knownDeezerUrl && searchedDeezerUrl && <DeezerSearchNote />}

        {deezerUrl && album.wikidata_id && (
          <WikidataP2723Button
            qid={album.wikidata_id}
            deezerUrl={deezerUrl}
            onSuccess={(id) => onUpdate({ wikidata_deezer_id: id })}
          />
        )}

        <div style={{ marginTop: 24, textAlign: "center" }}>
          {!confirmDel
            ? <button onClick={() => setConfirmDel(true)}
                style={{
                  background: "none", border: "1px solid #5a1a1a", borderRadius: 10,
                  padding: "8px 20px", color: "#d06060", fontSize: 13, fontWeight: 600,
                }}>
                Supprimer de la collection
              </button>
            : <>
              <div style={{ fontSize: 12, color: "#888", marginBottom: 12, lineHeight: 1.5 }}>
                L&apos;album et toutes ses données (note, commentaire, titres, pochette, liens) seront effacés définitivement.
              </div>
              <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
                <button onClick={onRemove}
                  style={{ background: "#7b1212", border: "none", borderRadius: 10, padding: "8px 20px", color: "#fff", fontWeight: 700 }}>
                  Confirmer
                </button>
                <button onClick={() => setConfirmDel(false)}
                  style={{ background: "#161616", border: "1px solid #242424", borderRadius: 10, padding: "8px 20px", color: "#f0ece4" }}>
                  Annuler
                </button>
              </div>
            </>
          }
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// ONGLET STATS
// ══════════════════════════════════════════════════════════════════════════════
function StatsTab({ collection }) {
  const genreCount = {};
  collection.forEach(a => (a.genres || []).forEach(g => { genreCount[g] = (genreCount[g] || 0) + 1; }));
  const genres = Object.entries(genreCount).sort((a, b) => b[1] - a[1]);

  const yearCount = {};
  collection.forEach(a => { if (a.year) yearCount[a.year] = (yearCount[a.year] || 0) + 1; });
  const years = Object.entries(yearCount).sort((a, b) => b[0] - a[0]);

  const rated     = collection.filter(a => a.rating > 0);
  const avgRating = rated.length
    ? (rated.reduce((s, a) => s + a.rating, 0) / rated.length).toFixed(1)
    : null;

  const topRated = [...collection].filter(a => a.rating === 5).slice(0, 5);
  const maxGenre = genres[0]?.[1] || 1;
  const maxYear  = Math.max(...years.map(([, c]) => c), 1);

  return (
    <div style={{ padding: "20px 16px 0" }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 28 }}>
        <KPICard icon="🎵" value={collection.length} label="Albums" />
        <KPICard icon="⭐" value={avgRating ?? "–"}   label="Note moy." />
        <KPICard icon="🎸" value={genres.length}      label="Genres" />
        <KPICard icon="📅" value={years.length}       label="Années" />
      </div>

      {genres.length > 0 && (
        <StatSection title="Par Genre">
          {genres.map(([g, c]) => <BarRow key={g} label={g} value={c} max={maxGenre} total={collection.length} />)}
        </StatSection>
      )}

      {years.length > 0 && (
        <StatSection title="Par Année">
          {years.map(([y, c]) => <BarRow key={y} label={y} value={c} max={maxYear} total={collection.length} />)}
        </StatSection>
      )}

      {topRated.length > 0 && (
        <StatSection title="Coups de cœur ★★★★★">
          {topRated.map(a => (
            <div key={a.id} style={{
              display: "flex", gap: 10, alignItems: "center",
              padding: "8px 0", borderBottom: "1px solid #181818",
            }}>
              <Cover src={a.cover} size={44} radius={6} />
              <div>
                <div style={{ fontWeight: 700, fontSize: 13 }}>{a.title}</div>
                <div style={{ color: "#555", fontSize: 12 }}>{a.artist}</div>
              </div>
            </div>
          ))}
        </StatSection>
      )}

      {collection.length === 0 && (
        <div style={{ textAlign: "center", color: "#2a2a2a", marginTop: 60, fontSize: 14 }}>
          Ajoute des albums pour voir tes stats !
        </div>
      )}
    </div>
  );
}

function KPICard({ icon, value, label }) {
  return (
    <div style={{
      background: "#111", border: "1px solid #1e1e1e",
      borderRadius: 14, padding: "18px 16px", textAlign: "center",
    }}>
      <div style={{ fontSize: 22 }}>{icon}</div>
      <div style={{ fontFamily: "'Playfair Display',serif", fontSize: 30, fontWeight: 900, lineHeight: 1.1 }}>{value}</div>
      <div style={{ color: "#444", fontSize: 10, textTransform: "uppercase", letterSpacing: 1.5, marginTop: 2 }}>{label}</div>
    </div>
  );
}

function StatSection({ title, children }) {
  return (
    <div style={{ marginBottom: 28 }}>
      <SectionLabel>{title}</SectionLabel>
      {children}
    </div>
  );
}

function BarRow({ label, value, max, total }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, fontSize: 13 }}>
        <span>{label}</span>
        <span style={{ color: "#444" }}>{value} ({Math.round(value / total * 100)}%)</span>
      </div>
      <div style={{ height: 5, background: "#191919", borderRadius: 3, overflow: "hidden" }}>
        <div style={{
          height: "100%", width: `${(value / max) * 100}%`,
          background: "linear-gradient(90deg,#f5a623,#b86a00)",
          borderRadius: 3, transition: "width .6s ease",
        }} />
      </div>
    </div>
  );
}
