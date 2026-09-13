#!/usr/bin/env bash
# Fetch and prepare the ambient Beds (ticket #28).
#
# Every source is a CC-BY field recording from Freesound, most of them made in
# India — the Bed is the one part of the soundscape where a real recording
# beats anything synthetic, and where the location genuinely shows. Sources,
# authors and licences are listed in docs/attribution.md; that file is the
# obligation, this script is only how the bytes got here.
#
# Outputs are committed, so a clone needs neither curl nor ffmpeg. Re-run only
# to change the set:  ./scripts/fetch-beds.sh
set -euo pipefail
cd "$(dirname "$0")/.."
CACHE=scripts/.cache/beds
OUT=public/audio/beds
mkdir -p "$CACHE" "$OUT"

# slug|freesound id|uploader|start offset (s)
#
# Two variants per palette so a Bed that plays for an hour never repeats the
# same minute twice running; the crowd and traffic layers ride on top, driven
# by live Service density rather than by the clock.
BEDS=(
  "dawn-birds|770080|tanweraman|20"
  "dawn-suburb|430998|Bheemasena|30"
  "day-street|578755|kevp888|10"
  "day-traffic|465712|Nielsvdb|20"
  "dusk-garden|466262|kevp888|30"
  "dusk-turning|568216|deadmanswill|30"
  "night-crickets|803557|Rico_Casazza|5"
  "night-alley|803556|Rico_Casazza|60"
  "crowd-kharghar|181118|sankalp|10"
  "crowd-kanpur|180428|sankalp|15"
  "traffic-jam|578743|kevp888|5"
)

# A minute is long enough that the ear never hears the whole thing before the
# cross-fade moves on, and short enough to keep the set around 10 MB.
LEN=60

for row in "${BEDS[@]}"; do
  IFS='|' read -r slug id user start <<< "$row"
  src="$CACHE/$id.mp3"
  if [ ! -f "$src" ]; then
    echo "fetching $slug ($id by $user)"
    page=$(curl -sf -m 60 -A 'mumbai-local-sim/0.1 (bed fetch)' \
      "https://freesound.org/people/$user/sounds/$id/")
    url=$(grep -o "https://cdn\.freesound\.org/previews/[0-9]*/${id}_[0-9]*-hq\.mp3" <<< "$page" | head -1)
    [ -n "$url" ] || { echo "no preview found for $id" >&2; exit 1; }
    curl -sf -m 300 --retry 3 --retry-connrefused -o "$src" "$url"
  fi
  # Up to a minute from a settled part of the recording, loudness-matched so
  # no palette jumps out when the Bed cross-fades into it. The fades matter
  # more than the length: the player overlaps clips by exactly two seconds, so
  # a clip that ends without one is an audible cut. Recordings shorter than
  # the excerpt keep whatever they have, with the fade moved to their real end.
  dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$src")
  start=$(awk -v s="$start" -v d="$dur" -v l="$LEN" 'BEGIN{m=d-l; if(m<0)m=0; print (s<m)?s:m}')
  len=$(awk -v s="$start" -v d="$dur" -v l="$LEN" 'BEGIN{r=d-s; print (r<l)?r:l}')
  out=$(awk -v l="$len" 'BEGIN{v=l-2; print (v>0)?v:0}')
  ffmpeg -nostdin -loglevel error -y -ss "$start" -t "$len" -i "$src" \
    -af "loudnorm=I=-23:TP=-2:LRA=11,afade=t=in:d=2,afade=t=out:st=$out:d=2" \
    -c:a aac -b:a 128k -ar 44100 -ac 2 -movflags +faststart "$OUT/$slug.m4a"
  echo "  -> $OUT/$slug.m4a  $(du -h "$OUT/$slug.m4a" | cut -f1)"
done
