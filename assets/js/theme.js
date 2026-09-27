/* ==========================================================================
   theme.js — theme toggle wiring
   The INITIAL theme is applied by a tiny inline script in <head> (see
   inline-theme snippet in each page) so it lands before first paint and a
   dark-theme visitor never sees a white flash. This module only handles
   the toggle afterwards.
   ========================================================================== */

const STORAGE_KEY = "pf-theme";

export function initTheme() {
  const root = document.documentElement;

  for (const btn of document.querySelectorAll("[data-theme-toggle]")) {
    btn.addEventListener("click", () => {
      const next = root.dataset.theme === "light" ? "dark" : "light";
      root.dataset.theme = next;
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        /* Private browsing / storage disabled — the toggle still works for
           this page view, it just will not persist. Not worth surfacing. */
      }
      btn.setAttribute(
        "aria-label",
        next === "light" ? "Switch to dark theme" : "Switch to light theme"
      );
    });
  }

  // Follow the OS if the visitor has not made an explicit choice here.
  window
    .matchMedia("(prefers-color-scheme: light)")
    .addEventListener("change", (e) => {
      let stored = null;
      try {
        stored = localStorage.getItem(STORAGE_KEY);
      } catch {
        /* ignore */
      }
      if (!stored) root.dataset.theme = e.matches ? "light" : "dark";
    });
}
