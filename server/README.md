# OUDI Downloader API

Small Node.js service for inspecting **direct media-file URLs** that the source permits users to download.

## Run locally

```bash
cd server
npm start
```

Health check: `GET /health`

Inspect a direct URL: `GET /api/inspect?url=https%3A%2F%2Fexample.com%2Fvideo.mp4`

The API rejects YouTube watch-page URLs. It does not extract protected streams, bypass DRM, or claim to provide YouTube downloads. It also rejects redirects and non-media HTML pages so a webpage is not mistaken for a video file.

## Deploy on Render

Use the repository's `render.yaml` blueprint. After deployment, copy the service's HTTPS URL and configure the Android app to use it. A deployed service URL and Android integration are still required before the app can call this API.

## Important

This starter API only inspects direct media URLs. It is not a media transcoder or a YouTube downloader. Do not expose arbitrary URL-fetching endpoints publicly without additional network-level SSRF protections, authentication, rate limits, and abuse monitoring.
