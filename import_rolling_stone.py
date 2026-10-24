"""
import_rolling_stone.py — Importe la liste Rolling Stone 500 dans vinylothek.db

- Lit rolling_stone_500.csv
- Exclut la musique classique
- Recherche chaque album sur MusicBrainz pour obtenir le MBID
- Insère dans SQLite (sans les titres — chargés à la demande dans l'app)
- Respecte le rate-limit MusicBrainz (1 requête/seconde)

Usage :
    python import_rolling_stone.py
    python import_rolling_stone.py --limit 50      # importer seulement les 50 premiers
    python import_rolling_stone.py --start 51      # reprendre à partir du rang 51
"""

import sqlite3
import json
import os
import csv
import time
import argparse
import requests

# ── Config ────────────────────────────────────────────────────────────────────
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH    = os.path.join(SCRIPT_DIR, "vinylothek.db")
CSV_PATH   = os.path.join(SCRIPT_DIR, "rolling_stone_500.csv")

MB_BASE  = "https://musicbrainz.org/ws/2"
CAA_BASE = "https://coverartarchive.org"
HEADERS  = {
    "User-Agent": "Vinylothek/1.0 (application personnelle)",
    "Accept":     "application/json",
}

# Genres à exclure
EXCLUDED_GENRES = {"classical", "opera", "orchestral", "baroque", "romantic", "contemporary classical"}

# Délai entre requêtes MusicBrainz (politique : max 1 req/sec)
MB_DELAY = 1.1

# ── Arguments ─────────────────────────────────────────────────────────────────
parser = argparse.ArgumentParser()
parser.add_argument("--limit", type=int, default=500, help="Nombre d'albums à importer")
parser.add_argument("--start", type=int, default=1,   help="Rang de départ (1 = premier)")
args = parser.parse_args()

# ── Vérifications ─────────────────────────────────────────────────────────────
if not os.path.exists(DB_PATH):
    print(f"❌ Base introuvable : {DB_PATH}")
    print("   Lance proxy.py au moins une fois pour créer la base.")
    exit(1)

if not os.path.exists(CSV_PATH):
    print(f"❌ Fichier CSV introuvable : {CSV_PATH}")
    print("   Télécharge-le avec :")
    print('   wget "https://gist.githubusercontent.com/hasmanyguitars/232302a4ba29fd8f5f0d0352ef55d2b9/raw/rolling_stone_top_500_albums_2020.csv" -O rolling_stone_500.csv')
    exit(1)

# ── DB ────────────────────────────────────────────────────────────────────────
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def already_in_db(conn, mbid):
    return conn.execute("SELECT 1 FROM albums WHERE id = ?", (mbid,)).fetchone() is not None

def insert_album(conn, data):
    conn.execute("""
        INSERT OR IGNORE INTO albums
            (id, title, artist, year, cover, genres,
             nb_tracks, duration, tracks, deezer_url, rating, comment)
        VALUES (?, ?, ?, ?, ?, ?, 0, 0, '[]', NULL, 0, '')
    """, (
        data["id"],
        data["title"],
        data["artist"],
        data["year"],
        data.get("cover"),
        json.dumps(data.get("genres", [])),
    ))
    conn.commit()

# ── MusicBrainz ───────────────────────────────────────────────────────────────
def mb_search(artist, album):
    """Recherche le release-group MusicBrainz le plus pertinent."""
    query = f'"{album}" AND artist:"{artist}"'
    try:
        r = requests.get(f"{MB_BASE}/release-group", params={
            "fmt": "json", "query": query, "type": "album", "limit": 5,
        }, headers=HEADERS, timeout=10)
        r.raise_for_status()
        rgs = r.json().get("release-groups", [])
        return rgs[0] if rgs else None
    except Exception as e:
        print(f"     ⚠️  MusicBrainz erreur : {e}")
        return None

def mb_genres(mbid):
    """Récupère genres et tags d'un release-group."""
    try:
        r = requests.get(f"{MB_BASE}/release-group/{mbid}", params={
            "fmt": "json", "inc": "genres+tags",
        }, headers=HEADERS, timeout=10)
        r.raise_for_status()
        data   = r.json()
        genres = [g["name"] for g in data.get("genres", [])]
        if not genres:
            genres = [t["name"] for t in sorted(
                data.get("tags", []), key=lambda x: -x.get("count", 0)
            )[:5]]
        return genres
    except Exception:
        return []

def caa_cover(mbid):
    """Récupère la pochette depuis Cover Art Archive."""
    try:
        r = requests.get(f"{CAA_BASE}/release-group/{mbid}",
                         headers=HEADERS, timeout=8, allow_redirects=True)
        if r.status_code == 404:
            return None
        images = r.json().get("images", [])
        front  = next((i for i in images if i.get("front")), images[0] if images else None)
        return (front["thumbnails"].get("large") or front.get("image")) if front else None
    except Exception:
        return None

def is_classical(genres):
    return any(g.lower() in EXCLUDED_GENRES for g in genres)

# ── Lecture CSV ───────────────────────────────────────────────────────────────
print(f"\n📂 Lecture de {CSV_PATH}…")
albums_csv = []
with open(CSV_PATH, newline="", encoding="utf-8") as f:
    reader = csv.DictReader(f)
    for row in reader:
        albums_csv.append(row)

print(f"   {len(albums_csv)} albums dans la liste Rolling Stone 500\n")

# Sélection selon --start et --limit
start_idx = args.start - 1
end_idx   = min(start_idx + args.limit, len(albums_csv))
selection = albums_csv[start_idx:end_idx]

print(f"▶  Import des albums #{args.start} à #{start_idx + len(selection)}")
print(f"   (Rate limit MusicBrainz : {MB_DELAY}s entre chaque requête)\n")
print("─" * 60)

# ── Import ────────────────────────────────────────────────────────────────────
conn = get_db()
inserted  = 0
skipped   = 0
classical = 0
not_found = 0

for i, row in enumerate(selection, start=args.start):
    # Détecte les colonnes (le CSV peut varier)
    artist = row.get("Artist") or row.get("artist") or row.get("Band") or ""
    title  = row.get("Album")  or row.get("album")  or row.get("Title") or ""
    year   = str(row.get("Year") or row.get("year") or "")[:4]

    artist = artist.strip()
    title  = title.strip()

    print(f"[{i:3}] {artist} — {title} ({year})")

    # 1. Recherche MusicBrainz
    time.sleep(MB_DELAY)
    rg = mb_search(artist, title)

    if not rg:
        print(f"      ❌ Introuvable sur MusicBrainz")
        not_found += 1
        continue

    mbid = rg["id"]

    # 2. Déjà dans la base ?
    if already_in_db(conn, mbid):
        print(f"      ⏭  Déjà présent (MBID: {mbid[:8]}…)")
        skipped += 1
        continue

    # 3. Genres
    time.sleep(MB_DELAY)
    genres = mb_genres(mbid)

    # 4. Exclure musique classique
    if is_classical(genres):
        print(f"      🎻 Exclu (classique) : {genres}")
        classical += 1
        continue

    # 5. Pochette
    time.sleep(MB_DELAY)
    cover = caa_cover(mbid)

    # 6. Insertion (sans titres — chargés à la demande dans l'app)
    insert_album(conn, {
        "id":     mbid,
        "title":  rg.get("title", title),
        "artist": artist,
        "year":   year,
        "cover":  cover,
        "genres": genres,
    })

    cover_ok = "🖼" if cover else "○"
    print(f"      ✅ {cover_ok}  MBID:{mbid[:8]}…  genres:{', '.join(genres[:3]) or '?'}")
    inserted += 1

conn.close()

# ── Résumé ────────────────────────────────────────────────────────────────────
print("\n" + "─" * 60)
print(f"✅ Importés    : {inserted}")
print(f"⏭  Déjà présents : {skipped}")
print(f"🎻 Exclus (classique) : {classical}")
print(f"❌ Introuvables : {not_found}")
print(f"\n🎵 Base mise à jour : {DB_PATH}")

if inserted > 0:
    print("\n💡 Relance l'app et actualise (Ctrl+Shift+R) pour voir les nouveaux albums.")
    print("   Les titres des chansons seront chargés à la demande quand tu ouvres un album.")
