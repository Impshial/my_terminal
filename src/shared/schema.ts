import { z } from 'zod';

export const idSchema = z.string().uuid();
export const profileSchema = z
  .object({
    id: idSchema,
    name: z.string().trim().min(1).max(80),
    host: z
      .string()
      .trim()
      .min(1)
      .max(253)
      .regex(/^[a-zA-Z0-9._:%-]+$/, 'Use a hostname or IP address, without a URL or command.'),
    port: z.number().int().min(1).max(65535),
    username: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[^\s\x00-\x1f\x7f]+$/),
    auth: z.enum(['password', 'key']),
    keyPath: z.string().max(2048).default(''),
    remoteShell: z
      .string()
      .max(256)
      .regex(/^(|\/[a-zA-Z0-9_./-]+)$/, 'Use an absolute POSIX shell path, such as /bin/zsh.')
      .default(''),
    autoConnect: z.boolean().default(false),
  })
  .strict()
  .refine((p) => p.auth !== 'key' || p.keyPath.length > 0, {
    message: 'Select a private key file.',
    path: ['keyPath'],
  });
export type Profile = z.infer<typeof profileSchema>;
export const preferencesSchema = z
  .object({
    appTheme: z.enum(['dark', 'light']).default('dark'),
    terminalTheme: z.enum(['powershell', 'command', 'retro']).default('powershell'),
    terminalFont: z
      .enum(['auto', 'Consolas', 'Cascadia Code', 'Cascadia Mono', 'Courier New'])
      .default('auto'),
    fontSize: z.number().int().min(9).max(32).default(14),
    scrollback: z.number().int().min(100).max(100000).default(10000),
    confirmClose: z.boolean().default(true),
    confirmMultilinePaste: z.boolean().default(true),
    shellPaths: z
      .object({
        pwsh: z.string().max(2048).default(''),
        powershell: z.string().max(2048).default(''),
        cmd: z.string().max(2048).default(''),
        wsl: z.string().max(2048).default(''),
        gitbash: z.string().max(2048).default(''),
      })
      .default({ pwsh: '', powershell: '', cmd: '', wsl: '', gitbash: '' }),
  })
  .strict();
export type Preferences = z.infer<typeof preferencesSchema>;
export const connectSchema = z
  .object({
    id: idSchema,
    profile: profileSchema,
    secret: z.string().max(16384).optional(),
    saveProfile: z.boolean(),
    saveSecret: z.boolean(),
    automatic: z.boolean().default(false),
  })
  .strict();
export type ConnectRequest = z.infer<typeof connectSchema>;
export const sizeSchema = z
  .object({ cols: z.number().int().min(2).max(500), rows: z.number().int().min(1).max(300) })
  .strict();
export type Size = z.infer<typeof sizeSchema>;
export const configSchema = z
  .object({
    version: z.literal(1),
    profiles: z.array(profileSchema).max(500),
    preferences: preferencesSchema,
    knownHosts: z.record(z.string(), z.string().regex(/^SHA256:[A-Za-z0-9+/]+$/)).default({}),
    secrets: z
      .record(z.string(), z.object({ binding: z.string(), ciphertext: z.string() }).strict())
      .default({}),
    window: z
      .object({
        width: z.number().min(760).max(10000),
        height: z.number().min(500).max(10000),
        x: z.number().optional(),
        y: z.number().optional(),
        maximized: z.boolean().default(false),
      })
      .optional(),
  })
  .strict();
export type Config = z.infer<typeof configSchema>;
export const defaultConfig = (): Config => ({
  version: 1,
  profiles: [],
  preferences: preferencesSchema.parse({}),
  knownHosts: {},
  secrets: {},
});

export type ShellOption = {
  id: string;
  name: string;
  available: boolean;
  executable: string;
  args: string[];
  reason?: string;
};
export type State = 'idle' | 'running' | 'connected' | 'disconnected' | 'exited' | 'error';
export type Tab = {
  id: string;
  generation: string;
  title: string;
  customTitle: boolean;
  kind: 'local' | 'remote';
  label: string;
  state: State;
  pending?: string;
  error?: string;
  exitCode?: number;
  shellId?: string;
  profile?: Profile;
};
export type SessionEvent =
  | { type: 'tab'; tab: Tab }
  | { type: 'data'; id: string; generation: string; data: string }
  | { type: 'reset'; id: string; generation: string; label: string }
  | { type: 'removed'; id: string };
export type Bootstrap = {
  profiles: Profile[];
  preferences: Preferences;
  shells: ShellOption[];
  warning?: string;
  version: string;
};
export type Action =
  | 'new'
  | 'connect'
  | 'manage'
  | 'close'
  | 'settings'
  | 'copy'
  | 'paste'
  | 'selectAll'
  | 'find'
  | 'clear'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomReset'
  | 'shortcuts'
  | 'help'
  | 'about'
  | 'refreshPreferences';
export type Reply<T> = { ok: true; value: T } | { ok: false; error: string };
export interface Bridge {
  bootstrap(): Promise<Bootstrap>;
  create(): Promise<Tab>;
  local(id: string, shellId: string, cwd?: string): Promise<void>;
  connect(request: ConnectRequest): Promise<void>;
  disconnect(id: string): Promise<void>;
  close(id: string): Promise<boolean>;
  rename(id: string, title: string): Promise<void>;
  input(id: string, generation: string, data: string): void;
  resize(id: string, generation: string, size: Size): void;
  ack(id: string, generation: string, length: number): void;
  profiles(): Promise<Profile[]>;
  saveProfile(profile: Profile): Promise<void>;
  deleteProfile(id: string): Promise<void>;
  forgetSecret(id: string): Promise<void>;
  preferences(preferences: Preferences): Promise<void>;
  browseKey(): Promise<string | undefined>;
  copy(text: string): Promise<void>;
  paste(): Promise<string | undefined>;
  confirmPaste(text: string): Promise<boolean>;
  onEvent(callback: (event: SessionEvent) => void): () => void;
  onAction(callback: (action: Action) => void): () => void;
}
