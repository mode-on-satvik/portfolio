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
 * Resolves once every page module's top-level code has run, so `holds` is
 * fully populated before anyone inspects it.
 *
 * A `setTimeout(0)` was NOT sufficient here, and the difference is a real bug
 * rather than a theoretical one. Every page loads two module scripts:
 *
 *   <script type="module" src="app.js">      <!-- calls whenReady() -->
 *   <script type="module" src="about.js">    <!-- calls hold() -->
 *
 * app.js does NOT wait for about.js to be *fetched* — each module executes as
 * soon as its OWN dependency graph is ready. about.js imports a strict subset
 * of app.js's graph, so its only extra network cost is its own file. Whenever
 * that file lands after app.js has already awaited profile.json (routinely,
 * once profile.json is in the memory cache), app.js reached the barrier with
 * `holds` still empty, saw nothing to wait for, and revealed the page before
 * about.js rendered anything into it. Measured: reveal at 92ms with
 * statsRows=1 ("Loading"), about.js's hold() at 156ms. Visible as a flash of
 * the placeholder copy, and the cause of the intermittent smoke-test failures
 * on both about and gallery.
 *
 * DOMContentLoaded is the correct barrier: non-async module scripts are
 * deferred, so every one of them has executed — and therefore every top-level
 * hold() is registered — by the time it fires.
 *
 * THE LISTENER IS ATTACHED HERE, AT MODULE EVALUATION, AND NOT INSIDE
 * whenReady(). That is the whole point, and getting it wrong deadlocked the
 * page for 1 load in ~8:
 *
 *   · app.js's main() is async, so app.js's module evaluation *returns* at its
 *     first await (`await getProfile()`). DOMContentLoaded then fires while
 *     main() is still parked.
 *   · When the profile lands, whenReady() runs at readyState 'interactive' —
 *     stylesheets and images are still in flight, so NOT 'complete' — and a
 *     DOMContentLoaded listener registered at that moment waits for an event
 *     that has already fired. It never fires again.
 *   · Worse, the timeout backstop lived *after* this await, so it never even
 *     started. The page sat at `is-loading` forever with its content fully
 *     rendered behind the fade. Observed directly: bodyClass 'is-loading',
 *     statsRows 7, readyTimeout unset, 182 polled frames.
 *
 * Evaluating at module scope removes the race by construction: ready.js is
 * imported by a deferred module script, so this line runs BEFORE
 * DOMContentLoaded, and the listener is therefore guaranteed to fire no matter
 * how late whenReady() is called.
 *
 * `load` is a second listener rather than a redundant one: it covers the only
 * remaining case, where this module is first evaluated by a *dynamic* import
 * after DOMContentLoaded has already passed. Then the DCL listener above can
 * never run, but load has not happened yet. And if even load has passed,
 * readyState is 'complete' and we resolve immediately. No path can hang.
 */
const domReady =
  document.readyState === "complete"
    ? Promise.resolve()
    : new Promise((resolve) => {
        document.addEventListener("DOMContentLoaded", resolve, { once: true });
        window.addEventListener("load", resolve, { once: true });
      });

/**
 * Resolve once every registered hold has been released.
 *
 * @returns {Promise<boolean>} true if all holds released, false on timeout.
 */
export async function whenReady(timeout = 8000) {
  /* A page that never releases its hold must still become visible — an
     invisible page is a far worse failure than an unpolished reveal.

     But the two outcomes are NOT the same, and collapsing them hides bugs:
     a page revealed by this timeout may be completely empty, while still
     looking "ready" to anything watching for the class. So report which
     happened, and let the caller mark the difference in the DOM.

     One timer covers BOTH waits, so the budget is 8s from the call rather
     than 8s per stage — and, critically, the barrier below cannot outlive it.
     The earlier version created the timer only after awaiting the DOM, which
     left that first await completely unguarded. */
  const TIMED_OUT = Symbol("timeout");
  const timer = new Promise((r) => setTimeout(() => r(TIMED_OUT), timeout));

  if ((await Promise.race([domReady, timer])) === TIMED_OUT) return false;
  if (!holds.size) return true;

  const result = await Promise.race([Promise.allSettled([...holds]), timer]);
  return result !== TIMED_OUT;
}
