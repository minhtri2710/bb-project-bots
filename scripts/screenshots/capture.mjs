// Regenerates docs/screenshots/*.png from synthetic fixtures.
//   bb plugin build && node scripts/screenshots/capture.mjs
// Env: BB_HOST_CSS=<bb app index-*.css> (auto-detected under ~/bb/app),
//      CHROME=<chromium binary> (default /usr/bin/chromium).
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const out = join(repo, "docs/screenshots");

function findHostCss() {
  if (process.env.BB_HOST_CSS) return process.env.BB_HOST_CSS;
  const pnpm = join(homedir(), "bb/app/node_modules/.pnpm");
  for (const dir of existsSync(pnpm) ? readdirSync(pnpm).filter((d) => d.startsWith("bb-app@")).sort().reverse() : []) {
    const assets = join(pnpm, dir, "node_modules/bb-app/app/dist/assets");
    const css = existsSync(assets) && readdirSync(assets).find((f) => /^index-.*\.css$/.test(f));
    if (css) return join(assets, css);
  }
  throw new Error("Set BB_HOST_CSS to BB's app index-*.css for theme variables");
}
const hostCss = findHostCss();

const server = await createServer({
  root: here,
  configFile: false,
  logLevel: "warn",
  server: { port: 5199, strictPort: true, fs: { allow: [repo] } },
  plugins: [{
    name: "screenshot-assets",
    configureServer(s) {
      s.middlewares.use((req, res, next) => {
        const file = req.url === "/@bb-host.css" ? hostCss : req.url === "/dist/app.css" ? join(repo, "dist/app.css") : null;
        if (!file) return next();
        res.setHeader("content-type", "text/css");
        res.end(readFileSync(file));
      });
    },
  }],
  resolve: { alias: [{ find: /^@\//, replacement: `${repo}/` }] },
  esbuild: { jsx: "automatic" },
});
await server.listen();

const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/usr/bin/chromium" });
const page = await browser.newPage({ deviceScaleFactor: 2, viewport: { width: 1000, height: 900 } });
page.on("pageerror", (e) => console.error("pageerror:", e.message));

const scenes = [
  { name: "sidebar", selector: "#shot" },
  { name: "inline", selector: "#shot", prepare: (p) => p.locator("[data-question=\"0\"] button").first().click() },
  { name: "inbox", selector: "#shot" },
  { name: "special", selector: '[role="dialog"]' },
];
for (const { name, selector, prepare } of scenes) {
  await page.goto(`http://localhost:5199/?scene=${name}`);
  await page.waitForSelector("body[data-ready]", { state: "attached" });
  await page.waitForTimeout(800);
  if (prepare) {
    await prepare(page);
    await page.waitForTimeout(400);
  }
  await page.mouse.move(0, 0);
  await page.locator(selector).first().screenshot({ path: join(out, `${name}.png`), animations: "disabled" });
  console.log("wrote", `docs/screenshots/${name}.png`);
}
await browser.close();
await server.close();
