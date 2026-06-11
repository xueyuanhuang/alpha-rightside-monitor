import { access, readFile } from "node:fs/promises";

const required = [
  "public/index.html",
  "public/styles.css",
  "public/app.js",
  "public/manifest.webmanifest",
  "public/service-worker.js",
  "functions/api/signals.js",
  "functions/api/refresh.js",
  "supabase/schema.sql"
];

for (const file of required) {
  await access(file);
}

const manifest = JSON.parse(await readFile("public/manifest.webmanifest", "utf8"));
if (!manifest.name || !manifest.start_url || !manifest.icons?.length) {
  throw new Error("manifest.webmanifest is missing required PWA fields");
}

const html = await readFile("public/index.html", "utf8");
for (const needle of ["manifest.webmanifest", "viewport"]) {
  if (!html.includes(needle)) {
    throw new Error(`index.html missing ${needle}`);
  }
}

const app = await readFile("public/app.js", "utf8");
if (!app.includes("service-worker.js")) {
  throw new Error("app.js missing service worker registration");
}

console.log("Build check passed");
