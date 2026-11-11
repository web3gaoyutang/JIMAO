import { randomUUID } from "node:crypto";
import {
  RULES,
  sanitizeInput,
  move,
  eye,
  distance,
  rayBox,
  wallDistance,
  canSee,
  findPath,
} from "./shared.mjs";

export function validateSettings(settings = {}) {
  if (!settings || typeof settings !== "object")
    throw Error("房间设置格式错误。");
  const capacity = Number(settings.capacity);
  if (!Number.isInteger(capacity) || capacity < 2 || capacity > 10)
    throw Error("房间人数必须为 2–10 人。");
  return { capacity, fillBots: settings.fillBots === true };
}
export function playerName(value) {
  return typeof value === "string"
    ? value
        .replace(/[\p{C}<>]/gu, "")
        .trim()
        .slice(0, 20) || "突击队员"
    : "突击队员";
}
export class Room {
  constructor(code, settings, map, emit = () => {}) {
    this.code = code;
    this.settings = validateSettings(settings);
    this.map = map;
    this.emit = emit;
    this.players = new Map();
    this.hostId = null;
    this.phase = "lobby";
    this.time = 0;
    this.round = 0;
    this.endsAt = 0;
    this.botNumber = 0;
    this.reason = "";
  }
  humans() {
    return [...this.players.values()].filter((p) => !p.bot);
  }
  add(id, name) {
    if (this.humans().length >= this.settings.capacity)
      throw Error("房间已满，请选择其他房间。");
    if (this.players.size >= this.settings.capacity) {
      const bot = [...this.players.values()].find((p) => p.bot);
      if (bot) this.players.delete(bot.id);
    }
    const p = this.makePlayer(id, playerName(name), false);
    this.players.set(id, p);
    this.hostId ||= id;
    if (this.phase === "playing") this.spawn(p);
    this.fill();
    return p;
  }
  makePlayer(id, name, bot) {
    return {
      id,
      name,
      bot,
      x: 0,
      y: 0,
      z: 0,
      yaw: 0,
      pitch: 0,
      vy: 0,
      crouch: false,
      grounded: true,
      health: 100,
      kills: 0,
      deaths: 0,
      ammo: RULES.magazine,
      reloadAt: 0,
      shotBudget: 1,
      respawnAt: 0,
      shieldUntil: 0,
      spawnId: 0,
      input: sanitizeInput(),
      inputAt: this.time,
      path: [],
      thinkAt: 0,
      botShotAt: 0,
    };
  }
  fill() {
    const target = this.settings.fillBots
      ? this.settings.capacity
      : this.humans().length;
    while (this.players.size > target) {
      const bot = [...this.players.values()].find((p) => p.bot);
      if (!bot) break;
      this.players.delete(bot.id);
    }
    while (this.players.size < target) {
      const bot = this.makePlayer(
        `bot-${randomUUID()}`,
        `训练机 ${++this.botNumber}`,
        true,
      );
      this.players.set(bot.id, bot);
      if (this.phase === "playing") this.spawn(bot);
    }
  }
  remove(id) {
    this.players.delete(id);
    if (this.hostId === id) this.hostId = this.humans()[0]?.id || null;
    if (!this.hostId) {
      this.players.clear();
      return;
    }
    this.fill();
    if (this.phase === "playing" && this.players.size < 2)
      this.finish("人数不足，对局结束");
  }
  configure(id, settings) {
    this.requireHost(id);
    if (this.phase === "playing") throw Error("对局中不能修改房间人数。");
    const next = validateSettings(settings);
    if (next.capacity < this.humans().length)
      throw Error("房间人数不能少于已加入的真人数量。");
    this.settings = next;
    this.fill();
  }
  requireHost(id) {
    if (this.hostId !== id) throw Error("只有房主可以执行此操作。");
  }
  start(id) {
    this.requireHost(id);
    if (this.phase === "playing") throw Error("对局已经开始。");
    this.fill();
    if (this.players.size < 2)
      throw Error("至少需要 2 名参战者，请等待玩家或开启机器人补位。");
    this.phase = "playing";
    this.round++;
    this.reason = "";
    this.endsAt = this.time + RULES.duration;
    for (const p of this.players.values()) {
      p.kills = 0;
      p.deaths = 0;
      p.health = 0;
    }
    for (const p of this.players.values()) this.spawn(p);
  }
  spawn(p) {
    const others = [...this.players.values()].filter(
      (o) => o.id !== p.id && o.health > 0,
    );
    // Farthest available spawn reduces spawn camping; ties rotate each life.
    const candidates = this.map.spawns.map((s, i) => ({
      s,
      score:
        Math.min(100, ...others.map((o) => distance(s, o))) +
        ((i + p.spawnId + this.round) % 7) * 0.01,
    }));
    candidates.sort((a, b) => b.score - a.score);
    Object.assign(p, candidates[0].s, {
      health: 100,
      ammo: RULES.magazine,
      vy: 0,
      grounded: true,
      crouch: false,
      respawnAt: 0,
      shieldUntil: this.time + RULES.protection,
      reloadAt: 0,
      shotBudget: 1,
      input: sanitizeInput(),
      inputAt: this.time,
      jumpHeld: false,
      path: [],
      thinkAt: 0,
    });
    p.yaw = Math.atan2(p.x, p.z);
    p.pitch = 0;
    p.spawnId++;
  }
  setInput(id, input) {
    const p = this.players.get(id);
    if (!p || p.health <= 0 || this.phase !== "playing") return;
    p.input = sanitizeInput(input);
    p.inputAt = this.time;
  }
  reload(id) {
    const p = this.players.get(id);
    if (
      this.phase !== "playing" ||
      !p ||
      p.health <= 0 ||
      p.reloadAt ||
      p.ammo >= RULES.magazine
    )
      return;
    p.reloadAt = this.time + (p.ammo === 0 ? RULES.emptyReload : RULES.reload);
  }
  shoot(id, direction) {
    const p = this.players.get(id);
    if (
      this.phase !== "playing" ||
      !p ||
      p.health <= 0 ||
      p.reloadAt ||
      !p.ammo ||
      p.shotBudget + 1e-8 < 1
    )
      return false;
    if (
      !direction ||
      !["x", "y", "z"].every(
        (k) =>
          typeof direction[k] === "number" && Number.isFinite(direction[k]),
      )
    )
      return false;
    const length = Math.hypot(direction.x, direction.y, direction.z);
    if (length < 0.9 || length > 1.1) return false;
    const dir = {
        x: direction.x / length,
        y: direction.y / length,
        z: direction.z / length,
      },
      origin = eye(p);
    p.ammo--;
    p.shotBudget--;
    p.shieldUntil = 0;
    let closest = wallDistance(origin, dir, this.map),
      victim = null,
      headshot = false;
    for (const target of this.players.values()) {
      if (target === p || target.health <= 0 || target.shieldUntil > this.time)
        continue;
      const height = target.crouch ? 1.15 : 1.8;
      const d = rayBox(
        origin,
        dir,
        [target.x - 0.32, target.y, target.z - 0.32],
        [target.x + 0.32, target.y + height, target.z + 0.32],
        closest,
      );
      if (d < closest) {
        closest = d;
        victim = target;
        headshot = origin.y + dir.y * d > target.y + height - 0.34;
      }
    }
    const end = {
      x: origin.x + dir.x * closest,
      y: origin.y + dir.y * closest,
      z: origin.z + dir.z * closest,
    };
    this.emit({
      type: "shot",
      id,
      origin,
      end,
      hit: victim?.id || null,
      headshot,
    });
    if (victim) {
      victim.health = Math.max(
        0,
        victim.health - RULES.damage * (headshot ? 2 : 1),
      );
      if (victim.health === 0) {
        victim.deaths++;
        p.kills++;
        victim.respawnAt = this.time + RULES.respawn;
        this.emit({ type: "kill", killer: p.name, victim: victim.name });
        if (p.kills >= RULES.scoreLimit) this.finish("已达到击杀目标");
      }
    }
    return true;
  }
  botInput(p, dt) {
    const targets = [...this.players.values()].filter(
      (t) => t !== p && t.health > 0,
    );
    targets.sort((a, b) => distance(p, a) - distance(p, b));
    const target = targets.find((t) => canSee(p, t, this.map)) || targets[0];
    if (!target) return;
    const visible = canSee(p, target, this.map);
    if (this.time >= p.thinkAt) {
      p.path = visible ? [] : findPath(p, target, this.map);
      p.thinkAt = this.time + 0.8;
    }
    while (p.path.length && distance(p, p.path[0]) < 0.5) p.path.shift();
    const goal = visible ? target : p.path[0];
    if (!goal) return;
    const yaw = Math.atan2(-(goal.x - p.x), -(goal.z - p.z));
    p.input = sanitizeInput({
      yaw,
      z: visible ? (distance(p, target) > 10 ? 1 : 0) : 1,
      x: visible ? Math.sin(this.time + p.spawnId) * 0.5 : 0,
    });
    move(p, p.input, dt, this.map);
    if (!p.ammo) this.reload(p.id);
    if (
      visible &&
      this.time >= p.botShotAt &&
      target.shieldUntil <= this.time
    ) {
      const o = eye(p),
        t = eye(target),
        spread = 0.035;
      const dir = { x: t.x - o.x, y: t.y - o.y - 0.25, z: t.z - o.z };
      const len = Math.hypot(dir.x, dir.y, dir.z);
      for (const k of ["x", "y", "z"])
        dir[k] = dir[k] / len + (Math.random() - 0.5) * spread;
      const normal = Math.hypot(dir.x, dir.y, dir.z);
      for (const k of ["x", "y", "z"]) dir[k] /= normal;
      p.yaw = Math.atan2(-dir.x, -dir.z);
      p.pitch = Math.asin(dir.y);
      this.shoot(p.id, dir);
      p.botShotAt = this.time + 0.24 + Math.random() * 0.2;
    }
  }
  tick(dt) {
    this.time += dt;
    if (this.phase !== "playing") return;
    if (this.time >= this.endsAt) {
      this.finish("时间到");
      return;
    }
    for (const p of this.players.values()) {
      if (this.phase !== "playing") break;
      if (p.health <= 0) {
        if (this.time >= p.respawnAt) this.spawn(p);
        continue;
      }
      p.shotBudget = Math.min(2, p.shotBudget + dt / RULES.shotInterval);
      if (p.reloadAt && this.time >= p.reloadAt) {
        p.ammo = RULES.magazine;
        p.reloadAt = 0;
      }
      if (p.bot) this.botInput(p, dt);
      else {
        // Background tabs or interrupted links must not keep walking indefinitely.
        const input =
          this.time - p.inputAt > 0.3
            ? sanitizeInput({ yaw: p.yaw, pitch: p.pitch })
            : p.input;
        move(p, input, dt, this.map);
      }
    }
  }
  finish(reason) {
    this.phase = "finished";
    this.reason = reason;
  }
  snapshot() {
    return {
      type: "state",
      code: this.code,
      hostId: this.hostId,
      phase: this.phase,
      settings: this.settings,
      round: this.round,
      time: this.time,
      remaining: Math.max(0, this.endsAt - this.time),
      reason: this.reason,
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        bot: p.bot,
        x: p.x,
        y: p.y,
        z: p.z,
        yaw: p.yaw,
        pitch: p.pitch,
        vy: p.vy,
        grounded: p.grounded,
        crouch: p.crouch,
        health: p.health,
        kills: p.kills,
        deaths: p.deaths,
        ammo: p.ammo,
        reloading: !!p.reloadAt,
        respawn: Math.max(0, p.respawnAt - this.time),
        shield: p.shieldUntil > this.time,
        spawnId: p.spawnId,
      })),
    };
  }
}
