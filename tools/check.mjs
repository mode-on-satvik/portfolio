/* ==========================================================================
   check.mjs — headless smoke test over the Chrome DevTools Protocol

   Loads pages in a real browser and asserts that:
     · no console errors or page exceptions occurred
     · no request failed (404s on CSS/JS/JSON/fonts)
     · expected DOM landed after the JS ran
     · no horizontal overflow at narrow widths

   Prereqs: a static server on :8080 and Chrome started with
   --remote-debugging-port=9222.

     node tools/check.mjs [baseUrl]
   ========================================================================== */

const BASE = process.argv[2] || "http://localhost:8080";
const CDP = "http://localhost:9222";

let nextId = 1;

/** Minimal CDP client over a raw WebSocket — no dependencies. */
async function connect() {
  const targets = await (await fetch(`${CDP}/json/list`)).json();
  let page = targets.find((t) => t.type === "page");
  if (!page) {
    await fetch(`${CDP}/json/new?about:blank`, { method: "PUT" });
    page = (await (await fetch(`${CDP}/json/list`)).json()).find(
      (t) => t.type === "page"
    );
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  const events = [];

  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });

  ws.onmessage = (msg) => {
    const data = JSON.parse(msg.data);
    if (data.id && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id);
      pending.delete(data.id);
      data.error ? reject(new Error(data.error.message)) : resolve(data.result);
    } else if (data.method) {
      events.push(data);
    }
  };

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  return { send, events, close: () => ws.close() };
}

const evaluate = async (send, expression) => {
  const { result } = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  return result.value;
};

/** Images that finished loading but have no pixels. */
const BROKEN_IMAGES = `[...document.images]
  .filter(i => i.complete && i.naturalWidth === 0)
  .map(i => i.currentSrc || i.src)`;

async function checkPage(client, path, assertions) {
  const { send, events } = client;
  events.length = 0;

  await send("Page.navigate", { url: `${BASE}${path}` });

  /* Wait for readiness on the RIGHT document. Checking `.is-ready` alone is
     a trap: for a moment after Page.navigate the previous document is still
     live, and it already has .is-ready set — so the poll succeeds instantly
     and every assertion then runs against the OLD page.

     Match origin AND path, not path alone: the two mount points we test
     (localhost:8080/ and localhost:8090/portfolio/) can produce the same
     pathname, so a path-only check can pin us to the wrong server's page. */
  const expected = new URL(`${BASE}${path}`);
  const expectedHref = expected.origin + expected.pathname;
  const deadline = Date.now() + 12000;
  let ready = false;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    ready = await evaluate(
      send,
      `location.origin + location.pathname === ${JSON.stringify(expectedHref)} &&
       document.body?.classList.contains('is-ready') === true`
    ).catch(() => false);
    if (ready) break;
  }

  const problems = [];
  if (!ready) problems.push("page never reached .is-ready state");

  /* `.is-ready` can also be set by the readiness TIMEOUT, which reveals a
     possibly-empty page. app.js marks that case so it cannot masquerade as a
     clean load here. */
  const timedOut = await evaluate(
    send,
    `document.body?.dataset.readyTimeout === "true"`
  ).catch(() => false);
  if (timedOut) {
    problems.push("page revealed via readiness TIMEOUT — rendering did not complete");
  }

  for (const ev of events) {
    if (ev.method === "Runtime.exceptionThrown") {
      const d = ev.params.exceptionDetails;
      problems.push(
        `EXCEPTION: ${d.exception?.description || d.text} @ ${d.url || "?"}`
      );
    }
    if (ev.method === "Runtime.consoleAPICalled" && ev.params.type === "error") {
      problems.push(
        `CONSOLE ERROR: ${ev.params.args
          .map((a) => a.value ?? a.description ?? "")
          .join(" ")}`
      );
    }
    if (ev.method === "Log.entryAdded" && ev.params.entry.level === "error") {
      problems.push(
        `LOG ERROR: ${ev.params.entry.text} ${ev.params.entry.url || ""}`
      );
    }
    if (ev.method === "Network.loadingFailed") {
      problems.push(`REQUEST FAILED: ${ev.params.errorText}`);
    }
    /* A 404 is a SUCCESSFUL response as far as the network layer is
       concerned — loadingFailed never fires for it. Without this check the
       harness happily passed a page with six broken images. */
    if (ev.method === "Network.responseReceived") {
      const { status, url } = ev.params.response;
      if (status >= 400) problems.push(`HTTP ${status}: ${url}`);
    }
  }

  for (const [label, expr, expected] of assertions) {
    const actual = await evaluate(send, expr);
    const ok =
      typeof expected === "function" ? expected(actual) : actual === expected;
    if (!ok) {
      problems.push(
        `ASSERT ${label}: got ${JSON.stringify(actual)}, expected ${
          typeof expected === "function" ? "(predicate)" : JSON.stringify(expected)
        }`
      );
    }
  }

  return problems;
}

/** Horizontal overflow is the most common responsive bug; check it directly. */
async function checkOverflow(client, path, widths) {
  const { send } = client;
  const bad = [];

  for (const w of widths) {
    await send("Emulation.setDeviceMetricsOverride", {
      width: w,
      height: 900,
      deviceScaleFactor: 1,
      mobile: w < 768,
    });
    await send("Page.navigate", { url: `${BASE}${path}` });
    await new Promise((r) => setTimeout(r, 1800));

    const overflow = await evaluate(
      send,
      `(() => {
        const de = document.documentElement;
        const over = de.scrollWidth - de.clientWidth;
        if (over <= 1) return null;
        // Name the widest offending element so the failure is actionable
        let worst = null, max = 0;
        for (const el of document.querySelectorAll('body *')) {
          const r = el.getBoundingClientRect();
          if (r.right > de.clientWidth + 1 && r.right > max) {
            max = r.right;
            worst = el.tagName.toLowerCase() +
              (el.className && typeof el.className === 'string'
                ? '.' + el.className.trim().split(/\\s+/).join('.') : '');
          }
        }
        return { over, worst, right: Math.round(max) };
      })()`
    );

    if (overflow) {
      bad.push(
        `${w}px: overflows by ${overflow.over}px — widest: ${overflow.worst} (right edge ${overflow.right})`
      );
    }
  }

  await send("Emulation.clearDeviceMetricsOverride");
  return bad;
}

/**
 * `.is-ready` must mean "rendered", not merely "script ran".
 *
 * Every assertion in this file that waits for `.is-ready` is only as good as
 * that promise, so it is checked directly rather than assumed. The bug it
 * catches is a race: app.js calls whenReady() while the page module's own
 * module script may not have executed yet, so `holds` is empty, the barrier
 * finds nothing to wait for, and the page reveals its "Loading…" placeholders
 * before the real content replaces them.
 *
 * It reproduces on a WARM cache and not a cold one — the faster the JSON
 * arrives, the more likely app.js finishes first — so both are exercised. A
 * rAF-polled snapshot of the first frame bearing `.is-ready` is the only
 * honest measurement; sampling later just sees the finished page.
 */
async function checkRevealOrdering(client) {
  const { send } = client;
  const problems = [];

  // Which selector must be non-empty by the time each page reveals.
  const pages = [
    ["/about/", { ".stats__row": 2, ".exp__row": 1 }],
    ["/", { ".cat": 1 }],
    ["/work/formal-suit/", { ".tile": 1 }],
  ];

  const probe = `
    window.__snap = null;
    (function poll() {
      const b = document.body;
      if (b && b.classList.contains('is-ready')) {
        if (!window.__snap) {
          window.__snap = { counts: {}, timeout: b.dataset.readyTimeout || 'no' };
          for (const sel of window.__sels) {
            window.__snap.counts[sel] = document.querySelectorAll(sel).length;
          }
        }
        return;
      }
      requestAnimationFrame(poll);
    })();`;

  for (const cold of [true, false]) {
    await send("Network.setCacheDisabled", { cacheDisabled: cold });

    for (const [path, expected] of pages) {
      const sels = Object.keys(expected);
      const { identifier } = await send("Page.addScriptToEvaluateOnNewDocument", {
        source: `window.__sels = ${JSON.stringify(sels)};\n${probe}`,
      });

      /* Two loads per page per cache state: the FIRST warm load is the one that
         used to fail, because that is when the JSON is cached but the module
         file still has to be revalidated. */
      for (let rep = 0; rep < 2; rep++) {
        await send("Page.navigate", { url: `${BASE}${path}` });
        await new Promise((r) => setTimeout(r, 3000));

        const snap = JSON.parse((await evaluate(send, `JSON.stringify(window.__snap)`)) || "null");
        const when = cold ? "cold" : "warm";

        if (!snap) {
          problems.push(`${path} (${when}, load ${rep + 1}): never reached .is-ready`);
          continue;
        }
        if (snap.timeout === "true") {
          problems.push(`${path} (${when}, load ${rep + 1}): revealed via readiness TIMEOUT`);
        }
        for (const sel of sels) {
          if (snap.counts[sel] < expected[sel]) {
            problems.push(
              `${path} (${when}, load ${rep + 1}): revealed with ${snap.counts[sel]} ${sel} ` +
                `— expected at least ${expected[sel]}. Page faded in before its content rendered.`
            );
          }
        }
      }

      await send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
    }
  }

  // Leave the cache disabled, which is how the rest of the run expects it.
  await send("Network.setCacheDisabled", { cacheDisabled: true });
  return problems;
}

/**
 * 404.html is served by Pages at whatever URL was requested, at any depth, so
 * its inline script rewrites relative asset paths to match. That branch cannot
 * be exercised in situ: a local static server answers unknown paths with its
 * own 404 body, and on a real deploy we cannot control the depth we land at.
 *
 * So the SHIPPED script is extracted from 404.html and run against stubbed
 * `location` / `document` objects — the real source, not a re-implementation
 * of it, which would only ever prove that the copy agrees with itself.
 */
async function check404Depth(client) {
  const { send } = client;
  const problems = [];

  const html = await (await fetch(`${BASE}/404.html`)).text();

  /* The repair script is the one that touches data-root-link. Identifying it
     by content rather than by position means reordering the inline scripts
     cannot silently make this test pass against the wrong one. */
  const src = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1])
    .find((s) => s.includes("data-root-link"));

  if (!src) {
    return ["could not find the depth-repair script in 404.html — did it move?"];
  }

  /* Expected depth = how many "../" make a relative asset path resolve back to
     the site root. Derived from the rule that a relative URL resolves against
     the base DIRECTORY (everything up to the last "/"), then confirmed against
     the browser's own URL resolver rather than reasoned about:

       new URL("../".repeat(d) + "assets/x", pageURL) === siteRoot + "assets/x"

     Note /portfolio/nope is depth 0, not 1: it names a missing FILE at the site
     root, so the base directory already IS the root. */
  const cases = [
    { host: "mode-on-satvik.github.io", path: "/portfolio/nope", depth: 0 },
    { host: "mode-on-satvik.github.io", path: "/portfolio/work/typo/", depth: 2 },
    { host: "mode-on-satvik.github.io", path: "/portfolio/a/b/c/", depth: 3 },
    { host: "mode-on-satvik.github.io", path: "/portfolio/work/typo/x.html", depth: 2 },
    // Bare custom domain: no repo segment to discount.
    { host: "satvik.example", path: "/work/typo/", depth: 2 },
    { host: "satvik.example", path: "/nope", depth: 0 },
  ];

  for (const c of cases) {
    const got = await evaluate(
      send,
      `(() => {
        const nodes = [
          { tag: 'link',   attrs: { href: 'assets/css/base.css' }, href: '' },
          { tag: 'script', attrs: { src:  'assets/js/app.js' } },
        ].map(n => ({
          ...n,
          getAttribute(k) { return this.attrs[k]; },
          setAttribute(k, v) { this.attrs[k] = v; },
        }));
        const links = [{ attrs: { href: 'about/' },
          getAttribute(k) { return this.attrs[k]; },
          setAttribute(k, v) { this.attrs[k] = v; } }];

        const doc = {
          documentElement: { dataset: {} },
          querySelectorAll(sel) {
            return sel.indexOf('data-root-link') !== -1 ? links : nodes;
          },
        };
        const loc = {
          hostname: ${JSON.stringify(c.host)},
          pathname: ${JSON.stringify(c.path)},
        };

        // Shadow the real globals by name so the shipped source sees the stubs.
        new Function('location', 'document', ${JSON.stringify(src)})(loc, doc);

        return JSON.stringify({
          depth: doc.documentElement.dataset.depth,
          css: nodes[0].attrs.href,
          js: nodes[1].attrs.src,
          link: links[0].attrs.href,
        });
      })()`
    );

    const r = JSON.parse(got);
    const want = "../".repeat(c.depth);
    const label = `${c.host}${c.path}`;

    if (r.css !== want + "assets/css/base.css")
      problems.push(`${label}: css href "${r.css}", expected "${want}assets/css/base.css"`);
    if (r.js !== want + "assets/js/app.js")
      problems.push(`${label}: script src "${r.js}", expected "${want}assets/js/app.js"`);
    if (r.link !== want + "about/")
      problems.push(`${label}: link href "${r.link}", expected "${want}about/"`);
    /* At depth 0 the script returns before setting data-depth, which is
       correct — the document already declares depth 0. */
    const wantDepth = c.depth === 0 ? undefined : String(c.depth);
    if (r.depth !== wantDepth)
      problems.push(`${label}: data-depth ${JSON.stringify(r.depth)}, expected ${JSON.stringify(wantDepth)}`);
  }

  return problems;
}

/**
 * The contact form has no server behind it — it composes a mailto:. So the
 * only things worth asserting are the ones that actually run client-side:
 * that an empty submit is refused rather than opening a blank email, and
 * that a filled submit produces a correctly encoded mailto: URL.
 *
 * The real submit is intercepted rather than performed: letting it through
 * would hand the page to the OS mail client and hang the harness.
 */
async function checkContactForm(client) {
  const { send } = client;
  const problems = [];

  await send("Page.navigate", { url: `${BASE}/contact/` });
  await new Promise((r) => setTimeout(r, 2000));

  /* 1. An empty submit must be refused in the page, and must not navigate.
        `beforeunload`/`unload` would not fire for a mailto: anyway, so
        navigation is detected by asserting the document is still here and
        no status of success was shown. */
  await evaluate(send, `document.querySelector('[data-form] [type=submit]').click()`);
  await new Promise((r) => setTimeout(r, 300));

  const empty = JSON.parse(
    await evaluate(
      send,
      `JSON.stringify({
        stillHere: !!document.querySelector('[data-form]'),
        flagged: document.querySelector('[data-form]').classList.contains('was-submitted'),
        invalid: !document.querySelector('[data-form]').checkValidity(),
        status: document.querySelector('[data-form-status]')?.textContent.trim() || ''
      })`
    )
  );
  if (!empty.stillHere) problems.push("empty submit navigated away from the page");
  if (!empty.flagged) problems.push("empty submit did not add .was-submitted (errors stay invisible)");
  if (!empty.invalid) problems.push("empty form reported itself valid with required fields blank");
  if (!/complete|required/i.test(empty.status))
    problems.push(`empty submit gave no validation message (status: ${JSON.stringify(empty.status)})`);

  /* 2. mailto: encoding, asserted against the SHIPPED composer.
        The submit path itself cannot be driven here: it ends in
        window.location.assign(), which is a non-writable property that cannot
        be stubbed, and letting it run hands the page to the OS mail client and
        hangs the harness. So contact.js exports mailtoURL and we test that —
        the same function the submit handler calls, not a copy of it. */
  const sent = await evaluate(
    send,
    `import('../assets/js/contact.js').then(m => m.mailtoURL({
      name: 'Casting Director',
      org: 'Studio & Co',
      email: 'cast@example.com',
      message: 'Line one & two\\nLine three'
    }, 'bookings@example.com')).catch(e => 'ERR ' + e.message)`
  );

  if (typeof sent !== "string" || sent.startsWith("ERR ")) {
    problems.push(`mailtoURL unavailable: ${sent}`);
  } else {
    if (!/^mailto:[^?]+@[^?]+\?/.test(sent)) problems.push(`mailto: malformed: ${sent}`);
    if (!/[?&]subject=/.test(sent)) problems.push("mailto: has no subject");
    if (!/[?&]body=/.test(sent)) problems.push("mailto: has no body");
    /* A raw newline or bare & in the query truncates the message in most mail
       clients, silently losing everything after it. */
    if (/\n/.test(sent)) problems.push("mailto: contains a raw newline (message will truncate)");
    if (/&(?!(amp;|subject=|body=))/.test(sent.replace(/^mailto:[^?]*\?/, "?")))
      problems.push(`mailto: contains an unencoded ampersand: ${sent}`);

    const body = decodeURIComponent((sent.match(/[?&]body=([^&]*)/) || [])[1] || "");
    const subject = decodeURIComponent((sent.match(/[?&]subject=([^&]*)/) || [])[1] || "");
    if (!body.includes("Line one & two"))
      problems.push(`mailto: body lost the ampersand text: ${JSON.stringify(body)}`);
    if (!body.includes("Line three"))
      problems.push(`mailto: body truncated at the newline: ${JSON.stringify(body)}`);
    if (!body.includes("cast@example.com"))
      problems.push("mailto: body omits the sender's address (unreplyable if From is wrong)");
    if (!subject.includes("Studio & Co"))
      problems.push(`mailto: subject lost the org: ${JSON.stringify(subject)}`);
  }

  return problems;
}

/**
 * Every internal link on every page, actually fetched. The About/Contact
 * breakage this branch fixes was exactly this: nine links pointing at pages
 * that were never written, and nothing checking them.
 */
async function checkLinks(client, paths) {
  const { send } = client;
  const problems = [];
  const checked = new Map(); // url -> status, so shared nav links fetch once

  for (const path of paths) {
    await send("Page.navigate", { url: `${BASE}${path}` });
    await new Promise((r) => setTimeout(r, 1800));

    const hrefs = await evaluate(
      send,
      `[...new Set([...document.querySelectorAll('a[href]')]
        .map(a => a.href)
        .filter(h => h.startsWith(location.origin))
        // Fragments and the mail link are not pages to fetch.
        .map(h => h.split('#')[0])
        .filter(Boolean))]`
    );

    for (const href of hrefs) {
      if (!checked.has(href)) {
        const status = await fetch(href, { method: "GET" })
          .then((r) => r.status)
          .catch(() => 0);
        checked.set(href, status);
      }
      const status = checked.get(href);
      if (status !== 200) {
        problems.push(`${path} → ${href.replace(BASE, "")} : HTTP ${status || "unreachable"}`);
      }
    }
  }

  return problems;
}

/**
 * Drive the lightbox the way a user does — real CDP key events, not
 * synthetic JS dispatch, so `preventDefault` and focus behaviour are
 * exercised for real.
 */
async function checkLightbox(client, count, mid) {
  const { send } = client;
  const problems = [];
  const last = count;

  const key = async (k, code, keyCode) => {
    for (const type of ["keyDown", "keyUp"]) {
      await send("Input.dispatchKeyEvent", {
        type,
        key: k,
        code,
        windowsVirtualKeyCode: keyCode,
        nativeVirtualKeyCode: keyCode,
      });
    }
    await new Promise((r) => setTimeout(r, 250));
  };

  await send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Page.navigate", { url: `${BASE}/work/formal-suit/` });
  await new Promise((r) => setTimeout(r, 2200));

  // Open via a genuine click on a middle tile.
  await evaluate(send, `document.querySelectorAll('.tile__btn')[${mid - 1}].click()`);
  await new Promise((r) => setTimeout(r, 400));

  const opened = await evaluate(
    send,
    `JSON.stringify({
      open: document.querySelector('.lb')?.classList.contains('is-open') ?? false,
      count: document.querySelector('[data-lb-count]')?.textContent.trim(),
      hash: location.hash,
      modal: document.querySelector('.lb')?.getAttribute('aria-modal'),
      focusInside: document.querySelector('.lb')?.contains(document.activeElement) ?? false,
      bodyLocked: document.body.style.overflow === 'hidden'
    })`
  );
  const o = JSON.parse(opened);
  if (!o.open) problems.push("lightbox did not open on tile click");
  if (o.count !== `${mid} / ${count}`)
    problems.push(`counter: got "${o.count}", expected "${mid} / ${count}"`);
  if (o.hash !== `#p=${mid}`)
    problems.push(`deep-link hash: got "${o.hash}", expected "#p=${mid}"`);
  if (o.modal !== "true") problems.push("missing aria-modal=true");
  if (!o.focusInside) problems.push("focus was not moved into the dialog");
  if (!o.bodyLocked) problems.push("page scroll was not locked behind the overlay");

  // Arrow navigation only means anything with a photo on either side of `mid`.
  if (mid < last) {
    await key("ArrowRight", "ArrowRight", 39);
    const next = await evaluate(send, `document.querySelector('[data-lb-count]').textContent.trim()`);
    if (next !== `${mid + 1} / ${count}`)
      problems.push(`ArrowRight: got "${next}", expected "${mid + 1} / ${count}"`);

    await key("ArrowLeft", "ArrowLeft", 37);
    const prev = await evaluate(send, `document.querySelector('[data-lb-count]').textContent.trim()`);
    if (prev !== `${mid} / ${count}`)
      problems.push(`ArrowLeft: got "${prev}", expected "${mid} / ${count}"`);
  }

  await key("End", "End", 35);
  const end = await evaluate(
    send,
    `JSON.stringify({
      count: document.querySelector('[data-lb-count]').textContent.trim(),
      nextDisabled: document.querySelector('[data-lb-next]').disabled
    })`
  );
  const e = JSON.parse(end);
  if (e.count !== `${last} / ${count}`)
    problems.push(`End key: got "${e.count}", expected "${last} / ${count}"`);
  if (!e.nextDisabled) problems.push("Next button not disabled on the last photo");

  await key("Escape", "Escape", 27);
  const closed = await evaluate(
    send,
    `JSON.stringify({
      open: document.querySelector('.lb').classList.contains('is-open'),
      hash: location.hash,
      bodyLocked: document.body.style.overflow === 'hidden',
      focusRestored: document.activeElement?.classList.contains('tile__btn') ?? false
    })`
  );
  const c = JSON.parse(closed);
  if (c.open) problems.push("Escape did not close the lightbox");
  if (c.hash) problems.push(`hash not cleared on close: "${c.hash}"`);
  if (c.bodyLocked) problems.push("page scroll still locked after close");
  if (!c.focusRestored) problems.push("focus was not restored to the originating tile");

  // A shared #p=N link must open straight onto that photo.
  const deepN = last;
  await send("Page.navigate", { url: `${BASE}/work/formal-suit/#p=${deepN}` });
  await new Promise((r) => setTimeout(r, 2400));
  const deep = await evaluate(
    send,
    `JSON.stringify({
      open: document.querySelector('.lb')?.classList.contains('is-open') ?? false,
      count: document.querySelector('[data-lb-count]')?.textContent.trim()
    })`
  );
  const d = JSON.parse(deep);
  if (!d.open) problems.push(`#p=${deepN} did not open the lightbox on load`);
  else if (d.count !== `${deepN} / ${count}`)
    problems.push(`#p=${deepN} landed on "${d.count}", expected "${deepN} / ${count}"`);

  /* An out-of-range deep link must degrade to a plain gallery, not a blank
     overlay: #p=999 is what a stale shared link looks like after photos are
     removed, and it should never trap the visitor behind an empty lightbox. */
  await send("Page.navigate", { url: `${BASE}/work/formal-suit/#p=999` });
  await new Promise((r) => setTimeout(r, 2200));
  const oob = await evaluate(
    send,
    `document.querySelector('.lb')?.classList.contains('is-open') ?? false`
  );
  if (oob) problems.push("#p=999 (out of range) opened an empty lightbox");

  await send("Emulation.clearDeviceMetricsOverride");
  return problems;
}

/**
 * The open photo must fit the viewport and be centred, at every shape of
 * screen. This is asserted geometrically rather than by eye because the bug it
 * catches is invisible in CSS review: `max-height: 100%` on the <img> resolved
 * against <picture>, whose own height is content-driven, so the cap did nothing
 * and a portrait photo rendered at full intrinsic height — overflowing the
 * viewport by hundreds of pixels and pushing the caption off-screen.
 */
async function checkLightboxFit(client) {
  const { send } = client;
  const problems = [];

  const viewports = [
    [1440, 900, "desktop"],
    [1920, 1080, "wide desktop"],
    [390, 844, "phone portrait"],
    [844, 390, "phone landscape"], // shortest viewport — the worst case
    [768, 1024, "tablet"],
  ];

  for (const [w, h, label] of viewports) {
    await send("Emulation.setDeviceMetricsOverride", {
      width: w,
      height: h,
      deviceScaleFactor: 1,
      mobile: w < 768,
    });
    // #p=1 opens straight onto a photo, so no clicking is needed.
    await send("Page.navigate", { url: `${BASE}/work/formal-suit/#p=1` });
    await new Promise((r) => setTimeout(r, 2600));

    const m = JSON.parse(
      await evaluate(
        send,
        `(() => {
          const img = document.querySelector('.lb__img');
          const bar = document.querySelector('.lb__bar');
          const cap = document.querySelector('.lb__cap');
          if (!img) return JSON.stringify({ missing: true });
          const r = img.getBoundingClientRect();
          const capR = cap?.getBoundingClientRect();
          return JSON.stringify({
            top: Math.round(r.top),
            bottom: Math.round(r.bottom),
            left: Math.round(r.left),
            right: Math.round(r.right),
            vh: innerHeight,
            vw: innerWidth,
            barBottom: Math.round(bar?.getBoundingClientRect().bottom ?? 0),
            capBottom: Math.round(capR?.bottom ?? 0),
            capTop: Math.round(capR?.top ?? 0),
            natural: img.naturalWidth + 'x' + img.naturalHeight,
          });
        })()`
      )
    );

    if (m.missing) {
      problems.push(`${label} ${w}x${h}: no photo rendered in the lightbox`);
      continue;
    }

    // Fits vertically. 1px of tolerance for sub-pixel rounding.
    if (m.bottom > m.vh + 1)
      problems.push(
        `${label} ${w}x${h}: photo overflows the bottom by ${m.bottom - m.vh}px (natural ${m.natural})`
      );
    if (m.top < -1)
      problems.push(`${label} ${w}x${h}: photo overflows the top by ${-m.top}px`);

    // Fits horizontally.
    if (m.right > m.vw + 1)
      problems.push(`${label} ${w}x${h}: photo overflows the right by ${m.right - m.vw}px`);
    if (m.left < -1)
      problems.push(`${label} ${w}x${h}: photo overflows the left by ${-m.left}px`);

    /* Must not collide with the chrome above or below. Note this is NOT also
       asserted as "equal gaps": the stage is a 1fr grid row between a taller
       bar and a shorter caption, so centring within that row correctly yields
       unequal distances to each, and demanding symmetry would fail a layout
       that is behaving exactly as designed. */
    const spaceTop = m.top - m.barBottom;
    const spaceBottom = m.capTop - m.bottom;
    if (spaceTop < -1 || spaceBottom < -1) {
      problems.push(
        `${label} ${w}x${h}: photo collides with the chrome (gap above ${spaceTop}px, below ${spaceBottom}px)`
      );
    }

    const cx = (m.left + m.right) / 2;
    if (Math.abs(cx - m.vw / 2) > 2)
      problems.push(`${label} ${w}x${h}: photo not horizontally centred (centre ${Math.round(cx)}, want ${m.vw / 2})`);
  }

  /* Scroll lock, driven by a REAL wheel gesture.
     `documentElement.scrollTop = n` is not a usable probe here: assigning it
     programmatically moves the viewport even when overflow is hidden, so it
     measures document height rather than whether a user can scroll. Only a
     dispatched wheel event goes through the same path a mouse does. */
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Page.navigate", { url: `${BASE}/work/formal-suit/#p=1` });
  await new Promise((r) => setTimeout(r, 2600));

  const wheel = () =>
    send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: 720,
      y: 450,
      deltaX: 0,
      deltaY: 600,
    });

  const yBefore = await evaluate(send, `window.scrollY`);
  await wheel();
  await new Promise((r) => setTimeout(r, 500));
  const yOpen = await evaluate(send, `window.scrollY`);
  if (yOpen !== yBefore)
    problems.push(`gallery scrolled behind the open lightbox (${yBefore} → ${yOpen})`);

  // And the lock must be released on close, or the gallery is left frozen.
  await evaluate(send, `document.querySelector('[data-lb-close]').click()`);
  await new Promise((r) => setTimeout(r, 400));
  const yClosed = await evaluate(send, `window.scrollY`);
  await wheel();
  await new Promise((r) => setTimeout(r, 500));
  const yAfter = await evaluate(send, `window.scrollY`);
  if (yAfter <= yClosed)
    problems.push(`page still cannot scroll after closing the lightbox (${yClosed} → ${yAfter})`);

  await send("Emulation.clearDeviceMetricsOverride");
  return problems;
}

/* ==========================================================================
   Admin panel

   The panel cannot be smoke-tested like a public page. It has no `.is-ready`
   barrier, every screen is behind a token, and every write goes to the real
   GitHub API — which must obviously never be called from a test run.

   So api.github.com is intercepted with Fetch.enable + a URL pattern, and
   answered from a table below. That is a genuine network-layer intercept, not
   a stub inside the page: the panel's own fetch() calls run unmodified, which
   means the request bodies asserted here are the exact bytes that would have
   gone to GitHub.

   The interception doubles as the safety property worth having: if a single
   request escaped to the real API the run would hang on auth rather than
   quietly committing something.
   ========================================================================== */

/* --- Fixtures -------------------------------------------------------------
   Byte-exact images, inline, rather than files on disk. Three reasons: the
   harness must not depend on the sample photos (which get replaced with real
   photography), a test image in the repo would be published by the workflow,
   and these are small enough to read.

   PHONE_JPEG is the one that matters. It is a real baseline JPEG carrying a
   genuine GPS IFD (tag 0x8825 → four GPS tags with rational coordinates),
   orientation 6, an XMP packet naming exif:GPSLatitude, and a COM comment.
   Confirmed against sharp: metadata() reports orientation 6 and an EXIF buffer
   containing the GPS pointer. An earlier attempt built with withExifMerge()
   looked right but sharp had silently dropped the GPS IFD, so the fixture was
   testing nothing — hence the hand-built bytes.
   ---------------------------------------------------------------------- */
const FIXTURES = {
  /* 16×24 JPEG: GPS IFD + orientation 6 + XMP + COM. */
  phoneJPEG:
    "/9j/4QCURXhpZgAASUkqAAgAAAACABIBAwABAAAABgAAACWIBAABAAAAJgAAAAAAAAAEAAEAAgACAAAATgAAAAIABQADAAAAXAAAAAMAAgACAAAARQAAAAQABQADAAAAdAAAAAAAAAAzAAAAAQAAAB4AAAABAAAAAAAAAAEAAAAAAAAAAQAAAAcAAAABAAAAAAAAAAEAAAD/4QDjaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wLwA8eDp4bXBtZXRhIHhtbG5zOng9ImFkb2JlOm5zOm1ldGEvIj48cmRmOlJERiB4bWxuczpyZGY9Imh0dHA6Ly93d3cudzMub3JnLzE5OTkvMDIvMjItcmRmLXN5bnRheC1ucyMiPjxyZGY6RGVzY3JpcHRpb24gZXhpZjpHUFNMYXRpdHVkZT0iNTEsMzAuME4iIGV4aWY6R1BTTG9uZ2l0dWRlPSIwLDcuMEUiLz48L3JkZjpSREY+PC94OnhtcG1ldGE+//4AGVNob3Qgb24gYSBwaG9uZSBhdCBob21l/9sAQwAKBwcIBwYKCAgICwoKCw4YEA4NDQ4dFRYRGCMfJSQiHyIhJis3LyYpNCkhIjBBMTQ5Oz4+PiUuRElDPEg3PT47/9sAQwEKCwsODQ4cEBAcOygiKDs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7/8AAEQgAGAAQAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/aAAwDAQACEQMRAD8Av0UUV5J6QUUUUAf/2Q==",

  /* 16×24 PNG with tEXt (location text) and a real eXIf chunk, CRCs correct. */
  dirtyPNG:
    "iVBORw0KGgoAAAANSUhEUgAAABAAAAAYCAIAAAB8wupbAAAAIXRFWHRDb21tZW50AFRha2VuIGF0IGhvbWUsIDUxLjVOIDAuMVecy0ElAAAAHmVYSWZJSSoACAAAAAEAJYgEAAEAAAAaAAAAAAAAAAAAAAA7L6fkAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAGklEQVR42mOIqlhAEmIY1TCqYVTDqAbaagAAqj4rH2ZayDAAAAAASUVORK5CYII=",

  /* 16×24 WebP with a real EXIF RIFF chunk. */
  dirtyWebP:
    "UklGRj4BAABXRUJQVlA4WAoAAAAIAAAADwAAFwAAVlA4IDAAAACwAgCdASoQABgAPp0+mUgloyKhMAgAsBOJQAAPZAAA/rZX/6+8odiZD+9y0UAgAABFWElG6AAAAEV4aWYAAElJKgAIAAAACAAOAQIACgAAAIoAAAASAQMAAQAAAAEAAAAaAQUAAQAAAG4AAAAbAQUAAQAAAHYAAAAoAQMAAQAAAAIAAAATAgMAAQAAAAEAAACYggIADAAAAH4AAABphwQAAQAAAJQAAAAAAAAAOGMAAOgDAAA4YwAA6AMAAGhvbWUgc3R1ZGlvAEdQUyA1MS41TgAGAACQBwAEAAAAMDIxMAGRBwAEAAAAAQIDAACgBwAEAAAAMDEwMAGgAwABAAAA//8AAAKgBAABAAAAEAAAAAOgBAABAAAAGAAAAAAAAAA=",

  /* Not an image at all — the reject path. */
  notAnImage: "JVBERi0xLjQKJeLjz9MKMSAwIG9iago8PC9UeXBlL0NhdGFsb2c+PgplbmRvYmoK",
};

/** A plausible category catalogue, independent of what is in data/. */
const MOCK_CATALOG = {
  updated: "2026-01-01T00:00:00Z",
  rev: 1,
  categories: [
    { slug: "formal-suit", title: "Formal Suit", count: 6, order: 1, published: true },
    { slug: "casual", title: "Casual", count: 4, order: 2, published: true },
    { slug: "ethnic", title: "Ethnic Wear", count: 3, order: 3, published: false },
  ],
};

/**
 * Intercept api.github.com at the network layer and answer from a table.
 *
 * Returns a `log` array that fills with every intercepted request, so a suite
 * can assert on ORDER and COUNT — which is where the interesting properties
 * live: job.json written last, zero calls when validation fails.
 */
async function mockGitHub(client, routes = {}) {
  const { send, events } = client;
  const log = [];

  await send("Fetch.enable", {
    patterns: [{ urlPattern: "https://api.github.com/*", requestStage: "Request" }],
  });

  const respond = async (requestId, status, bodyObj) => {
    const body = bodyObj === null ? "" : JSON.stringify(bodyObj);
    await send("Fetch.fulfillRequest", {
      requestId,
      responseCode: status,
      responseHeaders: [
        { name: "content-type", value: "application/json" },
        /* The panel's fetch is a cross-origin request, so without CORS headers
           the browser rejects the fulfilled response and the panel reports a
           network error instead of exercising the code under test. */
        { name: "access-control-allow-origin", value: "*" },
        { name: "access-control-allow-headers", value: "*" },
        { name: "access-control-allow-methods", value: "GET,PUT,POST,DELETE,OPTIONS" },
      ],
      body: body ? btoa64(body) : "",
    });
  };

  const handler = async (ev) => {
    if (ev.method !== "Fetch.requestPaused") return;
    const { requestId, request } = ev.params;
    const full = request.url.replace("https://api.github.com", "");
    /* Match on the path alone. Every Contents API read carries `?ref=main`, so
       an exact-match table keyed on the path would miss all of them and answer
       404 — which looks exactly like a panel bug (no categories, no drop zone)
       and cost a full run to diagnose. */
    const url = full.split("?")[0];
    const method = request.method;

    /* Preflight. The panel sends Authorization and a custom API-version
       header, so Chrome preflights every write. */
    if (method === "OPTIONS") return respond(requestId, 204, null);

    let bodyText = "";
    if (request.postData) bodyText = request.postData;
    log.push({ method, url, body: bodyText });

    for (const [pattern, reply] of Object.entries(routes)) {
      const [m, p] = pattern.split(" ");
      if (m !== method) continue;
      // "*" is a path wildcard, e.g. "PUT /repos/o/r/contents/*".
      const ok = p.endsWith("*") ? url.startsWith(p.slice(0, -1)) : url === p;
      if (!ok) continue;
      const out = typeof reply === "function" ? reply(url, bodyText) : reply;
      return respond(requestId, out.status ?? 200, out.body ?? null);
    }

    return respond(requestId, 404, { message: "Not Found" });
  };

  /* Events arrive on the shared queue, so drain it on a timer rather than
     adding a second consumer that would race with checkPage's reader.

     The cursor starts at the CURRENT end of the queue, not at zero. Starting
     at zero replays every Fetch.requestPaused from earlier suites: the
     fulfilRequest calls fail harmlessly on stale requestIds, but each one is
     also appended to `log`, so a later suite would assert against an earlier
     suite's traffic. */
  let cursor = events.length;
  const pump = setInterval(async () => {
    while (cursor < events.length) {
      const ev = events[cursor++];
      if (ev.method === "Fetch.requestPaused") await handler(ev).catch(() => {});
    }
  }, 25);

  return {
    log,
    stop: async () => {
      clearInterval(pump);
      await send("Fetch.disable").catch(() => {});
    },
  };
}

/** btoa for Node — Fetch.fulfillRequest wants a base64 body. */
const btoa64 = (s) => Buffer.from(s, "utf8").toString("base64");

/** The repo probe auth.js makes on sign-in, with push permission. */
const REPO_OK = { status: 200, body: { default_branch: "main", permissions: { push: true }, private: false } };

/** A Contents API write response. The panel only reads `.content.sha`. */
const PUT_OK = { status: 200, body: { content: { sha: "deadbeef" }, commit: { sha: "cafe" } } };

/** Contents API read of a JSON file. */
const contentsJSON = (obj, sha = "abc123") => ({
  status: 200,
  body: {
    sha,
    content: Buffer.from(JSON.stringify(obj), "utf8").toString("base64"),
    encoding: "base64",
  },
});

/** Drive the panel past the sign-in gate. */
async function signInPanel(send) {
  await evaluate(
    send,
    `(() => {
      const f = document.querySelector('#signin-form');
      document.querySelector('#token').value =
        'github_pat_11ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
      f.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      return true;
    })()`
  );
  await new Promise((r) => setTimeout(r, 900));
}

/** Console errors and exceptions on the panel, drained from the event queue. */
function panelErrors(events, from) {
  const out = [];
  for (let i = from; i < events.length; i++) {
    const ev = events[i];
    if (ev.method === "Runtime.exceptionThrown") {
      const d = ev.params.exceptionDetails;
      out.push(`EXCEPTION: ${d.exception?.description || d.text}`);
    }
    if (ev.method === "Runtime.consoleAPICalled" && ev.params.type === "error") {
      out.push(
        `CONSOLE ERROR: ${ev.params.args.map((a) => a.value ?? a.description ?? "").join(" ")}`
      );
    }
  }
  return out;
}

/**
 * The panel loads, stays out of search results, and shows nothing but the gate
 * until a token is accepted.
 *
 * "Nothing but the gate" is the security-relevant half: the panel markup ships
 * in the HTML, so a bug in the [hidden] toggling would expose the publish
 * controls to anyone who opens the URL. They would fail at the first API call,
 * but it should not get that far.
 */
async function checkAdminGate(client) {
  const { send, events } = client;
  const problems = [];
  const from = events.length;

  await send("Page.navigate", { url: `${BASE}/admin/` });
  await new Promise((r) => setTimeout(r, 1500));

  const m = JSON.parse(
    await evaluate(
      send,
      `JSON.stringify({
        robots: document.querySelector('meta[name=robots]')?.content || '',
        gateVisible: !document.querySelector('#gate')?.hidden,
        panelHidden: document.querySelector('#panel')?.hidden === true,
        signoutHidden: document.querySelector('#signout')?.hidden === true,
        /* The ATTRIBUTE is not the thing that hides an element. Any author
           display declaration outranks the UA sheet's [hidden] rule, so
           .btn's inline-flex re-showed a live "Sign out" on the signed-out
           gate while el.hidden still read true. Assert on what actually
           renders, for every [hidden] node — this panel has no other
           mechanism for concealing a screen. */
        hiddenButRendered: [...document.querySelectorAll('[hidden]')]
          .filter(el => getComputedStyle(el).display !== 'none')
          .map(el => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '')),
        tokenType: document.querySelector('#token')?.type,
        tokenAutocomplete: document.querySelector('#token')?.getAttribute('autocomplete'),
        theme: document.documentElement.dataset.theme,
        /* #signin-btn, not just any .btn: the header's Theme button carries
           .btn--sm and legitimately measures 34px, so sampling the first .btn
           reads a pass as a failure. */
        cssLoaded: getComputedStyle(document.querySelector('#signin-btn')).minHeight,
        repoNamed: (document.querySelector('.gate__lede')?.textContent || '').includes('mode-on-satvik/portfolio'),
        publishControls: document.querySelectorAll('#panel .drop, #panel #publish').length,
        panelRect: document.querySelector('#panel')?.getBoundingClientRect().height
      })`
    )
  );

  if (!/noindex/.test(m.robots)) problems.push(`admin page is indexable (robots: ${JSON.stringify(m.robots)})`);
  if (!/nofollow/.test(m.robots)) problems.push("admin robots meta lacks nofollow");
  if (!m.gateVisible) problems.push("sign-in gate is not visible on load");
  if (!m.panelHidden) problems.push("publish panel is NOT hidden before sign-in");
  if (m.panelRect !== 0) problems.push(`hidden panel still occupies ${m.panelRect}px of layout`);
  if (m.publishControls !== 0)
    problems.push(`${m.publishControls} publish control(s) rendered before sign-in`);
  if (!m.signoutHidden) problems.push("Sign out button shown while signed out");
  if (m.hiddenButRendered.length)
    problems.push(
      `[hidden] set but still rendered (a CSS display rule is overriding it): ${m.hiddenButRendered.join(", ")}`
    );
  if (m.tokenType !== "password") problems.push(`token field is type=${m.tokenType}, not password`);
  if (m.tokenAutocomplete !== "off")
    problems.push("token field allows autocomplete — the browser would save the token");
  if (m.theme !== "dark" && m.theme !== "light") problems.push("theme not applied pre-paint");
  if (parseFloat(m.cssLoaded) < 44)
    problems.push(`admin.css did not load or touch targets are under 44px (${m.cssLoaded})`);
  if (!m.repoNamed) problems.push("panel does not say which repo it publishes to");

  /* An obviously-wrong token must be refused without spending a request, so a
     typo cannot be mistaken for a network problem — and so the panel is not a
     way to probe GitHub. Asserted by watching for zero intercepted traffic. */
  const mock = await mockGitHub(client, { "GET /repos/mode-on-satvik/portfolio": REPO_OK });
  await evaluate(
    send,
    `(() => {
      document.querySelector('#token').value = 'not-a-token';
      document.querySelector('#signin-form')
        .dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      return true;
    })()`
  );
  await new Promise((r) => setTimeout(r, 700));

  const bad = JSON.parse(
    await evaluate(
      send,
      `JSON.stringify({
        msg: document.querySelector('#gate-msg')?.textContent.trim() || '',
        invalid: document.querySelector('#token')?.getAttribute('aria-invalid'),
        stillGated: document.querySelector('#panel')?.hidden === true
      })`
    )
  );
  if (mock.log.length !== 0)
    problems.push(`malformed token still hit the API ${mock.log.length} time(s): ${JSON.stringify(mock.log.map((r) => r.url))}`);
  if (!/github_pat_|ghp_/.test(bad.msg))
    problems.push(`malformed token gave no useful message: ${JSON.stringify(bad.msg)}`);
  if (bad.invalid !== "true") problems.push("rejected token field not marked aria-invalid");
  if (!bad.stillGated) problems.push("panel opened despite a rejected token");

  /* A valid token opens the panel AND must be cleared out of the DOM node, or
     it stays readable by anything that walks the document. */
  await mock.stop();
  const mock2 = await mockGitHub(client, {
    "GET /repos/mode-on-satvik/portfolio": REPO_OK,
    "GET /repos/mode-on-satvik/portfolio/contents/data/index.json": contentsJSON(MOCK_CATALOG),
  });
  await signInPanel(send);

  const good = JSON.parse(
    await evaluate(
      send,
      `JSON.stringify({
        panelOpen: document.querySelector('#panel')?.hidden === false,
        gateHidden: document.querySelector('#gate')?.hidden === true,
        tokenCleared: document.querySelector('#token')?.value === '',
        cats: document.querySelectorAll('#slug option').length,
        dropZone: !!document.querySelector('#drop'),
        tokenInDOM: document.documentElement.outerHTML.includes('github_pat_11ABCDEF'),
        signoutShown: document.querySelector('#signout')?.hidden === false
      })`
    )
  );
  if (!good.panelOpen) problems.push("valid token did not open the panel");
  if (!good.gateHidden) problems.push("gate still visible after sign-in");
  if (!good.tokenCleared) problems.push("token left in the input field after sign-in");
  if (good.tokenInDOM) problems.push("TOKEN IS RECOVERABLE FROM THE DOM after sign-in");
  if (good.cats !== MOCK_CATALOG.categories.length)
    problems.push(`category picker has ${good.cats} options, expected ${MOCK_CATALOG.categories.length}`);
  if (!good.dropZone) problems.push("upload drop zone did not render");
  if (!good.signoutShown) problems.push("Sign out button not shown after sign-in");

  /* Signing out must put it back, not just hide things. */
  await evaluate(send, `document.querySelector('#signout').click()`);
  await new Promise((r) => setTimeout(r, 400));
  const out = JSON.parse(
    await evaluate(
      send,
      `JSON.stringify({
        gateBack: document.querySelector('#gate')?.hidden === false,
        panelGone: document.querySelector('#panel')?.hidden === true
      })`
    )
  );
  if (!out.gateBack) problems.push("sign-out did not return to the gate");
  if (!out.panelGone) problems.push("sign-out left the panel visible");

  await mock2.stop();
  problems.push(...panelErrors(events, from));
  return problems;
}

/**
 * scrub.js, run in the browser against real bytes.
 *
 * This is the suite that earns its keep. The failure it guards against is
 * silent and permanent: a phone photo committed with its GPS intact publishes
 * the coordinates of a child's home into git history forever, and the image
 * looks identical either way. There is nothing to notice by eye, in review, or
 * in the deploy log.
 *
 * So it is checked on the OUTPUT BYTES, structurally, not by trusting the
 * stripper's own report.
 */
async function checkAdminScrub(client) {
  const { send, events } = client;
  const problems = [];
  const from = events.length;

  await send("Page.navigate", { url: `${BASE}/admin/` });
  await new Promise((r) => setTimeout(r, 1200));

  const result = await evaluate(
    send,
    `(async () => {
      const B64 = ${JSON.stringify(FIXTURES)};
      const bytes = (b64) => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      const mod = await import('./js/scrub.js');

      const asFile = (b64, name, type) =>
        new File([bytes(b64)], name, { type });

      /* Tag hunting on the OUTPUT. GPS EXIF is binary — tag 0x8825 as a
         little-endian 16-bit number is the byte pair 25 88 — so a text scan
         for "GPSLatitude" finds nothing in a real phone photo. That exact
         false negative is why this looks for the bytes. */
      const findPair = (arr, a, b) => {
        for (let i = 0; i < arr.length - 1; i++) if (arr[i] === a && arr[i + 1] === b) return i;
        return -1;
      };
      const asText = (arr) => {
        let s = '';
        for (const c of arr) s += (c >= 32 && c < 127) ? String.fromCharCode(c) : ' ';
        return s;
      };
      const segments = (arr) => {
        // JPEG marker walk, for asserting what survived.
        const out = [];
        if (arr[0] !== 0xff || arr[1] !== 0xd8) return out;
        let i = 2;
        while (i < arr.length - 1) {
          if (arr[i] !== 0xff) { i++; continue; }
          const m = arr[i + 1];
          if (m === 0xda || m === 0xd9) break;
          if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
          const len = (arr[i + 2] << 8) | arr[i + 3];
          if (len < 2 || i + 2 + len > arr.length) break;
          out.push({ marker: m, len });
          i += 2 + len;
        }
        return out;
      };

      const out = {};

      /* --- 1. The phone photo: GPS out, orientation kept ----------------- */
      const raw = bytes(B64.phoneJPEG);
      const phone = await mod.scrub(asFile(B64.phoneJPEG, 'IMG_4821.JPG', 'image/jpeg'));
      out.phone = { ok: phone.ok, reason: phone.reason };
      if (phone.ok) {
        const b = phone.bytes;
        out.phone.name = phone.name;
        out.phone.orientation = phone.orientation;
        out.phone.recompressed = phone.recompressed;
        out.phone.smaller = b.length < raw.length;
        out.phone.segments = segments(b).map(s => 'APP' + (s.marker - 0xe0) + ':' + s.len)
          .concat([]);
        out.phone.markers = segments(b).map(s => s.marker);
        // GPS IFD pointer, as bytes, in either endianness.
        out.phone.gpsLE = findPair(b, 0x25, 0x88) >= 0;
        out.phone.gpsBE = findPair(b, 0x88, 0x25) >= 0;
        const text = asText(b);
        out.phone.xmp = text.includes('x:xmpmeta') || text.includes('ns.adobe.com/xap');
        out.phone.gpsText = text.includes('GPSLatitude') || text.includes('GPSLongitude');
        out.phone.comment = text.includes('phone at home');
        // Orientation tag 0x0112 must still be findable — that is the flag the
        // workflow's sharp().rotate() needs to un-rotate the pixels.
        out.phone.hasOrientationTag = findPair(b, 0x12, 0x01) >= 0;
        out.phone.looksClean = mod.looksClean(b);

        /* Two dimensions, and the PAIR is the orientation proof.

           STORED size comes from the JPEG's own frame header (SOF), read out
           of the bytes. It must still be 16×24 — the entropy-coded pixel data
           was copied through verbatim, so a change here means the "lossless"
           stripper re-encoded something.

           Not read via createImageBitmap: imageOrientation "none" was
           removed from the spec, and Chrome now applies orientation whatever
           you pass, so both decodes came back 24×16 and the stored size was
           unobtainable that way.

           ORIENTED size must come back SWAPPED to 24×16. That can only happen
           if the rebuilt 32-byte EXIF is well-formed enough for a real decoder
           to read orientation 6 out of it. Finding the 0x0112 byte pair proves
           the bytes are present; this proves they are understood — which is
           exactly what the workflow's sharp().rotate() depends on. */
        const sof = (() => {
          let i = 2;
          while (i < b.length - 1) {
            if (b[i] !== 0xff) { i++; continue; }
            const m = b[i + 1];
            if (m === 0xda || m === 0xd9) break;
            if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
            const len = (b[i + 2] << 8) | b[i + 3];
            if (len < 2 || i + 2 + len > b.length) break;
            // SOF0..SOF15, excluding DHT(c4), JPG(c8) and DAC(cc).
            if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
              const h = (b[i + 5] << 8) | b[i + 6];
              const w = (b[i + 7] << 8) | b[i + 8];
              return w + 'x' + h;
            }
            i += 2 + len;
          }
          return 'no SOF found';
        })();
        out.phone.storedSize = sof;

        try {
          const applied = await createImageBitmap(
            new Blob([b], { type: 'image/jpeg' }), { imageOrientation: 'from-image' });
          out.phone.orientedSize = applied.width + 'x' + applied.height;
          applied.close?.();
        } catch (e) { out.phone.orientedSize = 'FAILED: ' + e.message; }
      }

      /* The raw fixture must be detected as dirty. If looksClean() calls the
         untouched phone photo clean, the whole check is decorative. */
      out.rawVerdict = mod.looksClean(raw);

      /* --- 2. PNG: tEXt and eXIf chunks removed -------------------------- */
      const png = await mod.scrub(asFile(B64.dirtyPNG, 'shot.png', 'image/png'));
      out.png = { ok: png.ok, reason: png.reason };
      if (png.ok) {
        const t = asText(png.bytes);
        out.png.hasTEXt = t.includes('tEXt');
        out.png.hasEXIf = t.includes('eXIf');
        out.png.leakedText = t.includes('Taken at home');
        out.png.looksClean = mod.looksClean(png.bytes);
        out.png.isPNG = png.bytes[0] === 0x89 && png.bytes[1] === 0x50;
        try {
          const bm = await createImageBitmap(new Blob([png.bytes], { type: 'image/png' }));
          out.png.decoded = bm.width + 'x' + bm.height;
          bm.close?.();
        } catch (e) { out.png.decoded = 'FAILED: ' + e.message; }
      }
      out.pngRawVerdict = mod.looksClean(bytes(B64.dirtyPNG));

      /* --- 3. WebP: EXIF chunk removed, RIFF size rewritten -------------- */
      const webp = await mod.scrub(asFile(B64.dirtyWebP, 'shot.webp', 'image/webp'));
      out.webp = { ok: webp.ok, reason: webp.reason };
      if (webp.ok) {
        const b = webp.bytes;
        const t = asText(b);
        out.webp.hasEXIF = t.slice(12).includes('EXIF');
        out.webp.leaked = t.includes('home studio') || t.includes('GPS 51.5N');
        out.webp.looksClean = mod.looksClean(b);
        // A RIFF size field left stale after chunk removal is a corrupt file.
        const declared = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(4, true);
        out.webp.riffSizeCorrect = declared === b.length - 8;
        try {
          const bm = await createImageBitmap(new Blob([b], { type: 'image/webp' }));
          out.webp.decoded = bm.width + 'x' + bm.height;
          bm.close?.();
        } catch (e) { out.webp.decoded = 'FAILED: ' + e.message; }
      }
      out.webpRawVerdict = mod.looksClean(bytes(B64.dirtyWebP));

      /* --- 4. A non-image must be refused, not uploaded ------------------ */
      const pdf = await mod.scrub(asFile(B64.notAnImage, 'scan.jpg', 'image/jpeg'));
      out.notAnImage = { ok: pdf.ok, reason: pdf.reason || '' };

      /* --- 5. Truncated input must not throw ---------------------------- */
      const tiny = await mod.scrub(new File([new Uint8Array(4)], 't.jpg', { type: 'image/jpeg' }));
      out.truncated = { ok: tiny.ok, reason: tiny.reason || '' };

      return JSON.stringify(out);
    })().catch(e => 'ERR ' + e.message + ' @ ' + e.stack)`
  );

  if (typeof result !== "string" || result.startsWith("ERR ")) {
    return [`scrub.js could not be exercised: ${result}`];
  }
  const r = JSON.parse(result);

  /* --- The fixture itself must be dirty ---------------------------------- */
  if (r.rawVerdict?.clean)
    problems.push(
      "looksClean() reports the UNTOUCHED phone fixture as clean — the detector is blind, " +
        "so every other assertion here is meaningless"
    );
  if (r.pngRawVerdict?.clean) problems.push("looksClean() reports the dirty PNG fixture as clean");
  if (r.webpRawVerdict?.clean) problems.push("looksClean() reports the dirty WebP fixture as clean");

  /* --- JPEG ------------------------------------------------------------- */
  if (!r.phone?.ok) {
    problems.push(`phone JPEG was rejected outright: ${r.phone?.reason}`);
  } else {
    const p = r.phone;
    if (p.gpsLE || p.gpsBE) problems.push("GPS IFD POINTER (0x8825) SURVIVED IN THE OUTPUT BYTES");
    if (p.gpsText) problems.push("GPS coordinate names survived in the output text");
    if (p.xmp) problems.push("XMP packet survived (it named exif:GPSLatitude)");
    if (p.comment) problems.push('COM comment survived ("phone at home")');
    if (!p.looksClean?.clean)
      problems.push(`scrub() returned bytes its own check calls dirty: ${p.looksClean?.marker}`);
    /* Orientation is the trap: strip everything and portraits publish sideways,
       silently, with nothing in any log. */
    if (p.orientation !== 6)
      problems.push(`orientation lost: reported ${p.orientation}, fixture is 6`);
    if (!p.hasOrientationTag)
      problems.push("orientation tag 0x0112 is not in the output — portraits will publish sideways");
    const app1 = (p.markers || []).filter((m) => m === 0xe1).length;
    if (app1 !== 1) problems.push(`expected exactly 1 APP1 (the rebuilt orientation), found ${app1}`);
    const others = (p.markers || []).filter((m) => m >= 0xe0 && m <= 0xef && m !== 0xe1);
    if (others.length) problems.push(`extra APPn segments survived: ${JSON.stringify(others)}`);
    if (p.recompressed) problems.push("JPEG took the canvas path — the lossless stripper failed");
    if (!p.smaller) problems.push("output is not smaller than the input, so nothing was stripped");
    if (p.storedSize !== "16x24")
      problems.push(`stripped JPEG no longer decodes at its stored size: ${p.storedSize}`);
    if (p.orientedSize !== "24x16")
      problems.push(
        `a real decoder did not apply orientation 6 to the rebuilt EXIF ` +
          `(got ${p.orientedSize}, expected 24x16) — the workflow's rotate() will ` +
          "do nothing and portraits will publish sideways"
      );
    if (!/\.JPG$/i.test(p.name || "")) problems.push(`filename changed unexpectedly: ${p.name}`);
  }

  /* --- PNG -------------------------------------------------------------- */
  if (!r.png?.ok) {
    problems.push(`PNG was rejected: ${r.png?.reason}`);
  } else {
    if (r.png.hasTEXt) problems.push("PNG tEXt chunk survived");
    if (r.png.hasEXIf) problems.push("PNG eXIf chunk survived");
    if (r.png.leakedText) problems.push('PNG comment text survived ("Taken at home")');
    if (!r.png.looksClean?.clean) problems.push(`PNG output still dirty: ${r.png.looksClean?.marker}`);
    if (!r.png.isPNG) problems.push("PNG output is no longer a PNG");
    if (r.png.decoded !== "16x24") problems.push(`stripped PNG no longer decodes: ${r.png.decoded}`);
  }

  /* --- WebP ------------------------------------------------------------- */
  if (!r.webp?.ok) {
    problems.push(`WebP was rejected: ${r.webp?.reason}`);
  } else {
    if (r.webp.hasEXIF) problems.push("WebP EXIF chunk survived");
    if (r.webp.leaked) problems.push("WebP EXIF text survived");
    if (!r.webp.looksClean?.clean) problems.push(`WebP output still dirty: ${r.webp.looksClean?.marker}`);
    if (!r.webp.riffSizeCorrect)
      problems.push("WebP RIFF size field not rewritten after chunk removal — the file is corrupt");
    if (r.webp.decoded !== "16x24") problems.push(`stripped WebP no longer decodes: ${r.webp.decoded}`);
  }

  /* --- Rejections ------------------------------------------------------- */
  if (r.notAnImage?.ok)
    problems.push("a PDF renamed .jpg was accepted for upload");
  else if (!/could not be read|Most Compatible/i.test(r.notAnImage?.reason || ""))
    problems.push(`unhelpful message for a non-image: ${JSON.stringify(r.notAnImage?.reason)}`);
  if (r.truncated?.ok) problems.push("a 4-byte file was accepted for upload");

  problems.push(...panelErrors(events, from));
  return problems;
}

/**
 * The publish path, with GitHub intercepted.
 *
 * Two properties here are worth more than the rest:
 *
 *   · Missing alt text must block publish having made ZERO API calls. Alt text
 *     is unfixable in practice once published (it needs another commit that
 *     never gets made), and a half-blocked publish that still staged three
 *     photos would be the worst of both.
 *
 *   · job.json must be the LAST write. It is the manifest the workflow reads;
 *     writing it before the photos means an interrupted batch leaves the
 *     workflow describing images that do not exist.
 */
async function checkAdminPublish(client) {
  const { send, events } = client;
  const problems = [];
  const from = events.length;

  await send("Page.navigate", { url: `${BASE}/admin/` });
  await new Promise((r) => setTimeout(r, 1200));

  const mock = await mockGitHub(client, {
    "GET /repos/mode-on-satvik/portfolio": REPO_OK,
    "GET /repos/mode-on-satvik/portfolio/contents/data/index.json": contentsJSON(MOCK_CATALOG),
    // Nothing already staged: a 404 here is the normal answer.
    "GET /repos/mode-on-satvik/portfolio/contents/_inbox/*": { status: 404, body: { message: "Not Found" } },
    "PUT /repos/mode-on-satvik/portfolio/contents/*": PUT_OK,
    "POST /repos/mode-on-satvik/portfolio/dispatches": { status: 204, body: null },
  });

  await signInPanel(send);

  /* Queue two photos through the real file-picker path — a synthetic
     DataTransfer, so addFiles() and scrub() run exactly as they would. */
  await evaluate(
    send,
    `(async () => {
      const b64 = ${JSON.stringify(FIXTURES.phoneJPEG)};
      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      const dt = new DataTransfer();
      for (const n of ['IMG_0001.JPG', 'IMG_0002.JPG']) {
        dt.items.add(new File([bytes], n, { type: 'image/jpeg' }));
      }
      const picker = document.querySelector('#picker');
      picker.files = dt.files;
      picker.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`
  );
  await new Promise((r) => setTimeout(r, 1500));

  const queued = JSON.parse(
    await evaluate(
      send,
      `JSON.stringify({
        rows: document.querySelectorAll('#queue .item').length,
        bad: document.querySelectorAll('#queue .item--bad').length,
        thumbs: [...document.querySelectorAll('#queue .item__thumb')]
          .filter(i => i.tagName === 'IMG').length,
        publishShown: document.querySelector('#publish-box')?.hidden === false,
        altBoxes: document.querySelectorAll('#queue [data-alt]').length
      })`
    )
  );
  if (queued.rows !== 2) problems.push(`queued ${queued.rows} rows, expected 2`);
  if (queued.bad) problems.push(`${queued.bad} queued photo(s) failed to scrub`);
  if (queued.thumbs !== 2) problems.push(`${queued.thumbs} thumbnails rendered, expected 2`);
  if (!queued.publishShown) problems.push("Publish button did not appear once photos were queued");
  if (queued.altBoxes !== 2) problems.push("alt-text fields missing from the queue rows");

  const beforeGate = mock.log.length;

  /* --- The alt-text gate ------------------------------------------------- */
  await evaluate(send, `document.querySelector('#publish').click()`);
  await new Promise((r) => setTimeout(r, 900));

  const gated = JSON.parse(
    await evaluate(
      send,
      `JSON.stringify({
        msg: document.querySelector('#upload-msg')?.textContent.trim() || '',
        rows: document.querySelectorAll('#queue .item').length,
        focused: document.activeElement?.dataset?.alt || null
      })`
    )
  );
  const gateCalls = mock.log.slice(beforeGate);
  if (gateCalls.length !== 0)
    problems.push(
      `publish with missing alt text made ${gateCalls.length} API call(s): ` +
        JSON.stringify(gateCalls.map((c) => c.method + " " + c.url))
    );
  if (!/alt text/i.test(gated.msg))
    problems.push(`no alt-text warning shown: ${JSON.stringify(gated.msg)}`);
  if (gated.rows !== 2) problems.push("the blocked publish dropped photos from the queue");
  if (!gated.focused) problems.push("the blocked publish did not focus the offending alt field");

  /* --- A real publish --------------------------------------------------- */
  await evaluate(
    send,
    `(() => {
      const boxes = [...document.querySelectorAll('#queue [data-alt]')];
      boxes[0].value = 'Child model in a navy three-piece suit, seated';
      boxes[0].dispatchEvent(new Event('input', { bubbles: true }));
      boxes[1].value = 'Closeup, direct to camera, studio lighting';
      boxes[1].dispatchEvent(new Event('input', { bubbles: true }));
      const cap = document.querySelector('#queue [data-caption]');
      cap.value = 'Look 1 & 2';
      cap.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#message').value = 'Add two suit photos';
      return true;
    })()`
  );

  /* Tick "use as set cover" on the second photo — this re-renders the queue,
     which is where per-row listeners would have leaked. */
  await evaluate(
    send,
    `(() => {
      const c = [...document.querySelectorAll('#queue [data-featured]')][1];
      c.checked = true;
      c.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`
  );
  await new Promise((r) => setTimeout(r, 300));

  const covers = await evaluate(
    send,
    `document.querySelectorAll('#queue [data-featured]:checked').length`
  );
  if (covers !== 1) problems.push(`${covers} photos ticked as set cover, expected exactly 1`);

  const beforePublish = mock.log.length;
  await evaluate(send, `document.querySelector('#publish').click()`);
  await new Promise((r) => setTimeout(r, 3000));

  const calls = mock.log.slice(beforePublish);
  const writes = calls.filter((c) => c.method === "PUT").map((c) => c.url);
  const dispatch = calls.filter((c) => c.method === "POST" && c.url.endsWith("/dispatches"));

  const photoWrites = writes.filter((u) => /_inbox\/formal-suit\/IMG_000[12]\.JPG$/.test(u));
  if (photoWrites.length !== 2)
    problems.push(`expected 2 photo writes under _inbox/formal-suit/, got ${JSON.stringify(writes)}`);

  const jobIndex = writes.findIndex((u) => u.endsWith("_inbox/job.json"));
  if (jobIndex < 0) problems.push("job.json was never written — the workflow would have no manifest");
  else if (jobIndex !== writes.length - 1)
    problems.push(
      `job.json was written at position ${jobIndex + 1} of ${writes.length}, not last — ` +
        "an interrupted batch would leave a manifest describing missing photos"
    );

  if (dispatch.length !== 1)
    problems.push(`expected exactly 1 repository_dispatch, got ${dispatch.length}`);
  else {
    const d = JSON.parse(dispatch[0].body || "{}");
    if (d.event_type !== "portfolio-publish")
      problems.push(`dispatch event_type is ${JSON.stringify(d.event_type)}, not portfolio-publish`);
  }

  /* The staged photo bytes must be the SCRUBBED ones. This is the last place
     the original could leak: a wiring mistake that sent q.file instead of
     q.bytes would pass every scrub test above and still commit the GPS. */
  const photoBody = calls.find((c) => c.method === "PUT" && /IMG_0001/.test(c.url));
  if (!photoBody) {
    problems.push("no PUT body captured for the first photo");
  } else {
    const sent = JSON.parse(photoBody.body || "{}");
    if (!sent.content) problems.push("photo PUT carried no content");
    else {
      const raw = Buffer.from(sent.content, "base64");
      const hex = raw.toString("latin1");
      if (hex.includes("GPSLatitude")) problems.push("STAGED PHOTO CONTAINS GPS TEXT");
      if (raw.includes(Buffer.from([0x25, 0x88]))) problems.push("STAGED PHOTO CONTAINS THE GPS IFD POINTER");
      if (hex.includes("xmpmeta")) problems.push("STAGED PHOTO CONTAINS AN XMP PACKET");
      if (hex.includes("phone at home")) problems.push("STAGED PHOTO CONTAINS THE COM COMMENT");
      const original = Buffer.from(FIXTURES.phoneJPEG, "base64");
      if (raw.length >= original.length)
        problems.push("staged photo is not smaller than the original — the raw file may have been sent");
      if (sent.branch !== "main") problems.push(`photo staged to branch ${JSON.stringify(sent.branch)}`);
    }
  }

  /* job.json must carry the alt text through, or the whole gate was theatre. */
  const jobBody = calls.find((c) => c.method === "PUT" && c.url.endsWith("_inbox/job.json"));
  if (jobBody) {
    const sent = JSON.parse(jobBody.body || "{}");
    let job = null;
    try {
      job = JSON.parse(Buffer.from(sent.content, "base64").toString("utf8"));
    } catch {
      problems.push("job.json body is not decodable JSON");
    }
    if (job) {
      const p1 = job.photos?.["IMG_0001.JPG"];
      const p2 = job.photos?.["IMG_0002.JPG"];
      if (!p1 || !p2) problems.push(`job.json is missing photo entries: ${JSON.stringify(Object.keys(job.photos || {}))}`);
      if (p1 && !/navy three-piece/.test(p1.alt || "")) problems.push(`job.json lost the alt text: ${JSON.stringify(p1.alt)}`);
      if (p1 && p1.slug !== "formal-suit") problems.push(`job.json has slug ${JSON.stringify(p1?.slug)}`);
      if (p1 && p1.caption !== "Look 1 & 2") problems.push(`job.json lost the caption: ${JSON.stringify(p1.caption)}`);
      if (p2 && p2.featured !== true) problems.push("job.json did not mark the chosen cover as featured");
      if (p1 && p1.featured === true) problems.push("job.json marked TWO photos as featured");
      if (job.message !== "Add two suit photos") problems.push(`job.json message is ${JSON.stringify(job.message)}`);
    }
  }

  /* After a successful publish the queue is emptied and the user is told the
     site is rebuilding — not left looking at photos that are already staged
     and wondering whether to press Publish again. */
  const after = JSON.parse(
    await evaluate(
      send,
      `JSON.stringify({
        rows: document.querySelectorAll('#queue .item').length,
        msg: document.querySelector('#upload-msg')?.textContent.trim() || '',
        boxHidden: document.querySelector('#publish-box')?.hidden === true,
        btnEnabled: document.querySelector('#publish')?.disabled === false
      })`
    )
  );
  if (after.rows !== 0) problems.push(`queue still has ${after.rows} row(s) after a successful publish`);
  if (!/rebuild/i.test(after.msg)) problems.push(`no success message after publish: ${JSON.stringify(after.msg)}`);
  if (!after.boxHidden) problems.push("Publish button still shown with an empty queue");
  if (!after.btnEnabled) problems.push("Publish button left disabled after the run finished");

  await mock.stop();
  problems.push(...panelErrors(events, from));
  return problems;
}

/**
 * Escaping, category edits, and the failure path.
 *
 * The XSS case is not hypothetical here: captions and alt text are typed by a
 * person and then read back from the repo and rendered into innerHTML. A
 * caption containing a script tag would execute for the next person who opens
 * the panel — with a live write token in memory. That is the highest-value
 * thing in this file to keep true.
 */
async function checkAdminSafety(client) {
  const { send, events } = client;
  const problems = [];
  const from = events.length;

  await send("Page.navigate", { url: `${BASE}/admin/` });
  await new Promise((r) => setTimeout(r, 1200));

  /* A category title straight out of the repo, containing markup. */
  const EVIL = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>';
  const evilCatalog = {
    ...MOCK_CATALOG,
    categories: [
      { slug: "formal-suit", title: EVIL, count: 2, order: 1, published: true },
      ...MOCK_CATALOG.categories.slice(1),
    ],
  };

  const catFiles = {
    "formal-suit": { title: "Formal Suit", order: 1, published: true, photos: [] },
    casual: { title: "Casual", order: 2, published: true, photos: [] },
  };

  const mock = await mockGitHub(client, {
    "GET /repos/mode-on-satvik/portfolio": REPO_OK,
    "GET /repos/mode-on-satvik/portfolio/contents/data/index.json": contentsJSON(evilCatalog),
    "GET /repos/mode-on-satvik/portfolio/contents/data/categories/formal-suit.json":
      contentsJSON(catFiles["formal-suit"], "sha-formal"),
    "GET /repos/mode-on-satvik/portfolio/contents/data/categories/casual.json":
      contentsJSON(catFiles.casual, "sha-casual"),
    "PUT /repos/mode-on-satvik/portfolio/contents/*": PUT_OK,
    "GET /repos/mode-on-satvik/portfolio/actions/workflows/publish.yml/runs*": {
      status: 200,
      body: {
        workflow_runs: [
          { id: 1, status: "in_progress", conclusion: null, run_started_at: "2026-01-01T00:00:00Z", html_url: "https://github.com/x/y/actions/runs/1", display_title: EVIL },
          { id: 2, status: "completed", conclusion: "success", run_started_at: "2026-01-01T00:00:00Z", html_url: "https://github.com/x/y/actions/runs/2", display_title: "Add photos" },
          { id: 3, status: "completed", conclusion: "failure", run_started_at: "2026-01-01T00:00:00Z", html_url: "https://github.com/x/y/actions/runs/3", display_title: "Broken run" },
        ],
      },
    },
  });

  await signInPanel(send);

  /* --- Escaping in the upload picker and the category list --------------- */
  await evaluate(send, `document.querySelector('#tab-cats').click()`);
  await new Promise((r) => setTimeout(r, 600));

  const xss = JSON.parse(
    await evaluate(
      send,
      `JSON.stringify({
        pwned: window.__pwned ?? null,
        injectedImgs: [...document.querySelectorAll('#view-cats img')]
          .filter(i => (i.getAttribute('src') || '') === 'x').length,
        scripts: document.querySelectorAll('#view-cats script').length,
        literal: (document.querySelector('#view-cats .cat__name')?.textContent || '').includes('onerror'),
        optionLiteral: (document.querySelector('#slug option')?.textContent || '').includes('onerror'),
        rows: document.querySelectorAll('#view-cats .cat').length,
        hiddenPill: document.querySelectorAll('#view-cats .pill--off').length,
        firstUpDisabled: document.querySelector('#view-cats [data-up]')?.disabled === true
      })`
    )
  );
  if (xss.pwned !== null) problems.push(`XSS EXECUTED from a category title (window.__pwned = ${xss.pwned})`);
  if (xss.injectedImgs) problems.push(`${xss.injectedImgs} injected <img> element(s) built from a category title`);
  if (xss.scripts) problems.push(`${xss.scripts} injected <script> element(s) in the category list`);
  if (!xss.literal) problems.push("the markup-bearing title was not rendered as literal text");
  if (!xss.optionLiteral) problems.push("the category <option> did not render the title literally");
  if (xss.rows !== 3) problems.push(`category list rendered ${xss.rows} rows, expected 3`);
  if (xss.hiddenPill !== 1) problems.push(`${xss.hiddenPill} categories marked hidden, expected 1`);
  if (!xss.firstUpDisabled) problems.push("the first category's Move-up button is not disabled");

  /* --- Hide/show writes the right file with the right sha --------------- */
  const beforeToggle = mock.log.length;
  await evaluate(send, `document.querySelector('#view-cats [data-toggle]').click()`);
  await new Promise((r) => setTimeout(r, 1500));

  const toggleWrites = mock.log.slice(beforeToggle).filter((c) => c.method === "PUT");
  if (toggleWrites.length !== 1) {
    problems.push(`hiding one category made ${toggleWrites.length} writes, expected 1`);
  } else {
    const w = toggleWrites[0];
    if (!w.url.endsWith("data/categories/formal-suit.json"))
      problems.push(`hide wrote the wrong file: ${w.url}`);
    const sent = JSON.parse(w.body || "{}");
    /* No sha means the write would clobber a concurrent edit from a laptop —
       GitHub would reject it, but the panel must be sending it. */
    if (sent.sha !== "sha-formal") problems.push(`hide sent sha ${JSON.stringify(sent.sha)}, expected the one it read`);
    const cat = JSON.parse(Buffer.from(sent.content, "base64").toString("utf8"));
    if (cat.published !== false) problems.push(`hide set published to ${cat.published}, expected false`);
    if (!Array.isArray(cat.photos)) problems.push("hide dropped the photos array from the category file");
  }

  /* --- Reorder swaps `order` on exactly the two affected files ---------- */
  const beforeMove = mock.log.length;
  await evaluate(send, `document.querySelector('#view-cats [data-down]').click()`);
  await new Promise((r) => setTimeout(r, 2000));

  const moveWrites = mock.log.slice(beforeMove).filter((c) => c.method === "PUT");
  if (moveWrites.length !== 2) {
    problems.push(`a reorder made ${moveWrites.length} writes, expected 2`);
  } else {
    const orders = moveWrites.map((w) => {
      const sent = JSON.parse(w.body || "{}");
      return {
        file: w.url.split("/").pop(),
        order: JSON.parse(Buffer.from(sent.content, "base64").toString("utf8")).order,
      };
    });
    const formal = orders.find((o) => o.file === "formal-suit.json");
    const casual = orders.find((o) => o.file === "casual.json");
    if (!formal || !casual) problems.push(`reorder wrote unexpected files: ${JSON.stringify(orders)}`);
    else if (formal.order !== 2 || casual.order !== 1)
      problems.push(`reorder did not swap order values: ${JSON.stringify(orders)}`);
  }

  /* --- Activity: state is distinguishable and links are safe ------------ */
  await evaluate(send, `document.querySelector('#tab-runs').click()`);
  await new Promise((r) => setTimeout(r, 1500));

  const runs = JSON.parse(
    await evaluate(
      send,
      `JSON.stringify({
        rows: document.querySelectorAll('#view-runs .run').length,
        busy: document.querySelectorAll('#view-runs .run__dot--busy').length,
        ok: document.querySelectorAll('#view-runs .run__dot--ok').length,
        bad: document.querySelectorAll('#view-runs .run__dot--bad').length,
        allNoopener: [...document.querySelectorAll('#view-runs a[target=_blank]')]
          .every(a => (a.rel || '').includes('noopener')),
        pwned: window.__pwned ?? null,
        titleLiteral: (document.querySelector('#view-runs .run')?.textContent || '').includes('onerror'),
        failureNamed: (document.querySelector('#view-runs')?.textContent || '').includes('Failed')
      })`
    )
  );
  if (runs.rows !== 3) problems.push(`Activity rendered ${runs.rows} runs, expected 3`);
  if (runs.busy !== 1 || runs.ok !== 1 || runs.bad !== 1)
    problems.push(`run states not distinguished (busy ${runs.busy}, ok ${runs.ok}, bad ${runs.bad})`);
  if (!runs.allNoopener) problems.push("an Activity link opens a new tab without rel=noopener");
  if (runs.pwned !== null) problems.push(`XSS EXECUTED from a workflow run title (${runs.pwned})`);
  if (!runs.titleLiteral) problems.push("a markup-bearing run title was not escaped");
  if (!runs.failureNamed) problems.push("a failed run is not labelled as failed");

  await mock.stop();

  /* --- The failure path: a rejected write must not lose the queue -------- */
  const failMock = await mockGitHub(client, {
    "GET /repos/mode-on-satvik/portfolio": REPO_OK,
    "GET /repos/mode-on-satvik/portfolio/contents/data/index.json": contentsJSON(MOCK_CATALOG),
    "GET /repos/mode-on-satvik/portfolio/contents/_inbox/*": { status: 404, body: { message: "Not Found" } },
    "PUT /repos/mode-on-satvik/portfolio/contents/*": {
      status: 401,
      body: { message: "Bad credentials" },
    },
  });

  await send("Page.navigate", { url: `${BASE}/admin/` });
  await new Promise((r) => setTimeout(r, 1200));
  await signInPanel(send);

  await evaluate(
    send,
    `(async () => {
      const bytes = Uint8Array.from(atob(${JSON.stringify(FIXTURES.phoneJPEG)}), c => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], 'IMG_9999.JPG', { type: 'image/jpeg' }));
      const picker = document.querySelector('#picker');
      picker.files = dt.files;
      picker.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`
  );
  await new Promise((r) => setTimeout(r, 1200));
  await evaluate(
    send,
    `(() => {
      const a = document.querySelector('#queue [data-alt]');
      a.value = 'A description';
      a.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`
  );
  await evaluate(send, `document.querySelector('#publish').click()`);
  await new Promise((r) => setTimeout(r, 2500));

  const failed = JSON.parse(
    await evaluate(
      send,
      `JSON.stringify({
        rows: document.querySelectorAll('#queue .item').length,
        msg: document.querySelector('#upload-msg')?.textContent.trim() || '',
        btnEnabled: document.querySelector('#publish')?.disabled === false,
        barHidden: document.querySelector('#bar')?.hidden === true
      })`
    )
  );
  /* The natural fear when an upload fails is that the photos are gone. They
     are not, and the panel has to say so — otherwise the recovery is to
     re-pick every file, which on a phone means finding them again. */
  if (failed.rows !== 1) problems.push("a failed publish emptied the queue — the photos would have to be re-picked");
  if (!/Nothing was lost/i.test(failed.msg))
    problems.push(`failed publish did not reassure that nothing was lost: ${JSON.stringify(failed.msg)}`);
  if (!/sign in again|credential|token/i.test(failed.msg))
    problems.push(`failed publish did not explain the 401: ${JSON.stringify(failed.msg)}`);
  if (!failed.btnEnabled) problems.push("Publish stayed disabled after a failure — no way to retry");
  if (!failed.barHidden) problems.push("the progress bar was left on screen after a failure");

  await failMock.stop();
  problems.push(...panelErrors(events, from));
  return problems;
}

async function main() {
  /* Read the expected photo count from the data rather than hardcoding it.
     A hardcoded 6 turns every legitimate content change into a suite failure,
     which trains you to ignore red — the opposite of what a harness is for. */
  const cat = await (await fetch(`${BASE}/data/categories/formal-suit.json`)).json();
  const COUNT = cat.photos.length;
  const MID = Math.min(3, COUNT); // the tile the lightbox test clicks

  /* How many distinct spans the masonry CAN produce, given the aspect ratios
     actually present. Asserting a fixed 3 is wrong: it fails when the data
     legitimately contains repeated ratios, while still passing if the masonry
     silently collapses to a uniform grid on varied data — the real bug. */
  const RATIOS = new Set(
    cat.photos.map((p) => (p.w / p.h).toFixed(3))
  ).size;

  const client = await connect();
  const { send } = client;

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Network.enable");

  /* Bypass Chrome's HTTP cache for the whole run.
     Without this the harness can test files that are no longer on disk: the
     first run after editing a CSS or JS file reuses the cached copy, so a fix
     appears not to work (or a break appears not to have happened) exactly when
     you are least expecting to be misled. Observed for real — one run failed 7
     assertions against a stale ready.js immediately after it was fixed, then
     passed on every subsequent run. A harness that is wrong only right after an
     edit is worse than no harness. */
  await send("Network.setCacheDisabled", { cacheDisabled: true });

  let failures = 0;
  const report = (name, problems) => {
    if (problems.length) {
      failures += problems.length;
      console.log(`\n✗ ${name}`);
      for (const p of problems) console.log(`    ${p}`);
    } else {
      console.log(`✓ ${name}`);
    }
  };

  report(
    "home: loads clean",
    await checkPage(client, "/", [
      ["marquee cells rendered", `document.querySelectorAll('.marquee__cell').length`, (n) => n >= 12],
      ["ticker items rendered", `document.querySelectorAll('.ticker__item').length`, (n) => n >= 12],
      ["category blocks rendered", `document.querySelectorAll('.cat').length`, 6],
      ["hero name bound from JSON", `document.querySelector('.hero__name')?.textContent.trim()`, (s) => !!s && s !== "Loading"],
      ["hero words split for stagger", `document.querySelectorAll('.hero__word').length`, (n) => n >= 1],
      ["profile bio bound", `document.querySelector('[data-bind="bio"]')?.textContent.length`, (n) => n > 80],
      ["first category links to pretty URL", `document.querySelector('.cat__media')?.getAttribute('href')`, (s) => /work\/[a-z-]+\/$/.test(s || "")],
      ["stats bound", `document.querySelector('[data-bind="stats.height"]')?.textContent.trim()`, (s) => /cm/.test(s || "")],
      ["theme applied pre-paint", `document.documentElement.dataset.theme`, (s) => s === "dark" || s === "light"],
      ["no-js class removed", `document.documentElement.classList.contains('no-js')`, false],
      /* The card lift. Both are one declaration each and easy to lose in a
         refactor, and neither breaks anything loudly when it goes — the page
         just quietly turns flat and square again. Asserted as a resolved
         computed value, so a typo'd or undefined custom property fails here
         rather than silently computing to none / 0px. */
      [
        "category cards keep their shadow",
        `getComputedStyle(document.querySelector('.cat__media')).boxShadow`,
        (s) => !!s && s !== "none",
      ],
      [
        "category cards keep a visible corner radius",
        `parseFloat(getComputedStyle(document.querySelector('.cat__media')).borderTopLeftRadius)`,
        (n) => n >= 8,
      ],
      /* Belt and braces alongside the HTTP check: an <img> that resolved but
         decoded to nothing (naturalWidth 0) is broken however it got there. */
      ["no broken images", BROKEN_IMAGES, (list) => list.length === 0],
    ])
  );

  report(
    "home: no horizontal overflow",
    await checkOverflow(client, "/", [320, 375, 414, 768, 1024, 1440, 1920])
  );

  report(
    "gallery: loads clean",
    await checkPage(client, "/work/formal-suit/", [
      ["tiles rendered", `document.querySelectorAll('.tile').length`, COUNT],
      ["header title bound", `document.querySelector('[data-g-title]')?.textContent.trim()`, "Formal Suit"],
      ["look count rendered", `document.querySelector('[data-g-count]')?.textContent.trim()`, (s) => /looks?$/.test(s || "")],
      ["meta line rendered", `document.querySelector('[data-g-meta]')?.textContent.trim().length`, (n) => n > 10],
      /* Depth-2 asset resolution is the GitHub-Pages-subpath trap: if the
         CSS did not resolve, this computed value falls back to `static`. */
      ["css resolved at depth 2", `getComputedStyle(document.querySelector('.tile')).gridRow`, (s) => /span/.test(s || "")],
      ["spans computed from ratio", `[...document.querySelectorAll('.tile')].map(t=>t.style.getPropertyValue('--span')).every(v=>Number(v)>1)`, true],
      /* Varied aspect ratios must produce varied spans — if they are all
         equal, the masonry has silently degraded to a uniform grid. */
      ["spans vary by aspect ratio", `new Set([...document.querySelectorAll('.tile')].map(t=>t.style.getPropertyValue('--span'))).size`, (n) => n >= RATIOS],
      ["tiles are real buttons", `document.querySelectorAll('.tile__btn').length`, COUNT],
      ["next-category link present", `document.querySelector('.gnext__link')?.getAttribute('href')`, (s) => /work\/[a-z-]+\/$/.test(s || "")],
      ["no broken images", BROKEN_IMAGES, (list) => list.length === 0],
      ["no-js class removed", `document.documentElement.classList.contains('no-js')`, false],
    ])
  );

  report(
    "gallery: no horizontal overflow",
    await checkOverflow(client, "/work/formal-suit/", [320, 375, 414, 768, 1024, 1440, 1920])
  );

  report(
    "about: loads clean",
    await checkPage(client, "/about/", [
      ["stats rows rendered", `document.querySelectorAll('.stats__row').length`, (n) => n >= 6],
      ["stat values bound from JSON", `document.querySelector('.stats__v')?.textContent.trim()`, (s) => !!s && s !== "…"],
      ["experience rows rendered", `document.querySelectorAll('.exp__row').length`, (n) => n >= 1],
      ["bio bound", `document.querySelector('[data-bind="bio"]')?.textContent.length`, (n) => n > 80],
      /* Depth-1 asset resolution: if the CSS did not resolve at this depth,
         the nav would not be fixed and this computed value falls back. */
      ["css resolved at depth 1", `getComputedStyle(document.querySelector('.nav')).position`, "fixed"],
      ["comp card built for print", `document.querySelector('[data-comp]')?.children.length`, (n) => n >= 2],
      ["comp card hidden on screen", `getComputedStyle(document.querySelector('[data-comp]')).display`, "none"],
      ["print button present", `!!document.querySelector('[data-print]')`, true],
      ["no broken images", BROKEN_IMAGES, (list) => list.length === 0],
      ["no-js class removed", `document.documentElement.classList.contains('no-js')`, false],
    ])
  );

  report(
    "about: no horizontal overflow",
    await checkOverflow(client, "/about/", [320, 375, 414, 768, 1024, 1440, 1920])
  );

  report(
    "contact: loads clean",
    await checkPage(client, "/contact/", [
      ["form present", `!!document.querySelector('[data-form]')`, true],
      ["required fields marked", `document.querySelectorAll('.form [required]').length`, (n) => n >= 3],
      ["every input has a label", `[...document.querySelectorAll('.form input, .form textarea')].every(el => !!document.querySelector('label[for="'+el.id+'"]'))`, true],
      ["email link bound from JSON", `document.querySelector('.contact__email')?.getAttribute('href')`, (s) => /^mailto:.+@.+/.test(s || "")],
      ["status region is live", `document.querySelector('[data-form-status]')?.getAttribute('aria-live')`, "polite"],
      ["css resolved at depth 1", `getComputedStyle(document.querySelector('.nav')).position`, "fixed"],
      ["no broken images", BROKEN_IMAGES, (list) => list.length === 0],
      ["no-js class removed", `document.documentElement.classList.contains('no-js')`, false],
    ])
  );

  report(
    "contact: no horizontal overflow",
    await checkOverflow(client, "/contact/", [320, 375, 414, 768, 1024, 1440, 1920])
  );

  report("contact: form validation", await checkContactForm(client));

  /* Only the root-depth case is exercised here: a local static server answers
     an unknown path with its OWN 404 body, so there is no way to make it serve
     our 404.html from a subdirectory. The depth-repair branch is therefore
     asserted directly against the function's logic below rather than in situ. */
  report(
    "404: loads clean at root depth",
    await checkPage(client, "/404.html", [
      ["error code shown", `document.querySelector('.notfound__code')?.textContent.trim()`, "404"],
      ["noindex set", `document.querySelector('meta[name=robots]')?.content`, (s) => /noindex/.test(s || "")],
      ["css resolved", `getComputedStyle(document.querySelector('.notfound__code')).fontSize`, (s) => parseFloat(s) > 40],
      /* At depth 0 the repair must leave hrefs untouched — a spurious "../"
         here would send every 404 visitor above the site root. */
      ["root-depth links unprefixed", `[...document.querySelectorAll('[data-root-link]')].every(a => !a.getAttribute('href').startsWith('../'))`, true],
      ["escape routes present", `document.querySelectorAll('[data-root-link]').length`, (n) => n >= 3],
      ["no broken images", BROKEN_IMAGES, (list) => list.length === 0],
    ])
  );

  report("404: depth repair", await check404Depth(client));

  report("nav: no dead links", await checkLinks(client, ["/", "/about/", "/contact/", "/work/formal-suit/", "/404.html"]));

  report("lightbox: interaction", await checkLightbox(client, COUNT, MID));

  report("lightbox: photo fits and centres", await checkLightboxFit(client));

  /* --- Admin panel -------------------------------------------------------
     Grouped here, after the public site, because these suites intercept
     api.github.com and it is worth having the public checks already reported
     if an intercept goes wrong. Each suite tears its own intercept down. */

  report("admin: gate and token custody", await checkAdminGate(client));

  report("admin: metadata stripped before upload", await checkAdminScrub(client));

  report("admin: publish path", await checkAdminPublish(client));

  report("admin: escaping, category edits, failure path", await checkAdminSafety(client));

  /* The panel is used one-handed on a phone, so 320px matters more here than
     anywhere else on the site. Only the gate can be checked this way — the
     signed-in screens need an intercept, which checkOverflow does not set up. */
  report(
    "admin: no horizontal overflow (gate)",
    await checkOverflow(client, "/admin/", [320, 375, 414, 768, 1024, 1440])
  );

  /* Last, because it deliberately toggles the HTTP cache: a warm cache is the
     condition under which the reveal race actually shows up. */
  report("reveal: content present before fade-in", await checkRevealOrdering(client));

  client.close();

  console.log(
    failures
      ? `\n${failures} problem(s) found.\n`
      : "\nAll checks passed.\n"
  );
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error("harness error:", err.message);
  process.exit(2);
});
