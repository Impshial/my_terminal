import { contextBridge, ipcRenderer } from 'electron';
import type { Action, Bridge, Reply, SessionEvent } from '../shared/schema';
async function invoke<T>(channel: string, args?: unknown): Promise<T> {
  const reply = (await ipcRenderer.invoke(channel, args)) as Reply<T>;
  if (!reply.ok) throw new Error(reply.error);
  return reply.value;
}
const bridge: Bridge = {
  bootstrap: () => invoke('app:bootstrap'),
  create: () => invoke('tab:create'),
  local: (id, shellId, cwd) => invoke('tab:local', { id, shellId, cwd }),
  connect: (args) => invoke('tab:connect', args),
  disconnect: (id) => invoke('tab:disconnect', { id }),
  close: (id) => invoke('tab:close', { id }),
  rename: (id, title) => invoke('tab:rename', { id, title }),
  input: (id, generation, data) => ipcRenderer.send('terminal:input', { id, generation, data }),
  resize: (id, generation, size) => ipcRenderer.send('terminal:resize', { id, generation, size }),
  ack: (id, generation, length) => ipcRenderer.send('terminal:ack', { id, generation, length }),
  profiles: () => invoke('profiles:list'),
  saveProfile: (p) => invoke('profiles:save', p),
  deleteProfile: (id) => invoke('profiles:delete', { id }),
  forgetSecret: (id) => invoke('profiles:forget', { id }),
  preferences: (p) => invoke('preferences:save', p),
  browseKey: () => invoke('key:browse'),
  copy: (text) => invoke('clipboard:copy', text),
  paste: () => invoke('clipboard:paste'),
  confirmPaste: (text) => invoke('clipboard:confirm', text),
  onEvent(callback) {
    const listener = (_: unknown, event: SessionEvent) => callback(event);
    ipcRenderer.on('terminal:event', listener);
    return () => {
      ipcRenderer.removeListener('terminal:event', listener);
    };
  },
  onAction(callback) {
    const listener = (_: unknown, action: Action) => callback(action);
    ipcRenderer.on('app:action', listener);
    return () => {
      ipcRenderer.removeListener('app:action', listener);
    };
  },
};
contextBridge.exposeInMainWorld('myterminal', bridge);
