"""
fill_tracks.py — Récupère les titres (et métadonnées manquantes) des albums qui n'en ont pas
- Passe par le proxy (proxy.py doit tourner) : cache, rate-limit MusicBrainz,
  Wikidata, Discogs et Deezer sont gérés par lui
- Ne remplace jamais titre, artiste, note, commentaire ni genres déjà présents
- Peut être relancé : il ne traite que les albums encore sans titres

Usage :
    python fill_tracks.py
"""

import os
import json
import time
import sqlite3
import requests

# ── Config ────────────────────────────────────────────────────────────────────
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH    = os.path.join(SCRIPT_DIR, "vinylothek.db")
PROXY      = "http://localhost:5000"
RETRIES    = 3

def proxy_get(path):
    for attempt in range(RETRIES):
        r = requests.get(PROXY + path, timeout=120)
        if r.status_code != 502:
            break
        time.sleep(10 * (attempt + 1))  # MusicBrainz surchargé : on patiente
    r.raise_for_status()
    return r.json()

try:
    requests.get(PROXY + "/collection", timeout=5)
except requests.exceptions.RequestException:
    print("❌ Proxy injoignable : lance d'abord python proxy.py")
    exit(1)

conn = sqlite3.connect(DB_PATH)
conn.row_factory = sqlite3.Row
albums = conn.execute(
    "SELECT * FROM albums WHERE tracks IS NULL OR tracks = '[]' ORDER BY added_at"
).fetchall()
print(f"{len(albums)} albums sans titres\n")

ok, empty, errors = 0, [], []
for i, a in enumerate(albums, 1):
    label = f"[{i}/{len(albums)}] {a['artist']} — {a['title']}"
    try:
        d = proxy_get(f"/album/{a['id']}")
        cover = a["cover"] or proxy_get(f"/cover/{a['id']}").get("url")
    except Exception as e:
        print(f"{label} : ⚠️  {e}")
        errors.append(label)
        continue

    patch = {
        "tracks":             json.dumps(d.get("tracks") or []),
        "nb_tracks":          d.get("nb_tracks", 0),
        "duration":           d.get("duration", 0),
        "cover":              cover,
        "year":               a["year"] or d.get("year"),
        "genres":             a["genres"] if json.loads(a["genres"] or "[]") else json.dumps(d.get("genres") or []),
        "deezer_url":         a["deezer_url"] or d.get("deezer_url"),
        "wikidata_id":        a["wikidata_id"] or d.get("wikidata_id"),
        "wikidata_deezer_id": a["wikidata_deezer_id"] or d.get("wikidata_deezer_id"),
        "work_language":      a["work_language"] or d.get("work_language"),
        "review_score":       a["review_score"] if a["review_score"] is not None else d.get("review_score"),
        "units_sold":         a["units_sold"] if a["units_sold"] is not None else d.get("units_sold"),
        "discogs_rating":     d.get("discogs_rating") if d.get("discogs_rating") is not None else a["discogs_rating"],
    }
    conn.execute(f"UPDATE albums SET {', '.join(k + ' = ?' for k in patch)} WHERE id = ?",
                 list(patch.values()) + [a["id"]])
    conn.commit()

    if d.get("nb_tracks"):
        ok += 1
        print(f"{label} : ✔ {d['nb_tracks']} titres")
    else:
        empty.append(label)
        print(f"{label} : ✘ aucun titre sur MusicBrainz (métadonnées mises à jour)")

conn.close()
print(f"\n✅ {ok} albums complétés · {len(empty)} sans titres sur MusicBrainz · {len(errors)} erreurs")
if errors:
    print("   Relance le script pour réessayer les albums en erreur.")
