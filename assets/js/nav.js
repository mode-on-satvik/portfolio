/* ==========================================================================
   nav.js — scroll state, mobile overlay menu with focus trap
   ========================================================================== */

export function initNav() {
  const nav = document.querySelector(".nav");
  const burger = document.querySelector(".nav__burger");
  const menu = document.querySelector(".menu");

  /* --- Frosted nav once scrolled off the hero ---------------------------
     An IntersectionObserver on a 1px sentinel rather than a scroll
     listener: no work on the main thread per frame. */
  if (nav) {
    const sentinel = document.createElement("div");
    sentinel.setAttribute("aria-hidden", "true");
    sentinel.style.cssText =
      "position:absolute;top:0;left:0;width:1px;height:1px;pointer-events:none";
    document.body.prepend(sentinel);

    new IntersectionObserver(
      ([entry]) => nav.classList.toggle("is-stuck", !entry.isIntersecting),
      { rootMargin: "-80px 0px 0px 0px" }
    ).observe(sentinel);
  }

  if (!burger || !menu) return;

  const links = [...menu.querySelectorAll("a, button")];
  let lastFocused = null;

  const setOpen = (open) => {
    menu.classList.toggle("is-open", open);
    document.body.classList.toggle("menu-open", open);
    burger.setAttribute("aria-expanded", String(open));
    menu.setAttribute("aria-hidden", String(!open));

    if (open) {
      lastFocused = document.activeElement;
      links[0]?.focus();
    } else {
      // Return focus where it came from, not to the top of the document.
      lastFocused?.focus();
    }
  };

  burger.addEventListener("click", () =>
    setOpen(!menu.classList.contains("is-open"))
  );

  // Close on navigation so the overlay is never left open behind a new page.
  for (const link of menu.querySelectorAll("a")) {
    link.addEventListener("click", () => setOpen(false));
  }

  document.addEventListener("keydown", (e) => {
    if (!menu.classList.contains("is-open")) return;

    if (e.key === "Escape") {
      setOpen(false);
      return;
    }

    // Trap Tab inside the overlay while it is open — otherwise focus walks
    // into the page behind it, which is invisible to a keyboard user.
    if (e.key === "Tab" && links.length) {
      const first = links[0];
      const last = links[links.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });

  // Reset state if the viewport grows past the desktop breakpoint while open.
  window.matchMedia("(min-width: 1024px)").addEventListener("change", (e) => {
    if (e.matches && menu.classList.contains("is-open")) setOpen(false);
  });
}
