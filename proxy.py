"""
proxy.py — Proxy MusicBrainz + Cover Art Archive + Collection SQLite
Lancer avec : python proxy.py
Écoute sur   : http://localhost:5000

Base de données : vinylothek.db (créée automatiquement dans le même dossier)
"""

import sqlite3
import json
import os
import re
import time
import threading
from flask import Flask, request, jsonify
import requests

app = Flask(__name__)

# ── Chargement du fichier .env (secrets hors du code) ────────────────────────
ENV_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
if os.path.exists(ENV_PATH):
    with open(ENV_PATH, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                os.environ.setdefault(key.strip(), value.strip().strip('"\''))

# Seul le front Vite a le droit d'appeler le proxy
ALLOWED_ORIGINS = {"http://localhost:5173", "http://127.0.0.1:5173"}

QID_RE = re.compile(r"^Q\d+$")

MB_BASE  = "https://musicbrainz.org/ws/2"
CAA_BASE = "https://coverartarchive.org"
DISCOGS_BASE = "https://api.discogs.com"

HEADERS = {
    "User-Agent": "Vinylothek/1.0 (application personnelle)",
    "Accept":     "application/json",
}

# Clé API Discogs : à définir dans .env (DISCOGS_TOKEN=...), voir https://www.discogs.com/developers/
DISCOGS_TOKEN = os.environ.get("DISCOGS_TOKEN", "")

# ── Base SQLite ───────────────────────────────────────────────────────────────
DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vinylothek.db")

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    with get_db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS albums (
                id                TEXT PRIMARY KEY,
                title             TEXT NOT NULL,
                artist            TEXT,
                year              TEXT,
                cover             TEXT,
                genres            TEXT DEFAULT '[]',
                nb_tracks         INTEGER DEFAULT 0,
                duration          INTEGER DEFAULT 0,
                tracks            TEXT DEFAULT '[]',
                deezer_url        TEXT,
                wikidata_id       TEXT,
                wikidata_deezer_id TEXT,
                work_language     TEXT,
                review_score      REAL,
                units_sold        REAL,
                rating            INTEGER DEFAULT 0,
                comment           TEXT DEFAULT '',
                discogs_rating    REAL,
                added_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        for column in [
            "deezer_url TEXT",
            "wikidata_id TEXT",
            "wikidata_deezer_id TEXT",
            "work_language TEXT",
            "review_score REAL",
            "units_sold REAL",
            "discogs_rating REAL",
        ]:
            try:
                name = column.split()[0]
                conn.execute(f"ALTER TABLE albums ADD COLUMN {column}")
            except Exception:
                pass
        conn.execute("""
            CREATE TABLE IF NOT EXISTS api_cache (
                key        TEXT PRIMARY KEY,
                data       TEXT NOT NULL,
                fetched_at REAL NOT NULL
            )
        """)
        conn.commit()
    print(f"[DB] Base SQLite : {DB_PATH}")

# ── Cache des appels API ──────────────────────────────────────────────────────
# Les réponses vides (pas de pochette, pas de note…) sont aussi gardées pour ne
# pas redemander ce qui n'existe pas. Les erreurs réseau, elles, ne sont jamais
# mises en cache. ?refresh=1 force un nouvel appel.
DAY        = 86400
CACHE_MISS = object()

def cache_get(key, max_age=None):
    with get_db() as conn:
        row = conn.execute("SELECT data, fetched_at FROM api_cache WHERE key = ?", (key,)).fetchone()
    if not row or (max_age and time.time() - row["fetched_at"] > max_age):
        return CACHE_MISS
    return json.loads(row["data"])

def cache_set(key, value):
    with get_db() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO api_cache (key, data, fetched_at) VALUES (?, ?, ?)",
            (key, json.dumps(value), time.time()),
        )
        conn.commit()

def wants_refresh():
    return request.args.get("refresh") == "1"

def row_to_dict(row):
    d = dict(row)
    d["genres"] = json.loads(d.get("genres") or "[]")
    d["tracks"] = json.loads(d.get("tracks") or "[]")
    return d

# ── CORS sur toutes les réponses ──────────────────────────────────────────────
@app.before_request
def check_origin():
    # Bloque les requêtes d'écriture venant d'un autre site ouvert dans le navigateur
    origin = request.headers.get("Origin")
    if request.method in ("POST", "PATCH", "DELETE") and origin and origin not in ALLOWED_ORIGINS:
        return jsonify({"error": "Origine non autorisée"}), 403

@app.after_request
def add_cors(response):
    origin = request.headers.get("Origin")
    if origin in ALLOWED_ORIGINS:
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Vary"] = "Origin"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, PATCH, DELETE, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return response

@app.route("/collection/<mbid>", methods=["OPTIONS"])
@app.route("/collection",        methods=["OPTIONS"])
def preflight(**kwargs):
    return jsonify({}), 204

# ── Helper MusicBrainz ───────────────────────────────────────────────────────
# MusicBrainz limite à 1 requête/seconde : on espace les appels
_mb_lock = threading.Lock()
_mb_last_call = 0.0

def mb_get(path, params=None):
    global _mb_last_call
    p = {"fmt": "json"}
    if params:
        p.update(params)
    with _mb_lock:
        wait = 1.0 - (time.monotonic() - _mb_last_call)
        if wait > 0:
            time.sleep(wait)
        _mb_last_call = time.monotonic()
    r = requests.get(f"{MB_BASE}{path}", params=p, headers=HEADERS, timeout=10)
    r.raise_for_status()
    return r.json()

WIKIDATA_SPARQL = "https://query.wikidata.org/sparql"

# ── Helper Discogs ────────────────────────────────────────────────────────
def discogs_get_rating(artist, title):
    """Récupère la note moyenne depuis Discogs (lève une exception en cas d'erreur)."""
    # Recherche de la release
    search_url = f"{DISCOGS_BASE}/database/search"
    params = {
        "artist": artist,
        "title": title,
        "type": "release",
        "format": "vinyl",
        "token": DISCOGS_TOKEN,
    }
    r = requests.get(search_url, params=params, headers=HEADERS, timeout=10)
    r.raise_for_status()
    results = r.json().get("results", [])
    if not results:
        return None

    # Récupérer les détails du premier résultat
    detail_url = f"{DISCOGS_BASE}/releases/{results[0]['id']}"
    r2 = requests.get(detail_url, params={"token": DISCOGS_TOKEN}, headers=HEADERS, timeout=10)
    r2.raise_for_status()

    rating = r2.json().get("community", {}).get("rating", {}).get("average")
    return float(rating) if rating else None


def discogs_rating_cached(artist, title, refresh=False):
    """Note Discogs, mise en cache 30 jours (elle évolue avec les votes)."""
    if not DISCOGS_TOKEN or not artist or not title:
        return None
    key = f"discogs:{artist}|{title}".lower()
    if not refresh:
        hit = cache_get(key, 30 * DAY)
        if hit is not CACHE_MISS:
            return hit
    try:
        rating = discogs_get_rating(artist, title)
    except Exception as e:
        print(f"[Discogs] Erreur pour {artist} - {title}: {e}")
        return None
    cache_set(key, rating)
    return rating


def wikidata_get_album_info(qid):
    if not qid or not QID_RE.match(qid):
        return {}
    query = f"""
    SELECT ?deezerId ?languageLabel ?reviewScore ?unitSold WHERE {{
      OPTIONAL {{ wd:{qid} wdt:P2723 ?deezerId. }}
      OPTIONAL {{ wd:{qid} wdt:P407 ?language. }}
      OPTIONAL {{ wd:{qid} wdt:P444 ?reviewScore. }}
      OPTIONAL {{ wd:{qid} wdt:P2664 ?unitSold. }}
      SERVICE wikibase:label {{ bd:serviceParam wikibase:language \"en\". }}
    }}
    """
    try:
        r = requests.get(
            WIKIDATA_SPARQL,
            params={"query": query},
            headers={**HEADERS, "Accept": "application/sparql-results+json"},
            timeout=10,
        )
        r.raise_for_status()
        results = r.json().get("results", {}).get("bindings", [])
        if not results:
            return {}
        # None = erreur (à ne pas mettre en cache), {} = rien trouvé
        row = results[0]
        info = {
            "wikidata_deezer_id": row.get("deezerId", {}).get("value"),
            "work_language": row.get("languageLabel", {}).get("value"),
            "review_score": float(row.get("reviewScore", {}).get("value")) if row.get("reviewScore", {}) else None,
            "units_sold": float(row.get("unitSold", {}).get("value")) if row.get("unitSold", {}) else None,
        }
        return info
    except Exception as e:
        print(f"[Wikidata] Erreur pour {qid}: {e}")
        return None

# ══════════════════════════════════════════════════════════════════════════════
# MUSICBRAINZ — Recherche
# ══════════════════════════════════════════════════════════════════════════════
@app.route("/search")
def search():
    q = request.args.get("q", "").strip()
    if not q:
        return jsonify({"error": "Paramètre q manquant"}), 400

    key = f"search:{q.lower()}"
    if not wants_refresh():
        hit = cache_get(key, 30 * DAY)
        if hit is not CACHE_MISS:
            return jsonify({"results": hit})

    try:
        data = mb_get("/release-group", {"query": q, "type": "album", "limit": 20})
    except Exception as e:
        return jsonify({"error": str(e)}), 502

    results = []
    for rg in data.get("release-groups", []):
        artist = rg.get("artist-credit", [{}])[0].get("artist", {}).get("name", "")
        results.append({
            "id":     rg.get("id"),
            "title":  rg.get("title"),
            "artist": artist,
            "year":   (rg.get("first-release-date") or "")[:4],
        })
    cache_set(key, results)
    return jsonify({"results": results})


# ══════════════════════════════════════════════════════════════════════════════
# MUSICBRAINZ — Détail album
# ══════════════════════════════════════════════════════════════════════════════
@app.route("/album/<mbid>")
def album_detail(mbid):
    # Titres et métadonnées : mis en cache sans limite (ils ne changent pas)
    refresh = wants_refresh()
    key = f"album:{mbid}"
    album = CACHE_MISS if refresh else cache_get(key)
    if album is CACHE_MISS:
        try:
            album, complete = fetch_album_detail(mbid)
        except Exception as e:
            return jsonify({"error": str(e)}), 502
        if complete:
            cache_set(key, album)
    album["discogs_rating"] = discogs_rating_cached(album["artist"], album["title"], refresh)
    return jsonify(album)


def fetch_album_detail(mbid):
    """Interroge MusicBrainz + Wikidata. Renvoie (album, complet) ; une
    réponse incomplète (erreur sur une release ou sur Wikidata) n'est pas cachée."""
    complete = True
    rg = mb_get(f"/release-group/{mbid}", {
        "inc": "artist-credits+genres+tags+releases+url-rels",
    })
    artist = rg.get("artist-credit", [{}])[0].get("artist", {}).get("name", "")
    year   = (rg.get("first-release-date") or "")[:4]

    genres = [g["name"] for g in rg.get("genres", [])]
    if not genres:
        genres = [t["name"] for t in sorted(
            rg.get("tags", []), key=lambda x: -x.get("count", 0)
        )[:5]]

    releases   = rg.get("releases", [])
    tracks = []
    duration = 0
    deezer_url = None
    wikidata_id = None

    for rel_url in rg.get("relations", []):
        url_str = rel_url.get("url", {}).get("resource", "")
        if not wikidata_id and "wikidata.org" in url_str.lower():
            qid = url_str.rstrip("/").split("/")[-1]
            if qid.startswith("Q"):
                wikidata_id = qid
        if not deezer_url and "deezer.com" in url_str.lower():
            deezer_url = url_str

    for release in releases[:3]:  # Limiter à 3 releases max
        try:
            rel = mb_get(f"/release/{release.get('id')}", {"inc": "recordings+url-rels"})
            if not tracks:
                for medium in rel.get("media", []):
                    for track in medium.get("tracks", []):
                        rec    = track.get("recording", {})
                        dur_ms = rec.get("length") or track.get("length") or 0
                        dur_s  = dur_ms // 1000
                        duration += dur_s
                        tracks.append({
                            "position": track.get("position", len(tracks) + 1),
                            "title":    track.get("title") or rec.get("title", ""),
                            "duration": dur_s,
                        })
            for rel_url in rel.get("relations", []):
                url_str = rel_url.get("url", {}).get("resource", "")
                if not wikidata_id and "wikidata.org" in url_str.lower():
                    qid = url_str.rstrip("/").split("/")[-1]
                    if qid.startswith("Q"):
                        wikidata_id = qid
                if not deezer_url and "deezer.com" in url_str.lower():
                    deezer_url = url_str
            if tracks and deezer_url and wikidata_id:
                break
        except Exception as e:
            print(f"[MB] Erreur sur release {release.get('id')}: {e}")
            complete = False
            continue

    wikidata_info = wikidata_get_album_info(wikidata_id) if wikidata_id else {}
    if wikidata_info is None:
        complete = False
        wikidata_info = {}
    deezer_url = deezer_url or (f"https://www.deezer.com/album/{wikidata_info.get('wikidata_deezer_id')}" if wikidata_info.get('wikidata_deezer_id') else None)

    return {
        "id": mbid, "title": rg.get("title"),
        "artist": artist, "year": year, "genres": genres,
        "nb_tracks": len(tracks), "duration": duration,
        "deezer_url": deezer_url, "tracks": tracks,
        "wikidata_id": wikidata_id,
        "wikidata_deezer_id": wikidata_info.get("wikidata_deezer_id"),
        "work_language": wikidata_info.get("work_language"),
        "review_score": wikidata_info.get("review_score"),
        "units_sold": wikidata_info.get("units_sold"),
    }, complete


# ══════════════════════════════════════════════════════════════════════════════
# COVER ART ARCHIVE — Pochette
# ══════════════════════════════════════════════════════════════════════════════
@app.route("/cover/<mbid>")
def cover(mbid):
    # 30 jours : une pochette absente peut être ajoutée plus tard sur CAA
    key = f"cover:{mbid}"
    if not wants_refresh():
        hit = cache_get(key, 30 * DAY)
        if hit is not CACHE_MISS:
            return jsonify({"url": hit})
    try:
        r = requests.get(
            f"{CAA_BASE}/release-group/{mbid}",
            headers=HEADERS, timeout=8, allow_redirects=True
        )
        if r.status_code == 404:
            url = None
        else:
            r.raise_for_status()
            images = r.json().get("images", [])
            front  = next((i for i in images if i.get("front")), images[0] if images else None)
            url    = (front["thumbnails"].get("large") or front.get("image")) if front else None
        cache_set(key, url)
        return jsonify({"url": url})
    except Exception:
        return jsonify({"url": None})


# ══════════════════════════════════════════════════════════════════════════════
# COLLECTION SQLite — CRUD
# ══════════════════════════════════════════════════════════════════════════════

@app.route("/collection", methods=["GET"])
def get_collection():
    """Récupère toute la collection."""
    with get_db() as conn:
        rows = conn.execute("SELECT * FROM albums ORDER BY added_at DESC").fetchall()
    return jsonify({"albums": [row_to_dict(r) for r in rows]})


@app.route("/collection", methods=["POST"])
def add_album():
    """Ajoute un album (INSERT OR IGNORE si déjà présent)."""
    data = request.get_json()
    if not data or not data.get("id"):
        return jsonify({"error": "Données manquantes"}), 400
    try:
        with get_db() as conn:
            conn.execute("""
                INSERT OR IGNORE INTO albums
                    (id, title, artist, year, cover, genres,
                     nb_tracks, duration, tracks, deezer_url,
                     wikidata_id, wikidata_deezer_id, work_language,
                     review_score, units_sold, rating, comment, discogs_rating)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                data["id"],
                data.get("title", ""),
                data.get("artist", ""),
                data.get("year", ""),
                data.get("cover"),
                json.dumps(data.get("genres", [])),
                data.get("nb_tracks", 0),
                data.get("duration", 0),
                json.dumps(data.get("tracks", [])),
                data.get("deezer_url"),
                data.get("wikidata_id"),
                data.get("wikidata_deezer_id"),
                data.get("work_language"),
                data.get("review_score"),
                data.get("units_sold"),
                data.get("rating", 0),
                data.get("comment", ""),
                data.get("discogs_rating"),
            ))
            conn.commit()
        return jsonify({"ok": True}), 201
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/collection/<mbid>", methods=["PATCH"])
def update_album(mbid):
    """Met à jour la note et/ou le commentaire."""
    data = request.get_json()
    if not data:
        return jsonify({"error": "Données manquantes"}), 400
    try:
        fields, values = [], []
        for key in ["title", "artist", "year", "cover", "genres", "nb_tracks", "duration", "tracks", "deezer_url", "wikidata_id", "wikidata_deezer_id", "work_language", "review_score", "units_sold", "rating", "comment", "discogs_rating"]:
            if key in data:
                if key == "genres" or key == "tracks":
                    fields.append(f"{key} = ?")
                    values.append(json.dumps(data[key] or []))
                elif key == "rating":
                    fields.append("rating = ?")
                    values.append(int(data[key]))
                elif key == "discogs_rating" or key == "review_score" or key == "units_sold":
                    fields.append(f"{key} = ?")
                    values.append(data[key])
                else:
                    fields.append(f"{key} = ?")
                    values.append(data[key])
        if not fields:
            return jsonify({"error": "Rien à mettre à jour"}), 400
        values.append(mbid)
        with get_db() as conn:
            conn.execute(f"UPDATE albums SET {', '.join(fields)} WHERE id = ?", values)
            conn.commit()
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/collection/<mbid>", methods=["DELETE"])
def delete_album(mbid):
    """Supprime un album de la collection."""
    try:
        with get_db() as conn:
            conn.execute("DELETE FROM albums WHERE id = ?", (mbid,))
            conn.commit()
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── Lancement ─────────────────────────────────────────────────────────────────
WIKIDATA_API = "https://www.wikidata.org/w/api.php"

@app.route("/wikidata/check-p2723/<qid>")
def check_wikidata_p2723(qid):
    if not QID_RE.match(qid):
        return jsonify({"error": "QID invalide"}), 400
    query = f"SELECT ?v WHERE {{ OPTIONAL {{ wd:{qid} wdt:P2723 ?v. }} }}"
    try:
        r = requests.get(WIKIDATA_SPARQL, params={"query": query},
                         headers={**HEADERS, "Accept": "application/sparql-results+json"}, timeout=8)
        bindings = r.json().get("results", {}).get("bindings", [])
        value = bindings[0].get("v", {}).get("value") if bindings else None
        return jsonify({"exists": bool(value), "value": value})
    except Exception as e:
        return jsonify({"error": str(e)}), 502

@app.route("/wikidata/add-p2723", methods=["POST", "OPTIONS"])
def add_wikidata_p2723():
    if request.method == "OPTIONS":
        return jsonify({}), 204
    data = request.get_json()
    qid       = data.get("qid", "").strip()
    deezer_id = str(data.get("deezer_id", "")).strip()
    username  = data.get("username", "").strip()
    password  = data.get("password", "")
    if not all([qid, deezer_id, username, password]):
        return jsonify({"error": "Données manquantes"}), 400
    try:
        session = requests.Session()
        r = session.get(WIKIDATA_API, params={
            "action": "query", "meta": "tokens", "type": "login", "format": "json"
        }, headers=HEADERS, timeout=10)
        login_token = r.json()["query"]["tokens"]["logintoken"]
        r = session.post(WIKIDATA_API, data={
            "action": "login", "lgname": username, "lgpassword": password,
            "lgtoken": login_token, "format": "json"
        }, headers=HEADERS, timeout=10)
        login_res = r.json().get("login", {})
        if login_res.get("result") != "Success":
            reason = login_res.get("reason") or login_res.get("result", "Échec")
            return jsonify({"error": f"Connexion Wikidata échouée : {reason}"}), 401
        r = session.get(WIKIDATA_API, params={
            "action": "query", "meta": "tokens", "format": "json"
        }, headers=HEADERS, timeout=10)
        csrf_token = r.json()["query"]["tokens"]["csrftoken"]
        r = session.post(WIKIDATA_API, data={
            "action": "wbcreateclaim",
            "entity": qid,
            "property": "P2723",
            "snaktype": "value",
            "value": json.dumps(deezer_id),
            "token": csrf_token,
            "format": "json",
            "summary": "Added Deezer album ID via Vinylothek",
        }, headers=HEADERS, timeout=15)
        result = r.json()
        if "error" in result:
            return jsonify({"error": result["error"].get("info", "Erreur Wikidata")}), 500
        return jsonify({"ok": True})
    except requests.exceptions.RequestException as e:
        return jsonify({"error": f"Erreur réseau : {str(e)}"}), 502
    except Exception as e:
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    init_db()
    print("🎵  Proxy Vinylothek démarré sur http://localhost:5000")
    print("    MusicBrainz · Cover Art Archive · SQLite")
    print("    Garde ce terminal ouvert.\n")
    app.run(port=5000, debug=False)
