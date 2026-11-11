// Shared by the authoritative server and the local movement prediction.
export const RULES = Object.freeze({
  minPlayers: 2,
  maxPlayers: 10,
  tickRate: 30,
  scoreLimit: 20,
  duration: 300,
  respawn: 3,
  protection: 2,
  magazine: 30,
  shotInterval: 60 / 720,
  damage: 26,
  reload: 2.1,
  emptyReload: 2.72,
});
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
export const eye = (p) => ({
  x: p.x,
  y: p.y + (p.crouch ? 1.05 : 1.68),
  z: p.z,
});
export function sanitizeInput(input = {}) {
  if (!input || typeof input !== "object") input = {};
  const number = (v, min, max) =>
    typeof v === "number" && Number.isFinite(v) ? clamp(v, min, max) : 0;
  return {
    x: number(input.x, -1, 1),
    z: number(input.z, -1, 1),
    yaw: number(input.yaw, -100, 100),
    pitch: number(input.pitch, -1.5, 1.5),
    jump: input.jump === true,
    crouch: input.crouch === true,
    sprint: input.sprint === true,
    ads: input.ads === true,
  };
}
export function move(p, input, dt, map) {
  p.yaw = input.yaw;
  p.pitch = input.pitch;
  // Standing up must not place the player's head inside a roof.
  const overhead = map.boxes.some(
    (b) =>
      !b.bulletOnly &&
      p.x > b.min[0] - 0.32 &&
      p.x < b.max[0] + 0.32 &&
      p.z > b.min[2] - 0.32 &&
      p.z < b.max[2] + 0.32 &&
      b.min[1] < p.y + 1.8 &&
      b.max[1] > p.y + 1.15,
  );
  p.crouch = input.crouch || (p.crouch && overhead);
  const height = p.crouch ? 1.15 : 1.8;
  const speed = p.crouch ? 2.3 : input.ads ? 2.8 : input.sprint ? 6.4 : 3.8;
  const norm = Math.max(1, Math.hypot(input.x, input.z));
  const sx = input.x / norm,
    sz = input.z / norm;
  const dx = (sx * Math.cos(p.yaw) - sz * Math.sin(p.yaw)) * speed * dt;
  const dz = (-sx * Math.sin(p.yaw) - sz * Math.cos(p.yaw)) * speed * dt;
  const oldY = p.y;
  if (input.jump && !p.jumpHeld && p.grounded && !p.crouch) {
    p.vy = 7;
    p.grounded = false;
  }
  p.jumpHeld = input.jump;
  p.vy = (p.vy || 0) - 20 * dt;
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / 0.15));
  for (let step = 0; step < steps; step++) {
    p.x += dx / steps;
    p.z += dz / steps;
    for (let pass = 0; pass < 3; pass++)
      for (const b of map.boxes) {
        if (
          b.bulletOnly ||
          b.max[1] <= p.y + (p.grounded ? 0.28 : 0.08) ||
          b.min[1] >= p.y + height
        )
          continue;
        const nx = clamp(p.x, b.min[0], b.max[0]),
          nz = clamp(p.z, b.min[2], b.max[2]);
        const ox = p.x - nx,
          oz = p.z - nz,
          d = Math.hypot(ox, oz);
        if (d >= 0.32) continue;
        if (d > 0.00001) {
          p.x += (ox / d) * (0.32 - d);
          p.z += (oz / d) * (0.32 - d);
        } else {
          const edges = [
            p.x - b.min[0],
            b.max[0] - p.x,
            p.z - b.min[2],
            b.max[2] - p.z,
          ];
          const side = edges.indexOf(Math.min(...edges));
          if (side === 0) p.x = b.min[0] - 0.32;
          if (side === 1) p.x = b.max[0] + 0.32;
          if (side === 2) p.z = b.min[2] - 0.32;
          if (side === 3) p.z = b.max[2] + 0.32;
        }
      }
  }
  p.x = clamp(p.x, map.bounds.minX + 0.4, map.bounds.maxX - 0.4);
  p.z = clamp(p.z, map.bounds.minZ + 0.4, map.bounds.maxZ - 0.4);
  let floor = 0,
    ceiling = Infinity;
  for (const b of map.boxes) {
    if (
      b.bulletOnly ||
      p.x + 0.22 < b.min[0] ||
      p.x - 0.22 > b.max[0] ||
      p.z + 0.22 < b.min[2] ||
      p.z - 0.22 > b.max[2]
    )
      continue;
    if (b.max[1] <= oldY + (p.grounded ? 0.28 : 0.08) + 0.0001)
      floor = Math.max(floor, b.max[1]);
    if (b.min[1] >= oldY + height - 0.05) ceiling = Math.min(ceiling, b.min[1]);
  }
  p.y += p.vy * dt;
  if (p.vy > 0 && p.y + height > ceiling) {
    p.y = ceiling - height;
    p.vy = 0;
  }
  p.grounded = p.y <= floor;
  if (p.grounded) {
    p.y = floor;
    p.vy = 0;
  }
}
export function rayBox(origin, dir, min, max, range = 300) {
  let near = 0,
    far = range;
  for (let axis = 0; axis < 3; axis++) {
    const k = ["x", "y", "z"][axis],
      o = origin[k],
      d = dir[k];
    if (Math.abs(d) < 1e-9) {
      if (o < min[axis] || o > max[axis]) return Infinity;
      continue;
    }
    let a = (min[axis] - o) / d,
      b = (max[axis] - o) / d;
    if (a > b) [a, b] = [b, a];
    near = Math.max(near, a);
    far = Math.min(far, b);
    if (near > far) return Infinity;
  }
  return near;
}
export function wallDistance(origin, dir, map, range = 300) {
  let best = range;
  for (const b of map.boxes)
    if (!b.playerOnly)
      best = Math.min(best, rayBox(origin, dir, b.min, b.max, best));
  return best;
}
export function canSee(a, b, map) {
  const o = eye(a),
    target = eye(b),
    d = { x: target.x - o.x, y: target.y - o.y, z: target.z - o.z };
  const len = Math.hypot(d.x, d.y, d.z);
  if (!len) return true;
  for (const k of ["x", "y", "z"]) d[k] /= len;
  return wallDistance(o, d, map, len) >= len - 0.05;
}
// Grid paths use the same exported navigation mask as the original harbor.
export function findPath(from, to, map) {
  const { width: w, height: h, minX, minZ, cell, walkable } = map.nav;
  const index = (p) =>
    clamp(Math.round((p.z - minZ) / cell), 0, h - 1) * w +
    clamp(Math.round((p.x - minX) / cell), 0, w - 1);
  const nearest = (start) => {
    if (walkable[start]) return start;
    for (let r = 1; r < 8; r++)
      for (let z = -r; z <= r; z++)
        for (let x = -r; x <= r; x++) {
          const nx = (start % w) + x,
            nz = Math.floor(start / w) + z,
            n = nz * w + nx;
          if (nx >= 0 && nx < w && nz >= 0 && nz < h && walkable[n]) return n;
        }
    return -1;
  };
  const start = nearest(index(from)),
    end = nearest(index(to));
  if (start < 0 || end < 0) return [];
  const prev = new Int32Array(w * h).fill(-1),
    queue = [start];
  prev[start] = start;
  for (let n = 0; n < queue.length && prev[end] < 0; n++) {
    const cur = queue[n],
      x = cur % w,
      z = Math.floor(cur / w);
    for (const [dx, dz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const nx = x + dx,
        nz = z + dz,
        next = nz * w + nx;
      if (
        nx < 0 ||
        nx >= w ||
        nz < 0 ||
        nz >= h ||
        !walkable[next] ||
        prev[next] >= 0
      )
        continue;
      prev[next] = cur;
      queue.push(next);
    }
  }
  if (prev[end] < 0) return [];
  const path = [];
  for (let cur = end; cur !== start; cur = prev[cur])
    path.push({
      x: minX + (cur % w) * cell,
      z: minZ + Math.floor(cur / w) * cell,
    });
  return path.reverse();
}
