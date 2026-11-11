import test from "node:test";
import assert from "node:assert/strict";
import { Room, validateSettings } from "../lan/room.mjs";
import {
  RULES,
  move,
  sanitizeInput,
  findPath,
  rayBox,
} from "../lan/shared.mjs";
const map = {
  bounds: { minX: -20, maxX: 20, minZ: -20, maxZ: 20 },
  boxes: [],
  spawns: [
    { x: 0, y: 0, z: 10 },
    { x: 0, y: 0, z: -10 },
  ],
  nav: {
    width: 5,
    height: 5,
    minX: -2,
    minZ: -2,
    cell: 1,
    walkable: Array(25).fill(1),
  },
};
const make = (capacity = 2, fillBots = false) =>
  new Room("123456", { capacity, fillBots }, structuredClone(map));
const advance = (room, seconds) => {
  for (let n = 0; n < Math.ceil(seconds * 30); n++) room.tick(1 / 30);
};
function duel() {
  const r = make();
  const a = r.add("a", "A"),
    b = r.add("b", "B");
  r.start("a");
  Object.assign(a, { x: 0, y: 0, z: 5, shieldUntil: 0 });
  Object.assign(b, { x: 0, y: 0, z: -5, shieldUntil: 0 });
  return { r, a, b };
}

test("capacity strictly accepts 2–10 and host controls configuration", () => {
  for (const capacity of [1, 11, 2.1, NaN, Infinity, undefined])
    assert.throws(() => validateSettings({ capacity }));
  for (let n = 2; n <= 10; n++)
    assert.equal(validateSettings({ capacity: n }).capacity, n);
  const r = make(10, true);
  r.add("host", "Host");
  assert.equal(r.players.size, 10);
  assert.equal(r.humans().length, 1);
  for (let i = 0; i < 9; i++) r.add("p" + i, "Player");
  assert.equal(r.humans().length, 10);
  assert.equal(r.players.size, 10);
  assert.throws(() => r.add("extra", "Extra"), /已满/);
  assert.throws(() => r.configure("p0", { capacity: 10 }), /房主/);
  assert.throws(() => r.configure("host", { capacity: 9 }), /真人/);
});
test("bots replace empty seats, host transfers and empty rooms clear", () => {
  const r = make(4, true);
  r.add("a", "A");
  r.add("b", "B");
  r.start("a");
  assert.equal(r.players.size, 4);
  r.remove("a");
  assert.equal(r.hostId, "b");
  assert.equal(r.players.size, 4);
  assert.equal([...r.players.values()].filter((p) => p.bot).length, 3);
  r.add("c", "C");
  assert.equal(r.players.size, 4);
  assert.equal(r.players.get("c").health, 100);
  r.remove("b");
  r.remove("c");
  assert.equal(r.players.size, 0);
  assert.equal(r.hostId, null);
});
test("minimum participants, no-bot waiting, finish after disconnect, rematch", () => {
  const r = make();
  r.add("a", "A");
  assert.throws(() => r.start("a"), /至少/);
  r.add("b", "B");
  r.start("a");
  assert.throws(
    () => r.configure("a", { capacity: 10, fillBots: true }),
    /对局中/,
  );
  assert.throws(() => r.start("b"), /房主/);
  r.remove("b");
  assert.equal(r.phase, "finished");
  r.configure("a", { capacity: 2, fillBots: true });
  r.start("a");
  assert.equal(r.phase, "playing");
  assert.equal(r.round, 2);
});
test("server resolves hits, death, scores, respawn and protection", () => {
  const { r, a, b } = duel();
  const dir = { x: 0, y: 0, z: -1 };
  r.shoot("a", dir);
  assert.equal(b.health, 48);
  assert.equal(a.ammo, 29);
  assert.equal(r.shoot("a", dir), false);
  advance(r, 0.1);
  r.shoot("a", dir);
  assert.equal(b.health, 0);
  assert.equal(a.kills, 1);
  assert.equal(b.deaths, 1);
  assert.equal(r.shoot("b", { x: 0, y: 0, z: 1 }), false);
  advance(r, 3.1);
  assert.equal(b.health, 100);
  assert.equal(b.ammo, 30);
  assert.ok(b.shieldUntil > r.time);
  Object.assign(b, { x: 0, y: 0, z: -5 });
  r.shoot("a", dir);
  assert.equal(b.health, 100);
  r.shoot("b", { x: 1, y: 0, z: 0 });
  assert.equal(b.shieldUntil, 0);
});
test("walls stop bullets and reload uses server time", () => {
  const { r, a, b } = duel();
  r.map.boxes.push({ min: [-2, 0, -1], max: [2, 3, 1] });
  r.shoot("a", { x: 0, y: 0, z: -1 });
  assert.equal(b.health, 100);
  r.reload("a");
  assert.ok(a.reloadAt);
  advance(r, 1);
  assert.equal(r.shoot("a", { x: 0, y: 0, z: -1 }), false);
  advance(r, 1.2);
  assert.equal(a.ammo, 30);
  assert.equal(a.reloadAt, 0);
});
test("malformed and forged shots cannot damage opponents or change state", () => {
  const { r, a, b } = duel();
  for (const direction of [
    null,
    { x: NaN, y: 0, z: 1 },
    { x: 0, y: 0, z: 100 },
    { x: "0", y: 0, z: 1 },
  ])
    assert.equal(r.shoot("a", direction), false);
  assert.equal(a.ammo, 30);
  assert.equal(b.health, 100);
  r.setInput("a", {
    x: 100,
    z: Infinity,
    yaw: NaN,
    position: { x: 500 },
    health: 10000,
  });
  advance(r, 0.05);
  assert.ok(a.x < 1);
  assert.equal(a.health, 100);
  assert.equal(a.input.x, 1);
  assert.equal(a.input.z, 0);
});
test("score limit and time limit end the round and freeze combat", () => {
  const { r, a, b } = duel();
  a.kills = RULES.scoreLimit - 1;
  b.health = 1;
  r.shoot("a", { x: 0, y: 0, z: -1 });
  assert.equal(r.phase, "finished");
  assert.equal(a.kills, 20);
  assert.equal(r.shoot("a", { x: 0, y: 0, z: -1 }), false);
  r.start("a");
  assert.equal(a.kills, 0);
  assert.equal(a.deaths, 0);
  r.endsAt = r.time + 0.01;
  r.tick(0.02);
  assert.equal(r.phase, "finished");
});
test("movement collisions, boundaries, diagonal speed and jump are shared", () => {
  const m = structuredClone(map);
  m.boxes = [{ min: [-2, 0, -2], max: [2, 3, 0] }];
  const p = { x: 0, y: 0, z: 1, vy: 0, grounded: true };
  for (let i = 0; i < 60; i++) move(p, sanitizeInput({ z: 1 }), 1 / 30, m);
  assert.ok(p.z >= 0.32 - 1e-8);
  const a = { x: 5, y: 0, z: 5, vy: 0, grounded: true },
    b = { ...a };
  move(a, sanitizeInput({ x: 1 }), 0.1, map);
  move(b, sanitizeInput({ x: 1, z: 1 }), 0.1, map);
  assert.ok(
    Math.abs(Math.hypot(a.x - 5, a.z - 5) - Math.hypot(b.x - 5, b.z - 5)) <
      1e-8,
  );
  move(a, sanitizeInput({ jump: true }), 0.1, map);
  assert.ok(a.y > 0);
  for (let i = 0; i < 90; i++)
    move(a, sanitizeInput({ x: 1, sprint: true }), 1 / 30, map);
  assert.ok(a.x <= 19.6);
  assert.equal(a.y, 0);
});
test("navigation finds a route around a blocked cell; ray slabs handle parallel rays", () => {
  const m = structuredClone(map);
  m.nav.walkable[12] = 0;
  const path = findPath({ x: -2, z: 0 }, { x: 2, z: 0 }, m);
  assert.ok(path.length > 4);
  assert.ok(path.every((p) => p.x !== 0 || p.z !== 0));
  assert.equal(
    rayBox({ x: 3, y: 1, z: 3 }, { x: 0, y: 0, z: -1 }, [-1, 0, -1], [1, 2, 1]),
    Infinity,
  );
});
test("bots move, fight, respawn and remain in valid harbor bounds", async () => {
  const { readFile } = await import("node:fs/promises");
  const harbor = JSON.parse(
    await readFile(new URL("../lan/harbor.json", import.meta.url), "utf8"),
  );
  const r = new Room("123456", { capacity: 10, fillBots: true }, harbor);
  r.add("a", "Human");
  r.start("a");
  const initial = r.snapshot();
  advance(r, 30);
  const result = r.snapshot();
  assert.equal(result.players.length, 10);
  assert.ok(result.players.some((p) => p.kills > 0));
  assert.ok(
    result.players.some(
      (p, i) =>
        Math.hypot(p.x - initial.players[i].x, p.z - initial.players[i].z) > 1,
    ),
  );
  assert.ok(
    result.players.every(
      (p) =>
        p.x >= harbor.bounds.minX &&
        p.x <= harbor.bounds.maxX &&
        p.z >= harbor.bounds.minZ &&
        p.z <= harbor.bounds.maxZ,
    ),
  );
});

test("stale movement inputs expire and shot spam cannot exceed the rate budget", () => {
  const { r, a } = duel();
  r.setInput("a", { x: 1 });
  advance(r, 1);
  const stopped = a.x;
  advance(r, 1);
  assert.equal(a.x, stopped);
  let shots = 0;
  for (let frame = 0; frame < 30; frame++) {
    for (let spam = 0; spam < 20; spam++)
      if (r.shoot("a", { x: 1, y: 0, z: 0 })) shots++;
    r.tick(1 / 30);
  }
  assert.ok(shots <= 14); // 12 rounds/sec plus at most two stored credits.
  assert.ok(shots >= 12);
  assert.equal(a.ammo, RULES.magazine - shots);
});

test("invalid input objects and control characters in names are harmless", () => {
  assert.equal(sanitizeInput(null).x, 0);
  assert.throws(() => validateSettings(null), /格式/);
  const r = make();
  const p = r.add("a", "<name>\u0000\n");
  assert.equal(p.name, "name");
});
