const MAX_URL_LENGTH = 4096;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-allow-headers": "content-type"
    }
  });
}

function validateMediaUrl(raw) {
  if (!raw || raw.length > MAX_URL_LENGTH) throw new Error("رابط غير صالح أو أطول من المسموح");
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("يسمح بروابط HTTP وHTTPS فقط");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") ||
      host.endsWith(".local") || host.endsWith(".internal") ||
      /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) {
    throw new Error("هذا المضيف غير مسموح");
  }
  if (/(^|\.)youtube\.com$|(^|\.)youtu\.be$|(^|\.)youtube-nocookie\.com$/.test(host)) {
    throw new Error("روابط YouTube لا توفر واجهة تنزيل خارجية معتمدة؛ استخدم خيارات YouTube الرسمية");
  }
  url.hash = "";
  return url;
}


const FACEBOOK_PAGE_HOSTS = ["facebook.com", "fb.watch"];
const FACEBOOK_MEDIA_SUFFIX = ".fbcdn.net";

function isFacebookPageHost(host) {
  const h = host.toLowerCase();
  return FACEBOOK_PAGE_HOSTS.some(d => h === d || h.endsWith("." + d));
}

function isFacebookMediaHost(host) {
  const h = host.toLowerCase();
  return h.endsWith(FACEBOOK_MEDIA_SUFFIX) || h === "fbcdn.net";
}

async function fetchFacebookPage(startUrl) {
  let current = new URL(startUrl);
  for (let hop = 0; hop <= 5; hop++) {
    if (current.protocol !== "https:" || !isFacebookPageHost(current.hostname)) {
      throw new Error("رابط Facebook حوّل إلى نطاق غير مسموح");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 9000);
    try {
      const response = await fetch(current.toString(), {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "user-agent": "Mozilla/5.0 (compatible; OUDI-Downloader/1.0)",
          "accept": "text/html,application/xhtml+xml"
        }
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location || hop === 5) throw new Error("تعذر تتبع تحويل رابط Facebook");
        current = new URL(location, current);
        continue;
      }
      if (!response.ok) throw new Error("Facebook ردّ بالحالة " + response.status);
      const type = (response.headers.get("content-type") || "").toLowerCase();
      if (!type.includes("text/html")) throw new Error("Facebook لم يُرجع صفحة فيديو عامة");
      const reader = response.body?.getReader();
      if (!reader) throw new Error("تعذر قراءة صفحة Facebook");
      const chunks = [];
      let total = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > 1500000) {
            await reader.cancel();
            throw new Error("صفحة Facebook أكبر من الحد المسموح للفحص");
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return new TextDecoder().decode(bytes);
    } finally {
      // Keep the timeout active while the response body is being streamed.
      clearTimeout(timeout);
    }
  }
  throw new Error("تعذر الوصول إلى صفحة Facebook");
}

function decodeHtml(value) {
  return value.replace(/&amp;/g, "&").replace(/&#38;/g, "&")
    .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'");
}

function extractFacebookVideoCandidates(html, pageUrl) {
  const candidates = new Map();
  const add = (raw, label) => {
    if (!raw) return;
    const decoded = decodeHtml(raw).replace(/\\\//g, "/").replace(/\\u0026/gi, "&");
    let media;
    try { media = new URL(decoded, pageUrl); } catch { return; }
    if (media.protocol !== "https:" || !isFacebookMediaHost(media.hostname)) return;
    const key = media.toString();
    if (!candidates.has(key)) candidates.set(key, { url: key, label });
  };

  const metas = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of metas) {
    const property = tag.match(/(?:property|name)\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase();
    const content = tag.match(/content\s*=\s*["']([^"']+)["']/i)?.[1];
    if (property && content && ["og:video", "og:video:url", "og:video:secure_url"].includes(property)) {
      add(content, "فيديو Facebook المتاح");
    }
  }

  // Public page HTML may expose separate SD/HD CDN URLs in embedded JSON.
  const fields = [
    ["browser_native_hd_url", "HD"],
    ["playable_url_quality_hd", "HD"],
    ["playable_url", "الجودة المتاحة"]
  ];
  for (const [field, label] of fields) {
    const pattern = new RegExp('"' + field + '"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"', "g");
    let match;
    while ((match = pattern.exec(html)) !== null) {
      try { add(JSON.parse('"' + match[1] + '"'), label); } catch { /* Ignore malformed embedded values. */ }
    }
  }
  return [...candidates.values()];
}

async function inspectFacebookPage(pageUrl) {
  const html = await fetchFacebookPage(pageUrl);
  const candidates = extractFacebookVideoCandidates(html, pageUrl);
  if (candidates.length === 0) {
    throw new Error("لم يعرض Facebook روابط فيديو مباشرة عامة. قد يحتاج الرابط إلى تسجيل دخول أو لا يتيح Facebook تنزيله.");
  }
  return {
    ok: true,
    source: "facebook-public-page",
    contentType: "video/*",
    fileName: "facebook-video.mp4",
    formats: candidates.map((candidate, index) => ({
      id: "facebook-" + (index + 1),
      label: candidate.label,
      mimeType: "video/mp4",
      size: null,
      url: candidate.url
    }))
  };
}

async function fetchFollowingSafeRedirects(startUrl, options, maxRedirects = 5) {
  let current = validateMediaUrl(startUrl.toString());

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const response = await fetch(current.toString(), {
      ...options,
      redirect: "manual"
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return { response, finalUrl: current };
    }

    const location = response.headers.get("location");
    if (!location) {
      try { await response.body?.cancel(); } catch { /* Ignore a closed redirect body. */ }
      throw new Error("المصدر أعاد تحويلًا بدون عنوان وجهة");
    }
    if (hop === maxRedirects) {
      try { await response.body?.cancel(); } catch { /* Ignore a closed redirect body. */ }
      throw new Error("الرابط يحتوي على تحويلات أكثر من الحد المسموح");
    }

    const next = new URL(location, current);
    if (current.protocol === "https:" && next.protocol !== "https:") {
      try { await response.body?.cancel(); } catch { /* Ignore a closed redirect body. */ }
      throw new Error("تم رفض تحويل غير آمن من HTTPS إلى HTTP");
    }
    const safeNext = validateMediaUrl(next.toString());
    try { await response.body?.cancel(); } catch { /* Ignore a closed redirect body. */ }
    current = safeNext;
  }

  throw new Error("تعذر تتبع تحويل الرابط");
}

function getContentDispositionFileName(disposition) {
  const extendedMatch = disposition.match(/(?:^|;)\s*filename\*\s*=\s*(?:"((?:\\.|[^"])*)"|([^;]*))/i);
  const extendedValue = (extendedMatch?.[1] ?? extendedMatch?.[2] ?? "")
    .replace(/\\(.)/g, "$1").trim();
  const encoded = extendedValue.match(/^([^']*)'[^']*'(.*)$/);
  if (encoded && encoded[1].toLowerCase() === "utf-8") {
    try {
      const decoded = decodeURIComponent(encoded[2]);
      if (decoded.trim()) return decoded;
    } catch {
      // Fall back to the legacy filename parameter if the extended value is malformed.
    }
  }

  const plainMatch = disposition.match(/(?:^|;)\s*filename\s*=\s*(?:"((?:\\.|[^"])*)"|([^;]*))/i);
  const plainValue = plainMatch?.[1] !== undefined
    ? plainMatch[1].replace(/\\(.)/g, "$1")
    : plainMatch?.[2]?.trim();
  return plainValue || null;
}

async function inspect(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 9000);
  try {
    let { response, finalUrl } = await fetchFollowingSafeRedirects(url, {
      method: "HEAD",
      signal: controller.signal,
      headers: { "user-agent": "OUDI-Downloader/1.0" }
    });
    let usedRangeProbe = false;

    // Some legitimate file hosts reject HEAD even though a normal download works.
    // Retry only when the method itself is unsupported, using a one-byte range.
    if (response.status === 405 || response.status === 501) {
      try { await response.body?.cancel(); } catch { /* Ignore an already closed response body. */ }
      usedRangeProbe = true;
      const probe = await fetchFollowingSafeRedirects(url, {
        method: "GET",
        signal: controller.signal,
        headers: {
          "user-agent": "OUDI-Downloader/1.0",
          "accept": "*/*",
          "range": "bytes=0-0"
        }
      });
      response = probe.response;
      finalUrl = probe.finalUrl;
    }

    if (usedRangeProbe) {
      // Do not download the media file during inspection if the host ignores Range.
      try { await response.body?.cancel(); } catch { /* Headers are enough for inspection. */ }
    }
    if (!response.ok) return { ok: false, error: "المصدر ردّ بالحالة " + response.status };
    const type = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const contentRange = response.headers.get("content-range") || "";
    const rangeTotal = contentRange.match(/\/(\d+)\s*$/)?.[1];
    const rawLength = Number(response.headers.get("content-length") || 0);
    const length = Number(rangeTotal || rawLength || 0);
    const size = rangeTotal
      ? (Number.isFinite(length) && length > 0 ? length : null)
      : (response.status === 206 ? null : (Number.isFinite(length) && length > 0 ? length : null));
    const disposition = response.headers.get("content-disposition") || "";
    const isHlsPlaylist = [
      "application/vnd.apple.mpegurl",
      "application/x-mpegurl",
      "application/mpegurl",
      "audio/mpegurl",
      "audio/x-mpegurl"
    ].includes(type);
    if (isHlsPlaylist) {
      return {
        ok: false,
        error: "الرابط يشير إلى قائمة تشغيل HLS وليس ملف فيديو مباشرًا؛ حفظ القائمة وحدها لا ينزّل الفيديو.",
        contentType: type
      };
    }
    const fileName = getContentDispositionFileName(disposition);
    const mediaFileExtension = /\.(?:3gp|aac|avi|flac|m4a|m4v|mkv|mov|mp3|mp4|mpeg|mpg|oga|ogg|opus|ts|wav|webm|wmv)$/i;
    let decodedPath = finalUrl.pathname;
    try { decodedPath = decodeURIComponent(decodedPath); } catch { /* Keep the encoded path for extension checks. */ }
    const hasKnownMediaExtension = mediaFileExtension.test(decodedPath) ||
      (typeof fileName === "string" && mediaFileExtension.test(fileName.trim()));
    const isMedia = type.startsWith("video/") || type.startsWith("audio/") ||
      (type === "application/octet-stream" && hasKnownMediaExtension);
    if (!isMedia) {
      const error = type === "application/octet-stream"
        ? "المصدر أعلن نوع ملف عام ولم يقدّم امتدادًا معروفًا لملف صوت أو فيديو؛ تم رفضه لتجنب تنزيل ملف غير وسائطي."
        : "الرابط لا يشير إلى ملف وسائط مباشر";
      return { ok: false, error, contentType: type || "unknown" };
    }
    return {
      ok: true,
      source: "direct",
      contentType: type,
      size,
    fileName,
      formats: [{ id: "original", label: "الصيغة الأصلية", mimeType: type, size, url: finalUrl.toString() }]
    };
  } finally {
    clearTimeout(timeout);
  }
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, OPTIONS",
        "access-control-allow-headers": "content-type"
      }
    });
    const requestUrl = new URL(request.url);
    if (request.method === "GET" && requestUrl.pathname === "/health") {
      return json({ ok: true, service: "OUDI Downloader API" });
    }
    if (request.method !== "GET" || requestUrl.pathname !== "/api/inspect") {
      return json({ ok: false, error: "Not found" }, 404);
    }
    try {
      const rawUrl = requestUrl.searchParams.get("url");
      if (rawUrl && rawUrl.length <= MAX_URL_LENGTH) {
        const parsed = new URL(rawUrl);
        if (["http:", "https:"].includes(parsed.protocol) && isFacebookPageHost(parsed.hostname)) {
          const result = await inspectFacebookPage(parsed);
          return json(result, 200);
        }
      }
      const mediaUrl = validateMediaUrl(rawUrl);
      const result = await inspect(mediaUrl);
      return json(result, result.ok ? 200 : 422);
    } catch (error) {
      return json({
        ok: false,
        error: error.name === "AbortError" ? "انتهت مهلة الاتصال بالمصدر" : (error.message || "تعذر فحص الرابط")
      }, 400);
    }
  }
};
