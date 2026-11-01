import * as pty from 'node-pty';
import { Client, type ClientChannel, type ConnectConfig } from 'ssh2';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import os from 'node:os';
import type { Profile, ShellOption, Size } from '../shared/schema';

export interface Transport {
  write(data: string): void;
  resize(size: Size): void;
  pause(): void;
  resume(): void;
  close(): void;
  subscribe(data: (data: string) => void, exit: (code?: number, error?: string) => void): void;
}
export function openLocal(shell: ShellOption, size: Size, cwd = os.homedir()): Transport {
  if (!shell.available) throw new Error(shell.reason ?? 'Shell is unavailable.');
  const env: NodeJS.ProcessEnv = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = pty.spawn(shell.executable, shell.args, {
    name: 'xterm-256color',
    cols: size.cols,
    rows: size.rows,
    cwd,
    env,
    useConpty: true,
  });
  child.pause();
  let closed = false;
  return {
    write: (data) => {
      if (!closed) child.write(data);
    },
    resize: (s) => {
      if (!closed) child.resize(s.cols, s.rows);
    },
    pause: () => {
      if (!closed) child.pause();
    },
    resume: () => {
      if (!closed) child.resume();
    },
    close: () => {
      if (!closed) {
        closed = true;
        child.kill();
      }
    },
    subscribe: (data, exit) => {
      child.onData(data);
      child.onExit((e) => {
        closed = true;
        exit(e.exitCode);
      });
    },
  };
}
export type TrustHost = (
  profile: Profile,
  fingerprint: string,
  automatic: boolean,
) => Promise<boolean>;
export async function openRemote(
  profile: Profile,
  secret: string | undefined,
  size: Size,
  signal: AbortSignal,
  trust: TrustHost,
  automatic = false,
): Promise<Transport> {
  let privateKey: Buffer | undefined;
  if (profile.auth === 'key') {
    const info = await stat(profile.keyPath).catch(() => {
      throw new Error('Private key file is unavailable. Check the path and file permissions.');
    });
    if (!info.isFile() || info.size > 1024 * 1024)
      throw new Error('Select a private key file smaller than 1 MB.');
    privateKey = await readFile(profile.keyPath);
  }
  if (signal.aborted) throw new Error('Connection cancelled.');
  return new Promise<Transport>((resolve, reject) => {
    const client = new Client();
    let stream: ClientChannel | undefined;
    let ready = false;
    let closed = false;
    let exitCallback: ((code?: number, error?: string) => void) | undefined;
    let exitCode: number | undefined;
    let verificationFailure: string | undefined;
    const clearCredential = () => {
      privateKey?.fill(0);
      privateKey = undefined;
      secret = undefined;
    };
    const finish = (error?: string) => {
      if (closed) return;
      closed = true;
      clearCredential();
      signal.removeEventListener('abort', abort);
      if (!ready) reject(new Error(error ?? 'SSH connection closed before a shell was ready.'));
      else exitCallback?.(exitCode, error);
    };
    const abort = () => {
      finish('Connection cancelled.');
      client.destroy();
    };
    signal.addEventListener('abort', abort, { once: true });
    const fail = (message: string) => {
      finish(message);
      client.destroy();
    };
    client.on('error', (error: Error & { level?: string }) => {
      const message =
        verificationFailure ??
        (error.level === 'client-authentication'
          ? 'Authentication failed. Check the username, key, or password.'
          : error.level === 'client-timeout'
            ? 'SSH connection timed out. Check the hostname, port, and network.'
            : 'SSH connection failed or was interrupted. Check the destination and network.');
      fail(message);
    });
    client.on('close', () => finish());
    client.on('ready', () => {
      clearCredential();
      const attach = (error: Error | undefined, channel: ClientChannel) => {
        if (error) return fail('The server could not start an interactive shell.');
        if (closed) {
          channel?.close();
          return;
        }
        stream = channel;
        channel.pause();
        channel.stderr.pause();
        channel.on('exit', (code: number) => {
          exitCode = code;
        });
        channel.on('close', () => {
          finish();
          client.end();
        });
        channel.on('error', () => fail('The remote terminal channel failed.'));
        ready = true;
        resolve({
          write: (data) => {
            if (!closed) channel.write(data);
          },
          resize: (s) => {
            if (!closed) channel.setWindow(s.rows, s.cols, 0, 0);
          },
          pause: () => {
            channel.pause();
            channel.stderr.pause();
          },
          resume: () => {
            channel.resume();
            channel.stderr.resume();
          },
          close: () => {
            finish();
            channel.close();
            client.end();
            client.destroy();
          },
          subscribe: (data, exit) => {
            exitCallback = exit;
            const out = new StringDecoder('utf8'),
              err = new StringDecoder('utf8');
            channel.on('data', (b: Buffer) => data(out.write(b)));
            channel.stderr.on('data', (b: Buffer) => data(err.write(b)));
            if (closed) exit(exitCode, 'SSH connection closed.');
          },
        });
      };
      const terminal = {
        term: 'xterm-256color',
        cols: size.cols,
        rows: size.rows,
        width: 0,
        height: 0,
      };
      if (!profile.remoteShell) client.shell(terminal, attach);
      else {
        // Explicit shells are restricted to absolute executable paths, never command text.
        const quoted = `'${profile.remoteShell}'`;
        client.exec(`test -x ${quoted} && test ! -d ${quoted}`, (error, check) => {
          if (error)
            return fail(
              'The server does not support checking an explicit POSIX shell. Use the default shell.',
            );
          check.resume();
          check.stderr.resume();
          check.on('error', () => fail('Could not verify the remote shell.'));
          check.on('close', (code: number) => {
            if (closed) return;
            if (code !== 0)
              return fail(
                'The requested remote shell is unavailable. Choose the default shell or an installed executable path.',
              );
            client.exec(`${quoted} -l`, { pty: terminal }, attach);
          });
        });
      }
    });
    const config: ConnectConfig = {
      host: profile.host,
      port: profile.port,
      username: profile.username,
      readyTimeout: 30000,
      keepaliveInterval: 15000,
      keepaliveCountMax: 3,
      hostVerifier: (key: Buffer, callback: (accept: boolean) => void) => {
        const fingerprint = `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
        trust(profile, fingerprint, automatic)
          .then((accept) => {
            if (!accept)
              verificationFailure = 'Host key was not trusted. The connection was stopped.';
            callback(!closed && accept);
          })
          .catch(() => {
            verificationFailure = 'Host key verification failed.';
            callback(false);
          });
      },
      ...(profile.auth === 'key'
        ? { privateKey, passphrase: secret || undefined }
        : { password: secret ?? '' }),
    };
    try {
      client.connect(config);
    } catch {
      fail('Unable to start SSH. Check the private key format and connection settings.');
    }
    // Config credentials are only retained by ssh2 for the handshake, never exposed via tab snapshots.
    config.password = undefined;
    config.passphrase = undefined;
    const timeout = setTimeout(() => {
      if (!ready) fail('SSH shell setup timed out.');
    }, 90000);
    timeout.unref();
    client.once('close', () => clearTimeout(timeout));
  });
}
