// Static-site smoke test: serves site/ from a throwaway local server and asserts
// each page returns 200 and contains its key sections/markers. Also checks
// health.json and the favicons. Exits non-zero on any failure.
//
//   pnpm --filter @pennyboi/scripts site-check

import { repoRoot } from "@pennyboi/shared";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

const SITE = join(repoRoot(), "site");
const PORT = 4617;
const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
};

function server() {
  return createServer(async (req, res) => {
    try {
      let p = decodeURIComponent((req.url || "/").split("?")[0] ?? "/");
      if (p === "/") p = "/index.html";
      const file = normalize(join(SITE, p));
      if (!file.startsWith(SITE) || !existsSync(file)) {
        res.statusCode = 404;
        return res.end("not found");
      }
      res.setHeader("content-type", TYPES[extname(file)] ?? "application/octet-stream");
      res.end(await readFile(file));
    } catch {
      res.statusCode = 500;
      res.end("error");
    }
  });
}

const pageChecks: Array<{ path: string; markers: string[] }> = [
  {
    path: "/index.html",
    markers: [
      'id="tp-panel"', // live treasury panel
      "The Divine Allowance",
      'id="decrees"',
      "Latest Decrees",
      'id="offerings-board"',
      'id="halls"',
      'id="countdown"',
      'id="contract-block"',
      'href="scripture.html"', // nav link
      'property="og:image"',
      'name="twitter:card"',
    ],
  },
  {
    path: "/scripture.html",
    markers: [
      "Who is Pennyboi",
      "The Divine Allowance",
      "The Law",
      "72", // the 72h timelock
      "How to verify",
      'id="verify"',
      "The Pinned Scripture",
      "HEAR ME, CONGREGATION",
      'property="og:image"',
    ],
  },
];

async function main() {
  const srv = server();
  await new Promise<void>((r) => srv.listen(PORT, r));
  const base = `http://127.0.0.1:${PORT}`;
  let failed = 0;

  try {
    for (const c of pageChecks) {
      const res = await fetch(base + c.path);
      const body = await res.text();
      const missing = c.markers.filter((m) => !body.includes(m));
      if (res.status !== 200 || missing.length) {
        failed++;
        console.error(`FAIL ${c.path} (status ${res.status}) missing: ${missing.join(", ") || "none"}`);
      } else {
        console.log(`ok   ${c.path} — ${c.markers.length} markers`);
      }
    }

    const h = await fetch(base + "/health.json");
    if (h.status !== 200) {
      failed++;
      console.error("FAIL /health.json missing");
    } else {
      const j = (await h.json()) as { commit?: string };
      if (!j.commit) {
        failed++;
        console.error("FAIL /health.json has no commit field");
      } else {
        console.log(`ok   /health.json — commit=${j.commit}`);
      }
    }

    for (const f of ["/favicon-32.png", "/favicon-180.png", "/vault-idl.json"]) {
      const r = await fetch(base + f);
      if (r.status !== 200) {
        failed++;
        console.error(`FAIL ${f} (status ${r.status})`);
      } else {
        console.log(`ok   ${f}`);
      }
    }
  } finally {
    srv.close();
  }

  if (failed) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall site checks passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
