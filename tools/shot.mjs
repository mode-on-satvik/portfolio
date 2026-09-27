/* ==========================================================================
   shot.mjs — screenshot a page at one or more widths over CDP

     node tools/shot.mjs /            1440 900  out-name
     node tools/shot.mjs /work/x/     390  844  mobile
   ========================================================================== */

const BASE = process.env.BASE || "http://localhost:8080";
const CDP = "http://localhost:9222";

const [path = "/", width = "1440", height = "900", name = "shot"] =
  process.argv.slice(2);

const targets = await (await fetch(`${CDP}/json/list`)).json();
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);

let id = 1;
const pending = new Map();

await new Promise((res) => (ws.onopen = res));
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) {
    pending.get(d.id)(d.result);
    pending.delete(d.id);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve) => {
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id: id++, method, params }));
  });

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: Number(width),
  height: Number(height),
  deviceScaleFactor: 1,
  mobile: Number(width) < 768,
});
/* Navigate via about:blank first. Going straight from /work/x/#p=5 to
   /work/x/ is a same-document fragment change, not a load — the previous
   page's state (an open lightbox, say) would survive into the screenshot. */
await send("Page.navigate", { url: "about:blank" });
await new Promise((r) => setTimeout(r, 300));
await send("Page.navigate", { url: BASE + path });

// Wait for the app to actually finish rendering, not a fixed guess. Falls
// through after the deadline so a broken page still yields a screenshot.
const want = new URL(BASE + path).pathname;
const deadline = Date.now() + 10000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 200));
  const { result } = await send("Runtime.evaluate", {
    expression: `location.pathname === ${JSON.stringify(want)} &&
      document.body?.classList.contains('is-ready') === true`,
    returnByValue: true,
  });
  if (result.value) break;
}

// Then let fonts land and entrance animations settle.
await new Promise((r) => setTimeout(r, 1200));

const { data } = await send("Page.captureScreenshot", { format: "png" });
const { writeFile, mkdir } = await import("node:fs/promises");
const os = await import("node:os");
const nodePath = await import("node:path");

// os.tmpdir(), not a hardcoded "/tmp" — on Windows Node resolves that to
// C:\tmp, which does not exist.
const dir = nodePath.join(os.tmpdir(), "pf-shots");
await mkdir(dir, { recursive: true });
const out = nodePath.join(dir, `${name}-${width}.png`);
await writeFile(out, Buffer.from(data, "base64"));
console.log(out);
ws.close();
