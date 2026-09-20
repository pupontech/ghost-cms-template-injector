# Popup ↔ settings UI parity (real browser)

Verdict: **PASS**

Extension loaded from: `/root/Downloads/ghost-cms-template-injector-v0.5.3.zip`, Chromium (headless=new), scripted over CDP.
Both pages were probed in the same browser session; the values below are what the
browser computes, not what the stylesheets claim.

## Popup

```json
{
  "tokens": {
    "bg": "#f5f5f7",
    "surface": "#ffffff",
    "surface2": "#fbfbfd",
    "text2": "#6e6e73",
    "line": "rgba(0, 0, 0, 0.08)",
    "accent": "#0a84ff",
    "danger": "#ff3b30",
    "radius": "10px"
  },
  "bodyBackground": "rgb(245, 245, 247)",
  "fontFamily": "ui-sans-serif",
  "headingTransform": "uppercase",
  "headingColor": "rgb(110, 110, 115)",
  "cardBackground": "rgb(255, 255, 255)",
  "cardRadius": "10px",
  "primaryBackground": "rgb(10, 132, 255)",
  "primaryColor": "rgb(255, 255, 255)",
  "secondaryBackground": "rgba(0, 0, 0, 0)",
  "darkModeSupported": false
}
```

## Options page (reference)

```json
{
  "tokens": {
    "bg": "#f5f5f7",
    "surface": "#ffffff",
    "surface2": "#fbfbfd",
    "text2": "#6e6e73",
    "line": "rgba(0, 0, 0, 0.08)",
    "accent": "#0a84ff",
    "danger": "#ff3b30",
    "radius": "10px"
  },
  "bodyBackground": "rgb(245, 245, 247)",
  "fontFamily": "ui-sans-serif",
  "headingTransform": "uppercase",
  "headingColor": "rgb(110, 110, 115)",
  "cardBackground": "rgb(255, 255, 255)",
  "cardRadius": "10px",
  "primaryBackground": "rgb(10, 132, 255)",
  "primaryColor": "rgb(255, 255, 255)",
  "secondaryBackground": "rgba(0, 0, 0, 0)",
  "darkModeSupported": false
}
```

## Checks

- ✅ `sameTokens`
- ✅ `sameBodyBackground`
- ✅ `settingsBackgroundApplied`
- ✅ `sameFontStack`
- ✅ `sameHeadingTreatment`
- ✅ `sameCardRadius`
- ✅ `samePrimaryColor`
- ✅ `secondaryIsHairline`
- ✅ `accentIsSystemBlue`
- ✅ `cardIsSurface`
