import path from 'path';
import fs from 'fs-extra';
import type { Browser, Page, LaunchOptions, PDFOptions } from 'puppeteer';
import { PdfOptions, PdfPageResult } from './types';
import { startLocalServer } from './LocalServer';
import { mergePdfs } from './PdfMerger';

const ASSETS_DIR = path.resolve(__dirname, '..', 'assets');
const PDF_OVERRIDES_CSS_PATH = path.join(ASSETS_DIR, 'pdf-overrides.css');
const PDF_PREPARE_JS_PATH = path.join(ASSETS_DIR, 'pdf-prepare.js');

const DEFAULT_FORMAT = 'A4';
const DEFAULT_MARGIN = {
  top: '20mm',
  bottom: '20mm',
  left: '15mm',
  right: '15mm',
};
const DEFAULT_WAIT_TIMEOUT = 10_000;
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_FOOTER_TEMPLATE = '<div style="font-size:8px;text-align:center;width:100%;">'
  + '<span class="pageNumber"></span> / <span class="totalPages"></span></div>';

/** Timeout for page.goto() navigation */
const NAVIGATION_TIMEOUT = 30_000;
/** Timeout for checking if Vue has mounted on the page */
const VUE_MOUNT_TIMEOUT = 10_000;
/** Timeout for page.pdf() generation */
const PDF_GENERATION_TIMEOUT = 60_000;
/** Viewport dimensions for Puppeteer pages */
const VIEWPORT_WIDTH = 1200;
const VIEWPORT_HEIGHT = 800;

/**
 * Generates PDF files from a built MarkBind site.
 *
 * Usage:
 *   const gen = new PdfGenerator(options);
 *   const results = await gen.generate();
 */
export class PdfGenerator {
  private options: Required<PdfOptions>;
  private overrideCss: string = '';
  private prepareJs: string = '';
  private normalizedBaseUrl: string;

  constructor(options: PdfOptions) {
    this.options = {
      siteOutputPath: options.siteOutputPath,
      pdfOutputPath: options.pdfOutputPath,
      baseUrl: options.baseUrl || '',
      format: options.format || DEFAULT_FORMAT,
      margin: { ...DEFAULT_MARGIN, ...options.margin },
      printBackground: options.printBackground !== false,
      pages: options.pages || ['**/*.html'],
      pagesExclude: options.pagesExclude || [],
      merge: options.merge || false,
      mergeFilename: options.mergeFilename || 'site.pdf',
      headerTemplate: options.headerTemplate || '',
      footerTemplate: options.footerTemplate || DEFAULT_FOOTER_TEMPLATE,
      waitTimeout: options.waitTimeout || DEFAULT_WAIT_TIMEOUT,
      concurrency: options.concurrency || DEFAULT_CONCURRENCY,
      executablePath: options.executablePath || process.env.PUPPETEER_EXECUTABLE_PATH || '',
    };
    this.normalizedBaseUrl = this.options.baseUrl.replace(/\/$/, '');
  }

  /**
   * Main entry point. Discovers HTML files, launches a browser,
   * spins up a local server, converts each page, and optionally merges.
   */
  async generate(onProgress?: (msg: string) => void): Promise<PdfPageResult[]> {
    const log = onProgress || (() => {});

    // Load injectable assets
    this.overrideCss = await fs.readFile(PDF_OVERRIDES_CSS_PATH, 'utf-8');
    this.prepareJs = await fs.readFile(PDF_PREPARE_JS_PATH, 'utf-8');

    // Discover HTML files to convert
    const htmlFiles = await this.discoverHtmlFiles();
    if (htmlFiles.length === 0) {
      log('No HTML files found to convert.');
      return [];
    }
    log(`Found ${htmlFiles.length} page(s) to convert.`);

    // Ensure output directory exists
    await fs.ensureDir(this.options.pdfOutputPath);

    // Start local server to serve the built site
    const { server, port } = await startLocalServer(
      this.options.siteOutputPath,
      this.options.baseUrl,
    );
    log(`Local server started on port ${port}.`);

    let browser: Browser | undefined;
    const results: PdfPageResult[] = [];

    try {
      // Launch Puppeteer (uses its bundled Chromium by default)
      const puppeteer = await this.loadPuppeteer();
      const launchOptions: LaunchOptions = {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
        ],
      };
      if (this.options.executablePath) {
        launchOptions.executablePath = this.options.executablePath;
      }
      browser = await puppeteer.launch(launchOptions);

      log('Browser launched.');

      // Process pages with controlled concurrency
      const batches = chunk(htmlFiles, this.options.concurrency);
      for (const batch of batches) {
        const batchResults = await Promise.all(
          batch.map(htmlFile => this.convertPage(browser!, port, htmlFile, log)),
        );
        results.push(...batchResults);
      }

      // Merge if requested, using site-nav order when available
      if (this.options.merge && results.some(r => r.success)) {
        const successful = results.filter(r => r.success);
        const navOrder = await this.extractNavOrder(htmlFiles);
        const ordered = navOrder.length > 0
          ? this.sortByNavOrder(successful, navOrder, log)
          : successful;
        await mergePdfs(ordered, this.options.pdfOutputPath, this.options.mergeFilename, log);
      }
    } finally {
      if (browser) {
        await browser.close();
      }
      server.close();
      log('Cleanup complete.');
    }

    return results;
  }

  /**
   * Discover HTML files in siteOutputPath matching the configured globs.
   */
  private async discoverHtmlFiles(): Promise<string[]> {
    const allFiles = await walkDir(this.options.siteOutputPath);

    // Filter to .html files, then apply include/exclude globs
    const htmlFiles = allFiles
      .filter(f => f.endsWith('.html'))
      .map(f => path.relative(this.options.siteOutputPath, f))
      // Exclude markbind asset files
      .filter(f => !f.startsWith('markbind' + path.sep) && !f.startsWith('markbind/'));

    // Apply page include patterns
    const { minimatch } = await import('minimatch');
    let included = htmlFiles.filter(f => {
      return this.options.pages.some(pattern => minimatch(f, pattern, { matchBase: true }));
    });

    // Apply exclude patterns
    if (this.options.pagesExclude.length > 0) {
      included = included.filter(f => {
        return !this.options.pagesExclude.some(
          pattern => minimatch(f, pattern, { matchBase: true }),
        );
      });
    }

    return included.sort();
  }

  /**
   * Convert a single HTML page to PDF.
   */
  private async convertPage(
    browser: Browser,
    port: number,
    htmlFile: string,
    log: (msg: string) => void,
  ): Promise<PdfPageResult> {
    const pdfFile = htmlFile.replace(/\.html$/, '.pdf');
    const pdfOutputFile = path.join(this.options.pdfOutputPath, pdfFile);

    let page: Page | undefined;

    try {
      // Ensure parent directory for output PDF exists
      await fs.ensureDir(path.dirname(pdfOutputFile));

      page = await browser.newPage();

      // Set viewport to approximate A4 content width at 96dpi.
      // A4 = 210mm wide. With 15mm left+right margins = 180mm content.
      // 180mm ~ 680px at 96dpi. We use a wider viewport so content
      // renders at full width before page.pdf() reflows to A4.
      await page.setViewport({ width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT });

      // Block all requests to external domains. The built site is fully
      // self-contained; external requests (CDN fonts, analytics, etc.)
      // would only slow things down or cause timeouts.
      await page.setRequestInterception(true);
      const localOrigin = `http://127.0.0.1:${port}`;
      page.on('request', (req) => {
        if (req.url().startsWith(localOrigin)) {
          req.continue();
        } else {
          req.abort();
        }
      });

      // Navigate to the page via the local server
      const url = `${localOrigin}${this.normalizedBaseUrl}/${htmlFile}`;
      await page.goto(url, { waitUntil: 'networkidle0', timeout: NAVIGATION_TIMEOUT });

      // Wait for Vue to mount (#app should have __vue_app__)
      await page.waitForFunction(
        () => {
          const app = document.querySelector('#app');
          return app && (app as any).__vue_app__ !== undefined;
        },
        { timeout: VUE_MOUNT_TIMEOUT },
      ).catch(() => {
        // If Vue doesn't mount (e.g. static page without Vue), continue anyway
      });

      // Inject PDF-specific CSS additions.
      // MarkBind's built-in @media print styles and d-print-none classes
      // handle most print concerns (hiding navbar, tabs nav, scroll buttons,
      // code wrapping, etc.). This CSS only adds PDF-specific extras like
      // forcing panels open and full-width layout.
      await page.addStyleTag({ content: this.overrideCss });

      // Execute the PDF preparation script to expand panels and wait for retrievers.
      // This also replaces iframes with styled placeholders since page.pdf()
      // cannot capture iframe content.
      await page.evaluate(`
        ${this.prepareJs}
        preparePdfContent(${this.options.waitTimeout});
      `);

      // Generate PDF
      const pdfOptions: PDFOptions = {
        path: pdfOutputFile,
        format: this.options.format,
        landscape: false,
        preferCSSPageSize: false,
        margin: this.options.margin,
        printBackground: this.options.printBackground,
        timeout: PDF_GENERATION_TIMEOUT,
      };

      if (this.options.headerTemplate || this.options.footerTemplate) {
        pdfOptions.displayHeaderFooter = true;
        pdfOptions.headerTemplate = this.options.headerTemplate
          || '<span></span>'; // must be non-empty if displayHeaderFooter is true
        pdfOptions.footerTemplate = this.options.footerTemplate
          || '<span></span>';
      }

      await page.pdf(pdfOptions);

      // Extract page title for PDF bookmarks
      const title = await page.title() || htmlFile.replace(/\.html$/, '');

      // Count pages in the generated PDF for bookmark offsets
      const { PDFDocument: PDFDoc } = await import('pdf-lib');
      const pdfBuf = await fs.readFile(pdfOutputFile);
      const pdfDoc = await PDFDoc.load(new Uint8Array(pdfBuf.buffer, pdfBuf.byteOffset, pdfBuf.byteLength));
      const pageCount = pdfDoc.getPageCount();

      log(`  OK: ${htmlFile} -> ${pdfFile} (${pageCount} page(s))`);
      return { htmlFile, pdfFile: pdfOutputFile, title, pageCount, success: true };
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log(`  FAIL: ${htmlFile} - ${errorMsg}`);
      return { htmlFile, pdfFile: pdfOutputFile, title: htmlFile, pageCount: 0, success: false, error: errorMsg };
    } finally {
      if (page) {
        await page.close();
      }
    }
  }

  /**
   * Extract page order from the site-nav in the built HTML.
   * Reads the first HTML file that contains a <nav id="site-nav"> and
   * extracts all <a href="..."> links in document order. Returns an
   * ordered list of relative HTML file paths.
   *
   * Accepts a pre-discovered list of HTML files to avoid re-walking the directory.
   */
  private async extractNavOrder(htmlFiles: string[]): Promise<string[]> {
    for (const file of htmlFiles) {
      const fullPath = path.join(this.options.siteOutputPath, file);
      const html = await fs.readFile(fullPath, 'utf-8');

      // Look for the site-nav section
      const navMatch = html.match(/<nav\s+id=["']site-nav["'][^>]*>([\s\S]*?)<\/nav>/i);
      if (!navMatch) continue;

      const navHtml = navMatch[1];

      // Extract all href values from anchor tags in the nav
      const hrefRegex = /href=["']([^"'#]+?)(?:#[^"']*)?["']/g;
      const seen = new Set<string>();
      const order: string[] = [];

      let match;
      while ((match = hrefRegex.exec(navHtml)) !== null) {
        let href = match[1];
        // Strip baseUrl prefix
        if (this.normalizedBaseUrl && href.startsWith(this.normalizedBaseUrl)) {
          href = href.slice(this.normalizedBaseUrl.length);
        }
        // Remove leading slash and normalize
        href = href.replace(/^\//, '');
        // Convert directory paths to index.html
        if (href === '' || href.endsWith('/')) {
          href += 'index.html';
        }
        if (!href.endsWith('.html')) continue;
        if (seen.has(href)) continue;
        seen.add(href);
        order.push(href);
      }

      if (order.length > 0) return order;
    }

    return [];
  }

  /**
   * Sort PDF results according to the site-nav order.
   * Pages not found in the nav are appended at the end in their original order.
   */
  private sortByNavOrder(
    results: PdfPageResult[],
    navOrder: string[],
    log: (msg: string) => void,
  ): PdfPageResult[] {
    const orderMap = new Map<string, number>();
    navOrder.forEach((file, idx) => orderMap.set(file, idx));

    const inNav: PdfPageResult[] = [];

    for (const result of results) {
      if (orderMap.has(result.htmlFile)) {
        inNav.push(result);
      }
    }

    inNav.sort((a, b) => orderMap.get(a.htmlFile)! - orderMap.get(b.htmlFile)!);

    const skipped = results.length - inNav.length;
    log(`Merge order: using site-nav order (${inNav.length} pages included, ${skipped} not in nav — skipped)`);

    return inNav;
  }

  /**
   * Dynamically import puppeteer, with a helpful error message if not installed.
   */
  private async loadPuppeteer(): Promise<typeof import('puppeteer')> {
    try {
      return await import('puppeteer');
    } catch {
      throw new Error(
        'Puppeteer is required for PDF generation but could not be loaded.\n'
        + 'Install it with: npm install puppeteer\n'
        + 'Or install @markbind/core-pdf which includes it as a dependency.',
      );
    }
  }
}

/**
 * Recursively list all files under a directory.
 */
async function walkDir(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkDir(fullPath));
    } else {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * Split an array into chunks of the given size.
 */
function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}
