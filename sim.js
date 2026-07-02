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
  S.POINT_DIST   = 1.6;
  S.WIDTH_BASE   = 15.0;
  S.WIDTH_DEN    = 700;
  S.WIDTH_SCMAX  = 6.0;
  S.BODY_SCALE   = 0.63;      // visual + collision scale — the ONE number both derive from
  S.SEG_MULT     = 4;
  S.START_SIZE   = 100;
  S.BOOST_BURN_PCT_SEC = 0.108; // proportional boost mass drain (fraction of size / sec)
  S.BOOST_MIN_SIZE     = 20;    // below this, boosting is impossible
  S.TICK_RATE    = 50;
  S.TICK_MS      = 1000 / S.TICK_RATE;      // 20 ms
  S.DT_SCALE     = 60 / S.TICK_RATE;        // 1.2 — "60fps frames" of motion per tick
  S.SEGMENT_SPACING_TICKS = 4;              // H2B body-path stride

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

  // ── Geometry (the single radius definition) ─────────────────────────────────
  // Linear-in-length thickness, capped at WIDTH_SCMAX, exactly as the server has
  // always computed it. The client renders at snakeRadius() so hitbox == drawing.
  S.snakeThickness = function (len) {
    return S.WIDTH_BASE * Math.min(1 + ((len || 100) - S.START_SIZE) / S.WIDTH_DEN, S.WIDTH_SCMAX);
  };
  S.snakeRadius = function (len) { return S.snakeThickness(len) * S.BODY_SCALE; };
  S.bodyHitR    = function (len) { return S.snakeRadius(len) * S.HITBOX_MULT; };
  S.headHitR    = function (len) { return S.snakeRadius(len) * S.HITBOX_MULT * S.HEAD_MULT; };
  S.segmentsForSize = function (len) { return Math.max(20, Math.floor((len || 40) * S.SEG_MULT)); };

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
    var spd = S.BASE_SPEED * S.DT_SCALE;
    if (sn.boosting) {
      spd *= S.BOOST_MULT;
      var burn = sn.length * S.BOOST_BURN_PCT_SEC * (S.DT_SCALE / 60);
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
    var lim = Math.min(S.segmentsForSize(target.length || 40), 1200);
    var segs = target.segs || [];
    for (var k = 2; k < lim; k++) {
      var seg = segs[k * S.SEGMENT_SPACING_TICKS];
      if (!seg) break;
      if (S.dist2(attacker.x, attacker.y, seg.x, seg.y) < r2
          || S.segHitsCircle(ap.x, ap.y, attacker.x, attacker.y, seg.x, seg.y, r)) return true;
    }
    return false;
  };

  // Food pickup: head circle vs food circle (rendered radius + food radius).
  S.foodContact = function (sn, f) {
    var r = S.snakeRadius(sn.length) + f.r;
    return S.dist2(sn.x, sn.y, f.x, f.y) < r * r;
  };

  // Is a snake past its spawn grace (may now kill / be killed)?
  S.combatReady = function (sn, nowMs) { return (nowMs - (sn.spawnTs || 0)) >= S.COLLISION_GRACE_MS; };

  return S;
});
