# Mumbai Local Sim

A 3D simulation of the Mumbai suburban railway, driven by the real Western
Railway timetable over real geography. This glossary fixes the vocabulary
shared by the simulation core, the baked datasets, and the rendering layer —
so that additional routes can arrive as data without the words shifting
underneath them.

## Language

### Geography

**Route**:
One suburban railway corridor that arrives as a single baked dataset — Western,
Central, Harbour.
_Avoid_: line (means something narrower here), network

**Corridor**:
The geographic alignment a Route follows on the ground, from its origin station
to its far terminus.
_Avoid_: alignment, path

**Section**:
A span of Corridor between two points along which the Track count does not
change.
_Avoid_: segment, stretch

**Chainage**:
Distance along a Route measured from its origin, where Churchgate is zero on
the Western Route.
_Avoid_: distance, mileage, offset

**Down**:
The direction of increasing Chainage — away from Churchgate.
_Avoid_: northbound, outbound

**Up**:
The direction of decreasing Chainage — toward Churchgate.
_Avoid_: southbound, inbound

### Track and Line

**Track**:
One physical pair of rails, counted per Section and drawn as a single polyline.
_Avoid_: line, rail, lane

**Line**:
The operational role a Track carries — Slow, Fast, or Through — paired with a
direction, as in "the Down Fast line". What a Service is booked to run on.
_Avoid_: lane, track (means something narrower here), path

**Turnout**:
Where a Track diverges or converges at a Section boundary.
_Avoid_: switch, points, junction

**Yard**:
An EMU car shed or holding siding off the running Lines, where a Rake stands
between Services.
_Avoid_: depot, shed, siding

### Stations

**Station**:
A stopping place on a Route, identified by a stable id and located at a
Chainage.

**Platform Face**:
The boarding edge alongside one Track at a Station. An island platform has two
Faces.
_Avoid_: platform (ambiguous — one platform may serve two Tracks)

**Halt**:
A Station where a given Service is scheduled to stop. Stations a Service passes
without stopping are skipped, not halted.
_Avoid_: stop, call

**Dwell**:
How long a Rake stands at a Halt.
_Avoid_: wait, hold (means something different here)

**Turnback**:
A Station where a Service terminates short of its Route's far terminus, and the
Rake reverses direction.
_Avoid_: short-terminate, reversal

### Services

**Service**:
One scheduled run along a Route, from origin to terminus, with a fixed sequence
of Halts. The unit the timetable is made of.
_Avoid_: train, trip, run

**Rake**:
The physical train set that works a Service — the thing rendered on the Track.
_Avoid_: train, consist, formation

**Service Type**:
What kind of Service it is — Slow, Fast, AC, or Express — which decides the
Line it runs on and which Stations it Halts at.
_Avoid_: class, category

**Timetable**:
The built schedule the simulation runs, derived from the baked dataset. Both
real and synthetic sources produce the same shape.
_Avoid_: schedule, diagram

**Headway**:
The time separation between consecutive Services on the same Line.
_Avoid_: gap, spacing, interval

**Hold**:
Time added to a Service against its published schedule so that a minimum
Headway is preserved.
_Avoid_: delay (reserved for unscheduled lateness), wait
