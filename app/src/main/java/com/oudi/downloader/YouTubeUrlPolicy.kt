package com.oudi.downloader

import java.net.URI
import java.util.Locale

internal fun isYouTubeUrl(rawUrl: String): Boolean {
    val uri = runCatching { URI(rawUrl.trim()) }.getOrNull() ?: return false
    val scheme = uri.scheme?.lowercase(Locale.ROOT)
    if (scheme != "http" && scheme != "https") return false

    val host = uri.host?.lowercase(Locale.ROOT)?.trimEnd('.') ?: return false
    return host == "youtube.com" || host.endsWith(".youtube.com") ||
        host == "youtu.be" || host.endsWith(".youtu.be") ||
        host == "youtube-nocookie.com" || host.endsWith(".youtube-nocookie.com")
}

internal fun isAllowedDownloadTarget(rawUrl: String): Boolean {
    val uri = runCatching { URI(rawUrl.trim()) }.getOrNull() ?: return false
    val scheme = uri.scheme?.lowercase(Locale.ROOT)
    if (scheme != "http" && scheme != "https") return false
    return !isYouTubeUrl(rawUrl)
}
