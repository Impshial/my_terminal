import { describe, expect, it, vi } from 'vitest';
import { SessionManager } from '../src/main/sessions';
import type { Transport } from '../src/main/transports';
import type { SessionEvent, ShellOption } from '../src/shared/schema';
const shell: ShellOption = {
  id: 'pwsh',
  name: 'PowerShell',
  executable: 'pwsh.exe',
  args: [],
  available: true,
};
function transport() {
  let data: (text: string) => void = () => {},
    exit: (code?: number) => void = () => {};
  return {
    write: vi.fn(),
    resize: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    close: vi.fn(() => exit(0)),
    subscribe: vi.fn((d, e) => {
      data = d;
      exit = e;
    }),
    output: (text: string) => data(text),
    end: (code: number) => exit(code),
  } satisfies Transport & { output(text: string): void; end(code: number): void };
}
describe('session lifecycle (injected transports)', () => {
  it('keeps tabs independent and rejects cross-window access', async () => {
    const manager = new SessionManager(() => {});
    const a = manager.create(1),
      b = manager.create(1);
    const ta = transport(),
      tb = transport();
    await manager.replace(1, a.id, { shell }, () => ta);
    await manager.replace(1, b.id, { shell }, () => tb);
    expect(() => manager.input(2, a.id, a.generation, 'stolen')).toThrow('does not belong');
    manager.close(1, a.id);
    expect(ta.close).toHaveBeenCalledOnce();
    expect(tb.close).not.toHaveBeenCalled();
    const snap = manager.snapshot(1, b.id);
    manager.input(1, b.id, snap.generation, 'still alive');
    expect(tb.write).toHaveBeenCalledWith('still alive');
  });
  it('retains the old session and generation after a failed replacement', async () => {
    const manager = new SessionManager(() => {});
    const a = manager.create(1),
      t = transport();
    await manager.replace(1, a.id, { shell }, () => t);
    const before = manager.snapshot(1, a.id);
    await expect(
      manager.replace(1, a.id, { shell }, () => Promise.reject(new Error('Unreachable host'))),
    ).rejects.toThrow('Unreachable');
    expect(manager.snapshot(1, a.id)).toMatchObject({
      generation: before.generation,
      state: 'running',
      error: 'Unreachable host',
    });
    expect(t.close).not.toHaveBeenCalled();
    manager.input(1, a.id, before.generation, 'pwd');
    expect(t.write).toHaveBeenCalledWith('pwd');
  });
  it('never sends input during a transition or from an old generation', async () => {
    const manager = new SessionManager(() => {});
    const a = manager.create(1),
      old = transport(),
      next = transport();
    await manager.replace(1, a.id, { shell }, () => old);
    const before = manager.snapshot(1, a.id);
    let resolve!: (t: Transport) => void;
    const attempt = manager.replace(
      1,
      a.id,
      { shell },
      () =>
        new Promise<Transport>((r) => {
          resolve = r;
        }),
    );
    manager.input(1, a.id, before.generation, 'buffered');
    expect(old.write).not.toHaveBeenCalled();
    resolve(next);
    await attempt;
    expect(old.close).toHaveBeenCalledOnce();
    manager.input(1, a.id, before.generation, 'stale');
    expect(next.write).not.toHaveBeenCalled();
    manager.input(1, a.id, manager.snapshot(1, a.id).generation, 'new');
    expect(next.write).toHaveBeenCalledWith('new');
  });
  it('cancels only a pending replacement, preserving the working session', async () => {
    const manager = new SessionManager(() => {});
    const a = manager.create(1),
      old = transport(),
      candidate = transport();
    await manager.replace(1, a.id, { shell }, () => old);
    let resolve!: (t: Transport) => void;
    const attempt = manager.replace(
      1,
      a.id,
      { shell },
      () =>
        new Promise<Transport>((r) => {
          resolve = r;
        }),
    );
    manager.disconnect(1, a.id);
    resolve(candidate);
    await expect(attempt).rejects.toThrow('cancelled');
    expect(old.close).not.toHaveBeenCalled();
    expect(candidate.close).toHaveBeenCalledOnce();
    expect(manager.snapshot(1, a.id).state).toBe('running');
  });
  it('cleans up a candidate if its tab closes during authentication', async () => {
    const manager = new SessionManager(() => {}),
      a = manager.create(1),
      t = transport();
    let resolve!: (t: Transport) => void;
    const p = manager.replace(
      1,
      a.id,
      { shell },
      () =>
        new Promise<Transport>((r) => {
          resolve = r;
        }),
    );
    manager.close(1, a.id);
    resolve(t);
    await expect(p).rejects.toThrow('cancelled');
    expect(t.close).toHaveBeenCalledOnce();
  });
  it('pauses fast producers and resumes after parser acknowledgements', async () => {
    const events: SessionEvent[] = [];
    const manager = new SessionManager((_, e) => events.push(e)),
      a = manager.create(1),
      t = transport();
    await manager.replace(1, a.id, { shell }, () => t);
    const snap = manager.snapshot(1, a.id);
    t.output('x'.repeat(300000));
    expect(t.pause).toHaveBeenCalledOnce();
    manager.ack(1, a.id, a.generation, 300000);
    expect(t.resume).toHaveBeenCalledTimes(1);
    manager.ack(1, a.id, snap.generation, 300000);
    expect(t.resume).toHaveBeenCalledTimes(2);
    t.end(7);
    expect(manager.snapshot(1, a.id)).toMatchObject({ state: 'exited', exitCode: 7 });
    manager.input(1, a.id, snap.generation, 'do not execute');
    expect(t.write).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === 'data')).toBe(true);
  });
});
