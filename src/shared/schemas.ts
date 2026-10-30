// Schemas shared by the daemon (request validation) and the web UI (typed responses).
import { z } from 'zod';

export const remotePath = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => p.startsWith('/'), 'path must start with /')
  .refine((p) => !p.split('/').some((s) => s === '..' || s === '.'), 'path must not contain . or ..')
  .refine((p) => !p.includes('\0'), 'path must not contain NUL');

export const remoteName = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[^/\\:*?"<>|]+$/, 'name must not contain / \\ : * ? " < > |');

export const localConfig = z.object({ root: z.string().min(1) });
export const webdavConfig = z.object({
  url: z.url(),
  username: z.string().optional(),
  password: z.string().optional(),
});
export const gdriveConfig = z.object({
  flowId: z.string().min(1),
  folderName: z.string().min(1).max(100).default('Farshelf'),
});

export const createRemoteInput = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('local'),
    name: remoteName,
    config: localConfig,
    passphrase: z.string().min(8).optional(),
  }),
  z.object({
    kind: z.literal('webdav'),
    name: remoteName,
    config: webdavConfig,
    passphrase: z.string().min(8).optional(),
  }),
  z.object({
    kind: z.literal('gdrive'),
    name: remoteName,
    config: gdriveConfig,
    passphrase: z.string().min(8).optional(),
  }),
]);
export type CreateRemoteInput = z.infer<typeof createRemoteInput>;

export const unlockInput = z.union([
  z.object({ passphrase: z.string().min(1) }),
  z.object({ recoveryKey: z.string().min(1) }),
]);

export const pathInput = z.object({ path: remotePath, source: z.enum(['user', 'ai']).default('user') });
export const moveInput = z.object({
  from: remotePath,
  to: remotePath,
  source: z.enum(['user', 'ai']).default('user'),
});

export const fileCategory = z.enum(['video', 'audio', 'image', 'document', 'archive', 'code']);
export const searchFilter = z.object({
  text: z.string().max(200).optional(),
  remoteId: z.string().optional(),
  kind: z.enum(['file', 'dir']).optional(),
  category: fileCategory.optional(),
  extensions: z.array(z.string().max(16)).max(50).optional(),
  minSize: z.number().int().nonnegative().optional(),
  maxSize: z.number().int().nonnegative().optional(),
  modifiedAfter: z.iso.date().optional(),
  modifiedBefore: z.iso.date().optional(),
  pathPrefix: z.string().max(4096).optional(),
  sort: z.enum(['relevance', 'name', 'size', 'mtime']).default('relevance'),
  order: z.enum(['asc', 'desc']).default('desc'),
  limit: z.number().int().min(1).max(500).default(50),
});
export type SearchFilter = z.infer<typeof searchFilter>;

export const aiSettings = z.object({
  enabled: z.boolean().default(false),
  provider: z.enum(['ollama', 'openai']).default('ollama'),
  baseUrl: z.url().default('http://127.0.0.1:11434'),
  model: z.string().min(1).max(200).default('llama3.2'),
  timeoutMs: z.number().int().min(1000).max(600_000).default(60_000),
});
export type AiSettings = z.infer<typeof aiSettings>;

export const settingsSchema = z.object({
  cacheLimitMiB: z.number().int().min(16).max(16_384).default(256),
  readAheadBlocks: z.number().int().min(0).max(32).default(6),
  uploadConcurrency: z.number().int().min(1).max(8).default(2),
  trashRetentionDays: z.number().int().min(1).max(365).default(30),
  lastUploadRemoteId: z.string().nullable().default(null),
  ai: aiSettings.default(aiSettings.parse({})),
});
export type Settings = z.infer<typeof settingsSchema>;
export const settingsPatch = settingsSchema
  .omit({ ai: true })
  .partial()
  .extend({ ai: aiSettings.partial().optional(), aiApiKey: z.string().max(500).nullable().optional() });

// The only operations an AI plan may propose. Executed by the UI calling the normal API after approval.
export const planStep = z.discriminatedUnion('tool', [
  z.object({ tool: z.literal('mkdir'), path: remotePath, reason: z.string().max(500).optional() }),
  z.object({
    tool: z.literal('move'),
    from: remotePath,
    to: remotePath,
    reason: z.string().max(500).optional(),
  }),
  z.object({ tool: z.literal('trash'), path: remotePath, reason: z.string().max(500).optional() }),
]);
export type PlanStep = z.infer<typeof planStep>;
export const aiPlan = z.object({
  summary: z.string().max(2000),
  steps: z.array(planStep).max(100),
});
export type AiPlan = z.infer<typeof aiPlan>;

export const aiPlanInput = z.object({
  request: z.string().min(1).max(2000),
  remoteId: z.string(),
  cwd: remotePath,
  shareNames: z.boolean().default(false),
});
export const aiSearchInput = z.object({ question: z.string().min(1).max(500) });

// ---- Response shapes (used by the UI) ----
export type RemoteKind = 'local' | 'webdav' | 'gdrive';
export interface RemoteInfo {
  id: string;
  name: string;
  kind: RemoteKind;
  encrypted: boolean;
  locked: boolean;
  createdAt: number;
  summary: string;
}
export interface Entry {
  name: string;
  path: string;
  kind: 'file' | 'dir';
  size: number;
  mtime: number;
  pending?: boolean;
}
export type JobState = 'queued' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled';
export interface JobInfo {
  id: string;
  kind: 'upload' | 'index';
  remoteId: string;
  state: JobState;
  label: string;
  path: string;
  progress: number;
  total: number;
  rate: number;
  error: string | null;
  attempts: number;
  createdAt: number;
  updatedAt: number;
}
export interface ActivityItem {
  id: number;
  ts: number;
  level: 'info' | 'warn' | 'error';
  remoteId: string | null;
  action: string;
  path: string | null;
  message: string;
}
export interface TrashItem {
  id: string;
  remoteId: string;
  originalPath: string;
  name: string;
  kind: 'file' | 'dir';
  size: number;
  trashedAt: number;
}
export interface SearchResult {
  remoteId: string;
  remoteName: string;
  path: string;
  name: string;
  kind: 'file' | 'dir';
  size: number;
  mtime: number;
}
export interface AppState {
  version: string;
  remotes: RemoteInfo[];
  settings: Settings;
  aiKeyStored: boolean;
  dav: { url: string; username: string; password: string };
  cache: { bytes: number; limit: number; entries: number };
  platform: string;
  keychain: string;
  /** 'builtin': one-click Google sign-in is available; 'own-client': the user must supply an OAuth client. */
  googleSignIn: 'builtin' | 'own-client';
}
