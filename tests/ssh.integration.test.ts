import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Server, utils, type Connection, type ServerChannel } from 'ssh2';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openRemote, type Transport } from '../src/main/transports';
import type { Profile } from '../src/shared/schema';
const key = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey;
const connections = new Set<Connection>();
const channels = new Set<ServerChannel>();
const servers: Server[] = [];
const ports: number[] = [];
const userPrivateKey = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: {
    type: 'pkcs1',
    format: 'pem',
    cipher: 'aes-256-cbc',
    passphrase: 'fixture-key-passphrase',
  },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey;
const parsedUserKey = utils.parseKey(userPrivateKey, 'fixture-key-passphrase');
if (parsedUserKey instanceof Error || Array.isArray(parsedUserKey))
  throw new Error('Invalid fixture key');
let keyDirectory: string;
let keyPath: string;
let counter = 0;
beforeAll(async () => {
  keyDirectory = await mkdtemp(path.join(os.tmpdir(), 'myterminal-key-test-'));
  keyPath = path.join(keyDirectory, 'encrypted-key.pem');
  await writeFile(keyPath, userPrivateKey);
  for (let i = 0; i < 2; i++) {
    const server = new Server({ hostKeys: [key] }, (client) => {
      connections.add(client);
      client.on('error', () => {});
      client.on('close', () => connections.delete(client));
      client.on('authentication', (ctx) => {
        if (
          ctx.method === 'password' &&
          ctx.username === 'test-user' &&
          ctx.password === 'test-only-password'
        )
          ctx.accept();
        else if (
          ctx.method === 'publickey' &&
          ctx.username === 'test-user' &&
          ctx.key.data.equals(parsedUserKey.getPublicSSH()) &&
          (!ctx.signature || parsedUserKey.verify(ctx.blob!, ctx.signature, ctx.hashAlgo) === true)
        )
          ctx.accept();
        else ctx.reject();
      });
      client.on('ready', () =>
        client.on('session', (accept) => {
          const session = accept();
          session.on('pty', (accept) => accept?.());
          session.on('window-change', (accept) => accept?.());
          session.on('shell', (accept) => {
            const channel = accept();
            channels.add(channel);
            const id = ++counter;
            channel.write(`session-${id}\r\n`);
            channel.on('data', (data: Buffer) => channel.write(`echo-${id}:${data}`));
            channel.on('close', () => channels.delete(channel));
          });
          session.on('exec', (accept) => {
            const channel = accept();
            channel.exit(1);
            channel.end();
          });
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    ports.push((server.address() as { port: number }).port);
  }
});
afterAll(async () => {
  for (const c of connections) c.end();
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  await rm(keyDirectory, { recursive: true, force: true });
});
const p = (port = ports[0]): Profile => ({
  id: randomUUID(),
  name: 'Controlled SSH fixture',
  host: '127.0.0.1',
  port,
  username: 'test-user',
  auth: 'password',
  keyPath: '',
  remoteShell: '',
  autoConnect: false,
});
const size = { cols: 90, rows: 28 };
const connect = (profile = p(), secret = 'test-only-password', trust = async () => true) =>
  openRemote(profile, secret, size, new AbortController().signal, trust);
async function output(t: Transport) {
  let text = '';
  t.subscribe(
    (data) => {
      text += data;
    },
    () => {},
  );
  t.resume();
  return { text: () => text };
}
describe('real loopback SSH transport (protocol fixture, not a remote OS shell)', () => {
  it('authenticates, opens independent channels on two endpoints, and isolates disconnects', async () => {
    const a = await connect(),
      b = await connect(),
      c = await connect(p(ports[1]));
    try {
      const ao = await output(a),
        bo = await output(b),
        co = await output(c);
      await expect.poll(() => ao.text()).toContain('session-');
      await expect.poll(() => bo.text()).toContain('session-');
      expect(ao.text()).not.toBe(bo.text());
      a.close();
      b.write('alive\r');
      c.write('other-host\r');
      b.resize({ cols: 120, rows: 40 });
      await expect.poll(() => bo.text()).toContain('alive');
      await expect.poll(() => co.text()).toContain('other-host');
    } finally {
      a.close();
      b.close();
      c.close();
    }
  });
  it('rejects wrong credentials and untrusted keys', async () => {
    await expect(connect(p(), 'wrong')).rejects.toThrow('Authentication failed');
    await expect(connect(p(), 'test-only-password', async () => false)).rejects.toThrow(
      'not trusted',
    );
  });
  it('authenticates with an encrypted private key and rejects a bad passphrase', async () => {
    const profile = { ...p(), auth: 'key' as const, keyPath };
    const t = await connect(profile, 'fixture-key-passphrase');
    const out = await output(t);
    await expect.poll(() => out.text()).toContain('session-');
    t.close();
    await expect(connect(profile, 'incorrect-passphrase')).rejects.toThrow('private key');
  });
  it('reports unsupported explicit shells without replacing a live session', async () => {
    await expect(connect({ ...p(), remoteShell: '/missing/shell' })).rejects.toThrow('unavailable');
  });
  it('reports a real interrupted connection', async () => {
    const t = await connect();
    let ended = false;
    t.subscribe(
      () => {},
      () => {
        ended = true;
      },
    );
    t.resume();
    for (const c of connections) c.end();
    await expect.poll(() => ended).toBe(true);
    t.close();
  });
  it('exposes a SHA256 fingerprint for trust and rejects an unreachable endpoint', async () => {
    let fingerprint = '';
    const t = await openRemote(
      p(),
      'test-only-password',
      size,
      new AbortController().signal,
      async (_, f) => {
        fingerprint = f;
        return true;
      },
    );
    t.close();
    expect(fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    await expect(connect(p(1))).rejects.toThrow('failed');
  });
});
