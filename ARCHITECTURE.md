# ARCHITECTURE.md — Voxel Architect

## Phase 1 data model

### Params (per structure)
```js
{
  width: 9, depth: 7,          // footprint, cells
  stories: 2,                  // 1..5, 3 blocks per story
  roofStyle: 'hip',            // 'flat' | 'gable' | 'hip'
  windowDensity: 0.45,         // 0..1 -> WINDOW pick weight
  chimney: false, symmetry: true,
  crenellation: false,         // castle merlons on flat roofs
  pillars: false,               // corner pillars
  door: true,
  seed: 12345,                 // int; full determinism via mulberry32
  prompt: 'cozy cottage'        // informational only
}
```
Validated by `normalizeParams()` in `wfc.js`.

### Generation result
```js
{
  grid: Uint8Array,            // (W+2) x GY x (D+2), 1-cell margin for stoop
  W, H, D,                     // grid dims
  footprint: { w, d, stories, wallH },
  params, seed,
  tilesetVersion: 'building-tileset-1',
  connectionPoints,   // generic portals for the Phase 2 composer (see below)
  stats: { contradictions, windows, collapsedCells }
}
```

### Connection points (generic portals)
```js
connectionPoints: [
  { x, y, z, dir: [dx, dz], kind: 'opening' | 'potential' },
  // …
]
```
Grid-space coordinates. `'opening'` = a real hole in the shell (a door today;
a cave mouth in a future tileset). `'potential'` = a plausible attachment
spot (e.g. face-center ground cells). The composer treats every saved
structure as a **labeled volume with connection points** — it never assumes
buildings, streets, or any urban layout.

### Tileset (`BLOCK_*` in `wfc.js`)
`AIR, FLOOR, WALL, WALL_TRIM, WINDOW, DOOR, ROOF, ROOF_RIDGE, CHIMNEY,
PILLAR, CRENELLATION, STAIRS` — each with an authored color in `BLOCK_INFO`.
Bump `TILESET_VERSION` when rules change; the library stores it per entry so
Phase 2 can migrate or warn on stale entries.

### Library entry (localStorage `voxel-architect.library.v1`)
```js
{ id, name, prompt, params, tilesetVersion, seed,
  connectionPoints,           // generic portals, see above
  thumbnail /* JPEG dataURL */, createdAt }
```
The grid is never stored — `(params, seed, tilesetVersion)` reproduces it.
No city/block/lot/district concepts appear anywhere in the saved format.

### Module seams
- `wfc.js` — pure logic, no DOM. Exports `generate`, `generateCandidates`,
  `promptToParams` (stub), `scoreCandidates` (stub), tileset constants.
- `app.js` — Three.js scene + UI. Renders one `InstancedMesh` per block type.
- `library.js` — storage + list rendering. `Library.renderList(el, onSelect)`.

## Generation algorithm (Phase 1)

1. **Authored skeleton (pre-collapse):** floor slab → wall rings per story →
   corner pillars → story-cap trim rows → door + front stoop stairs →
   roof mass (flat slab / gable prism / hip pyramid, ridge blocks on top) →
   chimney column.
2. **WFC pass on wall faces:** each non-corner wall cell in the lower two rows
   of every story holds domain `{WALL, WINDOW}`. Rules:
   - R1 support: WINDOW needs solid above *and* below (never above AIR/FLOOR/DOOR).
   - R2: WINDOW never orthogonally adjacent to DOOR.
   - R3: collapsing WINDOW removes WINDOW from in-face neighbours' domains
     (spacing); empty domain → safe fallback WALL (counted as contradiction).
   - Weighted pick: `P(WINDOW) ∝ windowDensity`; lowest-entropy-first order.
   - Optional symmetry: mirror the pick across the face's center axis.
3. Deterministic given `(params, seed)`.

## Phase 2 plan

### A. Jev integration points (stubs marked `PHASE 2 INTEGRATION POINT`)
1. **`promptToParams(prompt)`** → Jev structured-output call. Input: free
   text. Output: validated params JSON (via `normalizeParams`). Fallback to
   the keyword stub on failure.
2. **`scoreCandidates(candidates)`** → Jev `score` call. Render each
   candidate to 2–3 isometric PNG views, score against a rubric, e.g.
   `{ structuralCoherence, promptMatch, silhouette, detailBalance }`;
   keep top-k, show the rest as alternates. `app.js` already consumes the
   `{...candidate, score}` shape.
3. **Composition-constraint parsing** (see B): natural-language constraints
   ("keep X near Y", "everything interconnects", "no steep tunnels") →
   structured macro constraints in the domain-agnostic vocabulary
   (connectivity / proximity / frequency / topology / traversal limits)
   via Jev `choice`/extraction.

### B. @-mention composition grammar (fully domain-agnostic)

> Design rule: **no hardcoded domain concepts.** The composer must never
> assume cities, blocks, lots, districts, streets, or buildings. A cave
> system, a dungeon network, and a transit layout are all first-class.

A **composition** = `@`-mentions of saved structures + natural-language
constraints, compiled into a **macro-level constraint problem**:

- **Tiles** are *structure instances*: labeled volumes (whatever the user
  saved — a house, a cave chamber, a bridge span, a subway car) placed on a
  3D lattice, plus **empty space** and **connector** tiles (tunnels,
  corridors, spans — generated to join portals together).
- Every saved structure exposes **connection points / portals**
  (`{ x, y, z, dir, kind: 'opening' | 'potential' }` — Phase 1 already emits
  these; future tilesets author their own, e.g. cave mouths, tunnel ends).
- The constraint vocabulary is domain-agnostic:
  - **connectivity** — "interconnects", "all reachable", "no isolated X"
  - **proximity** — "keep X near Y", "X far from Y"
  - **frequency** — "at least one X per region", "at most N of X total"
    ("a shop on every block" is just frequency-over-regions in disguise)
  - **topology** — network vs. grid vs. cluster vs. chain arrangement
  - **traversal limits** — slope/grade caps and clearance on connectors
    ("no steep tunnels", "walkable throughout", "at least 2 tall")
- The macro solver (seeded, like Phase 1) places instances and routes
  connectors portal-to-portal until the constraints hold.

**Example 1 (Josh's):** *"Generate a @cave system that interconnects and can
likely be traveled in, so no really steep tunnels etc."*
→ palette = [@cave]; topology = network; connectivity = all-reachable;
traversal = grade ≤ walkable limit, clearance ≥ 2; connectors = tunnel tiles
between cave-mouth portals.

**Example 2:** *"Link @chamber-a and @chamber-b with @tunnels, keep @tunnels
far from @lava-pockets, at most 3 @tunnels total."*
→ proximity ban + frequency cap, same machinery, zero urban concepts.

- Export: merged voxel grid, or a placement list (JSON) for external tools
  (e.g. MagicaVoxel `.vox`, Minecraft schematics). Export formats are just
  serializers — they carry no domain assumptions either.

### C. Full structure editing UI
- Reopen any library entry's **params** in the left panel (already
  regenerable) **plus** direct voxel editing in a future editor mode:
  paint/erase per block type, then "re-run WFC" to re-solve details around
  manual edits. Edited structures save as new library versions (keep `seed`
  lineage: `{ parentId, seed, manualEdits }`).

### D. Non-goals for Phase 2
- Multiplayer / accounts (library stays local-first; optional export/import
  JSON instead).
- Photoreal rendering (voxel aesthetic is the product).
