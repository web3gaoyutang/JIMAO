import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { networkInterfaces } from "node:os";
import { resolve } from "node:path";
import { randomUUID, randomInt } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { Room } from "./lan/room.mjs";
import { RULES } from "./lan/shared.mjs";

const root = new URL("./", import.meta.url);
const map = JSON.parse(
  await readFile(new URL("lan/harbor.json", root), "utf8"),
);
const files = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/lan/client.mjs", "lan/client.mjs"],
  ["/lan/shared.mjs", "lan/shared.mjs"],
  ["/lan/entry.js", "lan/entry.js"],
  ["/lan/style.css", "lan/style.css"],
  ["/lan/harbor.json", "lan/harbor.json"],
]);
const types = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json",
};
export function createLanServer() {
  const rooms = new Map(),
    clients = new Map();
  const server = http.createServer(async (req, res) => {
    let path;
    try {
      path = new URL(req.url, "http://localhost").pathname;
    } catch {
      res.writeHead(400);
      res.end("Invalid URL");
      return;
    }
    if (path === "/api/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, protocol: 1, map: map.version }));
      return;
    }
    const file = files.get(path);
    if (!file || !["GET", "HEAD"].includes(req.method)) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    try {
      const data = await readFile(new URL(file, root));
      res.writeHead(200, {
        "Content-Type": types[file.split(".").pop()],
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-cache",
      });
      res.end(req.method === "HEAD" ? undefined : data);
    } catch {
      res.writeHead(500);
      res.end("Unable to load game");
    }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8192 });
  server.on("upgrade", (req, socket, head) => {
    let sameOrigin = true;
    try {
      if (req.headers.origin)
        sameOrigin = new URL(req.headers.origin).host === req.headers.host;
    } catch {
      sameOrigin = false;
    }
    if (req.url !== "/ws" || !sameOrigin || clients.size >= 100) {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
  });
  const send = (ws, data) => {
    if (ws.readyState === WebSocket.OPEN) {
      if (ws.bufferedAmount > 1024 * 1024) {
        ws.terminate();
        return;
      }
      ws.send(JSON.stringify(data));
    }
  };
  const broadcast = (room, data) => {
    for (const c of clients.values()) if (c.room === room) send(c.ws, data);
  };
  const list = () =>
    [...rooms.values()].map((r) => ({
      code: r.code,
      phase: r.phase,
      capacity: r.settings.capacity,
      humans: r.humans().length,
      bots: [...r.players.values()].filter((p) => p.bot).length,
      host: r.players.get(r.hostId)?.name,
    }));
  const publishList = () => {
    for (const c of clients.values())
      if (!c.room) send(c.ws, { type: "rooms", rooms: list() });
  };
  const leave = (c) => {
    const r = c.room;
    if (!r) return;
    c.room = null;
    r.remove(c.id);
    if (!r.hostId) rooms.delete(r.code);
    else broadcast(r, r.snapshot());
    publishList();
  };
  wss.on("connection", (ws) => {
    const c = {
      ws,
      id: randomUUID(),
      room: null,
      alive: true,
      count: 0,
      window: Date.now(),
    };
    clients.set(c.id, c);
    ws.on("error", () => {});
    ws.on("pong", () => {
      c.alive = true;
    });
    send(ws, { type: "welcome", id: c.id, protocol: 1, map: map.version });
    send(ws, { type: "rooms", rooms: list() });
    ws.on("message", (raw, binary) => {
      if (Date.now() - c.window > 1000) {
        c.window = Date.now();
        c.count = 0;
      }
      if (++c.count > 120 || binary) {
        ws.close(1008, "Too many messages");
        return;
      }
      try {
        const msg = JSON.parse(raw.toString());
        if (!msg || typeof msg !== "object") throw Error("无效请求。");
        if (msg.type === "ping") {
          send(ws, { type: "pong", at: msg.at });
          return;
        }
        if (msg.type === "list") {
          send(ws, { type: "rooms", rooms: list() });
          return;
        }
        if (msg.type === "leave") {
          leave(c);
          send(ws, { type: "left" });
          send(ws, { type: "rooms", rooms: list() });
          return;
        }
        if (msg.type === "create" || msg.type === "join") {
          if (c.room) throw Error("请先退出当前房间。");
          let room;
          if (msg.type === "create") {
            if (rooms.size >= 32)
              throw Error("房间数量已达上限，请加入现有房间。");
            let code;
            do {
              code = String(randomInt(100000, 1000000));
            } while (rooms.has(code));
            room = new Room(code, msg.settings, map, (event) =>
              broadcast(room, event),
            );
          } else {
            room = rooms.get(String(msg.code));
            if (!room) throw Error("房间不存在，请检查房间号或刷新列表。");
          }
          room.add(c.id, msg.name);
          rooms.set(room.code, room);
          c.room = room;
          broadcast(room, room.snapshot());
          publishList();
          return;
        }
        const r = c.room;
        if (!r) throw Error("请先创建或加入房间。");
        switch (msg.type) {
          case "configure":
            r.configure(c.id, msg.settings);
            broadcast(r, r.snapshot());
            publishList();
            break;
          case "start":
            r.start(c.id);
            broadcast(r, r.snapshot());
            publishList();
            break;
          case "input":
            r.setInput(c.id, msg.input);
            break;
          case "shoot":
            r.shoot(c.id, msg.direction);
            break;
          case "reload":
            r.reload(c.id);
            break;
          default:
            throw Error("未知请求。");
        }
      } catch (error) {
        send(ws, {
          type: "error",
          message:
            error instanceof SyntaxError ? "请求格式错误。" : error.message,
        });
      }
    });
    ws.on("close", () => {
      leave(c);
      clients.delete(c.id);
    });
  });
  let last = performance.now(),
    accumulator = 0,
    tick = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    accumulator += Math.min((now - last) / 1000, 0.25);
    last = now;
    while (accumulator >= 1 / RULES.tickRate) {
      let phaseChanged = false;
      for (const room of rooms.values()) {
        const phase = room.phase;
        room.tick(1 / RULES.tickRate);
        phaseChanged ||= phase !== room.phase;
      }
      if (phaseChanged) publishList();
      accumulator -= 1 / RULES.tickRate;
      tick++;
      if (tick % 2 === 0)
        for (const room of rooms.values())
          if (room.phase !== "lobby") broadcast(room, room.snapshot());
    }
  }, 1000 / RULES.tickRate);
  const heartbeat = setInterval(() => {
    for (const c of clients.values()) {
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      c.ws.ping();
    }
  }, 10000);
  return {
    server,
    rooms,
    async close() {
      clearInterval(timer);
      clearInterval(heartbeat);
      for (const c of clients.values()) c.ws.terminate();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  const port = Number(process.env.PORT || 8000),
    app = createLanServer();
  app.server.on("error", (e) => {
    console.error(`无法启动局域网服务：${e.message}`);
    process.exit(1);
  });
  app.server.listen(port, "0.0.0.0", () => {
    console.log(`几猫局域网服务已启动\n本机：http://localhost:${port}/?lan=1`);
    for (const addresses of Object.values(networkInterfaces()))
      for (const addr of addresses || [])
        if (addr.family === "IPv4" && !addr.internal)
          console.log(`局域网：http://${addr.address}:${port}/?lan=1`);
    console.log("同一 Wi-Fi / 局域网的玩家打开上述局域网地址；Ctrl+C 停止。");
  });
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, async () => {
      await app.close();
      process.exit(0);
    });
}
