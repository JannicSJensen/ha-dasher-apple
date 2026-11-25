/** Music Assistant speakers available for basic playback controls. */
export function radioPlayers(settings, registries) {
  if (!settings?.enabled) return [];
  if (settings.players.length) return settings.players.filter((id) => !settings.exclude.includes(id));
  const found = (registries?.entities ?? [])
    .filter((e) => e.pl === "music_assistant" && e.ei?.startsWith("media_player.") && !e.hb && e.ec == null)
    .map((e) => e.ei)
    .filter((id) => !settings.exclude.includes(id));
  return [...new Set(found)].sort();
}

/** Plex, Cast and Apple TV players available for basic media controls. */
export function plexPlayers({ settings, registries }) {
  if (!settings || settings.enabled === false) return [];
  const rows = (registries?.entities ?? []).filter((e) => e?.ei?.startsWith("media_player.") && !e.hb);
  const platforms = new Map(rows.map((e) => [e.ei, e.pl]));
  const found = rows
    .filter((e) => ["plex", "cast", "apple_tv"].includes(e.pl) && !/music_assistant/.test(e.ei))
    .map((e) => e.ei);
  const ids = settings.players.length ? settings.players : found;
  const excluded = new Set(settings.exclude);
  return [...new Set(ids)]
    .filter((id) => !excluded.has(id))
    .map((id) => ({ id, platform: platforms.get(id) ?? null }));
}

export const plexConfigured = (registries) => (registries?.entities ?? []).some((e) => e?.pl === "plex");
