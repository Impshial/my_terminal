// Loopback-only SSH protocol fixture. It echoes input; it is not an OS shell.
import ssh2 from 'ssh2';
const { Server } = ssh2;
import { generateKeyPairSync } from 'node:crypto';
export async function startSSHFixture(password, port = 0) {
  const key = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey;
  const clients = new Set();
  const channels = new Set();
  let count = 0;
  const server = new Server({ hostKeys: [key] }, (client) => {
    clients.add(client);
    client.on('error', () => {});
    client.on('close', () => clients.delete(client));
    client.on('authentication', (context) => {
      if (
        context.method === 'password' &&
        context.username === 'fixture-user' &&
        context.password === password
      )
        context.accept();
      else context.reject();
    });
    client.on('ready', () =>
      client.on('session', (accept) => {
        const session = accept();
        session.on('pty', (accept) => accept?.());
        session.on('window-change', (accept) => accept?.());
        session.on('shell', (accept) => {
          const channel = accept();
          channels.add(channel);
          channel.on('close', () => channels.delete(channel));
          const id = ++count;
          channel.write(`Fixture session ${id}\r\n`);
          channel.on('data', (data) => channel.write(`session-${id}:${data}`));
        });
      }),
    );
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    connections: clients,
    sendAll: (text) => {
      for (const channel of channels) channel.write(text);
    },
    close: async () => {
      for (const client of clients) client.end();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
