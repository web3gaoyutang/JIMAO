// Run in the browser console after loading /?q=low&seed=4207 and window.__ready.
// Downloaded harbor.json replaces lan/harbor.json whenever the original map changes.
(() => {
  const g = window.__G;
  if (!window.__ready || !g?.physics || g.params.seed !== "4207")
    throw Error("Open /?q=low&seed=4207 and wait for the game to load.");
  const map = {
    version: "harbor-4207-v1",
    seed: 4207,
    bounds: { minX: -39, maxX: 28, minZ: -29, maxZ: 29 },
    boxes: g.physics.boxes.map((b) => ({
      min: [b.min.x, b.min.y, b.min.z],
      max: [b.max.x, b.max.y, b.max.z],
      bulletOnly: b.bulletOnly,
      playerOnly: b.playerOnly,
    })),
    spawns: [
      g.level.playerStart.pos,
      ...g.level.enemySpawns
        .filter((s) => s.type === "ground")
        .map((s) => s.pos),
    ]
      .filter((p) => g.physics.nav.isWalkable(p.x, p.z))
      .map((p) => ({ x: p.x, y: p.y, z: p.z })),
    nav: {
      cell: 1,
      minX: -39,
      minZ: -29,
      width: 68,
      height: 59,
      walkable: Array.from({ length: 68 * 59 }, (_, n) =>
        g.physics.nav.isWalkable(-39 + (n % 68), -29 + Math.floor(n / 68))
          ? 1
          : 0,
      ),
    },
  };
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(map)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "harbor.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
})();
