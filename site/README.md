# Static site

The public landing site for the Whitechain x402 Facilitator. Plain HTML and CSS, no framework, no JavaScript on the page, no web fonts.

| File | Purpose |
| --- | --- |
| `index.html` | Landing page: value proposition, quickstart, networks, API summary, policy, FAQ (with FAQPage JSON-LD). |
| `docs.html` | Developer documentation: merchant and agent integration, HTTP API reference, limits, self-hosting, mainnet. |
| `landing.html` | Compact, fully self-contained page the facilitator itself serves at `GET /` (`LANDING_FILE`). No external assets, so it works behind a strict CSP. |
| `404.html` | Not-found page (Vercel serves it automatically). |
| `styles.css` | Shared stylesheet, light and dark via `prefers-color-scheme`. |
| `og.svg`, `og.png` | Social preview, 1200x630. Edit the SVG and re-render the PNG (see below). |
| `favicon.svg`, `favicon.ico`, `favicon-32.png`, `apple-touch-icon.png`, `icon-512.png`, `site.webmanifest` | Icons. |
| `robots.txt`, `sitemap.xml` | Crawling. |
| `build.mjs` | Zero-dependency build: copies everything to `dist/` and substitutes build-time variables. |
| `vercel.json` | Vercel project settings (build command, output directory, security headers, caching). |

## Build

```sh
cd site
SITE_URL=https://whitechain-x402-facilitator.vercel.app \
FACILITATOR_URL=https://x402.example.com \
GOOGLE_SITE_VERIFICATION=your-token \
node build.mjs
# -> site/dist/
```

Variables (all optional):

| Variable | Effect |
| --- | --- |
| `SITE_URL` | Canonical origin. Replaces the default `https://whitechain-x402-facilitator.vercel.app` in canonical, Open Graph, JSON-LD, sitemap and robots. |
| `FACILITATOR_URL` | Public facilitator origin. Replaces the `https://x402-facilitator-production-ff5f.up.railway.app` placeholder. The build warns if the placeholder is still present. |
| `GOOGLE_SITE_VERIFICATION` | Google Search Console token. Turns the `<!-- google-site-verification -->` marker in each page into the meta tag; the marker is removed when unset. |
| `BING_SITE_VERIFICATION` | Same for Bing (`msvalidate.01`). |
| `BUILD_DATE` | `YYYY-MM-DD` for `sitemap.xml` `<lastmod>`; defaults to today. |

The source files are valid and servable as they are, so any static host can serve `site/` directly; the build only fills in the variables above.

## Deploy on Vercel

Project settings: root directory `site`, framework "Other", build command `node build.mjs`, output directory `dist`, install command none. Set the variables above as project environment variables. `vercel.json` already carries these settings, so `vercel deploy --prod` from inside `site/` works without touching the dashboard.

## Re-render the Open Graph image and icons

The PNGs were rendered from the SVGs with headless Chrome. To re-render after editing `og.svg` or `favicon.svg`:

```sh
cd site
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"   # or google-chrome / chromium
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --window-size=1200,630 --screenshot=og.png og.svg
```

With `rsvg-convert` installed: `rsvg-convert -w 1200 -h 630 og.svg -o og.png` and `rsvg-convert -w 512 -h 512 favicon.svg -o icon-512.png`; downscale the icon to 180 and 32 px (`sips -z 180 180 icon-512.png --out apple-touch-icon.png` on macOS) and convert the 32 px PNG to `favicon.ico`.
