# NV Drama Short

Nuvio/Stremio-protocol addon that indexes DramaExpress public category/source pages and resolves publicly exposed media URLs from DramaExpress episode pages.

## Deployment

Deploy this repository as a Node web service. Build: `npm install`. Start: `npm start`. Health check: `/health`. Manifest: `/manifest.json`.

The addon does not host video and does not bypass DRM, authentication, paid access controls, or other access restrictions. It only follows publicly exposed pages/embeds and media URLs available from DramaExpress.


## Catalog coverage and auto-update

The addon does not store a fixed movie list. It reads DramaExpress catalog pages at runtime, follows pagination (up to 500 pages per catalog), deduplicates titles, and exposes results to Nuvio in pages of 100 items. Catalog heads are refreshed automatically about every 30 minutes, while individual HTML pages are cached briefly to reduce upstream load. New titles added to DramaExpress therefore become available automatically without rebuilding the ZIP.

The addon includes the 17 requested source catalogs plus the current DramaExpress genre catalogs. It does not guarantee that a title remains available upstream, and it does not bypass DRM, authentication, or paid access controls.
