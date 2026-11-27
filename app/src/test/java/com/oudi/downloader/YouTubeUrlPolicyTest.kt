package com.oudi.downloader

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class YouTubeUrlPolicyTest {
    @Test
    fun recognizesYouTubeDomainsAndSubdomains() {
        listOf(
            "https://youtube.com/watch?v=abc",
            "https://www.youtube.com/watch?v=abc",
            "https://m.youtube.com/watch?v=abc",
            "https://youtu.be/abc",
            "https://www.youtu.be/abc",
            "https://youtu.be./abc",
            "https://youtube.com./watch?v=abc",
            "https://youtube-nocookie.com/embed/abc",
            "https://www.youtube-nocookie.com/embed/abc"
        ).forEach { assertTrue("Expected YouTube URL: $it", isYouTubeUrl(it)) }
    }

    @Test
    fun rejectsLookalikeDomainsAndNonWebSchemes() {
        listOf(
            "https://youtube.com.evil.example/video.mp4",
            "https://youtu.be.evil.example/abc",
            "https://notyoutube.com/video.mp4",
            "https://example.com/youtube.com/video.mp4",
            "ftp://youtube.com/video.mp4",
            "youtube.com/watch?v=abc",
            "",
            "https://"
        ).forEach { assertFalse("Must not classify as YouTube: $it", isYouTubeUrl(it)) }
    }
}
