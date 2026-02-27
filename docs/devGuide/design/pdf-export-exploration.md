# PDF Export for MarkBind: Exploration & Design

## Current State

MarkBind has **zero** PDF export functionality today. The only print-related features are:
- `@media print` CSS rules for code blocks (word wrapping, line numbers)
- `<page-nav-print>` component that clones the page nav into print containers on `beforeprint`
- Navbar hidden in print (`d-print-none`)
- Collapsed panel bodies hidden in print (`d-print-none` on `.card-body` when `!localExpanded`)
- Tabs show all tab content in print (`printable-tabs` class) while hiding the tab nav (`d-print-none`)
- `no-page-break` prop on panels/tabs (maps to `page-break-inside: avoid`)

Users currently rely on the browser's native "Print to PDF" feature.

---

## Architecture: Where PDF Export Fits

### Why Not a Plugin?

MarkBind plugins operate **during** page generation (at the NodeProcessor stage). PDF export needs the **final rendered HTML output**. Plugins also lack direct filesystem I/O capabilities and operate per-page rather than at the site level.

### Recommended: New CLI Command

PDF export should be a new CLI command (`markbind pdf`), following the pattern of `build`, `serve`, and `deploy`. It operates **after** site generation, converting the already-rendered HTML files in `_site/` to PDF.

```
markbind pdf [root] [output]
  --baseUrl [baseUrl]    Override base URL
  --pages [glob]         Only export matching pages (default: all)
  --single               Merge all pages into a single PDF
  --toc                  Generate a table of contents page
  -s, --site-config      Custom site.json path
```

---

## Tool Choice: Puppeteer vs Playwright

| Aspect              | Puppeteer               | Playwright                  |
|---------------------|-------------------------|-----------------------------|
| PDF Support         | Excellent (Chromium)    | Chromium only (not FF/WK)   |
| CSS Support         | Full modern CSS         | Full modern CSS             |
| Node.js Native      | Yes                     | Yes                         |
| Bundle Size         | ~170MB (downloads Chrome)| ~250MB (downloads browsers)|
| Maturity for PDF    | Industry standard       | Growing, but PDF is Chromium-only anyway |
| API for PDF         | `page.pdf(options)`     | `page.pdf(options)`         |

**Recommendation: Puppeteer** — simpler API, smaller footprint, and since PDF generation only works with Chromium in both libraries anyway, Playwright's multi-browser advantage is moot.

Both could be made an **optional dependency** to avoid bloating the default install. The `markbind pdf` command would check for its presence and prompt installation if missing.

---

## High-Level Implementation Plan

### 1. New Package or Extension to CLI

```
packages/cli/src/cmd/pdf.ts    # CLI command handler
packages/core/src/Site/pdf/    # PDF generation logic
  PdfGenerator.ts              # Orchestrates PDF generation
  PdfPageRenderer.ts           # Renders individual pages to PDF
  pdfStyles.css                # PDF-specific override styles
```

### 2. Generation Flow

```
1. Ensure site is built (run generate() if _site/ doesn't exist)
2. Launch headless Chromium via Puppeteer
3. For each HTML page in _site/:
   a. Navigate to file:// URL (or spin up local server)
   b. Inject PDF-preparation JavaScript (expand panels, wait for retrievers)
   c. Wait for all content to load
   d. Apply PDF-specific CSS overrides
   e. Call page.pdf() with configured options
4. Optionally merge PDFs into a single file (pdf-lib)
5. Output to _pdf/ directory
```

### 3. Serving Content for PDF Rendering

Puppeteer can load pages via `file://` protocol, but this breaks relative asset paths and fetch-based content loading (Retriever component). Two approaches:

**Option A: Local HTTP Server** (recommended)
- Spin up a temporary static file server on a random port pointing at `_site/`
- Navigate Puppeteer to `http://localhost:{port}/page.html`
- Retriever `fetch()` calls work naturally
- Shut down server when done

**Option B: File protocol with workarounds**
- Load via `file:///path/to/_site/page.html`
- Requires `--allow-file-access-from-files` Chromium flag
- Retriever fetch won't work without intercepting requests
- More fragile

---

## Key Challenge: Expanding Panels & Loading Dynamic Content

This is the most complex aspect. MarkBind panels have several behaviors that affect PDF output:

### Panel States

| State | Behavior | PDF Concern |
|-------|----------|-------------|
| `expanded` prop not set | Collapsed by default | Content hidden, not in PDF |
| `expanded` prop set | Expanded by default | Content visible, OK |
| `src` attribute | Content loaded lazily via Retriever (fetch) | Content not loaded until panel opens |
| `minimized` | Panel shows as inline button | Content completely hidden |
| `preload` | Content fetched but panel still collapsed | DOM exists but not visible |

### Solution: Pre-PDF JavaScript Injection

Before generating the PDF, inject a script that:

```javascript
// pdf-prepare.js — injected into page before PDF generation

async function preparePdfContent() {
  // 1. Expand all panels
  document.querySelectorAll('.card-collapse').forEach(panel => {
    panel.style.maxHeight = 'none';
    panel.style.overflow = 'visible';
    panel.style.transition = 'none';
  });

  // 2. Show all panel bodies (remove d-print-none from card-body)
  document.querySelectorAll('.card-body.d-print-none').forEach(body => {
    body.classList.remove('d-print-none');
  });

  // 3. Trigger all Retriever components to fetch their content
  //    Find all panels with src that haven't loaded yet
  //    Click to expand them, triggering the Retriever fetch
  const unopenedPanels = document.querySelectorAll(
    '.expandable-card .card-header'
  );
  for (const header of unopenedPanels) {
    header.click(); // triggers toggle() -> open() -> Retriever.fetch()
  }

  // 4. Wait for all Retrievers to finish loading
  await waitForRetrievers();

  // 5. Remove collapsed state from all panels
  document.querySelectorAll('.card-collapse').forEach(panel => {
    panel.style.maxHeight = 'none';
    panel.style.overflow = 'visible';
  });

  // 6. Remove minimized panels - show them as expanded
  document.querySelectorAll('.morph').forEach(morph => {
    // Find the parent panel and trigger open
    const btn = morph.querySelector('.morph-display-wrapper');
    if (btn) btn.click();
  });

  // 7. Un-hide peek panels
  document.querySelectorAll('.card-peek-collapsed').forEach(el => {
    el.classList.remove('card-peek-collapsed');
  });

  // 8. Show all tab content (already handled by print CSS, but reinforce)
  // Tabs already show all content via printable-tabs class

  // 9. Hide interactive elements not useful in PDF
  //    - collapse/expand buttons
  //    - close buttons
  //    - popup buttons
  //    - search bar
  //    - scroll-to-top button
  document.querySelectorAll([
    '.collapse-button',
    '.close-button',
    '.popup-button',
    '.bottom-button-wrapper',
    '#search-bar-container',
    '.scroll-top-button',
  ].join(',')).forEach(el => {
    el.style.display = 'none';
  });

  // 10. Trigger page-nav-print insertion (simulate beforeprint)
  window.dispatchEvent(new Event('beforeprint'));
}

function waitForRetrievers(timeout = 10000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      const loading = document.querySelectorAll(
        '.card-body div:only-child'  // Retriever shows "Loading..." as only child
      );
      const stillLoading = Array.from(loading).some(
        el => el.textContent.trim() === 'Loading...'
      );
      if (!stillLoading || Date.now() - start > timeout) {
        resolve();
      } else {
        setTimeout(check, 200);
      }
    };
    check();
  });
}
```

### Handling Multiple Iframes / Embedded PDFs on a Page

The user's concern: "if I open the same PDF in frames multiple times on a page with different pages open, they all get rendered properly."

This applies to `<panel src="...">` where the same external content is loaded multiple times with different fragments. Key considerations:

1. **Retriever isolation**: Each `<retriever>` creates its own Vue app instance via `createApp()` and mounts independently. Multiple retrievers loading the same `src` with different `fragment` values will each fetch the content and extract their respective fragment. This is already correct.

2. **Race conditions**: Multiple concurrent `fetch()` calls to the same URL are fine — browsers cache/deduplicate them. Each Retriever mounts its result independently.

3. **PDF rendering timing**: The critical requirement is waiting for **all** Retrievers to finish before calling `page.pdf()`. The `waitForRetrievers()` function above handles this by polling for completion.

4. **Fragment-specific content**: Retrievers use `document.querySelector('#fragmentId')` on the fetched HTML to extract specific sections. If the same page is fetched twice with different fragments, each gets the right slice.

5. **Vue app isolation**: Each Retriever creates a new `createApp(TempComponent)` and mounts it to its own `this.$el`. These are fully isolated Vue instances — no shared state, no conflicts.

**Potential issue**: If panels with `src` pointing to the same page but different fragments are all expanded simultaneously, they will each `fetch()` the same URL. This is fine functionally but could be optimized with a fetch cache. For PDF generation, correctness is more important than speed here.

---

## PDF-Specific CSS Overrides

A dedicated stylesheet injected before PDF generation:

```css
/* pdf-overrides.css */

/* Force all panels expanded and visible */
.card-collapse {
  max-height: none !important;
  overflow: visible !important;
  transition: none !important;
}

.card-body {
  display: block !important;
}

/* Remove interactive elements */
.collapse-button,
.close-button,
.popup-button,
.bottom-button-wrapper,
.morph-display-wrapper,
#search-bar-container,
.scroll-top-button,
.site-nav-btn-container,
header[sticky] {
  display: none !important;
}

/* Remove peek fade effect */
.card-peek-collapsed::after {
  display: none !important;
}

/* Ensure code blocks wrap properly */
pre > code.hljs {
  white-space: pre-wrap !important;
  word-wrap: break-word !important;
}

/* Page break controls */
.card-container {
  page-break-inside: avoid;
}

h1, h2, h3, h4, h5, h6 {
  page-break-after: avoid;
}

table, figure, img {
  page-break-inside: avoid;
}

/* Show all tab content with clear labels */
.tab-content > .tab-pane {
  display: block !important;
  opacity: 1 !important;
}

.nav-tabs {
  display: none !important;
}

/* Full width content (no sidebar layout) */
#flex-body {
  flex-direction: column !important;
}

.site-nav-container {
  display: none !important;
}

/* Clean up for PDF presentation */
#content-wrapper {
  max-width: 100% !important;
  padding: 0 !important;
}
```

---

## Puppeteer PDF Options

```typescript
await page.pdf({
  path: outputPath,
  format: 'A4',
  printBackground: true,          // preserve colored backgrounds
  margin: {
    top: '20mm',
    bottom: '20mm',
    left: '15mm',
    right: '15mm',
  },
  displayHeaderFooter: true,
  headerTemplate: '<div style="font-size:8px;text-align:center;width:100%;">{{title}}</div>',
  footerTemplate: '<div style="font-size:8px;text-align:center;width:100%;">'
    + '<span class="pageNumber"></span> / <span class="totalPages"></span></div>',
  preferCSSPageSize: false,
  timeout: 30000,                  // per-page timeout
});
```

---

## Merging Multiple Pages into One PDF

For the `--single` flag, use `pdf-lib` (lightweight, no native dependencies):

```typescript
import { PDFDocument } from 'pdf-lib';

async function mergePdfs(pdfPaths: string[], outputPath: string) {
  const merged = await PDFDocument.create();

  for (const path of pdfPaths) {
    const bytes = await fs.readFile(path);
    const pdf = await PDFDocument.load(bytes);
    const pages = await merged.copyPages(pdf, pdf.getPageIndices());
    pages.forEach(page => merged.addPage(page));
  }

  const mergedBytes = await merged.save();
  await fs.writeFile(outputPath, mergedBytes);
}
```

---

## Configuration in site.json

```json
{
  "pdf": {
    "format": "A4",
    "margin": {
      "top": "20mm",
      "bottom": "20mm",
      "left": "15mm",
      "right": "15mm"
    },
    "headerTemplate": "",
    "footerTemplate": "<page> / <total>",
    "printBackground": true,
    "pages": ["**/*.md"],
    "pagesExclude": [],
    "expandPanels": true,
    "waitTimeout": 10000
  }
}
```

---

## Challenges & Risk Areas

### 1. Headless Browser Dependency Size
Puppeteer downloads a Chromium binary (~170MB). This is heavy for a dev tool.

**Mitigation**: Make Puppeteer an optional peer dependency. The `markbind pdf` command checks for it and prompts:
```
Puppeteer is required for PDF generation but not installed.
Run: npm install puppeteer
```

### 2. Panel Content Loading Reliability
Panels with `src` load content via client-side `fetch()`. If the local server isn't ready or the content fails to load, the PDF will have "Loading..." or error text.

**Mitigation**:
- Use a robust local server with a "ready" check before starting PDF generation
- Implement per-page timeout with clear error reporting
- Retry failed pages
- Log warnings for pages with remaining "Loading..." text

### 3. Vue Hydration & Client-Side Rendering
MarkBind pages use Vue SSR with client-side hydration. Some content is only available after Vue mounts and hydrates the page.

**Mitigation**: In Puppeteer, wait for:
```typescript
await page.waitForFunction(() => {
  // Vue has mounted and hydrated
  return document.querySelector('#app').__vue_app__ !== undefined;
});
```

### 4. External Resources (Images, Fonts)
Images referenced via relative URLs need the local server. External images (CDN) need network access.

**Mitigation**: The local server approach handles relative resources. For external resources, ensure Puppeteer doesn't block external network requests.

### 5. Page Break Quality
Automatic page breaks can split content awkwardly (mid-code-block, mid-table, mid-panel).

**Mitigation**: CSS `page-break-inside: avoid` on key elements. This is already partially supported via `noPageBreak` prop. Expand coverage in the PDF override CSS. Users can also add `no-page-break` class manually.

### 6. Math (KaTeX) and Diagrams (Mermaid, PlantUML)
These are rendered client-side or as inline SVG/images. They should work naturally in Puppeteer since it runs a real browser.

**Verification needed**: Ensure KaTeX fonts load properly in headless Chrome and Mermaid diagrams render before PDF capture.

### 7. Search Data and Dynamic Components
The search bar, scroll-to-top button, and other interactive components should be hidden in PDF output.

**Mitigation**: PDF override CSS hides these elements.

---

## Estimated Scope

| Component | Effort |
|-----------|--------|
| CLI command scaffolding (`pdf.ts`) | Small |
| Local server for PDF rendering | Small |
| PDF preparation script (expand panels, wait for content) | Medium |
| PDF override CSS | Small |
| Puppeteer page rendering | Medium |
| PDF merging (single-file mode) | Small |
| site.json configuration schema | Small |
| Error handling & retry logic | Medium |
| Testing with complex MarkBind sites | Medium |
| Documentation | Small |

---

## Alternatives Considered

### 1. wkhtmltopdf
- Pros: Lighter weight, CLI-based
- Cons: Uses old WebKit, poor modern CSS support (no CSS Grid, limited Flexbox), no Vue hydration, project is deprecated

### 2. Prince XML
- Pros: Excellent CSS support, great page break handling
- Cons: Commercial license ($$$), external binary dependency

### 3. CSS Paged Media (no headless browser)
- Pros: No browser dependency, pure CSS
- Cons: Very limited browser support for `@page` rules and margin boxes, can't handle Vue components or dynamic content

### 4. jsPDF / html2canvas
- Pros: Client-side, no server needed
- Cons: Rasterizes HTML (loses text quality), poor handling of multi-page content, no CSS paged media support

### 5. Building into the Plugin System
- Pros: Consistent with MarkBind architecture
- Cons: Plugins run mid-pipeline (before final HTML), lack filesystem access, wrong abstraction level for a site-level operation

---

## Summary

Adding PDF export to MarkBind is feasible with a **moderate** engineering effort. The recommended approach is:

1. **New `markbind pdf` CLI command** that runs after site generation
2. **Puppeteer** as an optional dependency for headless Chrome PDF rendering
3. **Local HTTP server** to serve the built site for Puppeteer to consume
4. **JavaScript injection** to expand all panels, trigger Retriever loads, and wait for content
5. **PDF-specific CSS overrides** to hide interactive elements and optimize layout
6. **Optional pdf-lib** for merging pages into a single PDF

The Panel/Retriever architecture is well-suited for this — each Retriever is an isolated Vue app that fetches and mounts independently, so multiple panels loading the same source with different fragments will render correctly. The key is waiting for all async content to finish loading before capturing the PDF.
