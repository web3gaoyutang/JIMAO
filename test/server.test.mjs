import test from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { createLanServer } from "../server.mjs";
async function client(url) {
  const ws = new WebSocket(url),
    messages = [],
    waiters = [];
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    messages.push(msg);
    for (const waiter of [...waiters])
      if (waiter.match(msg)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        clearTimeout(waiter.timer);
        waiter.resolve(msg);
      }
  });
  const wait = (match) => {
    const existing = messages.find(match);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { match, resolve };
      waiter.timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(waiter), 1);
        reject(Error("Message timeout"));
      }, 3000);
      waiters.push(waiter);
    });
  };
  const welcome = await wait((m) => m.type === "welcome");
  return {
    ws,
    id: welcome.id,
    wait,
    clear: () => {
      messages.length = 0;
    },
    send: (msg) => ws.send(JSON.stringify(msg)),
  };
}

test("real WebSockets: ten humans, full rejection, host transfer, bot replacement, isolated rooms", async (t) => {
  const app = createLanServer();
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const port = app.server.address().port,
    url = `ws://127.0.0.1:${port}/ws`;
  t.after(() => app.close());
  const players = await Promise.all(
    Array.from({ length: 11 }, () => client(url)),
  );
  t.after(() => players.forEach((p) => p.ws.terminate()));
  const host = players[0];
  host.send({
    type: "create",
    name: "Host",
    settings: { capacity: 10, fillBots: true },
  });
  const room = await host.wait((m) => m.type === "state");
  assert.equal(room.players.length, 10);
  for (let i = 1; i < 10; i++) {
    players[i].send({ type: "join", name: `Player ${i}`, code: room.code });
    await players[i].wait((m) => m.type === "state");
  }
  host.clear();
  host.send({ type: "start" });
  const started = await host.wait(
    (m) => m.type === "state" && m.phase === "playing",
  );
  assert.equal(started.players.filter((p) => !p.bot).length, 10);
  players[10].send({ type: "join", name: "Overflow", code: room.code });
  assert.match(
    (await players[10].wait((m) => m.type === "error")).message,
    /已满/,
  );
  host.ws.close();
  const transferred = await players[1].wait(
    (m) => m.type === "state" && m.hostId === players[1].id,
  );
  assert.equal(transferred.players.length, 10);
  assert.equal(transferred.players.filter((p) => p.bot).length, 1);
  players[10].clear();
  players[10].send({ type: "join", name: "Replacement", code: room.code });
  const joined = await players[10].wait((m) => m.type === "state");
  assert.equal(joined.players.filter((p) => p.bot).length, 0);
  players[9].send({ type: "leave" });
  await players[9].wait((m) => m.type === "left");
  players[9].clear();
  players[9].send({
    type: "create",
    name: "Other room",
    settings: { capacity: 2, fillBots: true },
  });
  const other = await players[9].wait((m) => m.type === "state");
  assert.notEqual(other.code, room.code);
  assert.equal(other.players.length, 2);
  players[9].ws.send("{bad json");
  assert.match(
    (await players[9].wait((m) => m.type === "error")).message,
    /格式/,
  );
  assert.equal(
    (await fetch(`http://127.0.0.1:${port}/api/health`)).status,
    200,
  );
  assert.equal(
    (await fetch(`http://127.0.0.1:${port}/package.json`)).status,
    404,
  );
  assert.equal(
    (await fetch(`http://127.0.0.1:${port}/.git/config`)).status,
    404,
  );
  assert.equal(
    (await fetch(`http://127.0.0.1:${port}/lan/client.mjs`)).headers.get(
      "content-type",
    ),
    "text/javascript; charset=utf-8",
  );
});

test("foreign WebSocket origins are rejected", async (t) => {
  const app = createLanServer();
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.close());
  const ws = new WebSocket(`ws://127.0.0.1:${app.server.address().port}/ws`, {
    origin: "http://unrelated.example",
  });
  const error = await new Promise((resolve) => ws.on("error", resolve));
  assert.match(error.message, /403/);
});
