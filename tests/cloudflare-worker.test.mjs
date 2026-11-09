import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const workerSource = await readFile(resolve(here, "../cloudflare-worker.js"), "utf8");
const { default: worker } = await import(
  `data:text/javascript;base64,${Buffer.from(workerSource, "utf8").toString("base64")}`
);

function inspectRequest(mediaUrl) {
  const url = new URL("https://oudi-test.invalid/api/inspect");
  url.searchParams.set("url", mediaUrl);
  return new Request(url);
}

test("falls back to a one-byte GET range when a direct host rejects HEAD", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (_url, options = {}) => {
    const headers = new Headers(options.headers);
    calls.push({ method: options.method, range: headers.get("range") });
    if (options.method === "HEAD") return new Response(null, { status: 405 });
    return new Response("x", {
      status: 206,
      headers: {
        "content-type": "video/mp4",
        "content-range": "bytes 0-0/123456",
        "content-length": "1",
        "content-disposition": 'attachment; filename="sample.mp4"'
      }
    });
  };

  try {
    const response = await worker.fetch(inspectRequest("https://cdn.example/sample.mp4"));
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.deepEqual(calls, [
      { method: "HEAD", range: null },
      { method: "GET", range: "bytes=0-0" }
    ]);
    assert.equal(body.size, 123456);
    assert.equal(body.fileName, "sample.mp4");
    assert.equal(body.formats[0].size, 123456);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("keeps HEAD metadata when the host supports HEAD", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (_url, options = {}) => {
    calls.push(options.method);
    return new Response(null, {
      status: 200,
      headers: {
        "content-type": "video/webm",
        "content-length": "9876"
      }
    });
  };

  try {
    const response = await worker.fetch(inspectRequest("https://cdn.example/sample.webm"));
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.deepEqual(calls, ["HEAD"]);
    assert.equal(body.size, 9876);
    assert.equal(body.formats[0].mimeType, "video/webm");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
