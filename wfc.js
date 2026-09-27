/* ============================================================================
 * wfc.js — 3D constraint-based voxel structure generator (Phase 1)
 *
 * A simplified 3D Wave-Function-Collapse-style generator for buildings.
 *
 * How it works:
 *   1. An authored "skeleton" pass pre-collapses most cells: floor slab,
 *      wall rings per story, corner pillars, story trim rows, door, roof
 *      mass per roof style, chimney, and a front stoop.
 *   2. The remaining wall-surface cells run a genuine lowest-entropy
 *      collapse with propagation: each cell holds a domain {WALL, WINDOW},
 *      adjacency/support rules prune domains, and collapsing a cell
 *      propagates constraints to its in-face neighbours.
 *   3. Everything is seeded (mulberry32) so (params + seed) deterministically
 *      reproduces a structure — this is what the library persists.
 *
 * No DOM dependencies: safe to import and unit-test in Node.
 * ========================================================================== */

export const BLOCK = {
  AIR: 0,
  FLOOR: 1,
  WALL: 2,
  WALL_TRIM: 3,
  WINDOW: 4,
  DOOR: 5,
  ROOF: 6,
  ROOF_RIDGE: 7,
  CHIMNEY: 8,
  PILLAR: 9,
  CRENELLATION: 10,
  STAIRS: 11,
};

/** Bump this whenever the authored tileset / rules change (library compat). */
export const TILESET_VERSION = 'building-tileset-1';

/** Authored tileset: block type -> render metadata. */
export const BLOCK_INFO = {
  [BLOCK.FLOOR]:        { name: 'floor',        color: 0x9a7b4f },
  [BLOCK.WALL]:         { name: 'wall',         color: 0xd9c9a3 },
  [BLOCK.WALL_TRIM]:    { name: 'wallTrim',     color: 0x7a5c3e },
  [BLOCK.WINDOW]:       { name: 'window',       color: 0xaad4f5, emissive: 0x2a4a5a },
  [BLOCK.DOOR]:         { name: 'door',         color: 0x6b4a2f },
  [BLOCK.ROOF]:         { name: 'roof',         color: 0xa8442f },
  [BLOCK.ROOF_RIDGE]:   { name: 'roofRidge',    color: 0x7e3323 },
  [BLOCK.CHIMNEY]:      { name: 'chimney',      color: 0x7d7d85 },
  [BLOCK.PILLAR]:       { name: 'pillar',       color: 0xcbb98f },
  [BLOCK.CRENELLATION]: { name: 'crenellation', color: 0xb3a88d },
  [BLOCK.STAIRS]:       { name: 'stairs',       color: 0x8f7f63 },
};

const STORY_H = 3; // blocks per story

/* ------------------------------------------------------------------ */
/* Seeded RNG                                                          */
/* ------------------------------------------------------------------ */

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ */
/* Params                                                              */
/* ------------------------------------------------------------------ */

export const DEFAULT_PARAMS = {
  width: 9,            // footprint X (cells)
  depth: 7,           // footprint Z (cells)
  stories: 2,         // 1..5
  roofStyle: 'hip',   // 'flat' | 'gable' | 'hip'
  windowDensity: 0.45, // 0..1 -> WINDOW pick weight
  chimney: false,
  symmetry: true,     // mirror collapse across face center axes
  crenellation: false, // castle merlons (flat roofs)
  pillars: false,      // corner pillars
  door: true,          // front door + stoop
  seed: 1,
};

export function normalizeParams(raw = {}) {
  const p = { ...DEFAULT_PARAMS, ...raw };
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  p.width = Math.round(clamp(p.width, 3, 16));
  p.depth = Math.round(clamp(p.depth, 3, 16));
  p.stories = Math.round(clamp(p.stories, 1, 5));
  p.windowDensity = clamp(Number(p.windowDensity) || 0, 0, 1);
  if (!['flat', 'gable', 'hip'].includes(p.roofStyle)) p.roofStyle = 'hip';
  for (const k of ['chimney', 'symmetry', 'crenellation', 'pillars', 'door']) {
    p[k] = !!p[k];
  }
  p.seed = (Number.isFinite(+p.seed) ? +p.seed : (Math.random() * 1e9) | 0) | 0;
  return p;
}

/* ------------------------------------------------------------------ */
/* Prompt -> params (KEYWORD STUB — Phase 2 replaces with Jev)          */
/*                                                                     */
/* PHASE 2 INTEGRATION POINT: swap this function for a call to Jev's   */
/* `choice`/structured-output endpoint that maps free text onto the    */
/* params schema above (validated by normalizeParams).                 */
/* ------------------------------------------------------------------ */

export function promptToParams(prompt) {
  const t = (prompt || '').toLowerCase();
  const base = { ...DEFAULT_PARAMS };
  const has = (...words) => words.some((w) => t.includes(w));

  if (has('tower'))       return { ...base, width: 5, depth: 5, stories: 4, roofStyle: 'flat', crenellation: true, pillars: true, windowDensity: 0.25 };
  if (has('castle', 'fort', 'keep')) return { ...base, width: 11, depth: 9, stories: 3, roofStyle: 'flat', crenellation: true, pillars: true, windowDensity: 0.3 };
  if (has('cottage'))     return { ...base, width: 7, depth: 6, stories: 1, roofStyle: 'gable', chimney: true, windowDensity: 0.5 };
  if (has('cabin', 'hut', 'shack'))  return { ...base, width: 6, depth: 5, stories: 1, roofStyle: 'gable', chimney: true, windowDensity: 0.35 };
  if (has('mansion', 'manor'))       return { ...base, width: 13, depth: 9, stories: 3, roofStyle: 'hip', pillars: true, chimney: true, windowDensity: 0.55 };
  if (has('shop', 'store', 'market'))return { ...base, width: 11, depth: 7, stories: 1, roofStyle: 'flat', windowDensity: 0.7 };
  if (has('apartment'))   return { ...base, width: 9, depth: 8, stories: 3, roofStyle: 'flat', windowDensity: 0.65 };
  if (has('temple', 'church', 'shrine')) return { ...base, width: 9, depth: 7, stories: 2, roofStyle: 'gable', pillars: true, windowDensity: 0.4 };
  if (has('bridge'))      return { ...base, width: 13, depth: 3, stories: 1, roofStyle: 'flat', windowDensity: 0, door: false };
  // "house"/"home" and anything unrecognized fall through to the default.
  return base;
}

/* ------------------------------------------------------------------ */
/* Core generator                                                      */
/* ------------------------------------------------------------------ */

export function generate(rawParams) {
  const p = normalizeParams(rawParams);
  const rng = mulberry32(p.seed);
  const H = p.stories * STORY_H;      // wall height
  const W = p.width, D = p.depth;

  // 1-cell margin around the footprint (room for the front stoop).
  const OX = 1, OZ = 1;
  const GX = W + 2, GZ = D + 2;
  const roofExtra = Math.ceil(Math.max(W, D) / 2) + 4;
  const GY = H + roofExtra + 4;

  const grid = new Uint8Array(GX * GY * GZ);
  const idx = (x, y, z) => (y * GZ + z) * GX + x;
  const at = (x, y, z) => grid[idx(x, y, z)];
  const set = (x, y, z, v) => { grid[idx(x, y, z)] = v; };
  // local footprint coords -> global
  const gx = (lx) => lx + OX;
  const gz = (lz) => lz + OZ;

  const stats = { contradictions: 0, windows: 0, collapsedCells: 0 };

  /* ---- 1. Floor --------------------------------------------------- */
  for (let lx = 0; lx < W; lx++)
    for (let lz = 0; lz < D; lz++) set(gx(lx), 0, gz(lz), BLOCK.FLOOR);

  const isCorner = (lx, lz) =>
    (lx === 0 || lx === W - 1) && (lz === 0 || lz === D - 1);
  const isPerim = (lx, lz) =>
    lx === 0 || lx === W - 1 || lz === 0 || lz === D - 1;

  /* ---- 2. Walls / trim / pillars (pre-collapsed) ------------------ */
  for (let s = 0; s < p.stories; s++) {
    const y0 = s * STORY_H + 1; // rows y0, y0+1, y0+2
    for (let lx = 0; lx < W; lx++) {
      for (let lz = 0; lz < D; lz++) {
        if (!isPerim(lx, lz)) continue;
        for (let y = y0; y < y0 + STORY_H; y++) {
          let v = BLOCK.WALL;
          if (isCorner(lx, lz)) v = p.pillars ? BLOCK.PILLAR : BLOCK.WALL;
          else if (y === y0 + STORY_H - 1) v = BLOCK.WALL_TRIM; // story cap
          set(gx(lx), y, gz(lz), v);
        }
      }
    }
  }

  /* ---- 3. Door + stoop (pre-collapsed) ----------------------------- */
  let doorX = -1;
  if (p.door) {
    doorX = Math.floor((W - 1) / 2);
    set(gx(doorX), 1, gz(0), BLOCK.DOOR);
    set(gx(doorX), 2, gz(0), BLOCK.DOOR);
    set(gx(doorX), 0, gz(-1), BLOCK.STAIRS); // stoop in the margin row
  }

  /* ---- 4. WFC over wall faces --------------------------------------
   * Cells: non-corner perimeter cells in the lower two rows of each
   * story (the top row is trim). Domain: {WALL, WINDOW}.
   * Authored adjacency/support rules:
   *   R1  WINDOW needs solid support above and below
   *       (above/below must be WALL, WALL_TRIM, PILLAR, or WINDOW —
   *        never AIR, FLOOR, or DOOR).
   *   R2  WINDOW may not sit next to a DOOR (in-face orthogonal).
   *   R3  WINDOWs may not share an in-face edge with another WINDOW
   *       (enforced by propagation: collapsing WINDOW deletes WINDOW
   *        from the 4 in-face neighbours' domains).
   * Density comes from the weighted pick, not the rules.
   */
  const faces = [
    // u runs along the face; (u,y) -> global coords
    { uMin: 1, uMax: W - 2, toXYZ: (u, y) => [gx(u), y, gz(0)] },       // front
    { uMin: 1, uMax: W - 2, toXYZ: (u, y) => [gx(u), y, gz(D - 1)] },   // back
    { uMin: 1, uMax: D - 2, toXYZ: (u, y) => [gx(0), y, gz(u)] },       // left
    { uMin: 1, uMax: D - 2, toXYZ: (u, y) => [gx(W - 1), y, gz(u)] },   // right
  ];

  const SOLID_BELOW = new Set([BLOCK.WALL, BLOCK.WALL_TRIM, BLOCK.PILLAR, BLOCK.WINDOW]);
  const SOLID_ABOVE = new Set([BLOCK.WALL, BLOCK.WALL_TRIM, BLOCK.PILLAR, BLOCK.WINDOW]);

  const cells = [];
  const cellAt = new Map(); // "face:u:y" -> cell
  faces.forEach((f, fi) => {
    for (let s = 0; s < p.stories; s++) {
      const y0 = s * STORY_H + 1;
      for (let y = y0; y < y0 + STORY_H - 1; y++) { // lower two rows only
        for (let u = f.uMin; u <= f.uMax; u++) {
          const [X, Y, Z] = f.toXYZ(u, y);
          if (at(X, Y, Z) !== BLOCK.WALL) continue; // skip pre-collapsed (door)
          const domain = new Set([BLOCK.WALL, BLOCK.WINDOW]);
          // R1: support check (above/below are pre-collapsed, so init-time)
          if (!SOLID_BELOW.has(at(X, Y - 1, Z))) domain.delete(BLOCK.WINDOW);
          if (!SOLID_ABOVE.has(at(X, Y + 1, Z))) domain.delete(BLOCK.WINDOW);
          // R2: not adjacent to a door (doors are pre-collapsed)
          const probe = (uu, yy) => {
            if (uu < f.uMin || uu > f.uMax) return BLOCK.AIR;
            const [PX, PY, PZ] = f.toXYZ(uu, yy);
            return at(PX, PY, PZ);
          };
          if (probe(u - 1, y) === BLOCK.DOOR || probe(u + 1, y) === BLOCK.DOOR) {
            domain.delete(BLOCK.WINDOW);
          }
          const cell = { fi, u, y, X, Y, Z, domain, state: null };
          cells.push(cell);
          cellAt.set(fi + ':' + u + ':' + y, cell);
        }
      }
    }
  });

  const neighbours = (c) => {
    const f = faces[c.fi];
    const out = [];
    for (const [du, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const n = cellAt.get(c.fi + ':' + (c.u + du) + ':' + (c.y + dy));
      if (n && n !== c) out.push(n);
    }
    return out;
  };

  const mirrorOf = (c) => {
    if (!p.symmetry) return null;
    const f = faces[c.fi];
    const um = (f.uMin + f.uMax) - c.u; // mirror across face center
    if (um === c.u) return null;
    return cellAt.get(c.fi + ':' + um + ':' + c.y) || null;
  };

  function collapseCell(c, state) {
    c.state = state;
    c.domain = new Set([state]);
    set(c.X, c.Y, c.Z, state);
    stats.collapsedCells++;
    if (state === BLOCK.WINDOW) stats.windows++;
    // R3 propagation
    if (state === BLOCK.WINDOW) {
      for (const n of neighbours(c)) {
        if (n.state === null && n.domain.has(BLOCK.WINDOW)) {
          n.domain.delete(BLOCK.WINDOW);
          if (n.domain.size === 0) {
            // Contradiction: fall back to WALL (keeps generation total).
            stats.contradictions++;
            collapseCell(n, BLOCK.WALL);
          }
        }
      }
    }
  }

  const WALL_W = 1.0;
  const WIN_W = Math.max(0, p.windowDensity) * 2.0;

  let guard = cells.length * 4 + 100;
  while (guard-- > 0) {
    let best = null;
    let bestSize = Infinity;
    // lowest-entropy pick (ties broken randomly via reservoir sampling)
    let ties = 0;
    for (const c of cells) {
      if (c.state !== null) continue;
      const s = c.domain.size;
      if (s < bestSize) { bestSize = s; best = c; ties = 1; }
      else if (s === bestSize) { ties++; if (rng() < 1 / ties) best = c; }
    }
    if (!best) break; // done
    let state;
    if (best.domain.size === 0) {
      stats.contradictions++;
      state = BLOCK.WALL;
    } else if (!best.domain.has(BLOCK.WINDOW) || WIN_W <= 0) {
      state = BLOCK.WALL;
    } else if (!best.domain.has(BLOCK.WALL)) {
      state = BLOCK.WINDOW;
    } else {
      state = rng() * (WALL_W + WIN_W) < WIN_W ? BLOCK.WINDOW : BLOCK.WALL;
    }
    collapseCell(best, state);
    // symmetry: mirror the pick across the face center axis
    const m = mirrorOf(best);
    if (m && m.state === null && m.domain.has(state)) collapseCell(m, state);
  }

  /* ---- 5. Roof ----------------------------------------------------- */
  const eaveY = H + 1;
  const fillColumn = (lx, lz, topY, ridge) => {
    for (let y = eaveY; y <= topY; y++) {
      set(gx(lx), y, gz(lz), y === topY && ridge ? BLOCK.ROOF_RIDGE : BLOCK.ROOF);
    }
  };

  if (p.roofStyle === 'flat') {
    for (let lx = 0; lx < W; lx++)
      for (let lz = 0; lz < D; lz++) set(gx(lx), eaveY, gz(lz), BLOCK.ROOF);
    if (p.crenellation) {
      // merlons: every other perimeter cell + corners
      for (let lx = 0; lx < W; lx++) {
        for (let lz = 0; lz < D; lz++) {
          if (!isPerim(lx, lz)) continue;
          const corner = isCorner(lx, lz);
          if (corner || (lx + lz) % 2 === 0) set(gx(lx), eaveY + 1, gz(lz), BLOCK.CRENELLATION);
        }
      }
    }
  } else if (p.roofStyle === 'gable') {
    // ridge runs along X; slopes face front/back
    const maxH = Math.floor((D - 1) / 2);
    for (let lx = 0; lx < W; lx++) {
      for (let lz = 0; lz < D; lz++) {
        const h = Math.min(lz, D - 1 - lz);
        fillColumn(lx, lz, eaveY + h, h === maxH);
      }
    }
  } else {
    // hip: slopes on all four sides
    const maxH = Math.min(Math.floor((W - 1) / 2), Math.floor((D - 1) / 2));
    for (let lx = 0; lx < W; lx++) {
      for (let lz = 0; lz < D; lz++) {
        const h = Math.min(lx, W - 1 - lx, lz, D - 1 - lz);
        fillColumn(lx, lz, eaveY + h, h === maxH);
      }
    }
  }

  /* ---- 6. Chimney --------------------------------------------------- */
  if (p.chimney) {
    const clx = Math.max(1, W - 2), clz = Math.floor(D / 2);
    const X = gx(clx), Z = gz(clz);
    let top = -1;
    for (let y = GY - 1; y >= 0; y--) {
      if (at(X, y, Z) !== BLOCK.AIR) { top = y; break; }
    }
    if (top > 0) {
      for (let y = top + 1; y <= top + 3 && y < GY; y++) set(X, y, Z, BLOCK.CHIMNEY);
    }
  }

  /* ---- 7. Connection points (generic portals for the Phase 2 composer) --
   * Domain-agnostic attachment points: { x, y, z, dir:[dx,dz], kind }.
   * 'opening' = a real hole in the shell (door, cave mouth...);
   * 'potential' = a plausible place a connector could attach later.
   * Coordinates are in grid space. Future tilesets author their own.
   */
  const connectionPoints = [];
  if (p.door && doorX >= 0) {
    connectionPoints.push({
      x: gx(doorX), y: 1, z: gz(0), dir: [0, -1], kind: 'opening',
    });
  }
  // face-center ground cells as potential connectors (skip the door face spot)
  const faceCenters = [
    { lx: Math.floor((W - 1) / 2), lz: 0, dir: [0, -1] },
    { lx: Math.floor((W - 1) / 2), lz: D - 1, dir: [0, 1] },
    { lx: 0, lz: Math.floor((D - 1) / 2), dir: [-1, 0] },
    { lx: W - 1, lz: Math.floor((D - 1) / 2), dir: [1, 0] },
  ];
  for (const f of faceCenters) {
    if (p.door && f.lx === doorX && f.lz === 0) continue; // door is the opening
    connectionPoints.push({
      x: gx(f.lx), y: 1, z: gz(f.lz), dir: f.dir, kind: 'potential',
    });
  }

  return {
    grid,
    W: GX, H: GY, D: GZ,   // grid dimensions (include 1-cell margin)
    footprint: { w: W, d: D, stories: p.stories, wallH: H },
    params: p,
    seed: p.seed,
    tilesetVersion: TILESET_VERSION,
    connectionPoints,
    stats,
  };
}

/* ------------------------------------------------------------------ */
/* Batch + scoring                                                     */
/* ------------------------------------------------------------------ */

/** Generate n candidates from params; seeds derive from params.seed. */
export function generateCandidates(params, n = 4) {
  const p = normalizeParams(params);
  const baseSeed = p.seed;
  const candidates = [];
  for (let i = 0; i < n; i++) {
    candidates.push(generate({ ...p, seed: (baseSeed + i * 7919) | 0 }));
  }
  return candidates;
}

// PHASE 2 INTEGRATION POINT (Jev curation):
//   Replace this stub with a call to Jev's `score` endpoint. Intended flow:
//     1. render each candidate to 2-3 views (isometric PNG dataURLs),
//     2. score against a rubric, e.g.
//        { structuralCoherence, promptMatch, silhouette, detailBalance },
//     3. keep top-k, surface the rest as alternates.
//   The stub preserves call-shape so app.js needs no changes later.
export function scoreCandidates(candidates /*, rubric */) {
  console.info(
    '[jev-stub] scoreCandidates: Jev curation not wired up (Phase 2). ' +
    'Returning candidates unscored.'
  );
  return candidates.map((c) => ({ ...c, score: null }));
}
