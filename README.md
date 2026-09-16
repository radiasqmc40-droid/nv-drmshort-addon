# NV Drama Short Addon 1.8.5

Nuvio addon for DramaExpress. This release tightens upstream resolution so debug/stream requests cannot spend 20+ seconds probing irrelevant URLs.

## Endpoints
- `/manifest.json`
- `/health`
- `/debug-upstream?url=https://dramaexpress.net/series/upgrade/episode-1`
- `/stream-debug/series/dex:upgrade:ep:1.json`

## Changes from 1.8.4
- 7s hard resolver deadline.
- 3s normal upstream fetch timeout.
- 2s media probe timeout.
- Filters irrelevant/social/navigation URLs from candidate extraction.
- Stops fabricating `/source/...` API candidates from ordinary page links.
- Adds `/debug-upstream` single-fetch connectivity test.
- Debug route returns JSON on timeout instead of allowing the gateway request to hang.
- Keeps HLS/media proxy and portrait video hint from previous releases.
