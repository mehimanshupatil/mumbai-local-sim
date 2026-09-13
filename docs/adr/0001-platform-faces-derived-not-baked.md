# Platform Faces are derived from drawn Tracks, not baked as real platform counts

A Station's Platform Faces are derived at build time from the Tracks its
Section actually draws, together with which Lines Halt there — not baked as a
per-Station count of the platforms the real station has. The simulation
therefore claims only that Rakes stop at Faces beside the rails they run on,
which is true, rather than claiming a specific real platform inventory, which
we cannot source.

## Considered Options

Real per-Station platform counts were investigated first and rejected, because
no source supports them:

- **Official Western Railway** publishes nothing. All five Public Time Table
  PDFs in `data/timetable/` contain zero occurrences of "platform"; NTES and
  the WR site carry no station-infrastructure data.
- **OpenStreetMap** agrees with reference counts at 18 of 37 Stations. Ten
  Stations carry no `ref` tag at all and Dahanu Road has no platform element.
  Element count is not Face count — island platforms tag `ref="1;2"`.
- **RailYatri** renders unpopulated records as "a total of 0 well-built
  platforms", a placeholder indistinguishable from data; it yields a real
  number at only 17 of 37.
- **Wikipedia** gives whole-station totals that fold in Harbour-line and
  mainline platforms, which is not what a Western-Route simulation needs. Two
  Stations have the field empty.
- **Deriving from Section Track count** matches at 13 of 37, needing 22
  overrides. Slow-only Halts have fewer Faces than Tracks; terminus and
  junction Stations have loop and bay Faces off the running Lines.
- **Deriving from `fastHalt`** could not be scored at all: every candidate
  reference set is confounded by Harbour and mainline Faces, and no source
  splits Western-suburban Faces out.

Malad and Mahalaxmi have no defensible number from any source. Virar is
unresolvable in principle — recent MRVC works added Platform 5A, its numbering
already uses suffixed Faces, and no source states a post-works total.

## Consequences

Face counts will differ from reality at terminus and junction Stations —
Borivali, Vasai Road, Virar, Andheri, Bandra, Dadar most visibly. This is
deliberate: an internally consistent derivation is preferred over invented
numbers presented as baked fact.

The rule self-corrects when a Section's Track count changes, and it carries to
a new Route with no new data to source. Platform *numbering* is explicitly out
of scope — real numbers include lettered Faces such as 1A, 3A and 5A, so any
future numbering work must model them as strings, not integers.

That exclusion governs the audio layer too. A real platform Announcement names
a platform number, and ours does not: a voice saying "platform number three"
is a far stronger claim of fact than a slab drawn on screen, so inventing one
for the PA would be this ADR's own error made louder. Announcements name the
time, the destination and the Service Type — all of which the data actually
holds — and stop there. See ADR 0002.
