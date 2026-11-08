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
      const mediaUrl = validateMediaUrl(requestUrl.searchParams.get("url"));
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
