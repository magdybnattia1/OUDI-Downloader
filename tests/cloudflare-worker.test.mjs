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

test("probes the actual un-ranged GET and cancels its body after receiving headers", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  let bodyCancelled = false;

  globalThis.fetch = async (_url, options = {}) => {
    const headers = new Headers(options.headers);
    calls.push({ method: options.method, range: headers.get("range") });
    return new Response(new ReadableStream({
      cancel() { bodyCancelled = true; }
    }), {
      status: 200,
      headers: {
        "content-type": "video/mp4",
        "content-length": "123456",
        "content-disposition": 'attachment; filename="sample.mp4"'
      }
    });
  };

  try {
    const response = await worker.fetch(inspectRequest("https://cdn.example/sample.mp4"));
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.deepEqual(calls, [{ method: "GET", range: null }]);
    assert.equal(bodyCancelled, true);
    assert.equal(body.size, 123456);
    assert.equal(body.fileName, "sample.mp4");
    assert.equal(body.formats[0].size, 123456);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not depend on HEAD support when the direct GET is allowed", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (_url, options = {}) => {
    calls.push(options.method);
    return new Response(null, {
      status: 200,
      headers: { "content-type": "video/mp4", "content-length": "54321" }
    });
  };

  try {
    const response = await worker.fetch(inspectRequest("https://cdn.example/head-blocked.mp4"));
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.deepEqual(calls, ["GET"]);
    assert.equal(body.size, 54321);
    assert.equal(body.formats[0].mimeType, "video/mp4");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects an actual GET failure instead of trusting metadata-only checks", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (_url, options = {}) => {
    calls.push(options.method);
    return new Response(null, { status: 403 });
  };

  try {
    const response = await worker.fetch(inspectRequest("https://cdn.example/restricted.mp4"));
    const body = await response.json();
    assert.equal(response.status, 422);
    assert.equal(body.ok, false);
    assert.match(body.error, /403/);
    assert.deepEqual(calls, ["GET"]);
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

test("follows safe public redirects using the actual GET method", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url, options = {}) => {
    const currentUrl = String(url);
    calls.push({ url: currentUrl, method: options.method });
    if (currentUrl === "https://share.example/clip") {
      return new Response(null, { status: 302, headers: { location: "/assets/final.mp4" } });
    }
    return new Response(null, {
      status: 200,
      headers: { "content-type": "video/mp4", "content-length": "4096" }
    });
  };

  try {
    const response = await worker.fetch(inspectRequest("https://share.example/clip"));
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.deepEqual(calls, [
      { url: "https://share.example/clip", method: "GET" },
      { url: "https://share.example/assets/final.mp4", method: "GET" }
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
    return new Response(null, { status: 302, headers: { location: "https://localhost/private.mp4" } });
  };

  try {
    const response = await worker.fetch(inspectRequest("https://share.example/clip"));
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.match(body.error, /المضيف غير مسموح/);
    assert.deepEqual(calls, [{ url: "https://share.example/clip", method: "GET" }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects HTTPS redirects that downgrade to HTTP", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method });
    return new Response(null, { status: 301, headers: { location: "http://cdn.example/video.mp4" } });
  };

  try {
    const response = await worker.fetch(inspectRequest("https://share.example/clip"));
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.match(body.error, /تحويل غير آمن/);
    assert.deepEqual(calls, [{ url: "https://share.example/clip", method: "GET" }]);
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

for (const contentType of [
  "application/vnd.apple.mpegurl",
  "application/x-mpegurl",
  "application/mpegurl",
  "audio/mpegurl",
  "audio/x-mpegurl"
]) {
  test(`does not report an HLS playlist as a downloadable video file (${contentType})`, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, options = {}) => {
      assert.equal(options.method, "GET");
      return new Response(null, {
        status: 200,
        headers: { "content-type": contentType, "content-length": "256" }
      });
    };

    try {
      const response = await worker.fetch(inspectRequest("https://cdn.example/stream"));
      const body = await response.json();
      assert.equal(response.status, 422);
      assert.equal(body.ok, false);
      assert.match(body.error, /قائمة تشغيل HLS/);
      assert.equal(body.contentType, contentType);
      assert.equal(body.formats, undefined);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}


test("rejects generic binary responses without a known audio or video filename", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, {
    status: 200,
    headers: {
      "content-type": "application/octet-stream",
      "content-length": "2048"
    }
  });

  try {
    const response = await worker.fetch(inspectRequest("https://cdn.example/download?id=42"));
    const body = await response.json();
    assert.equal(response.status, 422);
    assert.equal(body.ok, false);
    assert.match(body.error, /نوع ملف عام/);
    assert.equal(body.formats, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("accepts a generic binary response when the URL has a known media extension", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, {
    status: 200,
    headers: {
      "content-type": "application/octet-stream",
      "content-length": "8192"
    }
  });

  try {
    const response = await worker.fetch(inspectRequest("https://cdn.example/video.mp4"));
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.formats[0].mimeType, "application/octet-stream");
    assert.equal(body.formats[0].url, "https://cdn.example/video.mp4");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("accepts a generic binary response when Content-Disposition names a media file", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, {
    status: 200,
    headers: {
      "content-type": "application/octet-stream",
      "content-disposition": 'attachment; filename="audio.mp3"',
      "content-length": "4096"
    }
  });

  try {
    const response = await worker.fetch(inspectRequest("https://cdn.example/download?id=audio"));
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.fileName, "audio.mp3");
    assert.equal(body.formats[0].mimeType, "application/octet-stream");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
