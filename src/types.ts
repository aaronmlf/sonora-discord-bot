export const AUDIO_CATEGORIES = ["music", "effect"] as const;
export type AudioCategory = (typeof AUDIO_CATEGORIES)[number];

export const REPEAT_MODES = ["off", "track", "queue"] as const;
export type RepeatMode = (typeof REPEAT_MODES)[number];

export const PLAYER_STATUSES = [
  "idle",
  "buffering",
  "playing",
  "paused",
  "error",
] as const;
export type PlayerStatus = (typeof PLAYER_STATUSES)[number];

export interface TrackBase {
  id: string;
  title: string;
  artist?: string;
  album?: string;
  category: AudioCategory;
  durationMs?: number;
  thumbnailUrl?: string;
}

export interface LibraryTrack extends TrackBase {
  favorite?: boolean;
  tags?: string[];
  contentHash?: string;
  addedAt?: string;
  source: "local";
  relativePath: string;
  sizeBytes: number;
  format?: string;
  modifiedAt: string;
}

export interface ExternalTrack extends TrackBase {
  source: "youtube";
  category: "music";
  webpageUrl: string;
  originalUrl: string;
  resolvedFrom: "youtube" | "spotify";
}

export type PlayableTrack = LibraryTrack | ExternalTrack;

export type QueuedTrack = PlayableTrack & {
  entryId?: string;
  requestedBy: string;
  requestedAt: string;
};

export interface PlaylistItem {
  id: string;
  trackId: string;
  addedAt: string;
}

export interface Playlist {
  id: string;
  name: string;
  description?: string;
  items: PlaylistItem[];
  createdAt: string;
  updatedAt: string;
}

export type AccessRole = "owner" | "collaborator";
export type ControlProfile = "full" | "playback" | "effects";
export interface AccessPolicy { profile: ControlProfile; guildIds: string[] | null }

export interface AccessPrincipal {
  profile?: ControlProfile;
  guildIds?: string[] | null;
  role: AccessRole;
  displayName: string;
  collaboratorId?: string;
}

export interface AccessStatus {
  authenticated: boolean;
  principal: AccessPrincipal | null;
  csrfToken: string | null;
  remoteAccessEnabled: boolean;
  publicUrl: string | null;
}

export interface CollaboratorSummary {
  profile?: ControlProfile;
  guildIds?: string[] | null;
  id: string;
  displayName: string;
  status: "pending" | "active" | "revoked";
  createdAt: string;
  redeemedAt: string | null;
  lastSeenAt: string | null;
}

export interface InvitationSummary {
  id: string;
  collaboratorId: string;
  displayName: string;
  status: "pending" | "used" | "expired" | "revoked";
  createdAt: string;
  expiresAt: string;
}

export interface ActiveEffect {
  playbackId: string;
  trackId: string;
  title: string;
  startedAt: string;
}

export interface SessionSnapshot {
  environmentVolume?: number;
  environments?: (ActiveEffect & { volume: number })[];
  ducking?: boolean;
  recoveryAvailable?: boolean;
  guildId: string;
  guildName: string;
  voiceChannelId?: string;
  voiceChannelName?: string;
  status: PlayerStatus;
  current: QueuedTrack | null;
  upcoming: QueuedTrack[];
  repeatMode: RepeatMode;
  volume: number;
  effectVolume: number;
  activeEffects: ActiveEffect[];
  startedAt: string | null;
  pausedAt: string | null;
  error: string | null;
}

export interface Scene {
  id: string;
  name: string;
  playlistId: string | null;
  environments: { trackId: string; volume: number }[];
  effectIds: string[];
  musicVolume: number;
  environmentVolume: number;
  effectVolume: number;
  ducking: boolean;
  transitionMs: number;
}

export interface AppSnapshot {
  bot: {
    configured: boolean;
    connected: boolean;
    username: string | null;
  };
  library: LibraryTrack[];
  playlists: Playlist[];
  sessions: SessionSnapshot[];
}
