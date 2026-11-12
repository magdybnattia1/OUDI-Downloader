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


test("prefers and decodes RFC 5987 UTF-8 filenames", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, {
    status: 200,
    headers: {
      "content-type": "video/mp4",
      "content-disposition": "attachment; filename=\"fallback.mp4\"; filename*=UTF-8''%D8%A7%D8%AE%D8%AA%D8%A8%D8%A7%D8%B1%20video.mp4"
    }
  });

  try {
    const response = await worker.fetch(inspectRequest("https://cdn.example/sample.mp4"));
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.fileName, "اختبار video.mp4");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("falls back to the quoted filename when the extended filename is malformed", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, {
    status: 200,
    headers: {
      "content-type": "video/mp4",
      "content-disposition": "attachment; filename=\"safe\\\"clip.mp4\"; filename*=UTF-8''bad%ZZ"
    }
  });

  try {
    const response = await worker.fetch(inspectRequest("https://cdn.example/sample.mp4"));
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.fileName, "safe\"clip.mp4");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("follows safe public redirects and returns the final media URL", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method });
    if (calls.length === 1) {
      return new Response(null, {
        status: 302,
        headers: { location: "/assets/final.mp4" }
      });
    }
    return new Response(null, {
      status: 200,
      headers: {
        "content-type": "video/mp4",
        "content-length": "4096"
      }
    });
  };

  try {
    const response = await worker.fetch(inspectRequest("https://share.example/clip"));
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.deepEqual(calls, [
      { url: "https://share.example/clip", method: "HEAD" },
      { url: "https://share.example/assets/final.mp4", method: "HEAD" }
    ]);
    assert.equal(body.formats[0].url, "https://share.example/assets/final.mp4");
    assert.equal(body.size, 4096);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects redirects to localhost before making a second request", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method });
    return new Response(null, {
      status: 302,
      headers: { location: "https://localhost/private.mp4" }
    });
  };

  try {
    const response = await worker.fetch(inspectRequest("https://share.example/clip"));
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.match(body.error, /المضيف غير مسموح/);
    assert.deepEqual(calls, [
      { url: "https://share.example/clip", method: "HEAD" }
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects HTTPS redirects that downgrade to HTTP", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method });
    return new Response(null, {
      status: 301,
      headers: { location: "http://cdn.example/video.mp4" }
    });
  };

  try {
    const response = await worker.fetch(inspectRequest("https://share.example/clip"));
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.match(body.error, /تحويل غير آمن/);
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("keeps the Facebook request timeout active while reading the page body", async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let timeoutCallback;
  let timerCleared = false;
  const timerId = 12345;

  globalThis.setTimeout = (callback, delay) => {
    assert.equal(delay, 9000);
    timeoutCallback = callback;
    return timerId;
  };
  globalThis.clearTimeout = id => {
    assert.equal(id, timerId);
    timerCleared = true;
  };
  globalThis.fetch = async (_url, options = {}) => {
    const body = new ReadableStream({
      pull(controller) {
        assert.equal(timerCleared, false, "timeout must remain active during body reads");
        options.signal.addEventListener("abort", () => {
          controller.error(new DOMException("The operation was aborted.", "AbortError"));
        }, { once: true });
        timeoutCallback();
      }
    }, { highWaterMark: 0 });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" }
    });
  };

  try {
    const response = await worker.fetch(inspectRequest("https://www.facebook.com/share/r/test"));
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.equal(body.error, "انتهت مهلة الاتصال بالمصدر");
    assert.equal(timerCleared, true);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});
