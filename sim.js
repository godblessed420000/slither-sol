/**
 * SlitherSOL — SHARED DETERMINISTIC SIMULATION + COLLISION MODULE
 * ===============================================================
 * SINGLE SOURCE OF TRUTH for every gameplay number and every piece of collision
 * math. Loaded verbatim by BOTH runtimes:
 *   • server  — `const SIM = require('./sim.js')`   (authoritative, 50 Hz)
 *   • client  — `<script src="sim.js"></script>` → global `SIM`
 *
 * RULES (do not break these):
 *   1. This file must be byte-identical in game-server/ and slither-sol-deploy/.
 *      The determinism harness (sim.test.js) asserts it.
 *   2. No collision or movement math may live anywhere else. Callers only
 *      orchestrate (loop over snakes, apply deaths) — they never compute radii,
 *      distances, gates, or integrate motion themselves.
 *   3. Every function here is PURE w.r.t. its inputs except stepSnake/_moveSnake,
 *      which deterministically mutate the passed snake. Given the same snake
 *      state + input + world, they always produce the same result — this is what
 *      makes client prediction and server authority converge bit-for-bit.
 */
(function (root, factory) {
  var SIM = factory();
  if (typeof module === 'object' && module.exports) module.exports = SIM;
  else root.SIM = SIM;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var S = {};

  // ── Physics constants — matched to moneyslither.com (user-extracted bundle) ───
  // Per-second values are BASE × DT_SCALE × TICK_RATE = BASE × 60 (DT_SCALE×TICK_RATE
  // is always 60). moneyslither targets: speed 288 px/s, boost 630 px/s (2.1875×),
  // turn 8.22 rad/s (0.274 rad/tick @ their 30 TPS) → auto-circle radius ≈ 35 px.
  S.BASE_SPEED   = 4.8;      // 4.8 × 60 = 288 px/s  (moneyslither SNAKE_SPD)
  S.BOOST_MULT   = 2.1875;   // 288 × 2.1875 = 630 px/s (moneyslither BOOST_SPD)
  S.TURN_RATE    = 0.137;    // 0.137 × 60 = 8.22 rad/s (moneyslither MAX_TURN, rate-matched)
  S.POINT_DIST   = 1.6;      // movement-path resample density (internal; body links derive from it)
  // Legacy width constants — used ONLY by the client auto-zoom feel math now;
  // the actual snake radius comes from the moneyslither curve below.
  S.WIDTH_BASE   = 15.0;
  S.WIDTH_DEN    = 700;
  S.WIDTH_SCMAX  = 6.0;
  S.BODY_SCALE   = 0.63;
  S.SEG_MULT     = 4;        // legacy (lobby size-stat display only)
  S.TICK_RATE    = 60;       // user requested 60 TPS (moneyslither runs 30; per-second values identical)
  S.TICK_MS      = 1000 / S.TICK_RATE;      // 16.67 ms
  S.DT_SCALE     = 60 / S.TICK_RATE;        // 1.0 — "60fps frames" of motion per tick

  // ── moneyslither/damnbruh size & body model (user-extracted constants) ───────
  // length is measured in SECTIONS. size = sections × SIZE_PER_SEGMENT.
  //   radius   = BASE_RADIUS + size^RADIUS_GROWTH × RADIUS_SCALE
  //   spacing  = radius × SEGMENT_SPACING  (body link spacing — VARIABLE, grows with girth)
  //   sections = the number of body links (start 24, +2 per food, boost floor 12)
  S.SIZE_PER_SEGMENT = 5;
  S.SEGMENT_SPACING  = 0.5;
  S.BASE_RADIUS      = 8;
  S.RADIUS_GROWTH    = 0.6;
  S.RADIUS_SCALE     = 0.8;
  S.INIT_SECTIONS    = 24;    // starting length
  S.MIN_SECTIONS     = 8;     // absolute floor
  S.MAX_SECTIONS     = 300;   // hard cap (paid lobbies: min(300, floor(usd×70)))
  S.FOOD_GROW        = 2;     // sections per food orb
  S.FOOD_TARGET      = 135;   // orbs on map
  S.FOOD_PICKUP_R    = 29;    // pickup reach beyond snake radius
  S.KILL_FOOD_PICKUP_R = 42;  // kill-food (SOL drop) reach beyond snake radius
  S.SHED_NOEAT_MS    = 4000;  // can't re-eat own boost-shed pebbles for this long
  // Boost drain: 3.0 sections per 8 ticks @30TPS = 0.375/tick = 11.25 sections/sec.
  // Expressed per-second so it is tick-rate independent at our 60 TPS.
  S.BOOST_DRAIN_SECTIONS_PER_SEC = 11.25;
  S.BOOST_MIN_SIZE   = 12;    // boost stops draining below this many sections

  // ── Unified collision knobs (V405) ──────────────────────────────────────────
  // collision(body) radius = renderedRadius × HITBOX_MULT
  // collision(head) radius = collision(body) radius × HEAD_MULT
  // moneyslither combat hitboxes (user-extracted): SS_HB=0.95, SS_HBS=1.07, SS_HHBS=1.18.
  //   body hitbox = renderedRadius × 0.95 × 1.07       = ×1.0165
  //   head hitbox = renderedRadius × 0.95 × 1.07 × 1.18 = ×1.1995
  // Restores moneyslither's die-before-touch (user chose "match moneyslither exactly").
  S.HITBOX_MULT  = 0.95 * 1.07;   // 1.0165 — body hitbox vs drawn radius
  S.HEAD_MULT    = 1.18;          // head hitbox = body × 1.18
  S.FACE_DEG     = 75;    // H2H facing gate half-angle
  S.FACE_COS     = Math.cos(S.FACE_DEG * Math.PI / 180);
  S.COLLISION_GRACE_MS = 1500; // spawn grace before a snake can kill or be killed

  // ── Geometry (the single radius definition — moneyslither curve) ─────────────
  // radius = BASE_RADIUS + (sections × SIZE_PER_SEGMENT)^RADIUS_GROWTH × RADIUS_SCALE
  // The client renders at snakeRadius(), so hitbox and drawing share one source.
  S.snakeRadius = function (len) {
    var sections = Math.max(S.MIN_SECTIONS, (len || S.INIT_SECTIONS));
    return S.BASE_RADIUS + Math.pow(sections * S.SIZE_PER_SEGMENT, S.RADIUS_GROWTH) * S.RADIUS_SCALE;
  };
  // Back-compat shim: a few client call sites (zoom feel) use thickness×BODY_SCALE;
  // defining thickness = radius/BODY_SCALE keeps thickness×BODY_SCALE === radius.
  S.snakeThickness = function (len) { return S.snakeRadius(len) / S.BODY_SCALE; };
  S.bodyHitR    = function (len) { return S.snakeRadius(len) * S.HITBOX_MULT; };
  S.headHitR    = function (len) { return S.snakeRadius(len) * S.HITBOX_MULT * S.HEAD_MULT; };
  // Body-link layout: `sections` links spaced radius×0.5 apart along the movement
  // path. Internally the path is still resampled at POINT_DIST density, so links
  // are path points strided pathStride() apart — one shared definition for the
  // renderer, the H2B collision pass, and the server's path transmission.
  S.segSpacing   = function (len) { return S.snakeRadius(len) * S.SEGMENT_SPACING; };
  S.pathStride   = function (len) { return Math.max(1, Math.round(S.segSpacing(len) / S.POINT_DIST)); };
  S.bodySections = function (len) { return Math.max(2, Math.floor(len || S.INIT_SECTIONS)); };
  // Total PATH POINTS spanning the body (draw cap + path-buffer sizing).
  S.segmentsForSize = function (len) {
    return Math.max(20, S.bodySections(len) * S.pathStride(len));
  };

  // ── Distance + swept helpers ────────────────────────────────────────────────
  S.dist2 = function (ax, ay, bx, by) { var dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; };
  // Did the moving point (p1→p2) pass within radius r of (cx,cy)? Continuous test
  // that stops fast/boosting heads tunnelling through a hitbox between ticks.
  S.segHitsCircle = function (p1x, p1y, p2x, p2y, cx, cy, r) {
    var ex = p2x - p1x, ey = p2y - p1y;
    var fx = p1x - cx,  fy = p1y - cy;
    var a  = ex * ex + ey * ey;
    if (a < 1e-6) return fx * fx + fy * fy <= r * r;
    var b  = 2 * (fx * ex + fy * ey);
    var cc = fx * fx + fy * fy - r * r;
    var disc = b * b - 4 * a * cc;
    if (disc < 0) return false;
    disc = Math.sqrt(disc);
    var t1 = (-b - disc) / (2 * a), t2 = (-b + disc) / (2 * a);
    return (t1 >= 0 && t1 <= 1) || (t2 >= 0 && t2 <= 1) || (t1 <= 0 && t2 >= 1);
  };

  // ── Movement (one canonical integrator) ─────────────────────────────────────
  // Advances the head one wrapped step and lays down body points at exactly
  // POINT_DIST spacing via arc-length resampling. Mutates sn.{x,y,segs,_segAccum}.
  S._moveSnake = function (sn, spd, world) {
    var cx = Math.cos(sn.angle), cy = Math.sin(sn.angle);
    var px = sn.x, py = sn.y;
    sn.x = ((px + cx * spd) % world + world) % world;
    sn.y = ((py + cy * spd) % world + world) % world;
    var d0  = sn._segAccum || 0;
    var tot = d0 + spd;
    var nk  = Math.floor(tot / S.POINT_DIST);
    var maxS = Math.max(S.segmentsForSize(sn.length || 40) + 60, 80);
    if (!sn.segs) sn.segs = [];
    for (var j = 1; j <= nk; j++) {
      var t  = (j * S.POINT_DIST - d0) / spd;
      var sx = ((px + cx * spd * t) % world + world) % world;
      var sy = ((py + cy * spd * t) % world + world) % world;
      sn.segs.unshift({ x: sx, y: sy });
      if (sn.segs.length > maxS) sn.segs.pop();
    }
    sn._segAccum = tot - nk * S.POINT_DIST;
  };

  // Advance a snake by EXACTLY one 50 Hz tick given a direction+boost input.
  // This is the whole of a snake's per-tick physics; server and client both call
  // it, so a client stepping N fixed ticks lands on the server's exact state.
  // input = { a: targetAngleRadians, b: boostHeld }
  S.stepSnake = function (sn, input, world) {
    var aim = (input && input.a != null) ? input.a : sn.angle;
    var da = aim - sn.angle;
    while (da >  Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    sn.angle += Math.sign(da) * Math.min(Math.abs(da), S.TURN_RATE * S.DT_SCALE);

    sn.boosting = !!(input && input.b) && sn.length > S.BOOST_MIN_SIZE;
    // _spdMult: optional per-snake speed factor (default 1). Bots set it <1 to move
    // slower; nothing else sets it, so players + the determinism harness are unchanged.
    var spd = S.BASE_SPEED * S.DT_SCALE * (sn._spdMult || 1);
    if (sn.boosting) {
      spd *= S.BOOST_MULT;
      // moneyslither drain: CONSTANT rate (11.25 sections/sec), floored at
      // BOOST_MIN_SIZE — not proportional to size.
      var burn = S.BOOST_DRAIN_SECTIONS_PER_SEC / S.TICK_RATE;
      sn.length = Math.max(S.BOOST_MIN_SIZE, sn.length - burn);
    }
    sn.headR = S.snakeRadius(sn.length);

    // Pre-move head position — lets collision sweep the head's path this tick.
    sn._prevX = sn.x;
    sn._prevY = sn.y;
    S._moveSnake(sn, spd, world);
  };

  // ── Collision predicates (the only place this math exists) ──────────────────
  function prevOf(sn) {
    return { x: sn._prevX != null ? sn._prevX : sn.x, y: sn._prevY != null ? sn._prevY : sn.y };
  }

  // Head-to-head contact: static overlap OR either head swept across the other.
  S.h2hContact = function (a, b) {
    var r = S.headHitR(a.length) + S.headHitR(b.length);
    if (S.dist2(a.x, a.y, b.x, b.y) <= r * r) return true;
    var ap = prevOf(a), bp = prevOf(b);
    return S.segHitsCircle(ap.x, ap.y, a.x, a.y, b.x, b.y, r)
        || S.segHitsCircle(bp.x, bp.y, b.x, b.y, a.x, a.y, r);
  };

  // H2H facing gate: BOTH snakes must aim at each other within FACE_DEG.
  S.facingGateOpen = function (a, b) {
    var dx = b.x - a.x, dy = b.y - a.y;
    var d  = Math.sqrt(dx * dx + dy * dy) || 1;
    var aDot = Math.cos(a.angle) * (dx / d)  + Math.sin(a.angle) * (dy / d);
    var bDot = Math.cos(b.angle) * (-dx / d) + Math.sin(b.angle) * (-dy / d);
    return aDot >= S.FACE_COS && bDot >= S.FACE_COS;
  };

  // Deterministic H2H resolution — returns the LOSER's id. Smaller dies; on a tie
  // the smaller id loses (identical on every client and the server → never both).
  S.h2hLoser = function (aLen, aId, bLen, bId) {
    if (aLen < bLen) return aId;
    if (bLen < aLen) return bId;
    return aId < bId ? aId : bId;
  };

  // Head-to-body: does the attacker's head (static or swept) reach any of the
  // target's collidable body points? Strided sampling identical to the server.
  // attacker: {x,y,_prevX,_prevY,length}; target: {segs,length}
  S.headHitsBody = function (attacker, target) {
    var r  = S.headHitR(attacker.length) + S.bodyHitR(target.length);
    var r2 = r * r;
    var ap = prevOf(attacker);
    // Body links: bodySections(target) points, spaced radius×0.5 along the path —
    // i.e. every pathStride()-th path point. Start at k=2 (skip the neck; those
    // two links sit inside the head zone and belong to the H2H referee).
    var stride = S.pathStride(target.length);
    var lim = Math.min(S.bodySections(target.length), 1200);
    var segs = target.segs || [];
    for (var k = 2; k < lim; k++) {
      var seg = segs[k * stride];
      if (!seg) break;
      if (S.dist2(attacker.x, attacker.y, seg.x, seg.y) < r2
          || S.segHitsCircle(ap.x, ap.y, attacker.x, attacker.y, seg.x, seg.y, r)) return true;
    }
    return false;
  };

  // Food pickup — moneyslither reach: snake radius + FOOD_PICKUP_R px (generous,
  // covers the orb's own size; f.r is render-only).
  S.foodContact = function (sn, f) {
    var r = S.snakeRadius(sn.length) + S.FOOD_PICKUP_R;
    return S.dist2(sn.x, sn.y, f.x, f.y) < r * r;
  };

  // Is a snake past its spawn grace (may now kill / be killed)?
  S.combatReady = function (sn, nowMs) { return (nowMs - (sn.spawnTs || 0)) >= S.COLLISION_GRACE_MS; };

  return S;
});
