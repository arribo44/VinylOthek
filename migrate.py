"""
migrate.py — Migration localStorage → SQLite
Usage : python migrate.py export.json

1. Lit le fichier JSON exporté depuis le localStorage du navigateur
2. Insère les albums dans vinylothek.db (SQLite)
3. Génère un snippet JS à coller dans la console pour effacer le localStorage
"""

import sys
import json
import sqlite3
import os

# ── Chemins ───────────────────────────────────────────────────────────────────
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH    = os.path.join(SCRIPT_DIR, "vinylothek.db")

# ── Vérification des arguments ────────────────────────────────────────────────
if len(sys.argv) < 2:
    print("Usage : python migrate.py export.json")
    sys.exit(1)

JSON_PATH = sys.argv[1]
if not os.path.exists(JSON_PATH):
    print(f"Fichier introuvable : {JSON_PATH}")
    sys.exit(1)

# ── Lecture du JSON ───────────────────────────────────────────────────────────
with open(JSON_PATH, "r", encoding="utf-8") as f:
    raw = f.read().strip()

try:
    albums = json.loads(raw)
except json.JSONDecodeError as e:
    print(f"Erreur de lecture du JSON : {e}")
    sys.exit(1)

if not isinstance(albums, list):
    print("Format inattendu : le fichier doit contenir une liste JSON.")
    sys.exit(1)

print(f"\n📂 {len(albums)} album(s) trouvé(s) dans {JSON_PATH}")

# ── Connexion SQLite ──────────────────────────────────────────────────────────
if not os.path.exists(DB_PATH):
    print(f"⚠️  Base introuvable : {DB_PATH}")
    print("   Lance proxy.py au moins une fois pour créer la base, puis relance migrate.py.")
    sys.exit(1)

conn = sqlite3.connect(DB_PATH)
conn.row_factory = sqlite3.Row

# ── Migration ─────────────────────────────────────────────────────────────────
inserted = 0
skipped  = 0

for album in albums:
    album_id = album.get("id")
    if not album_id:
        print(f"  ⚠️  Album sans id ignoré : {album.get('title', '?')}")
        skipped += 1
        continue

    # Vérifie si déjà présent
    exists = conn.execute("SELECT 1 FROM albums WHERE id = ?", (album_id,)).fetchone()
    if exists:
        print(f"  ⏭  Déjà présent : {album.get('title', album_id)}")
        skipped += 1
        continue

    genres = album.get("genres", [])
    tracks = album.get("tracks", [])

    conn.execute("""
        INSERT INTO albums
            (id, title, artist, year, cover, genres,
             nb_tracks, duration, tracks, deezer_url, rating, comment)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        album_id,
        album.get("title", ""),
        album.get("artist", ""),
        album.get("year", ""),
        album.get("cover"),
        json.dumps(genres if isinstance(genres, list) else []),
        album.get("nb_tracks", 0),
        album.get("duration", 0),
        json.dumps(tracks if isinstance(tracks, list) else []),
        album.get("deezer_url") or album.get("deezerUrl"),
        album.get("rating", 0),
        album.get("comment", ""),
    ))
    print(f"  ✅ Importé : {album.get('title', album_id)} — {album.get('artist', '')}")
    inserted += 1

conn.commit()
conn.close()

# ── Résumé ────────────────────────────────────────────────────────────────────
print(f"\n🎵 Migration terminée : {inserted} importé(s), {skipped} ignoré(s)")
print(f"   Base mise à jour : {DB_PATH}\n")

# ── Instructions pour effacer le localStorage ─────────────────────────────────
if inserted > 0:
    print("─" * 60)
    print("🧹 ÉTAPE SUIVANTE — Effacer le localStorage")
    print("─" * 60)
    print("Ouvre http://localhost:5173 dans ton navigateur,")
    print("puis F12 → Console et colle cette commande :\n")
    print('   localStorage.removeItem("vinylothek_collection")')
    print('   console.log("✅ localStorage effacé !")')
    print("\nActualise ensuite la page (F5) pour vérifier")
    print("que la collection est bien chargée depuis SQLite.")
    print("─" * 60)
else:
    print("ℹ️  Aucun nouvel album importé — localStorage inchangé.")
