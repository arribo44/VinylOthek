"""
fill_years.py — Complète l'année de sortie des albums qui n'en ont pas
- Utilise d'abord le cache du proxy (table api_cache), sans appel réseau
- Sinon interroge MusicBrainz (first-release-date du release-group)
- Respecte le rate-limit MusicBrainz (1 requête/seconde)

Usage :
    python fill_years.py
    python fill_years.py --dry-run     # affiche sans modifier la base
"""

import os
import json
import time
import sqlite3
import argparse
import requests

# ── Config ────────────────────────────────────────────────────────────────────
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH    = os.path.join(SCRIPT_DIR, "vinylothek.db")

MB_BASE = "https://musicbrainz.org/ws/2"
HEADERS = {
    "User-Agent": "Vinylothek/1.0 (application personnelle)",
    "Accept":     "application/json",
}

# Délai entre requêtes MusicBrainz (politique : max 1 req/sec)
MB_DELAY = 1.1

# ── Arguments ─────────────────────────────────────────────────────────────────
parser = argparse.ArgumentParser()
parser.add_argument("--dry-run", action="store_true", help="Ne rien écrire dans la base")
args = parser.parse_args()

if not os.path.exists(DB_PATH):
    print(f"❌ Base introuvable : {DB_PATH}")
    exit(1)

# ── DB ────────────────────────────────────────────────────────────────────────
conn = sqlite3.connect(DB_PATH)
conn.row_factory = sqlite3.Row

albums = conn.execute(
    "SELECT id, artist, title FROM albums WHERE year IS NULL OR year = ''"
).fetchall()
print(f"{len(albums)} albums sans année\n")

def year_from_cache(mbid):
    try:
        row = conn.execute("SELECT data FROM api_cache WHERE key = ?", (f"album:{mbid}",)).fetchone()
    except sqlite3.OperationalError:
        return None  # table api_cache pas encore créée
    return (json.loads(row["data"]).get("year") or None) if row else None

def year_from_musicbrainz(mbid):
    r = requests.get(f"{MB_BASE}/release-group/{mbid}", params={"fmt": "json"}, headers=HEADERS, timeout=10)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return (r.json().get("first-release-date") or "")[:4] or None

# ── Boucle ────────────────────────────────────────────────────────────────────
found, missing, errors = 0, [], []
for i, a in enumerate(albums, 1):
    label = f"[{i}/{len(albums)}] {a['artist']} — {a['title']}"
    year = year_from_cache(a["id"])
    if not year:
        try:
            year = year_from_musicbrainz(a["id"])
        except Exception as e:
            print(f"{label} : ⚠️  {e}")
            errors.append(a)
            time.sleep(MB_DELAY)
            continue
        time.sleep(MB_DELAY)

    if year:
        found += 1
        print(f"{label} : {year}")
        if not args.dry_run:
            conn.execute("UPDATE albums SET year = ? WHERE id = ?", (year, a["id"]))
            conn.commit()
    else:
        missing.append(a)
        print(f"{label} : ✘ aucune date sur MusicBrainz")

conn.close()
print(f"\n✅ {found} années ajoutées · {len(missing)} sans date · {len(errors)} erreurs"
      + (" (dry-run, rien n'a été écrit)" if args.dry_run else ""))
if errors:
    print("   Relance le script pour réessayer les albums en erreur.")
