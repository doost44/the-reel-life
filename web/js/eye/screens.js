// Monitors and the screens open on them, in the Chrome version. Chrome lists
// the monitors (Window Management, which asks once) and opens each screen as a
// window filling its monitor. A page can't make another window fullscreen,
// so a screen goes fullscreen when it's clicked, which also lets it speak.
// Without Chrome's monitor list, there's only the monitor this page is on.

const SCREEN_PAGE = new URL('../../screen.html', import.meta.url);

export class LocalScreens {
  constructor() {
    this.monitors = [];
    this.windows = new Map(); // screen id → its window
    this.details = null;
  }

  // Monitors, as the Python eye lists them: { id, label, x, y, width, height, primary }.
  async refresh(ask = false) {
    let screens = null;
    if ('getScreenDetails' in window) {
      let allowed = false;
      try {
        allowed = (await navigator.permissions.query({ name: 'window-management' })).state === 'granted';
      } catch {
        allowed = false;
      }
      if (allowed || ask) {
        try {
          this.details ??= await window.getScreenDetails();
          this.details.onscreenschange = () => this.refresh();
          screens = this.details.screens;
        } catch {
          screens = null;
        }
      }
    }
    if (screens) {
      const seen = new Map();
      this.monitors = [...screens].sort((a, b) => a.left - b.left || a.top - b.top).map((screen, index) => {
        const base = screen.label || `Display ${index + 1}`;
        const count = (seen.get(base) ?? 0) + 1;
        seen.set(base, count);
        const id = count > 1 ? `${base} (${count})` : base;
        return { id, label: id, x: screen.left, y: screen.top, width: screen.width, height: screen.height, primary: screen.isPrimary };
      });
    } else {
      const { availLeft = 0, availTop = 0, width, height } = window.screen;
      this.monitors = [{ id: 'This screen', label: 'This screen (allow window management to see the others)', x: availLeft, y: availTop, width, height, primary: true }];
    }
    return this.monitors;
  }

  // Opens a screen in a window filling its monitor. Returns what went wrong, if anything.
  open(screen) {
    if (!screen) return "That screen isn't in the setup.";
    const monitor = this.monitors.find((candidate) => candidate.id === screen.monitor);
    if (!monitor) return `Choose a monitor for ${screen.name} first, or check that it's connected (Find devices).`;
    this.close(screen.id);
    const url = new URL(SCREEN_PAGE);
    url.searchParams.set('id', screen.id);
    const features = `popup,left=${monitor.x},top=${monitor.y},width=${monitor.width},height=${monitor.height}`;
    const opened = window.open(url, `screen-${screen.id}`, features);
    if (!opened) return 'Chrome blocked the window: allow pop-ups for this site, then try again.';
    this.windows.set(screen.id, opened);
    return null;
  }

  close(id) {
    const opened = this.windows.get(id);
    if (opened && !opened.closed) opened.close();
    this.windows.delete(id);
  }

  openScreens() {
    return [...this.windows].filter(([, opened]) => !opened.closed).map(([id]) => id);
  }
}
