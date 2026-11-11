import { RULES, move, sanitizeInput, clamp, distance } from "./shared.mjs";

export async function mount(g) {
  const response = await fetch("./lan/harbor.json");
  if (!response.ok) throw Error("无法载入联机地图");
  const map = await response.json();
  document.body.classList.add("lan-mode");
  const sheet = document.createElement("link");
  sheet.rel = "stylesheet";
  sheet.href = "./lan/style.css";
  document.head.append(sheet);
  const shell = document.createElement("section");
  shell.id = "lan-shell";
  shell.className = "lan";
  shell.setAttribute("aria-label", "局域网对战");
  shell.innerHTML = `<div class="lan-wrap">
    <header><div><h1>局域网对战</h1><p>几猫港区 · 2–10 人自由对战</p></div><a href="./">返回单人模式</a></header>
    <p id="lan-connection" class="lan-status" role="status">正在连接局域网服务…</p>
    <p id="lan-error" role="alert" hidden></p>
    <button id="lan-reconnect" class="btn small" hidden>重新连接</button>
    <div id="lan-browser">
      <label for="lan-name">你的呼号</label><input id="lan-name" maxlength="20" placeholder="输入玩家名称" autocomplete="nickname">
      <div class="lan-columns">
        <section><h2>创建房间</h2>
          <label for="lan-capacity">参战总人数（含机器人）</label><select id="lan-capacity">${Array.from({ length: 9 }, (_, i) => `<option value="${i + 2}" ${i === 2 ? "selected" : ""}>${i + 2} 人</option>`).join("")}</select>
          <label><input id="lan-fill" type="checkbox" checked>自动用机器人补满空位</label>
          <p>真人加入时替换机器人，离开后自动补位。</p>
          <div class="lan-actions"><button id="lan-create" class="btn primary" disabled>创建房间</button></div>
        </section>
        <section><h2>加入对战</h2><label for="lan-code">六位房间号</label>
          <form id="lan-join-form" class="lan-inline"><input id="lan-code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="例如 123456" aria-label="六位房间号" required><button id="lan-join" class="btn" disabled>加入</button></form>
          <div class="lan-actions"><button id="lan-refresh" class="btn small" disabled>刷新房间</button></div>
          <div id="lan-rooms"><p>连接成功后显示房间。</p></div>
        </section>
      </div>
    </div>
    <div id="lan-room-panel" hidden>
      <div class="lan-actions"><h2 id="lan-room-title"></h2><button id="lan-copy" class="btn small">复制邀请链接</button></div>
      <p id="lan-room-status"></p>
      <div class="lan-columns">
        <section><h2 id="lan-roster-title">参战名单</h2><table><thead><tr><th scope="col">玩家</th><th scope="col">击杀</th><th scope="col">阵亡</th></tr></thead><tbody id="lan-roster"></tbody></table></section>
        <section><h2>房间设置</h2>
          <label for="lan-room-capacity">参战总人数</label><select id="lan-room-capacity">${Array.from({ length: 9 }, (_, i) => `<option value="${i + 2}">${i + 2} 人</option>`).join("")}</select>
          <label><input id="lan-room-fill" type="checkbox">自动补充机器人</label>
          <p id="lan-settings-note">只有房主可以修改设置和开始对战。</p>
          <div class="lan-actions"><button id="lan-start" class="btn primary">开始对战</button><button id="lan-resume" class="btn primary" hidden>返回战场</button><button id="lan-leave" class="btn">退出房间</button></div>
        </section>
      </div>
    </div>
    <div class="lan-rules"><p>率先击杀 ${RULES.scoreLimit} 人获胜，或在 5 分钟结束时按击杀数排名；同分并列。阵亡 3 秒后复活，复活保护 2 秒，开火会解除保护。</p><p>WASD 移动 · 鼠标瞄准 · 左键开火 · 右键瞄准 · R 换弹 · Space 跳跃 · Shift 冲刺 · C 蹲伏 · Esc / P 查看战况。菜单不会暂停对局。</p><p>同一 Wi-Fi / 局域网的朋友打开房主电脑的局域网地址，再加入房间。</p><p class="lan-address" id="lan-address"></p></div>
  </div>`;
  const hud = document.createElement("div");
  hud.id = "lan-hud";
  hud.className = "lan";
  hud.hidden = true;
  hud.innerHTML =
    '<div class="lan-score"><div id="lan-clock"></div><strong id="lan-score"></strong><div id="lan-network"></div></div><button id="lan-menu-button" class="btn small">战况 / 退出</button><div id="lan-life" role="status"></div><div id="lan-feed"></div><div id="lan-help">点击画面捕获鼠标；Esc / P 查看战况</div>';
  document.getElementById("ui").append(shell, hud);
  const $ = (id) => document.getElementById(id);
  const error = (message) => {
    $("lan-error").textContent = message;
    $("lan-error").hidden = !message;
  };
  let socket = null,
    connected = false,
    id = null,
    state = null,
    local = null,
    authoritative = null,
    paused = false;
  let sendElapsed = 0,
    pingElapsed = 0,
    lastPacket = performance.now(),
    spawnId = -1,
    round = -1,
    signature = "";
  let feedUntil = 0,
    latency = 0;
  const avatars = new Map(),
    T = g.THREE;
  let savedName = "";
  try {
    savedName = localStorage.getItem("jimao.lan.name") || "";
  } catch {}
  $("lan-name").value = savedName;
  $("lan-address").textContent = location.origin + "/?lan=1";
  const query = new URLSearchParams(location.search);
  $("lan-code").value = query.get("room") || "";
  const send = (message) => {
    if (socket?.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify(message));
  };
  const name = () => {
    const value = $("lan-name").value.trim() || "突击队员";
    try {
      localStorage.setItem("jimao.lan.name", value);
    } catch {}
    return value;
  };
  const game = {
    state: "lan-lobby",
    update,
    start() {},
    pause: () => showMenu(true),
    resume: () => showMenu(false),
  };
  g.player.enabled = false;
  g.player.alive = false;
  g.hud.show(false);
  g.weapon.setVisible(false);
  g.enemies.clear?.();
  g.camera.position.set(-32, 5, 6);
  g.camera.lookAt(0, 3, 0);
  g.render.post.fade = 0;
  const canControl = () =>
    connected &&
    state?.phase === "playing" &&
    !paused &&
    local?.health > 0 &&
    performance.now() - lastPacket < 3000;
  function showMenu(open) {
    paused = open;
    shell.hidden = !open;
    g.input.setGameplay(canControl());
    if (open) {
      g.input.exitLock();
      send({
        type: "input",
        input: { yaw: local?.yaw || 0, pitch: local?.pitch || 0 },
      });
      $("lan-resume").focus();
    } else {
      g.audio.resume?.();
      g.input.requestLock();
    }
    g.weapon.debug.noFire = !canControl();
  }
  $("lan-menu-button").onclick = () => showMenu(true);
  $("lan-resume").onclick = () => showMenu(false);
  $("lan-create").onclick = () => {
    error("");
    send({
      type: "create",
      name: name(),
      settings: {
        capacity: Number($("lan-capacity").value),
        fillBots: $("lan-fill").checked,
      },
    });
  };
  $("lan-join-form").onsubmit = (e) => {
    e.preventDefault();
    error("");
    send({ type: "join", name: name(), code: $("lan-code").value.trim() });
  };
  $("lan-refresh").onclick = () => send({ type: "list" });
  $("lan-leave").onclick = () => send({ type: "leave" });
  $("lan-start").onclick = () => {
    g.audio.resume?.();
    error("");
    send({ type: "start" });
  };
  for (const key of ["lan-room-capacity", "lan-room-fill"])
    $(key).onchange = () =>
      send({
        type: "configure",
        settings: {
          capacity: Number($("lan-room-capacity").value),
          fillBots: $("lan-room-fill").checked,
        },
      });
  $("lan-copy").onclick = async () => {
    const invite = new URL(location.href);
    invite.search = "";
    invite.searchParams.set("lan", "1");
    invite.searchParams.set("room", state.code);
    try {
      if (!navigator.clipboard) throw Error();
      await navigator.clipboard.writeText(invite.href);
      $("lan-room-status").textContent = "邀请链接已复制。";
    } catch {
      $("lan-room-status").textContent = "邀请地址：" + invite.href;
      $("lan-room-status").style.userSelect = "text";
    }
    if (["localhost", "127.0.0.1", "[::1]"].includes(location.hostname))
      $("lan-room-status").textContent +=
        " 请将 localhost / 127.0.0.1 替换为服务器启动时显示的局域网 IP。";
  };
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && state?.phase === "playing") showMenu(true);
  });
  g.events.on("input:lock", (event) => {
    if (
      !event.locked &&
      state?.phase === "playing" &&
      !paused &&
      !g.input.touch
    )
      showMenu(true);
  });
  g.events.on("weapon:reload", (event) => {
    if (event.phase === "start" && state?.phase === "playing")
      send({ type: "reload" });
  });
  g.combat.playerShot = (origin, direction) => {
    if (canControl())
      send({
        type: "shoot",
        direction: { x: direction.x, y: direction.y, z: direction.z },
      });
    return g.physics.raycast(origin, direction, 300);
  };
  g.player.damage = () => {}; // Health and death are determined only by room snapshots.
  g.player.update = (dt) => {
    if (!local || state?.phase !== "playing") return;
    const enabled = canControl(),
      p = g.player;
    if (enabled) {
      local.yaw -= g.input.look.dx * (g.input.ads ? 0.7 : 1);
      local.pitch = clamp(
        local.pitch - g.input.look.dy * (g.input.ads ? 0.7 : 1),
        -1.5,
        1.5,
      );
    }
    if (local.yaw > Math.PI * 2 || local.yaw < -Math.PI * 2)
      local.yaw %= Math.PI * 2;
    const input = currentInput(enabled);
    if (local.health > 0) move(local, input, dt, map);
    if (authoritative && local.health > 0) {
      const gap = distance(local, authoritative);
      // Correct prediction gradually, with immediate correction for large divergence.
      const k = gap > 2 ? 1 : Math.min(1, dt * 4);
      local.x += (authoritative.x - local.x) * k;
      local.z += (authoritative.z - local.z) * k;
      if (Math.abs(local.y - authoritative.y) > 1.5) {
        local.y = authoritative.y;
        local.vy = authoritative.vy;
      }
      // Advance the latest server state using the last local input between snapshots.
      move(authoritative, input, dt, map);
    }
    p.pos.set(local.x, local.y, local.z);
    p.yaw = local.yaw;
    p.pitch = local.pitch;
    p.crouching = local.crouch;
    p.onGround = local.grounded;
    p.health = local.health;
    p.alive = local.health > 0;
    p.enabled = enabled;
    p.speed = enabled
      ? Math.hypot(input.x, input.z) * (input.sprint ? 6.4 : 3.8)
      : 0;
    p.sprinting = enabled && input.sprint && p.speed > 0;
    p.vel.set(0, local.vy, 0);
    p.ads = g.weapon.ads;
    p.eye.set(
      local.x,
      local.y + (p.alive ? (local.crouch ? 1.05 : 1.68) : 0.55),
      local.z,
    );
    g.camera.position.copy(p.eye);
    g.camera.rotation.set(local.pitch, local.yaw, 0, "YXZ");
    p.forward.set(0, 0, -1).applyQuaternion(g.camera.quaternion);
    const fov = input.ads ? 55 : p.baseFov || 74;
    g.camera.fov += (fov - g.camera.fov) * Math.min(1, dt * 12);
    g.camera.updateProjectionMatrix();
    g.render.post.damage = Math.max(0, (g.render.post.damage || 0) - dt * 2);
    g.render.post.lowHealth = p.alive ? Math.max(0, 1 - p.health / 40) : 0.8;
  };
  g.player.addRecoil = (pitch = 0, yaw = 0) => {
    if (local) {
      local.pitch = clamp(local.pitch + pitch * 0.5, -1.5, 1.5);
      local.yaw += yaw * 0.5;
    }
  };
  function currentInput(enabled = canControl()) {
    return sanitizeInput({
      x: enabled ? g.input.move.x : 0,
      z: enabled ? g.input.move.y : 0,
      yaw: local?.yaw || 0,
      pitch: local?.pitch || 0,
      jump: enabled && g.input.down("jump"),
      crouch: enabled && g.input.crouch,
      sprint: enabled && g.input.sprint && !g.input.fire,
      ads: enabled && g.input.ads,
    });
  }
  function resetRoom() {
    state = null;
    local = null;
    authoritative = null;
    spawnId = -1;
    round = -1;
    signature = "";
    paused = false;
    g.input.setGameplay(false);
    g.input.exitLock();
    g.player.alive = false;
    g.player.enabled = false;
    g.hud.show(false);
    g.weapon.setVisible(false);
    hud.hidden = true;
    shell.hidden = false;
    game.state = "lan-lobby";
    $("lan-room-panel").hidden = true;
    $("lan-browser").hidden = false;
    for (const avatar of avatars.values()) disposeAvatar(avatar);
    avatars.clear();
  }
  function renderRooms(rooms) {
    const list = $("lan-rooms");
    list.replaceChildren();
    if (!rooms.length) {
      const p = document.createElement("p");
      p.textContent = "暂无房间。创建一个，邀请朋友加入。";
      list.append(p);
      return;
    }
    for (const room of rooms) {
      const row = document.createElement("div");
      row.className = "lan-room";
      const label = document.createElement("div"),
        title = document.createElement("strong"),
        detail = document.createElement("small");
      title.textContent = `${room.code} · ${room.host}`;
      detail.textContent = `${room.humans} 真人 + ${room.bots} 机器人 / ${room.capacity} 人 · ${room.phase === "playing" ? "对战中" : "等待加入"}`;
      label.append(title, detail);
      const button = document.createElement("button");
      button.className = "btn small";
      button.textContent = room.humans >= room.capacity ? "已满" : "加入";
      button.disabled = room.humans >= room.capacity;
      button.onclick = () => {
        error("");
        send({ type: "join", code: room.code, name: name() });
      };
      row.append(label, button);
      list.append(row);
    }
  }
  function renderState() {
    if (!state) return;
    $("lan-browser").hidden = true;
    $("lan-room-panel").hidden = false;
    const host = state.hostId === id,
      playing = state.phase === "playing",
      finished = state.phase === "finished";
    $("lan-room-title").textContent = `房间 ${state.code}`;
    $("lan-room-status").textContent = finished
      ? `${state.reason} · ${winners()}`
      : playing
        ? "对局进行中。查看战况期间仍可能受到攻击。"
        : `已就位 ${state.players.length} / ${state.settings.capacity} 人 · ${host ? "你是房主" : "等待房主开始"}`;
    $("lan-roster-title").textContent = finished ? "本局战绩" : "参战名单";
    $("lan-room-capacity").value = String(state.settings.capacity);
    $("lan-room-fill").checked = state.settings.fillBots;
    $("lan-room-capacity").disabled = !host || playing;
    $("lan-room-fill").disabled = !host || playing;
    $("lan-settings-note").textContent = playing
      ? "对局结束后，房主可以调整设置并开始下一局。"
      : "房主可调整总人数；关闭机器人后至少需要 2 名真人。";
    $("lan-start").hidden = playing;
    $("lan-start").disabled = !host || state.players.length < 2;
    $("lan-start").textContent = finished ? "再来一局" : "开始对战";
    $("lan-resume").hidden = !playing;
    const tbody = $("lan-roster");
    tbody.replaceChildren();
    for (const p of [...state.players].sort((a, b) => b.kills - a.kills)) {
      const tr = document.createElement("tr");
      tr.dataset.self = String(p.id === id);
      for (const value of [
        `${p.name}${p.bot ? " · 机器人" : ""}${p.id === state.hostId ? " · 房主" : ""}${p.id === id ? " · 你" : ""}`,
        p.kills,
        p.deaths,
      ]) {
        const cell = document.createElement("td");
        cell.textContent = value;
        tr.append(cell);
      }
      tbody.append(tr);
    }
  }
  function winners() {
    const best = Math.max(...state.players.map((p) => p.kills));
    return (
      state.players
        .filter((p) => p.kills === best)
        .map((p) => p.name)
        .join("、") +
      (state.players.filter((p) => p.kills === best).length > 1
        ? " 并列第一"
        : " 获胜")
    );
  }
  function acceptState(next) {
    lastPacket = performance.now();
    const previousPhase = state?.phase;
    state = next;
    const me = state.players.find((p) => p.id === id);
    if (!me) return;
    if (state.phase === "playing") {
      if (round !== state.round || spawnId !== me.spawnId) {
        round = state.round;
        spawnId = me.spawnId;
        local = { ...me };
        g.weapon.reset();
        g.weapon.reserve = 9999;
        g.render.post.damage = 0;
      } else {
        if (local && me.health < local.health) {
          g.render.post.damage = 0.7;
          g.events.emit("player:hit", {
            amount: local.health - me.health,
            fromPos: null,
          });
        }
        Object.assign(local, {
          health: me.health,
          respawn: me.respawn,
          shield: me.shield,
        });
      }
      authoritative = { ...me };
      if (previousPhase !== "playing") {
        paused = false;
        shell.hidden = true;
        hud.hidden = false;
        game.state = "lan-playing";
        g.hud.show(true);
        g.hud.setMarkers([]);
        g.input.setGameplay(true);
      }
      g.player.alive = me.health > 0;
      g.weapon.setVisible(me.health > 0);
      g.weapon.reserve = 9999;
    } else {
      g.input.setGameplay(false);
      g.input.exitLock();
      g.player.enabled = false;
      g.weapon.setVisible(false);
      g.hud.show(false);
      hud.hidden = true;
      shell.hidden = false;
      game.state = "lan-lobby";
      paused = false;
    }
    const key = JSON.stringify([
      state.phase,
      state.hostId,
      state.settings,
      state.players.map((p) => [p.id, p.kills, p.deaths]),
    ]);
    if (key !== signature) {
      signature = key;
      renderState();
    }
    const present = new Set();
    for (const p of state.players) {
      if (p.id === id) continue;
      present.add(p.id);
      let avatar = avatars.get(p.id);
      if (!avatar) {
        avatar = createAvatar(p);
        avatars.set(p.id, avatar);
      }
      if (avatar.spawnId !== p.spawnId) {
        avatar.root.position.set(p.x, p.y, p.z);
        avatar.spawnId = p.spawnId;
      }
      avatar.target = p;
      avatar.root.visible = state.phase === "playing" && p.health > 0;
    }
    for (const [key, avatar] of avatars)
      if (!present.has(key)) {
        disposeAvatar(avatar);
        avatars.delete(key);
      }
  }
  function createAvatar(p) {
    const root = new T.Group(),
      body = new T.Group();
    root.add(body);
    const color = p.bot ? 0xc77742 : 0x6aafbe,
      material = new T.MeshStandardMaterial({ color, roughness: 0.65 });
    const dark = new T.MeshStandardMaterial({
      color: 0x202b33,
      roughness: 0.7,
    });
    const mesh = (w, h, d, x, y, z, mat) => {
      const m = new T.Mesh(new T.BoxGeometry(w, h, d), mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      body.add(m);
      return m;
    };
    mesh(0.55, 0.65, 0.32, 0, 1.05, 0, material);
    mesh(0.38, 0.35, 0.38, 0, 1.57, 0, material);
    mesh(0.28, 0.09, 0.02, 0, 1.6, -0.2, dark);
    mesh(0.17, 0.55, 0.2, -0.35, 0.99, 0, dark);
    mesh(0.17, 0.55, 0.2, 0.35, 0.99, -0.1, dark);
    const left = mesh(0.2, 0.65, 0.22, -0.16, 0.35, 0, dark),
      right = mesh(0.2, 0.65, 0.22, 0.16, 0.35, 0, dark);
    mesh(0.12, 0.12, 0.65, 0.32, 1.05, -0.38, dark);
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 80;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "rgba(11,13,15,.85)";
    ctx.fillRect(0, 0, 512, 80);
    ctx.fillStyle = "#e8e4da";
    ctx.font = "28px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(p.name + (p.bot ? " [机器人]" : ""), 256, 50, 490);
    const texture = new T.CanvasTexture(canvas),
      sprite = new T.Sprite(
        new T.SpriteMaterial({ map: texture, depthTest: true }),
      );
    sprite.scale.set(2.4, 0.375, 1);
    sprite.position.y = 2.2;
    root.add(sprite);
    g.scene.add(root);
    return { root, body, left, right, material, target: p, spawnId: -1 };
  }
  function disposeAvatar(avatar) {
    g.scene.remove(avatar.root);
    const materials = new Set();
    avatar.root.traverse((node) => {
      node.geometry?.dispose();
      if (node.material) materials.add(node.material);
    });
    for (const material of materials) {
      material.map?.dispose();
      material.dispose();
    }
  }
  function connect() {
    if (socket) socket.close();
    error("");
    $("lan-reconnect").hidden = true;
    $("lan-connection").textContent = "正在连接局域网服务…";
    const ws = new WebSocket(
      `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`,
    );
    socket = ws;
    const timeout = setTimeout(() => {
      if (socket === ws && !connected) ws.close();
    }, 6000);
    ws.onmessage = (event) => {
      if (socket !== ws) return;
      const message = JSON.parse(event.data);
      if (message.type === "welcome") {
        clearTimeout(timeout);
        id = message.id;
        connected = true;
        lastPacket = performance.now();
        $("lan-connection").textContent = "局域网服务已连接";
        for (const key of ["lan-create", "lan-join", "lan-refresh"])
          $(key).disabled = false;
        if (message.map !== map.version) {
          error("地图版本不同，请刷新页面后重新连接。");
          ws.close();
        }
      }
      if (message.type === "rooms") renderRooms(message.rooms);
      if (message.type === "state") {
        error("");
        acceptState(message);
      }
      if (message.type === "left") resetRoom();
      if (message.type === "error") {
        error(message.message);
        signature = "";
        if (state) renderState();
      }
      if (message.type === "pong") {
        latency = Math.round(performance.now() - message.at);
        lastPacket = performance.now();
      }
      if (message.type === "shot") {
        if (message.id !== id)
          g.fx.tracer?.(
            new T.Vector3(message.origin.x, message.origin.y, message.origin.z),
            new T.Vector3(message.end.x, message.end.y, message.end.z),
          );
        if (message.id === id && message.hit)
          g.hud.hitmarker(message.headshot ? "weak" : "hit");
        if (message.hit === id)
          g.events.emit("player:hit", {
            amount: 26,
            fromPos: new T.Vector3(
              message.origin.x,
              message.origin.y,
              message.origin.z,
            ),
          });
      }
      if (message.type === "kill") {
        $("lan-feed").textContent = `${message.killer} 击败 ${message.victim}`;
        feedUntil = performance.now() + 4000;
      }
    };
    ws.onclose = () => {
      clearTimeout(timeout);
      if (socket !== ws) return;
      connected = false;
      resetRoom();
      $("lan-connection").textContent = "连接已断开";
      renderRooms([]);
      error(
        `无法连接局域网服务。请在房主电脑运行 npm start，并使用同一局域网地址打开页面；检查防火墙是否允许 ${location.port || (location.protocol === "https:" ? "443" : "80")} 端口，然后重新连接。`,
      );
      $("lan-reconnect").hidden = false;
      for (const key of ["lan-create", "lan-join", "lan-refresh"])
        $(key).disabled = true;
    };
    ws.onerror = () => {};
  }
  $("lan-reconnect").onclick = connect;
  function update(dt) {
    pingElapsed += dt;
    if (connected && pingElapsed >= 2) {
      pingElapsed = 0;
      send({ type: "ping", at: performance.now() });
    }
    if (state?.phase !== "playing") return false;
    if (g.input.pressed("pause")) showMenu(!paused);
    const enabled = canControl();
    g.input.setGameplay(enabled);
    g.weapon.debug.noFire = !enabled;
    sendElapsed += dt;
    if (sendElapsed >= 0.05) {
      sendElapsed %= 0.05;
      send({ type: "input", input: currentInput(enabled) });
    }
    const sec = Math.ceil(state.remaining);
    $("lan-clock").textContent =
      `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")} · 目标 ${RULES.scoreLimit} 击杀`;
    const me = state.players.find((p) => p.id === id);
    $("lan-score").textContent =
      `${me?.kills || 0} 击杀 / ${me?.deaths || 0} 阵亡`;
    $("lan-network").textContent =
      performance.now() - lastPacket > 3000
        ? "连接中断，正在等待服务器…"
        : `${state.players.length} 人 · ${latency} ms`;
    $("lan-life").textContent =
      local?.health <= 0
        ? `${Math.ceil(local.respawn)} 秒后复活`
        : local?.shield
          ? "复活保护中 · 开火解除"
          : "";
    if (performance.now() > feedUntil) $("lan-feed").textContent = "";
    for (const avatar of avatars.values()) {
      const p = avatar.target,
        old = avatar.root.position.clone();
      avatar.root.position.lerp(
        new T.Vector3(p.x, p.y, p.z),
        Math.min(1, dt * 14),
      );
      avatar.root.rotation.y = p.yaw;
      avatar.body.scale.y = p.crouch ? 0.65 : 1;
      avatar.material.emissive.setHex(p.shield ? 0x445566 : 0);
      const moving = old.distanceToSquared(avatar.root.position) > 0.00001;
      avatar.left.rotation.x = moving ? Math.sin(g.time.t * 10) * 0.4 : 0;
      avatar.right.rotation.x = -avatar.left.rotation.x;
    }
    return true;
  }
  connect();
  return game;
}
