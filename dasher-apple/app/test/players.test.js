import assert from "node:assert/strict";
import { test } from "node:test";
import { plexConfigured, plexPlayers, radioPlayers } from "../src/players.js";

test("music players respect registry visibility and explicit exclusions", () => {
  const registries = { entities: [
    { ei: "media_player.b", pl: "music_assistant" },
    { ei: "media_player.a", pl: "music_assistant" },
    { ei: "media_player.hidden", pl: "music_assistant", hb: true },
    { ei: "media_player.disabled", pl: "music_assistant", ec: "config" },
  ] };
  const settings = { enabled: true, players: [], exclude: ["media_player.b"] };
  assert.deepEqual(radioPlayers(settings, registries), ["media_player.a"]);
  assert.deepEqual(radioPlayers({ ...settings, players: ["media_player.tv", "media_player.b"] }, registries), ["media_player.tv"]);
  assert.deepEqual(radioPlayers({ ...settings, enabled: false }, registries), []);
});

test("media players include compatible devices and respect explicit exclusions", () => {
  const registries = { entities: [
    { ei: "media_player.tv", pl: "cast" },
    { ei: "media_player.plex_music_assistant", pl: "plex" },
    { ei: "media_player.apple_tv", pl: "apple_tv" },
    { ei: "media_player.hidden", pl: "plex", hb: true },
  ] };
  const settings = { enabled: true, players: [], exclude: ["media_player.tv"] };
  assert.deepEqual(plexPlayers({ settings, registries }), [{ id: "media_player.apple_tv", platform: "apple_tv" }]);
  assert.deepEqual(plexPlayers({ settings: { ...settings, players: ["media_player.other"] }, registries }), [{ id: "media_player.other", platform: null }]);
  assert.equal(plexConfigured(registries), true);
});
