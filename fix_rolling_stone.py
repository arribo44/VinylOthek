"""
fix_rolling_stone.py — Corrige les albums Rolling Stone 500 mal associés sur MusicBrainz
et importe ceux qui manquent.

Étape 1 — propositions (ne modifie rien) :
    python fix_rolling_stone.py propose propositions.json
Étape 2 — application, après relecture (proxy.py doit tourner) :
    python fix_rolling_stone.py apply propositions.json

Une correction garde la note, le commentaire et la date d'ajout de l'album ;
titres, pochette, genres et liens sont récupérés pour la nouvelle fiche.
Pour écarter une proposition, supprime-la du fichier JSON avant l'étape 2.
"""

import os
import re
import csv
import sys
import json
import time
import sqlite3
import unicodedata
import requests

# ── Config ────────────────────────────────────────────────────────────────────
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH    = os.path.join(SCRIPT_DIR, "vinylothek.db")
CSV_PATH   = os.path.join(SCRIPT_DIR, "rolling_stone_500.csv")

MB_BASE = "https://musicbrainz.org/ws/2"
PROXY   = "http://localhost:5000"
HEADERS = {
    "User-Agent": "Vinylothek/1.0 (application personnelle)",
    "Accept":     "application/json",
}

# Délai entre requêtes MusicBrainz (politique : max 1 req/sec)
MB_DELAY = 1.1

# Fautes ou intitulés du CSV qui ne correspondent pas au nom MusicBrainz
ARTIST_ALIASES = {"Joy Divison": "Joy Division", "Jimi Hendrix": "The Jimi Hendrix Experience"}
TITLE_ALIASES  = {("The Beatles", "White Album"): "The Beatles"}

# ── Utilitaires ───────────────────────────────────────────────────────────────
def norm(s, keep_brackets=False):
    s = unicodedata.normalize("NFKD", (s or "").replace("﻿", "")).encode("ascii", "ignore").decode().lower()
    if not keep_brackets:
        s = re.sub(r"[\(\[].*?[\)\]]", "", s)
    s = re.sub(r"^the\s+", "", s.strip().replace("&", " and "))
    return re.sub(r"[^a-z0-9]+", "", s)

def lucene_terms(s):
    """Mots sans caractères spéciaux Lucene, pour une recherche tolérante."""
    return re.sub(r'[+\-!(){}\[\]^"~*?:\\/&|]', " ", s).strip()

def year_of(s):
    m = re.search(r"(19|20)\d\d", s or "")
    return int(m.group(0)) if m else None

def load_csv():
    rows = []
    with open(CSV_PATH, encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            # NFC : certains accents du CSV sont décomposés (« o » + tréma), ce qui casse la recherche
            artist = unicodedata.normalize("NFC", r["Artist"]).strip()
            title  = unicodedata.normalize("NFC", r["Album"].replace("﻿", "")).strip()
            rows.append({
                "rank":   int(r["Rank"]),
                "artist": ARTIST_ALIASES.get(artist, artist),
                "title":  TITLE_ALIASES.get((artist, title), title),
                "year":   year_of(r["Info"]),
            })
    return rows

def mb_search(artist, title):
    # Mots non entre guillemets : « The Eagles » trouve « Eagles », « Brian Eno » trouve « Eno »
    q = f"releasegroup:({lucene_terms(title)}) AND artist:({lucene_terms(artist)}) AND primarytype:album"
    for attempt in range(5):
        r = requests.get(f"{MB_BASE}/release-group", params={"query": q, "limit": 40, "fmt": "json"},
                         headers=HEADERS, timeout=15)
        time.sleep(MB_DELAY)
        if r.status_code != 503:
            break
        time.sleep(3 * (attempt + 1))  # MusicBrainz surchargé : on patiente
    r.raise_for_status()
    return r.json().get("release-groups", [])

def score(rg, row):
    """Note une fiche MusicBrainz : bon titre, bon artiste, album original, bonne année."""
    credit = " ".join(c.get("name", "") + c.get("joinphrase", "") for c in rg.get("artist-credit", []))
    if norm(row["artist"]) not in norm(credit) and norm(credit) not in norm(row["artist"]):
        return None
    t, want = norm(rg.get("title")), norm(row["title"])
    if norm(rg.get("title"), keep_brackets=True) == norm(row["title"], keep_brackets=True):
        s = 100
    elif t == want:
        s = 70  # même titre à une mention près : « (Deluxe Edition) », « (Live From Houston) »…
    elif want and (want in t or t in want):
        s = 40
    else:
        return None
    s += 0 if rg.get("secondary-types") else 30       # ni live, ni compilation, ni BO
    y = year_of(rg.get("first-release-date"))
    if y and row["year"]:
        s += 20 if y == row["year"] else -5 * min(abs(y - row["year"]), 10)
    return s + rg.get("score", 0) / 10

def summary(rg):
    return {
        "id":     rg["id"],
        "title":  rg.get("title"),
        "artist": " ".join(c.get("name", "") + c.get("joinphrase", "") for c in rg.get("artist-credit", [])).strip(),
        "year":   (rg.get("first-release-date") or "")[:4],
        "types":  rg.get("secondary-types", []),
    }

# ── Étape 1 : propositions ────────────────────────────────────────────────────
def propose(out_path):
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    albums = [dict(a) for a in conn.execute("SELECT id, artist, title, year FROM albums")]
    ids = {a["id"] for a in albums}

    # Relie chaque ligne du CSV à un album de la base (même artiste, même titre, sinon même artiste)
    used, links = set(), []
    for row in load_csv():
        same = [a for a in albums if norm(a["artist"]) == norm(row["artist"]) and a["id"] not in used]
        exact = [a for a in same if norm(a["title"]) == norm(row["title"])]
        links.append((row, exact[0] if exact else None))
        if exact:
            used.add(exact[0]["id"])
    for i, (row, cur) in enumerate(links):
        if cur is None:
            same = [a for a in albums if norm(a["artist"]) == norm(row["artist"]) and a["id"] not in used]
            if same:
                used.add(same[0]["id"])
                links[i] = (row, same[0])

    def suspicious(row, cur):
        if cur is None:
            return True
        y = year_of(cur["year"])
        return norm(cur["title"]) != norm(row["title"]) or (y and row["year"] and abs(y - row["year"]) > 1)

    todo = [(row, cur) for row, cur in links if suspicious(row, cur)]
    print(f"{len(todo)} albums à vérifier sur MusicBrainz (~{len(todo) * MB_DELAY:.0f} s)\n")

    proposals, unresolved = [], []
    for row, cur in todo:
        label = f"#{row['rank']} {row['artist']} — {row['title']} ({row['year']})"
        try:
            rgs = mb_search(row["artist"], row["title"])
        except Exception as e:
            print(f"⚠️  {label} : {e}")
            unresolved.append({"rs": row, "reason": str(e)})
            continue
        # À score égal, on garde la fiche actuelle
        scored = sorted(((score(rg, row), rg) for rg in rgs),
                        key=lambda x: (-(x[0] or -1e9), not cur or x[1]["id"] != cur["id"]))
        best = next((rg for s, rg in scored if s is not None), None)

        if best is None:
            print(f"✘  {label} : rien trouvé")
            unresolved.append({"rs": row, "reason": "aucune fiche correspondante"})
        elif cur and best["id"] == cur["id"]:
            print(f"✔  {label} : déjà la bonne fiche ({cur['title']})")
        elif best["id"] in ids:
            print(f"✔  {label} : déjà dans la collection ({best.get('title')})")
        else:
            p = {"kind": "fix" if cur else "import", "rs": row, "current": cur, "proposed": summary(best)}
            proposals.append(p)
            before = f"{cur['title']} ({cur['year']})" if cur else "absent"
            print(f"→  {label}\n     {before}  ⇒  {best.get('title')} ({p['proposed']['year']})"
                  + (f" [{', '.join(p['proposed']['types'])}]" if p["proposed"]["types"] else ""))

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"proposals": proposals, "unresolved": unresolved}, f, ensure_ascii=False, indent=1)
    fixes = sum(p["kind"] == "fix" for p in proposals)
    print(f"\n{fixes} corrections · {len(proposals) - fixes} imports · {len(unresolved)} non résolus")
    print(f"Propositions écrites dans {out_path}")

# ── Étape 2 : application ─────────────────────────────────────────────────────
def proxy_get(path):
    r = requests.get(PROXY + path, timeout=120)
    r.raise_for_status()
    return r.json()

def apply(in_path):
    with open(in_path, encoding="utf-8") as f:
        proposals = json.load(f)["proposals"]
    conn = sqlite3.connect(DB_PATH)
    ok, skipped = 0, []
    for i, p in enumerate(proposals, 1):
        new_id = p["proposed"]["id"]
        label = f"[{i}/{len(proposals)}] {p['rs']['artist']} — {p['proposed']['title']}"
        if conn.execute("SELECT 1 FROM albums WHERE id = ?", (new_id,)).fetchone():
            skipped.append(label + " : déjà dans la collection")
            continue
        try:
            d = proxy_get(f"/album/{new_id}")
            cover = proxy_get(f"/cover/{new_id}").get("url")
        except Exception as e:
            skipped.append(f"{label} : {e}")
            continue

        values = {
            "id": new_id, "title": d.get("title"), "artist": d.get("artist"), "year": d.get("year"),
            "cover": cover, "genres": json.dumps(d.get("genres") or []),
            "nb_tracks": d.get("nb_tracks", 0), "duration": d.get("duration", 0),
            "tracks": json.dumps(d.get("tracks") or []), "deezer_url": d.get("deezer_url"),
            "wikidata_id": d.get("wikidata_id"), "wikidata_deezer_id": d.get("wikidata_deezer_id"),
            "work_language": d.get("work_language"), "review_score": d.get("review_score"),
            "units_sold": d.get("units_sold"), "discogs_rating": d.get("discogs_rating"),
        }
        cols = list(values)
        if p["kind"] == "fix":
            # Note, commentaire et date d'ajout sont conservés (colonnes non modifiées)
            old_id = p["current"]["id"]
            conn.execute(f"UPDATE albums SET {', '.join(c + ' = ?' for c in cols)} WHERE id = ?",
                         [values[c] for c in cols] + [old_id])
            conn.executemany("DELETE FROM api_cache WHERE key = ?", [(f"album:{old_id}",), (f"cover:{old_id}",)])
        else:
            conn.execute(f"INSERT INTO albums ({', '.join(cols)}) VALUES ({', '.join('?' for _ in cols)})",
                         [values[c] for c in cols])
        conn.commit()
        ok += 1
        print(f"{label} : ✔ {'corrigé' if p['kind'] == 'fix' else 'importé'} ({values['year']})")

    conn.close()
    print(f"\n✅ {ok} albums traités · {len(skipped)} ignorés")
    for s in skipped:
        print("   " + s)

# ── Main ──────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] not in ("propose", "apply"):
        print(__doc__)
        sys.exit(1)
    (propose if sys.argv[1] == "propose" else apply)(sys.argv[2])
