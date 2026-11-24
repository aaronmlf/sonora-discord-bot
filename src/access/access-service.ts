import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile, copyFile } from "node:fs/promises";
import type { AccessPolicy } from "../types.js";
import path from "node:path";

import type {
  AccessPrincipal,
  CollaboratorSummary,
  InvitationSummary,
} from "../types.js";

const INVITATION_TTL_MS = 24 * 60 * 60 * 1_000;
const OWNER_SESSION_TTL_MS = 12 * 60 * 60 * 1_000;

interface CollaboratorRecord {
  profile?: AccessPolicy["profile"];
  guildIds?: string[] | null;
  id: string;
  displayName: string;
  createdAt: string;
  redeemedAt?: string;
  lastSeenAt?: string;
  revokedAt?: string;
  sessionTokenHash?: string;
  csrfTokenHash?: string;
}

interface InvitationRecord {
  id: string;
  collaboratorId: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  usedAt?: string;
  revokedAt?: string;
}

interface PersistedAccess {
  version: 1 | 2;
  collaborators: CollaboratorRecord[];
  invitations: InvitationRecord[];
}

interface OwnerSession {
  tokenHash: string;
  csrfTokenHash: string;
  expiresAt: string;
}

export interface AuthenticatedAccess {
  principal: AccessPrincipal;
  csrfTokenHash: string;
  expiresAt: string | null;
}

export interface IssuedSession {
  principal: AccessPrincipal;
  sessionToken: string;
  csrfToken: string;
  expiresAt: string | null;
}

export interface InvitationPreview {
  displayName: string;
  expiresAt: string;
  profile: AccessPolicy["profile"];
  guildIds: string[] | null;
}

export interface CreatedInvitation {
  id: string;
  collaboratorId: string;
  displayName: string;
  token: string;
  expiresAt: string;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function matchesHash(value: string, expectedHash: string): boolean {
  const actual = Buffer.from(hash(value), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function token(): string {
  return randomBytes(32).toString("base64url");
}

export class AccessService {
  private collaborators: CollaboratorRecord[] = [];
  private invitations: InvitationRecord[] = [];
  private readonly ownerSessions = new Map<string, OwnerSession>();
  private readonly metadataPath: string;
  private persistenceQueue: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.metadataPath = path.join(dataDir, "access.json");
  }

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.metadataPath), { recursive: true });
    try {
      const persisted = JSON.parse(
        await readFile(this.metadataPath, "utf8"),
      ) as PersistedAccess;
      if (persisted.version === 1 || persisted.version === 2) {
        this.collaborators = Array.isArray(persisted.collaborators)
          ? persisted.collaborators
          : [];
        this.invitations = Array.isArray(persisted.invitations)
          ? persisted.invitations
          : [];
      }
      if (persisted.version === 1) await copyFile(this.metadataPath, `${this.metadataPath}.pre-v2-${Date.now()}.bak`);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
    }
  }

  issueOwnerSession(): IssuedSession {
    const now = Date.now();
    for (const [tokenHash, session] of this.ownerSessions) {
      if (Date.parse(session.expiresAt) <= now) this.ownerSessions.delete(tokenHash);
    }
    const sessionToken = token();
    const csrfToken = token();
    const expiresAt = new Date(Date.now() + OWNER_SESSION_TTL_MS).toISOString();
    const record: OwnerSession = {
      tokenHash: hash(sessionToken),
      csrfTokenHash: hash(csrfToken),
      expiresAt,
    };
    this.ownerSessions.set(record.tokenHash, record);
    return {
      principal: { role: "owner", displayName: "Anfitrião" },
      sessionToken,
      csrfToken,
      expiresAt,
    };
  }

  authenticate(sessionToken: string): AuthenticatedAccess | null {
    const tokenHash = hash(sessionToken);
    const owner = this.ownerSessions.get(tokenHash);
    if (owner) {
      if (Date.parse(owner.expiresAt) <= Date.now()) {
        this.ownerSessions.delete(tokenHash);
        return null;
      }
      return {
        principal: { role: "owner", displayName: "Anfitrião" },
        csrfTokenHash: owner.csrfTokenHash,
        expiresAt: owner.expiresAt,
      };
    }

    const collaborator = this.collaborators.find(
      (candidate) =>
        !candidate.revokedAt &&
        Boolean(candidate.sessionTokenHash) &&
        matchesHash(sessionToken, candidate.sessionTokenHash ?? ""),
    );
    if (!collaborator?.sessionTokenHash || !collaborator.csrfTokenHash) return null;
    collaborator.lastSeenAt = new Date().toISOString();
    return {
      principal: {
        role: "collaborator",
        displayName: collaborator.displayName,
        collaboratorId: collaborator.id,
        profile: collaborator.profile ?? "full",
        guildIds: collaborator.guildIds ?? null,
      },
      csrfTokenHash: collaborator.csrfTokenHash,
      expiresAt: null,
    };
  }

  verifyCsrf(access: AuthenticatedAccess, csrfToken: string): boolean {
    return matchesHash(csrfToken, access.csrfTokenHash);
  }

  revokeSession(sessionToken: string): Promise<void> {
    const tokenHash = hash(sessionToken);
    if (this.ownerSessions.delete(tokenHash)) return Promise.resolve();
    const collaborator = this.collaborators.find(
      (candidate) => candidate.sessionTokenHash === tokenHash,
    );
    if (!collaborator) return Promise.resolve();
    delete collaborator.sessionTokenHash;
    delete collaborator.csrfTokenHash;
    return this.persist();
  }

  async createInvitation(displayName: string, policy: AccessPolicy = { profile: "full", guildIds: null }): Promise<CreatedInvitation> {
    const cleanName = displayName.trim();
    if (!cleanName) throw new Error("Informe o nome do convidado.");
    const now = new Date();
    const collaborator: CollaboratorRecord = {
      ...policy,
      id: randomUUID(),
      displayName: cleanName,
      createdAt: now.toISOString(),
    };
    const invitationToken = token();
    const invitation: InvitationRecord = {
      id: randomUUID(),
      collaboratorId: collaborator.id,
      tokenHash: hash(invitationToken),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + INVITATION_TTL_MS).toISOString(),
    };
    this.collaborators.push(collaborator);
    this.invitations.push(invitation);
    await this.persist();
    return {
      id: invitation.id,
      collaboratorId: collaborator.id,
      displayName: collaborator.displayName,
      token: invitationToken,
      expiresAt: invitation.expiresAt,
    };
  }

  previewInvitation(invitationToken: string): InvitationPreview | null {
    const invitation = this.findUsableInvitation(invitationToken);
    if (!invitation) return null;
    const collaborator = this.collaborators.find(
      ({ id }) => id === invitation.collaboratorId,
    );
    if (!collaborator || collaborator.revokedAt) return null;
    return {
      displayName: collaborator.displayName,
      expiresAt: invitation.expiresAt,
      profile: collaborator.profile ?? "full",
      guildIds: collaborator.guildIds ?? null,
    };
  }

  async redeemInvitation(invitationToken: string): Promise<IssuedSession> {
    const invitation = this.findUsableInvitation(invitationToken);
    if (!invitation) throw new Error("Convite invalido, usado ou expirado.");
    const collaborator = this.collaborators.find(
      ({ id }) => id === invitation.collaboratorId,
    );
    if (!collaborator || collaborator.revokedAt) {
      throw new Error("Este acesso foi revogado.");
    }

    const sessionToken = token();
    const csrfToken = token();
    const now = new Date().toISOString();
    invitation.usedAt = now;
    collaborator.redeemedAt = now;
    collaborator.lastSeenAt = now;
    collaborator.sessionTokenHash = hash(sessionToken);
    collaborator.csrfTokenHash = hash(csrfToken);
    await this.persist();
    return {
      principal: {
        role: "collaborator",
        displayName: collaborator.displayName,
        collaboratorId: collaborator.id,
        profile: collaborator.profile ?? "full",
        guildIds: collaborator.guildIds ?? null,
      },
      sessionToken,
      csrfToken,
      expiresAt: null,
    };
  }

  async revokeInvitation(invitationId: string): Promise<void> {
    const invitation = this.invitations.find(({ id }) => id === invitationId);
    if (!invitation || invitation.usedAt || invitation.revokedAt) {
      throw new Error("Convite pendente nao encontrado.");
    }
    invitation.revokedAt = new Date().toISOString();
    const collaborator = this.collaborators.find(
      ({ id }) => id === invitation.collaboratorId,
    );
    if (collaborator && !collaborator.redeemedAt) {
      collaborator.revokedAt = invitation.revokedAt;
    }
    await this.persist();
  }

  async revokeCollaborator(collaboratorId: string): Promise<void> {
    const collaborator = this.collaborators.find(({ id }) => id === collaboratorId);
    if (!collaborator || collaborator.revokedAt) {
      throw new Error("Colaborador ativo nao encontrado.");
    }
    const revokedAt = new Date().toISOString();
    collaborator.revokedAt = revokedAt;
    delete collaborator.sessionTokenHash;
    delete collaborator.csrfTokenHash;
    for (const invitation of this.invitations) {
      if (invitation.collaboratorId === collaboratorId && !invitation.usedAt) {
        invitation.revokedAt = revokedAt;
      }
    }
    await this.persist();
  }

  listCollaborators(): CollaboratorSummary[] {
    return this.collaborators
      .map((collaborator) => ({
        id: collaborator.id,
        profile: collaborator.profile ?? "full",
        guildIds: collaborator.guildIds ?? null,
        displayName: collaborator.displayName,
        status: collaborator.revokedAt
          ? "revoked" as const
          : collaborator.redeemedAt
            ? "active" as const
            : "pending" as const,
        createdAt: collaborator.createdAt,
        redeemedAt: collaborator.redeemedAt ?? null,
        lastSeenAt: collaborator.lastSeenAt ?? null,
      }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  listInvitations(): InvitationSummary[] {
    return this.invitations
      .map((invitation) => {
        const collaborator = this.collaborators.find(
          ({ id }) => id === invitation.collaboratorId,
        );
        const status: InvitationSummary["status"] = invitation.revokedAt
          ? "revoked"
          : invitation.usedAt
            ? "used"
            : Date.parse(invitation.expiresAt) <= Date.now()
              ? "expired"
              : "pending";
        return {
          id: invitation.id,
          collaboratorId: invitation.collaboratorId,
          displayName: collaborator?.displayName ?? "Convidado removido",
          status,
          createdAt: invitation.createdAt,
          expiresAt: invitation.expiresAt,
        };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private findUsableInvitation(invitationToken: string): InvitationRecord | null {
    return this.invitations.find(
      (invitation) =>
        !invitation.usedAt &&
        !invitation.revokedAt &&
        Date.parse(invitation.expiresAt) > Date.now() &&
        matchesHash(invitationToken, invitation.tokenHash),
    ) ?? null;
  }

  async updatePolicy(id: string, policy: AccessPolicy): Promise<void> {
    const collaborator = this.collaborators.find(item => item.id === id && !item.revokedAt);
    if (!collaborator) throw new Error("Colaborador não encontrado.");
    collaborator.profile = policy.profile; collaborator.guildIds = policy.guildIds ? [...new Set(policy.guildIds)] : null;
    await this.persist();
  }

  private async persist(): Promise<void> {
    const payload: PersistedAccess = {
      version: 2,
      collaborators: structuredClone(this.collaborators),
      invitations: structuredClone(this.invitations),
    };
    const serialized = `${JSON.stringify(payload, null, 2)}\n`;
    const write = async (): Promise<void> => {
      const temporaryPath = `${this.metadataPath}.${randomUUID()}.tmp`;
      await writeFile(temporaryPath, serialized, {
        encoding: "utf8",
        mode: 0o600,
      });
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, this.metadataPath);
    };
    const pending = this.persistenceQueue.then(write, write);
    this.persistenceQueue = pending.catch(() => undefined);
    await pending;
  }
}
