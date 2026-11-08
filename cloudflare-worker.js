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
    let response;
    try {
      response = await fetch(current.toString(), {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "user-agent": "Mozilla/5.0 (compatible; OUDI-Downloader/1.0)",
          "accept": "text/html,application/xhtml+xml"
        }
      });
    } finally {
      clearTimeout(timeout);
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location || hop === 5) throw new Error("تعذر تتبع تحويل رابط Facebook");
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) throw new Error(`Facebook ردّ بالحالة ${response.status}`);
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
  }
  throw new Error("تعذر الوصول إلى صفحة Facebook");
}

function decodeHtml(value) {
  return value.replace(/&amp;/g, "&").replace(/&#38;/g, "&")
    .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'");
}

function findOgVideo(html) {
  const metas = html.match(/<meta\\b[^>]*>/gi) || [];
  const values = {};
  for (const tag of metas) {
    const property = tag.match(/(?:property|name)\\s*=\\s*["']([^"']+)["']/i)?.[1]?.toLowerCase();
    const content = tag.match(/content\\s*=\\s*["']([^"']+)["']/i)?.[1];
    if (property && content && ["og:video", "og:video:url", "og:video:secure_url"].includes(property)) {
      values[property] = decodeHtml(content);
    }
  }
  return values["og:video:secure_url"] || values["og:video:url"] || values["og:video"] || null;
}

async function inspectFacebookPage(pageUrl) {
  const html = await fetchFacebookPage(pageUrl);
  const candidate = findOgVideo(html);
  if (!candidate) {
    throw new Error("لم يعرض Facebook رابط فيديو مباشرًا عامًا. قد يحتاج الرابط إلى تسجيل دخول أو لا يتيح Facebook تنزيله.");
  }
  let media;
  try { media = new URL(candidate, pageUrl); } catch { throw new Error("رابط الفيديو الذي أعاده Facebook غير صالح"); }
  if (media.protocol !== "https:" || !isFacebookMediaHost(media.hostname)) {
    throw new Error("رابط الفيديو الناتج ليس من نطاق تنزيل Facebook المسموح");
  }
  return {
    ok: true,
    source: "facebook-public-og",
    contentType: "video/*",
    fileName: "facebook-video.mp4",
    formats: [{ id: "facebook-original", label: "فيديو Facebook المتاح", mimeType: "video/*", size: null, url: media.toString() }]
  };
}

async function inspect(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 9000);
  try {
    const response = await fetch(url.toString(), {
      method: "HEAD",
      redirect: "manual",
      signal: controller.signal,
      headers: { "user-agent": "OUDI-Downloader/1.0" }
    });
    if (response.status >= 300 && response.status < 400) {
      return { ok: false, error: "الرابط يحوّل إلى عنوان آخر؛ استخدم رابط الملف النهائي المباشر" };
    }
    if (!response.ok) return { ok: false, error: `المصدر ردّ بالحالة ${response.status}` };
    const type = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const length = Number(response.headers.get("content-length") || 0);
    const disposition = response.headers.get("content-disposition") || "";
    const isMedia = type.startsWith("video/") || type.startsWith("audio/") ||
      type === "application/octet-stream" || type === "application/vnd.apple.mpegurl" ||
      type === "application/x-mpegurl";
    if (!isMedia) return { ok: false, error: "الرابط لا يشير إلى ملف وسائط مباشر", contentType: type || "unknown" };
    return {
      ok: true,
      source: "direct",
      contentType: type,
      size: Number.isFinite(length) && length > 0 ? length : null,
      fileName: disposition.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i)?.[1]?.replace(/"/g, "") || null,
      formats: [{ id: "original", label: "الصيغة الأصلية", mimeType: type, size: length || null, url: url.toString() }]
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
