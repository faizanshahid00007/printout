// Runs before the page paints so a reader who chose a side never sees the other
// one flash first. Without a stored choice the system preference decides.
(function () {
  const KEY = 'printshop-theme';
  const root = document.documentElement;

  let stored = null;
  try {
    stored = localStorage.getItem(KEY);
  } catch {
    stored = null; // private browsing; the system preference still works
  }

  if (stored === 'dark' || stored === 'light') {
    root.dataset.theme = stored;
  }

  const prefersDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;
  const isDark = () => (root.dataset.theme ? root.dataset.theme === 'dark' : prefersDark());

  function wire() {
    // The shop page carries two mastheads — signed in and signed out — so every
    // toggle on the page gets wired and relabelled together.
    const buttons = Array.from(document.querySelectorAll('.theme-toggle'));
    if (buttons.length === 0) return;

    const label = () => {
      for (const button of buttons) {
        button.textContent = isDark() ? 'Light' : 'Dark';
        button.setAttribute(
          'aria-label',
          isDark() ? 'Switch to light theme' : 'Switch to dark theme'
        );
      }
    };

    for (const button of buttons) {
      button.addEventListener('click', () => {
        const next = isDark() ? 'light' : 'dark';
        root.dataset.theme = next;
        try {
          localStorage.setItem(KEY, next);
        } catch {
          // choice lasts for this page only
        }
        label();
      });
    }

    // Follow the system while the reader has not picked a side.
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (!root.dataset.theme) label();
    });

    label();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
})();
