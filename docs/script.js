/* ADO Visualizer — landing page interactivity.
   Tiny by design: theme toggle (with localStorage persistence) plus a small
   smooth-scroll guard for in-page anchors. No frameworks, no analytics. */

(() => {
  const STORAGE_KEY = "adoviz.theme";
  const root = document.documentElement;

  /** Apply a theme by setting / removing the data-theme attribute. */
  const applyTheme = (theme) => {
    if (theme === "light" || theme === "dark") {
      root.setAttribute("data-theme", theme);
    } else {
      root.removeAttribute("data-theme");
    }
  };

  /** Resolve the theme that's actually rendered right now. */
  const resolveTheme = () => {
    const explicit = root.getAttribute("data-theme");
    if (explicit === "light" || explicit === "dark") return explicit;
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  };

  // Initial application from localStorage. We do this in the script tag (not
  // in <head>) on purpose — it avoids the tiny FOUC of the wrong theme since
  // the CSS already responds to prefers-color-scheme out of the box. Stored
  // preference simply overrides the system one.
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark") applyTheme(stored);
  } catch {
    /* localStorage may be unavailable (private mode, file://, etc.) */
  }

  const toggle = document.getElementById("theme-toggle");
  if (toggle) {
    toggle.addEventListener("click", () => {
      const next = resolveTheme() === "dark" ? "light" : "dark";
      applyTheme(next);
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        /* ignore */
      }
    });
  }

  // If the user hasn't picked a theme, follow the OS as it changes.
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const onSystemChange = () => {
    let stored = null;
    try {
      stored = localStorage.getItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
    if (stored !== "light" && stored !== "dark") applyTheme(null);
  };
  if (mq.addEventListener) mq.addEventListener("change", onSystemChange);
  else if (mq.addListener) mq.addListener(onSystemChange);
})();
