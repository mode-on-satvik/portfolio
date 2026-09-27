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
     and every assertion then runs against the OLD page. Matching the
     pathname too pins us to the new document. */
  const expectedPath = new URL(`${BASE}${path}`).pathname;
  const deadline = Date.now() + 12000;
  let ready = false;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    ready = await evaluate(
      send,
      `location.pathname === ${JSON.stringify(expectedPath)} &&
       document.body?.classList.contains('is-ready') === true`
    ).catch(() => false);
    if (ready) break;
  }

  const problems = [];
  if (!ready) problems.push("page never reached .is-ready state");

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
 * Drive the lightbox the way a user does — real CDP key events, not
 * synthetic JS dispatch, so `preventDefault` and focus behaviour are
 * exercised for real.
 */
async function checkLightbox(client) {
  const { send } = client;
  const problems = [];

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

  // Open via a genuine click on the third tile.
  await evaluate(send, `document.querySelectorAll('.tile__btn')[2].click()`);
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
  if (o.count !== "3 / 6") problems.push(`counter: got "${o.count}", expected "3 / 6"`);
  if (o.hash !== "#p=3") problems.push(`deep-link hash: got "${o.hash}", expected "#p=3"`);
  if (o.modal !== "true") problems.push("missing aria-modal=true");
  if (!o.focusInside) problems.push("focus was not moved into the dialog");
  if (!o.bodyLocked) problems.push("page scroll was not locked behind the overlay");

  await key("ArrowRight", "ArrowRight", 39);
  const next = await evaluate(send, `document.querySelector('[data-lb-count]').textContent.trim()`);
  if (next !== "4 / 6") problems.push(`ArrowRight: got "${next}", expected "4 / 6"`);

  await key("ArrowLeft", "ArrowLeft", 37);
  const prev = await evaluate(send, `document.querySelector('[data-lb-count]').textContent.trim()`);
  if (prev !== "3 / 6") problems.push(`ArrowLeft: got "${prev}", expected "3 / 6"`);

  await key("End", "End", 35);
  const end = await evaluate(
    send,
    `JSON.stringify({
      count: document.querySelector('[data-lb-count]').textContent.trim(),
      nextDisabled: document.querySelector('[data-lb-next]').disabled
    })`
  );
  const e = JSON.parse(end);
  if (e.count !== "6 / 6") problems.push(`End key: got "${e.count}", expected "6 / 6"`);
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
  await send("Page.navigate", { url: `${BASE}/work/formal-suit/#p=5` });
  await new Promise((r) => setTimeout(r, 2400));
  const deep = await evaluate(
    send,
    `JSON.stringify({
      open: document.querySelector('.lb')?.classList.contains('is-open') ?? false,
      count: document.querySelector('[data-lb-count]')?.textContent.trim()
    })`
  );
  const d = JSON.parse(deep);
  if (!d.open) problems.push("#p=5 did not open the lightbox on load");
  else if (d.count !== "5 / 6") problems.push(`#p=5 landed on "${d.count}", expected "5 / 6"`);

  await send("Emulation.clearDeviceMetricsOverride");
  return problems;
}

async function main() {
  const client = await connect();
  const { send } = client;

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Network.enable");

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
      ["tiles rendered", `document.querySelectorAll('.tile').length`, 6],
      ["header title bound", `document.querySelector('[data-g-title]')?.textContent.trim()`, "Formal Suit"],
      ["look count rendered", `document.querySelector('[data-g-count]')?.textContent.trim()`, (s) => /looks?$/.test(s || "")],
      ["meta line rendered", `document.querySelector('[data-g-meta]')?.textContent.trim().length`, (n) => n > 10],
      /* Depth-2 asset resolution is the GitHub-Pages-subpath trap: if the
         CSS did not resolve, this computed value falls back to `static`. */
      ["css resolved at depth 2", `getComputedStyle(document.querySelector('.tile')).gridRow`, (s) => /span/.test(s || "")],
      ["spans computed from ratio", `[...document.querySelectorAll('.tile')].map(t=>t.style.getPropertyValue('--span')).every(v=>Number(v)>1)`, true],
      /* Varied aspect ratios must produce varied spans — if they are all
         equal, the masonry has silently degraded to a uniform grid. */
      ["spans vary by aspect ratio", `new Set([...document.querySelectorAll('.tile')].map(t=>t.style.getPropertyValue('--span'))).size`, (n) => n >= 3],
      ["tiles are real buttons", `document.querySelectorAll('.tile__btn').length`, 6],
      ["next-category link present", `document.querySelector('.gnext__link')?.getAttribute('href')`, (s) => /work\/[a-z-]+\/$/.test(s || "")],
      ["no broken images", BROKEN_IMAGES, (list) => list.length === 0],
      ["no-js class removed", `document.documentElement.classList.contains('no-js')`, false],
    ])
  );

  report(
    "gallery: no horizontal overflow",
    await checkOverflow(client, "/work/formal-suit/", [320, 375, 414, 768, 1024, 1440, 1920])
  );

  report("lightbox: interaction", await checkLightbox(client));

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
