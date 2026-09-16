# NV Drama Short Public v2.0.0

Nuvio/Stremio-protocol addon that no longer depends on DramaExpress.

## Sources

The addon exposes exactly the requested 17 catalogs:

DramaBox, FlareFlow, FlickReels, GoodShort, JoyReels, KalosTV, MoboReels, MoreShort, MyDramaWave, NetShort, PetaDrama, Reelshort, Shortical, ShortTV, ShortWave, Stardust, StoryReel.

FlexTV is intentionally excluded.

## Public-source architecture

- DramaExpress is completely removed from the runtime code, manifest, logo, IDs, catalog discovery, metadata, and stream resolver.
- For providers with documented public REST endpoints, the addon uses DramaBos public API routes for search, detail, episodes, and HLS playback.
- For providers without a documented public endpoint in the integration, the addon falls back to EveryDrama public pages and attempts to discover catalog entries and openly exposed media URLs.
- No DRM bypass, authentication bypass, or paid-access bypass is implemented.

## Deployment

Node 20+, `npm install`, `npm start`, health check `/health`, manifest `/manifest.json`.

The addon is designed for automatic runtime refresh and does not store a fixed movie database.
