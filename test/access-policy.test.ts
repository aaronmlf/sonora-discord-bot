import assert from "node:assert/strict";
import { it } from "node:test";
import { canRequest, canSeeGuild } from "../src/access/policy.js";
import type { AccessPrincipal, ControlProfile } from "../src/types.js";

it("enforces all profiles and fails closed for new mutation routes", () => {
  const principal = (profile: ControlProfile): AccessPrincipal => ({ role: "collaborator", displayName: "Teste", profile, guildIds: ["111"] });
  for (const profile of ["full", "playback", "effects"] as const) {
    const p = principal(profile);
    assert.equal(canSeeGuild(p, "222"), false);
    assert.equal(canRequest(p, "POST", "/api/sessions/222/actions", { action: "volume" }), false);
    assert.equal(canRequest(p, "POST", "/api/backups/export", {}), false);
    assert.equal(canRequest(p, "PATCH", "/api/access/collaborators/test", {}), false);
    assert.equal(canRequest(p, "POST", "/api/new-dangerous-operation", {}), false);
    assert.equal(canRequest(p, "DELETE", "/api/library/song", {}), false, "Scoped collaborators must not mutate global files");
  }
  assert.equal(canRequest(principal("effects"), "POST", "/api/sessions/111/effects", {}), true);
  assert.equal(canRequest(principal("effects"), "POST", "/api/sessions/111/actions", { action: "volume" }), false);
  assert.equal(canRequest(principal("effects"), "POST", "/api/sessions/111/studio", { action: "scene" }), false);
  assert.equal(canRequest(principal("playback"), "POST", "/api/sessions/111/queue", {}), true);
  assert.equal(canRequest(principal("playback"), "POST", "/api/sessions/111/effects", {}), false);
  assert.equal(canRequest(principal("full"), "POST", "/api/sessions/111/studio", { action: "scene" }), true);
  assert.equal(canRequest({ role: "collaborator", displayName: "Legacy" }, "DELETE", "/api/library/song", {}), true);
});
