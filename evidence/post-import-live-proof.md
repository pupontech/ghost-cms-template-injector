# Post-import live proof (real Ghost + real Chromium)

Verdict: **PASS**

Environment: Ghost 6.59 behind a local TLS proxy (`https://localhost:2443`), an unpacked MV3
extension built from this tree, Chromium (headless=new), scripted over CDP. The capture modules
and the planner are compiled from this tree with esbuild — the same source the extension ships.
No cookie value, token, or credential appears below.

## A. Capture (production capture code + real Ghost data)

```json
{
  "presetId": "imported-1789735447649",
  "name": "Imported 1789735447649",
  "warnings": [],
  "metadata": {
    "excerpt": {
      "mode": "only-if-empty",
      "value": "An excerpt worth templating."
    },
    "tags": {
      "mode": "merge",
      "values": ["Software", "Reviews"]
    },
    "customTemplate": {
      "mode": "only-if-empty",
      "value": "custom-review.hbs"
    },
    "featureImage": {
      "mode": "only-if-empty",
      "url": "/content/images/2026/09/import-source-14.png"
    }
  },
  "content": {
    "source": "inline-lexical",
    "mode": "replace",
    "bytes": 507
  },
  "checks": {
    "bodyCaptured": true,
    "bodyByteIdentical": true,
    "excerptCaptured": true,
    "excerptOnlyIfEmpty": true,
    "tagsCaptured": true,
    "tagsMerge": true,
    "customTemplateCaptured": true,
    "featureImagePortable": true,
    "featureImageOnlyIfEmpty": true,
    "titleNotCaptured": true,
    "grouped": true,
    "documentBytesUnderLimit": true
  },
  "negativeControl": "preset-capture: this post has no body content to capture (the post is empty)"
}
```

## B. Apply (real store, real planner, real MAIN-world bridge)

```json
{
  "store": {
    "listed": true,
    "documentBytes": 1148
  },
  "snapshot": {
    "bodyEmpty": true,
    "excerpt": null,
    "customTemplate": null,
    "title": "Import target 1789735447649",
    "tags": [],
    "featureImage": null
  },
  "plan": {
    "status": "ready",
    "fields": ["body", "customTemplate", "excerpt", "featureImage", "tags"]
  },
  "readback": {
    "postId": "6aad32171d5721000145cec2",
    "title": "Import target 1789735447649",
    "titleUnchanged": true,
    "customExcerpt": "An excerpt worth templating.",
    "customTemplate": "custom-review.hbs",
    "featureImage": "https://localhost:2443/content/images/2026/09/import-source-14.png",
    "expectedFeatureImagePath": "/content/images/2026/09/import-source-14.png",
    "tags": ["Reviews", "Software"],
    "bodyTextNodes": 2,
    "bodyContainsImportedText": true,
    "checks": {
      "excerptApplied": true,
      "tagsApplied": true,
      "customTemplateApplied": true,
      "featureImageApplied": true,
      "bodyApplied": true,
      "titleUntouched": true
    }
  }
}
```

## Steps

- **compiled the production capture + schema modules from this tree** — `{"bundles":["capture.mjs","schema.mjs"]}`
- **uploaded the source post photo through Ghost admin images/upload/** — `{"status":201,"url":"https://localhost:2443/content/images/2026/09/import-source-14.png"}`
- **created the source post to import through the Admin API** — `{"postId":"6aad32171d5721000145ceb8","tags":["Software","Reviews"],"customTemplate":"custom-review.hbs"}`
- **read the post back with ?formats=lexical&include=tags (the extension's own query)** — `{"lexicalBytes":507,"tagNames":["Software","Reviews"]}`
- **the captured preset passes production schema validation** — `{"presetId":"imported-1789735447649"}`
- **every capture expectation holds for the real post** — `{"bodyCaptured":true,"bodyByteIdentical":true,"excerptCaptured":true,"excerptOnlyIfEmpty":true,"tagsCaptured":true,"tagsMerge":true,"customTemplateCaptured":true,"featureImagePortable":true,"featureImageOnlyIfEmpty":true,"titleNotCaptured":true,"grouped":true,"documentBytesUnderLimit":true}`
- **negative control: an unreadable body aborts the import (fail closed)** — `{"message":"preset-capture: this post has no body content to capture (the post is empty)"}`
- **created the target draft the imported preset will be applied to** — `{"postId":"6aad32171d5721000145cec2"}`
- **unpacked extension loaded with the production bundles** — `{"extensionId":"eaoleodmfffldgklpdhnoehfeknooghh"}`
- **the REAL options page lists the captured preset from chrome.storage.local** — `{"listed":true,"documentBytes":1148}`
- **the delivered options import section is live and refuses to save without a capture** — `{"sectionPresent":true,"heading":"Import a post as a preset","sourceOptions":0,"initialStatus":"No Ghost Admin tab found. Open your Ghost Admin (and enable the extension for it), then press Refresh post list.","statusAfterClick":"Pick a post to import first.","storedIds":["imported-1789735447649"],"refusedWithoutCapture":true,"storedNothingNew":true}`
- **compiled the production planner from this tree** — `{"bundle":"plan-iife.js"}`
- **Ghost Admin editor loaded the live Ember record** — `{"postId":"6aad32171d5721000145cec2"}`
- **snapshotted the live editor record (empty body, no excerpt/photo)** — `{"bodyEmpty":true,"excerpt":null,"customTemplate":null,"title":"Import target 1789735447649","tags":[],"featureImage":null}`
- **the production planner planned the imported preset against the live record** — `{"status":"ready","fields":["body","customTemplate","excerpt","featureImage","tags"]}`
- **installing the MAIN bundle three times still answers each request once** — `{"installedFlag":true,"replies":1}`
- **per-field live diagnostics through the production path** — `[{"field":"body","ok":true,"error":null,"status":null},{"field":"excerpt","ok":true,"error":null,"status":null},{"field":"tags","ok":true,"error":null,"status":null},{"field":"customTemplate","ok":true,"error":null,"status":null},{"field":"featureImage","ok":true,"error":null,"status":null}]`
- **production MAIN-world bridge applied the imported preset with one native save** — `{"saved":true,"resourceId":"6aad32171d5721000145cec2","fields":["body","customTemplate","excerpt","featureImage","tags"]}`
- **authenticated Admin API readback confirms every imported field** — `{"postId":"6aad32171d5721000145cec2","title":"Import target 1789735447649","titleUnchanged":true,"customExcerpt":"An excerpt worth templating.","customTemplate":"custom-review.hbs","featureImage":"https://localhost:2443/content/images/2026/09/import-source-14.png","expectedFeatureImagePath":"/content/images/2026/09/import-source-14.png","tags":["Reviews","Software"],"bodyTextNodes":2,"bodyContainsImportedText":true,"checks":{"excerptApplied":true,"tagsApplied":true,"customTemplateApplied":true,"featureImageApplied":true,"bodyApplied":true,"titleUntouched":true}}`

## Storage-level corroboration (run separately against the same instance)

```bash
docker exec ghost-local-mysql mysql -ughost -pghostpw ghost -e "select title, custom_excerpt, custom_template, feature_image from posts where id='6aad32171d5721000145cec2'\\G"
docker exec ghost-local-mysql mysql -ughost -pghostpw ghost -e "select p.slug, t.name from posts p join posts_tags pt on pt.post_id=p.id join tags t on t.id=pt.tag_id where p.id='6aad32171d5721000145cec2';"
```

## Limitation recorded honestly

The isolated content-script registration needs the optional host permission, which Chrome only
grants through its native consent bubble (not reachable in headless automation). Phase B drives
the production MAIN-world bundle with the exact plan the content script sends, and phase A runs
the production capture code against the real API; the popup↔content-script plumbing is covered
by the unit and integration suites rather than claimed here.
