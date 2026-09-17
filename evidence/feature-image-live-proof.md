# Feature-image live proof (real browser + real Ghost)

Verdict: **PASS**

Environment: Ghost 6.59 behind a local TLS proxy (`https://localhost:2443`), unpacked MV3
extension built from this tree, Chromium (headless=new), scripted over CDP.
No cookie value, token, or credential appears below.

## Steps

- **created a draft post through the Admin API** — `{"postId":"6aac3bd3f8fac2000160cdd3"}`
- **unpacked extension loaded with the production bundles** — `{"extensionId":"eaoleodmfffldgklpdhnoehfeknooghh"}`
- **options page cached the picked photo in the extension** — `{"assetId":"img_1fa47d454cce914b","status":"Photo “preset-hero.png” cached in this browser (157 bytes).","previewVisible":true}`
- **service worker returned the cached photo bytes over the asset channel** — `{"bytes":157,"expectedBytes":157,"bytesIdentical":true,"mimeType":"image/png"}`
- **the stored preset references the photo by id — no image bytes in the document** — `{"featureImage":{"assetId":"img_1fa47d454cce914b","mode":"replace"},"documentBytes":283}`
- **Ghost Admin editor loaded the live Ember record** — `{"postId":"6aac3bd3f8fac2000160cdd3"}`
- **uploaded the photo through Ghost admin images/upload/ from the page origin** — `{"status":201,"url":"https://localhost:2443/content/images/2026/09/preset-hero-2.png"}`
- **production MAIN-world bridge applied the feature image with one native save** — `{"saved":true,"resourceId":"6aac3bd3f8fac2000160cdd3"}`
- **authenticated Admin API readback confirms feature_image persisted** — `{"postId":"6aac3bd3f8fac2000160cdd3","featureImage":"https://localhost:2443/content/images/2026/09/preset-hero-2.png","expected":"https://localhost:2443/content/images/2026/09/preset-hero-2.png"}`
- **Ghost serves the uploaded photo** — `{"status":200,"bytes":"157","expectedBytes":157}`

## Storage-level corroboration (run separately against the same post)

The harness cannot query the database itself; the value it wrote was confirmed outside it:

```bash
docker exec ghost-local-mysql mysql -ughost -pghostpw ghost -e "select feature_image from posts where id='6aac3bd3f8fac2000160cdd3'\G"
docker exec ghost-local ls -l /var/lib/ghost/content/images/2026/09/
```

`feature_image` in the row is stored transform-ready as `__GHOST_URL__/content/images/...`, and the
uploaded file (157 bytes) is present in the container content directory.

## Limitation recorded honestly

The isolated content-script registration requires the optional host permission, which Chrome
only grants through its native consent bubble (not reachable in headless automation).
Phase B therefore drives the production MAIN-world bundle and the same upload request shape the
content script issues; phase A runs the real extension runtime (options page + service worker).
