import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConfigStore } from '../src/main/store';
import {
  connectSchema,
  preferencesSchema,
  profileSchema,
  type Profile,
} from '../src/shared/schema';
const directories: string[] = [];
const vault = new Map<string, string>();
const codec = {
  async encrypt(text: string) {
    const id = randomUUID();
    vault.set(id, text);
    return id;
  },
  async decrypt(id: string) {
    return vault.get(id)!;
  },
};
const profile = (): Profile => ({
  id: randomUUID(),
  name: 'RunPod',
  host: 'ssh.example.test',
  port: 2222,
  username: 'pod-id-user',
  auth: 'password',
  keyPath: '',
  remoteShell: '',
  autoConnect: false,
});
async function store() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myterminal-store-test-'));
  directories.push(dir);
  const s = new ConfigStore(dir, codec);
  await s.load();
  return s;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
describe('versioned profile persistence', () => {
  it('survives reload without exposing credentials and preserves concurrent edits', async () => {
    const s = await store(),
      a = profile(),
      b = profile();
    await Promise.all([s.saveProfile(a, 'private-password', true), s.saveProfile(b)]);
    const content = await readFile(s.file, 'utf8');
    expect(content).not.toContain('private-password');
    expect(JSON.stringify(s.publicProfiles())).not.toContain('ciphertext');
    const reopened = new ConfigStore(s.directory, codec);
    await reopened.load();
    expect(reopened.publicProfiles()).toHaveLength(2);
    expect(await reopened.secret(a)).toBe('private-password');
  });
  it('never reuses a credential at a changed host or identity', async () => {
    const s = await store(),
      p = profile();
    await s.saveProfile(p, 'credential', true);
    expect(await s.secret({ ...p, host: 'other.test' })).toBeUndefined();
    await s.saveProfile({ ...p, username: 'another-user' });
    expect(await s.secret(p)).toBeUndefined();
    expect(s.data.secrets).toEqual({});
  });
  it('removes credentials with deleted profiles and keeps host trust', async () => {
    const s = await store(),
      p = profile();
    await s.saveProfile(p, 'credential', true);
    await s.trustHost(p.host, p.port, 'SHA256:abcdef');
    await s.deleteProfile(p.id);
    expect(s.publicProfiles()).toEqual([]);
    expect(await s.secret(p)).toBeUndefined();
    expect(s.hostKey(p.host, p.port)).toBe('SHA256:abcdef');
  });
  it('preserves invalid configuration and falls back safely', async () => {
    const s = await store();
    await writeFile(s.file, '{broken');
    const reopened = new ConfigStore(s.directory, codec);
    await reopened.load();
    expect(reopened.warning).toContain('Invalid settings');
    expect(reopened.data.version).toBe(1);
    expect((await readdir(s.directory)).some((f) => f.startsWith('config.invalid-'))).toBe(true);
  });
  it('does not partially save when protected storage fails', async () => {
    const s = await store();
    const failing = new ConfigStore(s.directory, {
      encrypt: async () => {
        throw new Error('locked');
      },
      decrypt: codec.decrypt,
    });
    await failing.load();
    await expect(failing.saveProfile(profile(), 'secret', true)).rejects.toThrow('locked');
    expect(failing.publicProfiles()).toHaveLength(0);
    await failing.saveProfile(profile());
    expect(failing.publicProfiles()).toHaveLength(1);
  });
});
describe('IPC input schemas', () => {
  it('rejects commands, malformed ports, extra secret fields, and excessive buffers', () => {
    const p = profile();
    expect(profileSchema.safeParse({ ...p, host: 'ssh user@host; calc.exe' }).success).toBe(false);
    expect(profileSchema.safeParse({ ...p, remoteShell: '/bin/bash; id' }).success).toBe(false);
    expect(profileSchema.safeParse({ ...p, port: 0 }).success).toBe(false);
    expect(profileSchema.safeParse({ ...p, password: 'plaintext' }).success).toBe(false);
    expect(
      connectSchema.safeParse({
        id: randomUUID(),
        profile: p,
        saveProfile: false,
        saveSecret: false,
        secret: 's'.repeat(17000),
      }).success,
    ).toBe(false);
    expect(preferencesSchema.safeParse({ scrollback: 1e9 }).success).toBe(false);
    expect(
      profileSchema.parse({ ...p, host: '2001:db8::1', username: 'proxied-pod-user' }).username,
    ).toBe('proxied-pod-user');
  });
});
