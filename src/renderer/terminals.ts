import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import type { Preferences, SessionEvent, Tab } from '../shared/schema';
import '@xterm/xterm/css/xterm.css';

type View = {
  tab: Tab;
  terminal: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  container?: HTMLElement;
  cleanup?: () => void;
};
const terminalFont = (p: Preferences) =>
  p.terminalFont === 'auto'
    ? p.terminalTheme === 'retro'
      ? 'Courier New, Courier, monospace'
      : 'Consolas, monospace'
    : `${p.terminalFont}, monospace`;
const themeFor = (p: Preferences) =>
  p.terminalTheme === 'powershell'
    ? {
        background: '#012456',
        foreground: '#eeeeee',
        cursor: '#ffffff',
        selectionBackground: '#496b94',
        black: '#000000',
        red: '#800000',
        green: '#008000',
        yellow: '#808000',
        blue: '#000080',
        magenta: '#800080',
        cyan: '#008080',
        white: '#c0c0c0',
        brightBlack: '#808080',
        brightRed: '#ff0000',
        brightGreen: '#00ff00',
        brightYellow: '#ffff00',
        brightBlue: '#0000ff',
        brightMagenta: '#ff00ff',
        brightCyan: '#00ffff',
        brightWhite: '#ffffff',
      }
    : p.terminalTheme === 'command'
      ? {
          background: '#000000',
          foreground: '#f2f2f2',
          cursor: '#ffffff',
          selectionBackground: '#515151',
          black: '#0c0c0c',
          red: '#c50f1f',
          green: '#13a10e',
          yellow: '#c19c00',
          blue: '#0037da',
          magenta: '#881798',
          cyan: '#3a96dd',
          white: '#cccccc',
          brightBlack: '#767676',
          brightRed: '#e74856',
          brightGreen: '#16c60c',
          brightYellow: '#f9f1a5',
          brightBlue: '#3b78ff',
          brightMagenta: '#b4009e',
          brightCyan: '#61d6d6',
          brightWhite: '#f2f2f2',
        }
      : {
          background: '#000000',
          foreground: '#38f568',
          cursor: '#50ff78',
          selectionBackground: '#185b2a',
          black: '#001904',
          red: '#29b94b',
          green: '#38f568',
          yellow: '#65ed80',
          blue: '#24a943',
          magenta: '#42d56a',
          cyan: '#7bff9b',
          white: '#38f568',
          brightBlack: '#1a9b3a',
          brightRed: '#68ff8d',
          brightGreen: '#6aff91',
          brightYellow: '#97ffad',
          brightBlue: '#54dd78',
          brightMagenta: '#84ffa1',
          brightCyan: '#a2ffba',
          brightWhite: '#b2ffc6',
        };
export class Terminals {
  private views = new Map<string, View>();
  constructor(
    private preferences: Preferences,
    private report: (message: string) => void,
  ) {}
  private make(tab: Tab): View {
    const terminal = new Terminal({
      fontFamily: 'Cascadia Code, Cascadia Mono, Consolas, monospace',
      fontSize: this.preferences.fontSize,
      scrollback: this.preferences.scrollback,
      cursorBlink: true,
      cursorStyle: 'bar',
      allowProposedApi: true,
      allowTransparency: false,
      convertEol: false,
      disableStdin: true,
      theme: {
        background: '#101418',
        foreground: '#d6e0e7',
        cursor: '#91e2bb',
        selectionBackground: '#34534b',
        black: '#1d252c',
        red: '#f08383',
        green: '#9bd8ac',
        yellow: '#e9ca83',
        blue: '#87bff5',
        magenta: '#c6a1ed',
        cyan: '#8dded7',
        white: '#d6e0e7',
        brightBlack: '#788b98',
        brightRed: '#ffa5a5',
        brightGreen: '#b6efbc',
        brightYellow: '#ffe4a0',
        brightBlue: '#a9d5ff',
        brightMagenta: '#e0baff',
        brightCyan: '#affff2',
        brightWhite: '#ffffff',
      },
    });
    const fit = new FitAddon(),
      search = new SearchAddon();
    terminal.options.theme = themeFor(this.preferences);
    terminal.options.fontFamily = terminalFont(this.preferences);
    terminal.options.cursorStyle = this.preferences.terminalTheme === 'retro' ? 'block' : 'bar';
    terminal.loadAddon(fit);
    terminal.loadAddon(search);
    terminal.loadAddon(new Unicode11Addon());
    terminal.unicode.activeVersion = '11';
    const view: View = { tab, terminal, fit, search };
    // Consume OSC 52, including requests: a remote process cannot read/write the system clipboard.
    terminal.parser.registerOscHandler(52, () => true);
    terminal.onData((data) => {
      if (view.tab.pending || !['running', 'connected'].includes(view.tab.state)) return;
      for (let offset = 0; offset < data.length; offset += 32768)
        window.myterminal.input(tab.id, view.tab.generation, data.slice(offset, offset + 32768));
    });
    terminal.onResize((size) => window.myterminal.resize(tab.id, view.tab.generation, size));
    terminal.attachCustomKeyEventHandler(
      (event) =>
        !(
          event.ctrlKey &&
          event.shiftKey &&
          ['C', 'V', 'T', 'W', 'F', 'O'].includes(event.key.toUpperCase())
        ),
    );
    return view;
  }
  event(event: SessionEvent) {
    if (event.type === 'removed') {
      const v = this.views.get(event.id);
      v?.cleanup?.();
      v?.terminal.dispose();
      this.views.delete(event.id);
      return;
    }
    if (event.type === 'tab') {
      let v = this.views.get(event.tab.id);
      if (!v) {
        v = this.make(event.tab);
        this.views.set(event.tab.id, v);
      }
      v.tab = event.tab;
      v.terminal.options.disableStdin =
        !!event.tab.pending || !['running', 'connected'].includes(event.tab.state);
      return;
    }
    const view = this.views.get(event.id);
    if (!view) return;
    if (event.type === 'reset') {
      const container = view.container;
      view.cleanup?.();
      view.terminal.dispose();
      const next = this.make({ ...view.tab, generation: event.generation });
      this.views.set(event.id, next);
      if (container) {
        container.replaceChildren();
        this.mount(event.id, container);
      }
    } else if (view.tab.generation === event.generation) {
      view.terminal.write(event.data, () =>
        window.myterminal.ack(event.id, event.generation, event.data.length),
      );
    }
  }
  mount(id: string, container: HTMLElement) {
    const view = this.views.get(id);
    if (!view) return;
    if (view.container === container) return;
    view.container = container;
    view.terminal.open(container);
    const resize = new ResizeObserver(() => {
      if (container.clientWidth && container.clientHeight) this.fit(id);
    });
    resize.observe(container);
    const paste = (event: ClipboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      const generation = view.tab.generation;
      const text = event.clipboardData?.getData('text/plain') ?? '';
      void window.myterminal
        .confirmPaste(text)
        .then((accept) => {
          if (accept && this.views.get(id)?.tab.generation === generation) this.pasteText(id, text);
        })
        .catch((e) => this.report(e.message));
    };
    container.addEventListener('paste', paste, true);
    view.cleanup = () => {
      resize.disconnect();
      container.removeEventListener('paste', paste, true);
    };
    this.fit(id);
  }
  fit(id: string) {
    const v = this.views.get(id);
    if (v?.container?.clientWidth && v.container.clientHeight) {
      v.fit.fit();
      window.myterminal.resize(id, v.tab.generation, {
        cols: v.terminal.cols,
        rows: v.terminal.rows,
      });
    }
  }
  focus(id: string) {
    this.fit(id);
    this.views.get(id)?.terminal.focus();
  }
  copy(id: string) {
    return window.myterminal.copy(this.views.get(id)?.terminal.getSelection() ?? '');
  }
  async paste(id: string) {
    const generation = this.views.get(id)?.tab.generation;
    const text = await window.myterminal.paste();
    if (text !== undefined && this.views.get(id)?.tab.generation === generation)
      this.pasteText(id, text);
  }
  private pasteText(id: string, text: string) {
    const v = this.views.get(id);
    if (v && !v.tab.pending && ['running', 'connected'].includes(v.tab.state)) {
      v.terminal.paste(text);
      v.terminal.focus();
    }
  }
  selectAll(id: string) {
    this.views.get(id)?.terminal.selectAll();
  }
  clear(id: string) {
    this.views.get(id)?.terminal.clear();
  }
  search(id: string, query: string, previous = false) {
    const v = this.views.get(id);
    if (!v) return false;
    if (!query) {
      v.search.clearDecorations();
      return false;
    }
    return previous ? v.search.findPrevious(query) : v.search.findNext(query);
  }
  update(preferences: Preferences) {
    this.preferences = preferences;
    document.documentElement.dataset.appTheme = preferences.appTheme;
    document.documentElement.dataset.terminalTheme = preferences.terminalTheme;
    for (const [id, v] of this.views) {
      v.terminal.options.theme = themeFor(preferences);
      v.terminal.options.fontFamily = terminalFont(preferences);
      v.terminal.options.cursorStyle = preferences.terminalTheme === 'retro' ? 'block' : 'bar';
      v.terminal.options.fontSize = preferences.fontSize;
      v.terminal.options.scrollback = preferences.scrollback;
      this.fit(id);
    }
  }
  dispose() {
    for (const v of this.views.values()) {
      v.cleanup?.();
      v.terminal.dispose();
    }
    this.views.clear();
  }
}
