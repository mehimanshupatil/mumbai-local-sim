#!/usr/bin/env python3
"""
One-time extraction of Western Railway Public Time Tables (PTT PDFs) into a
raw JSON grid: one row per train, with per-station times aligned by position
(not by pdfplumber's text-flow, which drops blank cells and loses alignment).

The PDFs are native text (not scanned), laid out as a rigid grid: a few
header rows (route/terminus code, train number, car count) followed by one
row per station. Words carry reliable (x0, top) positions, so columns and
rows are recovered by clustering position, not by parsing prose.

Usage: pip install -r scripts/requirements-timetable.txt
       python3 scripts/extract-timetable-pdfs.py
Output: scripts/.cache/timetable-raw.json (gitignored; scripts/bake-real-timetable.ts consumes it)

Re-run whenever WR publishes a new PTT: drop the new PDF(s) into
data/timetable/ (any filename — direction/AC-ness are read from each PDF's
own header, not the filename) and re-run both this script and
`pnpm bake:realtimetable`.
"""
import json
import re
import sys
from pathlib import Path

import pdfplumber

ROOT = Path(__file__).parent.parent
TIMETABLE_DIR = ROOT / "data" / "timetable"
OUT_PATH = ROOT / "scripts" / ".cache" / "timetable-raw.json"


def classify_source(path: Path):
    """Direction/AC-ness from the PDF's own header text, not the filename —
    so a re-run with a differently-named future PTT still classifies
    correctly. Falls back to the filename only if the header is ambiguous
    (seen once: the Dahanu PTT's title line doesn't say DN/UP up front)."""
    with pdfplumber.open(path) as pdf:
        header_text = (pdf.pages[0].extract_text() or "")[:400].upper()
    is_up = "UP TRAINS" in header_text or re.search(r"\bUP\b", path.stem.upper())
    is_down = "DN TRAINS" in header_text or re.search(r"\bDN\b|\bDOWN\b", path.stem.upper())
    direction = "up" if is_up and not is_down else "down"
    is_ac = bool(re.search(r"\bAC\b", path.stem.upper())) or "AIR CONDITION" in header_text
    return direction, ("ac" if is_ac else None)

# Canonical station names in corridor order, matching src/data/western.json.
# PDF label -> canonical name aliases where they diverge (typos, abbreviations,
# spacing). Matching is done on a normalized (lowercased, alnum-only) key.
CANONICAL_STATIONS = [
    "Churchgate", "Marine Lines", "Charni Road", "Grant Road", "Mumbai Central",
    "Mahalaxmi", "Lower Parel", "Prabhadevi", "Dadar", "Matunga Road",
    "Mahim Junction", "Bandra", "Khar Road", "Santacruz", "Vile Parle",
    "Andheri", "Jogeshwari", "Ram Mandir", "Goregaon", "Malad", "Kandivali",
    "Borivali", "Dahisar", "Mira Road", "Bhayandar", "Naigaon", "Vasai Road",
    "Nallasopara", "Virar", "Vaitarna", "Saphale", "Kelve Road", "Palghar",
    "Umroli", "Boisar", "Vangaon", "Dahanu Road",
]


def normalize(s: str) -> str:
    return re.sub(r"[^a-z]", "", s.lower())


ALIASES = {
    normalize("M'BAI CENTRAL (L)"): normalize("Mumbai Central"),
    normalize("M'BAI CENTRAL"): normalize("Mumbai Central"),
    normalize("Mahalakshmi"): normalize("Mahalaxmi"),
    normalize("Kandivli"): normalize("Kandivali"),
    normalize("Nalla Sopara"): normalize("Nallasopara"),
    normalize("Mahim Jn."): normalize("Mahim Junction"),
    normalize("Mahim Jn"): normalize("Mahim Junction"),
    normalize("Vaiterna"): normalize("Vaitarna"),
    normalize("Santa Cruz"): normalize("Santacruz"),
    normalize("Vasai  Road"): normalize("Vasai Road"),
}
CANON_BY_KEY = {normalize(n): n for n in CANONICAL_STATIONS}


def station_id_for(label: str):
    key = normalize(label)
    key = ALIASES.get(key, key)
    return CANON_BY_KEY.get(key)


TRAIN_NUMBER_RE = re.compile(r"^\d{4,6}[A-Z]?$")
TIME_RE = re.compile(r"^(\d{1,2}):(\d{2})(?::(\d{2}))?$")
ROUTE_CODE_RE = re.compile(r"^[A-Z]{2,4}(-[A-Z]{2,4})?$")


def cluster_rows(words, tol=3.0):
    """Group words into visual rows by 'top', tolerant of sub-pixel jitter."""
    rows = []
    for w in sorted(words, key=lambda w: w["top"]):
        if rows and w["top"] - rows[-1][-1]["top"] < tol:
            rows[-1].append(w)
        else:
            rows.append([w])
    return rows


def row_text_by_column(row, col_x0s, max_snap):
    """Assign each word in a row to its nearest header column, by x0."""
    out = {i: [] for i in range(len(col_x0s))}
    for w in row:
        best_i, best_d = None, max_snap
        for i, cx in enumerate(col_x0s):
            d = abs(w["x0"] - cx)
            if d < best_d:
                best_i, best_d = i, d
        if best_i is not None:
            out[best_i].append(w)
    return out


def snap_distance(col_x0s):
    """Half the tightest adjacent-column gap, with margin — tight timetable
    layouts (e.g. the Dahanu PTT, ~32px columns) need a smaller snap radius
    than the main DN/UP grids (~45-55px) or words bleed into the neighbor."""
    if len(col_x0s) < 2:
        return 24.0
    gaps = [b - a for a, b in zip(col_x0s, col_x0s[1:])]
    return max(8.0, min(24.0, min(gaps) / 2 - 2))


def parse_page(page, direction: str, service_hint: str | None, source: str, page_no: int):
    words = page.extract_words(use_text_flow=False, keep_blank_chars=False)
    if not words:
        return []
    rows = cluster_rows(words)

    # Header block: the row whose tokens are mostly train numbers anchors
    # column x-positions. Matched by content (regex), not by an x0 cutoff —
    # data-column start position varies a lot between PTT layouts (the main
    # DN/UP grids start past x0=150; the tighter Dahanu PTT starts at x0=92,
    # which a fixed threshold silently drops, shifting every column after it).
    header_row_idx = None
    for i, row in enumerate(rows[:6]):
        numberish = [w for w in row if TRAIN_NUMBER_RE.match(w["text"])]
        if len(numberish) >= max(2, len(row) * 0.5):
            header_row_idx = i
            break
    if header_row_idx is None:
        return []  # notes/blank page

    number_row = rows[header_row_idx]
    number_words = sorted(
        (w for w in number_row if TRAIN_NUMBER_RE.match(w["text"])), key=lambda w: w["x0"]
    )
    col_x0s = [w["x0"] for w in number_words]
    train_numbers = [w["text"] for w in number_words]
    snap = snap_distance(col_x0s)
    # Station-label text sits left of the first real data column; a fixed
    # margin comfortably separates it in both layouts (checked against the
    # widest label in each, "M'BAI CENTRAL (L)" and "DAHANU ROAD").
    label_max_x0 = col_x0s[0] - 10 if col_x0s else 100.0

    route_row = rows[header_row_idx - 1] if header_row_idx > 0 else []
    route_by_col = row_text_by_column(route_row, col_x0s, snap) if route_row else {}
    routes = [
        " ".join(w["text"] for w in route_by_col.get(i, [])) or None
        for i in range(len(col_x0s))
    ]

    car_row = rows[header_row_idx + 1] if header_row_idx + 1 < len(rows) else []
    car_by_col = row_text_by_column(car_row, col_x0s, snap) if car_row else {}
    cars = []
    for i in range(len(col_x0s)):
        toks = [w["text"] for w in car_by_col.get(i, [])]
        m = next((t for t in toks if t.isdigit()), None)
        cars.append(int(m) if m else None)

    # Station rows: everything after the header block whose col0 label
    # matches a canonical station name (in order; skip non-matching rows —
    # they're page titles or footnote lines, not data).
    stations_seen = 0
    trains = [
        {
            "source": source,
            "page": page_no,
            "direction": direction,
            "trainNumber": tn,
            "route": routes[i],
            "cars": cars[i],
            "serviceHint": service_hint,
            "stops": [],  # [{stationId, timeSeconds}]
            "notes": [],
        }
        for i, tn in enumerate(train_numbers)
    ]

    for row in rows[header_row_idx + 2 :]:
        label_words = sorted((w for w in row if w["x0"] < label_max_x0), key=lambda w: w["x0"])
        if not label_words:
            continue
        label = " ".join(w["text"] for w in label_words)
        sid = station_id_for(label)
        if not sid:
            continue  # footnote / stray text row
        stations_seen += 1
        by_col = row_text_by_column([w for w in row if w["x0"] >= label_max_x0], col_x0s, snap)
        for i in range(len(col_x0s)):
            for w in by_col.get(i, []):
                m = TIME_RE.match(w["text"])
                if m:
                    h, mm, ss = int(m[1]), int(m[2]), int(m[3] or 0)
                    trains[i]["stops"].append(
                        {"stationId": sid, "timeSeconds": h * 3600 + mm * 60 + ss}
                    )
                elif w["text"] not in ("", None):
                    trains[i]["notes"].append(w["text"])

    if stations_seen < 5:
        return []  # didn't find a real station grid on this page
    return [t for t in trains if t["stops"]]


def main():
    pdf_paths = sorted(TIMETABLE_DIR.glob("*.pdf"))
    if not pdf_paths:
        print(f"no PDFs found in {TIMETABLE_DIR}", file=sys.stderr)
        sys.exit(1)

    all_trains = []
    for path in pdf_paths:
        direction, hint = classify_source(path)
        with pdfplumber.open(path) as pdf:
            print(f"{path.name}: {len(pdf.pages)} pages, direction={direction}, serviceHint={hint}")
            for pno, page in enumerate(pdf.pages):
                trains = parse_page(page, direction, hint, path.name, pno)
                all_trains.extend(trains)

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(all_trains, indent=1))
    print(f"\nwrote {len(all_trains)} train records to {OUT_PATH}")


if __name__ == "__main__":
    main()
