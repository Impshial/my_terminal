import { randomUUID } from 'node:crypto';
import type { Profile, SessionEvent, ShellOption, Size, Tab } from '../shared/schema';
import type { Transport } from './transports';

type Entry = {
  owner: number;
  tab: Tab;
  transport?: Transport;
  attempt?: AbortController;
  size: Size;
  outstanding: number;
  paused: boolean;
};
export class SessionManager {
  private entries = new Map<string, Entry>();
  constructor(private emit: (owner: number, event: SessionEvent) => void) {}
  create(owner: number) {
    if ([...this.entries.values()].filter((e) => e.owner === owner).length >= 64)
      throw new Error('The 64-tab limit has been reached.');
    const tab: Tab = {
      id: randomUUID(),
      generation: randomUUID(),
      title: 'New terminal',
      customTitle: false,
      kind: 'local',
      label: 'No session',
      state: 'idle',
    };
    this.entries.set(tab.id, {
      owner,
      tab,
      size: { cols: 100, rows: 30 },
      outstanding: 0,
      paused: false,
    });
    this.publish(this.get(owner, tab.id));
    return structuredClone(tab);
  }
  private get(owner: number, id: string) {
    const e = this.entries.get(id);
    if (!e || e.owner !== owner) throw new Error('Terminal does not belong to this window.');
    return e;
  }
  private publish(e: Entry) {
    this.emit(e.owner, { type: 'tab', tab: structuredClone(e.tab) });
  }
  snapshot(owner: number, id: string) {
    return structuredClone(this.get(owner, id).tab);
  }
  active(owner: number) {
    return [...this.entries.values()].filter(
      (e) => e.owner === owner && (!!e.transport || !!e.attempt),
    ).length;
  }
  async replace(
    owner: number,
    id: string,
    destination: { shell?: ShellOption; profile?: Profile },
    factory: (size: Size, signal: AbortSignal) => Promise<Transport> | Transport,
  ) {
    const e = this.get(owner, id);
    if (e.attempt) throw new Error('A connection attempt is already in progress.');
    const attempt = new AbortController();
    e.attempt = attempt;
    const label = destination.profile
      ? `${destination.profile.name} · ${destination.profile.username}@${destination.profile.host}:${destination.profile.port}`
      : destination.shell!.name;
    if (!e.transport && e.tab.state === 'idle') {
      e.tab.kind = destination.profile ? 'remote' : 'local';
      e.tab.profile = destination.profile ? structuredClone(destination.profile) : undefined;
      e.tab.shellId = destination.shell?.id;
      e.tab.label = label;
      if (!e.tab.customTitle) e.tab.title = destination.profile?.name ?? destination.shell!.name;
    }
    e.tab.pending = `${e.tab.kind === 'remote' && !e.transport ? 'Reconnecting' : 'Connecting'} → ${label}`;
    e.tab.error = undefined;
    this.publish(e);
    try {
      const candidate = await factory(e.size, attempt.signal);
      if (attempt.signal.aborted || this.entries.get(id) !== e) {
        candidate.close();
        throw new Error('Connection cancelled.');
      }
      const old = e.transport;
      e.tab.generation = randomUUID(); // Stale input and acknowledgements cannot reach the replacement.
      e.transport = candidate;
      e.outstanding = 0;
      e.paused = false;
      e.tab.kind = destination.profile ? 'remote' : 'local';
      e.tab.profile = destination.profile ? structuredClone(destination.profile) : undefined;
      e.tab.shellId = destination.shell?.id;
      e.tab.label = label;
      e.tab.state = destination.profile ? 'connected' : 'running';
      e.tab.pending = undefined;
      e.tab.exitCode = undefined;
      if (!e.tab.customTitle) e.tab.title = destination.profile?.name ?? destination.shell!.name;
      const generation = e.tab.generation;
      old?.close();
      this.emit(owner, { type: 'reset', id, generation, label });
      this.publish(e);
      candidate.subscribe(
        (data) => {
          if (
            this.entries.get(id) !== e ||
            e.tab.generation !== generation ||
            e.transport !== candidate
          )
            return;
          e.outstanding += data.length;
          if (e.outstanding > 256 * 1024 && !e.paused) {
            e.paused = true;
            candidate.pause();
          }
          if (e.outstanding > 4 * 1024 * 1024) {
            e.tab.error =
              'Output exceeded the safety buffer. The session was closed to keep the app responsive.';
            this.disconnect(owner, id);
            return;
          }
          this.emit(owner, { type: 'data', id, generation, data });
        },
        (code, error) => {
          if (
            this.entries.get(id) !== e ||
            e.tab.generation !== generation ||
            e.transport !== candidate
          )
            return;
          e.transport = undefined;
          e.tab.state = destination.profile ? 'disconnected' : 'exited';
          e.tab.exitCode = code;
          e.tab.error = error;
          this.publish(e);
        },
      );
      candidate.resize(e.size);
      candidate.resume();
    } catch (error) {
      if (!attempt.signal.aborted && this.entries.get(id) === e) {
        e.tab.error = error instanceof Error ? error.message : 'Could not start the terminal.';
        if (!e.transport && e.tab.state === 'idle') e.tab.state = 'error';
      }
      throw error;
    } finally {
      if (e.attempt === attempt) {
        e.attempt = undefined;
        e.tab.pending = undefined;
        if (this.entries.get(id) === e) this.publish(e);
      }
    }
  }
  input(owner: number, id: string, generation: string, data: string) {
    const e = this.get(owner, id);
    if (e.tab.generation === generation && !e.attempt) e.transport?.write(data);
  }
  resize(owner: number, id: string, generation: string, size: Size) {
    const e = this.get(owner, id);
    if (e.tab.generation !== generation) return;
    e.size = size;
    e.transport?.resize(size);
  }
  ack(owner: number, id: string, generation: string, length: number) {
    const e = this.get(owner, id);
    if (e.tab.generation !== generation) return;
    e.outstanding = Math.max(0, e.outstanding - length);
    if (e.paused && e.outstanding < 64 * 1024) {
      e.paused = false;
      e.transport?.resume();
    }
  }
  rename(owner: number, id: string, title: string) {
    const e = this.get(owner, id);
    e.tab.title = title;
    e.tab.customTitle = true;
    this.publish(e);
  }
  disconnect(owner: number, id: string) {
    const e = this.get(owner, id);
    if (e.attempt) {
      e.attempt.abort();
      e.attempt = undefined;
      e.tab.pending = undefined;
      if (!e.transport) e.tab.state = e.tab.kind === 'remote' ? 'disconnected' : 'exited';
      this.publish(e);
      return;
    }
    const t = e.transport;
    e.transport = undefined;
    t?.close();
    e.tab.state = e.tab.kind === 'remote' ? 'disconnected' : 'exited';
    this.publish(e);
  }
  close(owner: number, id: string) {
    const e = this.get(owner, id);
    this.entries.delete(id);
    e.attempt?.abort();
    e.transport?.close();
    this.emit(owner, { type: 'removed', id });
  }
  dispose(owner: number) {
    for (const [id, e] of this.entries) if (e.owner === owner) this.close(owner, id);
  }
}
