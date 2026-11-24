import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { AccessService } from "../src/access/access-service.js";

describe("AccessService", () => {
  it("cria convite de uso unico, autentica e revoga o colaborador", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "sonora-access-"));
    try {
      const access = new AccessService(dataDir);
      await access.initialize();
      const invitation = await access.createInvitation("Volt");

      assert.equal(access.previewInvitation(invitation.token)?.displayName, "Volt");
      const session = await access.redeemInvitation(invitation.token);
      assert.equal(access.previewInvitation(invitation.token), null);
      assert.equal(session.principal.role, "collaborator");

      const authenticated = access.authenticate(session.sessionToken);
      assert.equal(authenticated?.principal.displayName, "Volt");
      assert.ok(authenticated);
      assert.equal(access.verifyCsrf(authenticated, session.csrfToken), true);
      assert.equal(access.verifyCsrf(authenticated, "token-incorreto"), false);

      const persisted = await readFile(path.join(dataDir, "access.json"), "utf8");
      assert.equal(persisted.includes(invitation.token), false);
      assert.equal(persisted.includes(session.sessionToken), false);
      assert.equal((await stat(path.join(dataDir, "access.json"))).mode & 0o077, 0);

      await access.revokeCollaborator(invitation.collaboratorId);
      assert.equal(access.authenticate(session.sessionToken), null);
      assert.equal(access.listCollaborators()[0]?.status, "revoked");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("permite cancelar um convite ainda pendente", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "sonora-invite-"));
    try {
      const access = new AccessService(dataDir);
      await access.initialize();
      const invitation = await access.createInvitation("Convidado");
      await access.revokeInvitation(invitation.id);
      assert.equal(access.previewInvitation(invitation.token), null);
      assert.equal(access.listInvitations()[0]?.status, "revoked");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
