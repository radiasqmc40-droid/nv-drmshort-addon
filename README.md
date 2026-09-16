# NV Drama Short Public 2.0.2

- DramaExpress is completely removed.
- Uses Node 20 native `http` and `fetch`; no runtime npm dependencies.
- Exposes the requested 17 source names.
- Public playback API is verified in this build for 11 sources:
  DramaBox, FlareFlow, FlickReels, GoodShort, JoyReels, KalosTV,
  MoboReels, NetShort, Reelshort, ShortWave, Stardust.
- MoreShort, MyDramaWave, PetaDrama, Shortical, ShortTV, StoryReel remain
  listed but their public playback endpoints were not verified.

## Abasthan
Build: `npm install && npm run build`
Start: `npm start`

The server listens on `0.0.0.0` and uses `process.env.PORT`.
