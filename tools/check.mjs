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
