// Kept separate from the original bundled game; only loaded on the LAN route.
window.createLanGame = async (game) => {
  const { mount } = await import("./client.mjs");
  return mount(game);
};
