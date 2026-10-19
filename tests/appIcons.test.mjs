import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);

async function assertPng(path, size) {
  assert.match(path, /^icons\/[a-z0-9-]+\.png$/);
  const data = await readFile(new URL(path, root));
  assert.deepEqual([...data.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(data.toString("ascii", 12, 16), "IHDR");
  assert.equal(data.readUInt32BE(16), size);
  assert.equal(data.readUInt32BE(20), size);
}

test("PWA icons are correctly sized PNG assets available in the offline shell", async () => {
  const manifest = JSON.parse(await readFile(new URL("manifest.webmanifest", root), "utf8"));
  const worker = await readFile(new URL("sw.js", root), "utf8");
  for (const size of [192, 512]) {
    const icon = manifest.icons.find((entry) => entry.sizes === `${size}x${size}`);
    assert.ok(icon);
    assert.equal(icon.type, "image/png");
    assert.equal(icon.purpose, "any");
    await assertPng(icon.src, size);
    assert.ok(worker.includes(`"${icon.src}"`));
  }
});

test("Safari touch icon, favicon and header use the new image with stable dimensions", async () => {
  const index = await readFile(new URL("index.html", root), "utf8");
  const worker = await readFile(new URL("sw.js", root), "utf8");
  for (const [rel, size] of [["apple-touch-icon", 180], ["icon", 32]]) {
    const link = index.match(new RegExp(`<link rel="${rel}"[^>]*>`))?.[0];
    assert.ok(link);
    assert.ok(link.includes(`sizes="${size}x${size}"`));
    const path = link.match(/href="([^"]+)"/)[1];
    await assertPng(path, size);
    assert.ok(worker.includes(`"${path}"`));
  }
  assert.match(index, /<img class="brand-mark" src="icons\/clownfish-192\.png" width="40" height="40" alt=""/);
  assert.ok(!index.includes("icons/icon-192.svg"));
});
