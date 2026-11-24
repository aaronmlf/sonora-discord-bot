import type { AccessPrincipal } from "../types.js";

export function canSeeGuild(principal: AccessPrincipal, guildId: string): boolean {
  return principal.role === "owner" || principal.guildIds == null || principal.guildIds.includes(guildId);
}

// Explicit allow-list: new write routes are denied to collaborators until classified.
export function canRequest(principal: AccessPrincipal, method: string, pathname: string, body: unknown): boolean {
  if (principal.role === "owner") return true;
  if (/^\/api\/(access|diagnostics|backups)(\/|$)/.test(pathname)) return false;
  const guild = pathname.match(/^\/api\/sessions\/([^/]+)(?:\/|$)/)?.[1];
  if (guild && !canSeeGuild(principal, decodeURIComponent(guild))) return false;
  if (["GET", "HEAD"].includes(method)) return true;
  if (pathname === "/api/auth/logout") return true;
  const profile = principal.profile ?? "full";
  const action = (body as { action?: string } | null)?.action;
  if (guild) {
    if (pathname.endsWith("/studio")) {
      const shared = ["stopLayer", "stopEffects"];
      const musical = ["entry", "shuffle", "restoreQueue", "discardQueue", "playNow"];
      const full = ["saveQueue", "environment", "environmentVolume", "layerVolume", "ducking", "scene"];
      if (profile === "full") return (action !== "saveQueue" || principal.guildIds == null) && [...shared, ...musical, ...full].includes(action ?? "");
      // stopLayer is further checked against active effects; environments are not effects.
      return (profile === "effects" ? shared : musical).includes(action ?? "");
    }
    if (pathname.endsWith("/actions")) {
      return profile === "full" || (profile === "effects" ? action === "effectVolume" : ["pause", "resume", "skip", "stop", "clear", "volume", "loop"].includes(action ?? ""));
    }
    if (pathname.endsWith("/effects")) return profile !== "playback";
    if (/\/queue(?:\/|$)|\/playlists\//.test(pathname)) return profile !== "effects";
    return false;
  }
  if (profile !== "full" || principal.guildIds != null) return false;
  return /^\/api\/(library|playlists|scenes)(\/|$)/.test(pathname) || (pathname === "/api/studio/library" && action !== "purge");
}
