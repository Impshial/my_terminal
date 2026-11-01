import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  configSchema,
  defaultConfig,
  preferencesSchema,
  profileSchema,
  type Config,
  type Preferences,
  type Profile,
} from '../shared/schema';

export interface SecretCodec {
  encrypt(text: string): Promise<string>;
  decrypt(text: string): Promise<string>;
}
const binding = (p: Profile) =>
  createHash('sha256')
    .update(JSON.stringify([p.host.toLowerCase(), p.port, p.username, p.auth, p.keyPath]))
    .digest('hex');
export class ConfigStore {
  data = defaultConfig();
  warning?: string;
  private queue: Promise<void> = Promise.resolve();
  constructor(
    readonly directory: string,
    private codec: SecretCodec,
  ) {}
  get file() {
    return path.join(this.directory, 'config.json');
  }
  async load() {
    await mkdir(this.directory, { recursive: true });
    try {
      this.data = configSchema.parse(JSON.parse(await readFile(this.file, 'utf8')));
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        // Preserve the original for recovery, without ever logging its contents.
        await rename(
          this.file,
          path.join(this.directory, `config.invalid-${Date.now()}.json`),
        ).catch(() => {});
        this.warning =
          'Invalid settings were preserved in the application-data folder. MyTerminal loaded safe defaults.';
      }
      this.data = defaultConfig();
    }
  }
  private transaction(change: (draft: Config) => Promise<void> | void): Promise<void> {
    const next = this.queue
      .catch(() => {})
      .then(async () => {
        const draft = structuredClone(this.data);
        await change(draft);
        const valid = configSchema.parse(draft);
        const temporary = path.join(this.directory, `config-${randomUUID()}.tmp`);
        await writeFile(temporary, JSON.stringify(valid, null, 2), {
          encoding: 'utf8',
          mode: 0o600,
          flush: true,
        });
        await rename(temporary, this.file);
        this.data = valid;
      });
    this.queue = next;
    return next;
  }
  publicProfiles() {
    return structuredClone(this.data.profiles);
  }
  saveProfile(input: Profile, secret?: string, saveSecret = false) {
    const profile = profileSchema.parse(input);
    return this.transaction(async (draft) => {
      const old = draft.profiles.find((p) => p.id === profile.id);
      if (old && binding(old) !== binding(profile)) delete draft.secrets[profile.id];
      draft.profiles = [...draft.profiles.filter((p) => p.id !== profile.id), profile];
      if (saveSecret && secret !== undefined)
        draft.secrets[profile.id] = {
          binding: binding(profile),
          ciphertext: await this.codec.encrypt(secret),
        };
    });
  }
  deleteProfile(id: string) {
    return this.transaction((d) => {
      d.profiles = d.profiles.filter((p) => p.id !== id);
      delete d.secrets[id];
    });
  }
  forgetSecret(id: string) {
    return this.transaction((d) => {
      delete d.secrets[id];
    });
  }
  async secret(profile: Profile): Promise<string | undefined> {
    await this.queue.catch(() => {});
    const item = this.data.secrets[profile.id];
    if (!item || item.binding !== binding(profile)) return undefined;
    try {
      return await this.codec.decrypt(item.ciphertext);
    } catch {
      throw new Error(
        'The saved credential could not be unlocked. Enter it again or forget the saved credential.',
      );
    }
  }
  preferences(input: Preferences) {
    const p = preferencesSchema.parse(input);
    return this.transaction((d) => {
      d.preferences = p;
    });
  }
  window(bounds: Config['window']) {
    return this.transaction((d) => {
      d.window = bounds;
    });
  }
  hostKey(host: string, port: number) {
    return this.data.knownHosts[`${host.toLowerCase()}:${port}`];
  }
  trustHost(host: string, port: number, fingerprint: string) {
    return this.transaction((d) => {
      d.knownHosts[`${host.toLowerCase()}:${port}`] = fingerprint;
    });
  }
}
