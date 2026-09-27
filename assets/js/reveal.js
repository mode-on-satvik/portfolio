/* ==========================================================================
   reveal.js — scroll-triggered entrance animations
   ========================================================================== */

/**
 * Observe .reveal elements and add .in once when they enter the viewport.
 *
 * Deliberately one-shot: the class is never removed and the element is
 * unobserved immediately, so scrolling back up does not re-animate content
 * the visitor has already seen (which reads as a glitch, not a flourish).
 */
export function initReveal(root = document) {
  const items = root.querySelectorAll(".reveal:not(.in)");
  if (!items.length) return;

  // Respect the OS setting: show everything at once, animate nothing.
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    for (const el of items) el.classList.add("in");
    return;
  }

  if (!("IntersectionObserver" in window)) {
    for (const el of items) el.classList.add("in");
    return;
  }

  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("in");
        io.unobserve(entry.target);
      }
    },
    {
      // Fire slightly before the element is fully on screen so the motion
      // completes as it arrives, rather than starting once it is already there.
      rootMargin: "0px 0px -12% 0px",
      threshold: 0.08,
    }
  );

  for (const el of items) io.observe(el);
}

/** Stagger a group of children by index, e.g. gallery tiles. */
export function stagger(elements, step = 60, max = 8) {
  [...elements].forEach((el, i) => {
    // Cap the delay: with 40 tiles, an uncapped stagger would leave the last
    // one waiting 2.4s after it is already visible.
    el.style.setProperty("--reveal-delay", `${Math.min(i, max) * step}ms`);
  });
}
