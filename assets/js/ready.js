/* ==========================================================================
   ready.js — page-readiness barrier

   `body.is-loading → .is-ready` drives the entrance fade. If app.js flips it
   as soon as the profile lands, a page whose content is rendered by another
   module (gallery.js, home.js) fades in EMPTY and then pops its content in —
   visible as a flash, and it makes automated checks racy because "ready" did
   not mean "rendered".

   So page modules declare their work up front:

     const done = hold();      // at module top level
     …render…
     done();                   // when the DOM is actually populated

   and app.js waits for every hold before revealing the page.
   ========================================================================== */

const holds = new Set();

/**
 * Register outstanding work. Returns a release function — call it when the
 * work is finished, including on failure, or the page never reveals.
 */
export function hold() {
  let release;
  const promise = new Promise((resolve) => (release = resolve));
  holds.add(promise);
  return release;
}

/**
 * Resolve once every registered hold has been released.
 *
 * The initial `setTimeout(0)` matters: it yields a full macrotask, which
 * guarantees every module's top-level code has run and therefore that every
 * hold() has been registered before we look at the set. Without it we could
 * observe an empty set and reveal too early.
 */
export async function whenReady(timeout = 8000) {
  await new Promise((r) => setTimeout(r, 0));
  if (!holds.size) return;

  /* A page that never releases its hold must still become visible — an
     invisible page is a far worse failure than an unpolished reveal. */
  await Promise.race([
    Promise.allSettled([...holds]),
    new Promise((r) => setTimeout(r, timeout)),
  ]);
}
