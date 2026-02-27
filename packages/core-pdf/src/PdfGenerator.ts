import path from 'path';
import http from 'http';
import fs from 'fs-extra';
import type { Browser, Page } from 'puppeteer';
import { PdfOptions, PdfPageResult } from './types';

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
const DEFAULT_WAIT_TIMEOUT = 10000;
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_FOOTER_TEMPLATE = '<div style="font-size:8px;text-align:center;width:100%;">'
  + '<span class="pageNumber"></span> / <span class="totalPages"></span></div>';

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
    const { server, port } = await this.startServer();
    log(`Local server started on port ${port}.`);

    let browser: Browser | undefined;
    const results: PdfPageResult[] = [];

    try {
      // Launch Puppeteer
      const puppeteer = await this.loadPuppeteer();
      const launchOptions: any = {
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
      const batches = this.chunk(htmlFiles, this.options.concurrency);
      for (const batch of batches) {
        const batchResults = await Promise.all(
          batch.map(htmlFile => this.convertPage(browser!, port, htmlFile, log)),
        );
        results.push(...batchResults);
      }

      // Merge if requested, using site-nav order when available
      if (this.options.merge && results.some(r => r.success)) {
        const successful = results.filter(r => r.success);
        const navOrder = await this.extractNavOrder();
        const ordered = navOrder.length > 0
          ? this.sortByNavOrder(successful, navOrder, log)
          : successful;
        await this.mergePdfs(ordered, log);
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
    const allFiles = await this.walkDir(this.options.siteOutputPath);

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
   * Recursively list all files under a directory.
   */
  private async walkDir(dir: string): Promise<string[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...await this.walkDir(fullPath));
      } else {
        files.push(fullPath);
      }
    }
    return files;
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
      const baseUrl = this.options.baseUrl.replace(/\/$/, '');
      const url = `${localOrigin}${baseUrl}/${htmlFile}`;
      await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });

      // Wait for Vue to mount (#app should have __vue_app__)
      await page.waitForFunction(
        () => {
          const app = document.querySelector('#app');
          return app && (app as any).__vue_app__ !== undefined;
        },
        { timeout: 10000 },
      ).catch(() => {
        // If Vue doesn't mount (e.g. static page without Vue), continue anyway
      });

      // Screenshot each iframe and replace with an inline <img>.
      // PDF iframes are rendered in a separate tab (headless Chrome doesn't
      // render PDFs inside iframes); HTML iframes are screenshotted in-place.
      await this.screenshotIframes(page, port);

      // Inject PDF override CSS
      await page.addStyleTag({ content: this.overrideCss });

      // Execute the PDF preparation script to expand panels and wait for retrievers.
      // This also replaces any remaining iframes (ones that failed screenshot)
      // with styled placeholders.
      await page.evaluate(`
        ${this.prepareJs}
        preparePdfContent(${this.options.waitTimeout});
      `);

      // Extra settle time after preparation
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 500)));

      // Generate PDF
      const pdfOptions: any = {
        path: pdfOutputFile,
        format: this.options.format,
        margin: this.options.margin,
        printBackground: this.options.printBackground,
        timeout: 60000,
      };

      if (this.options.headerTemplate || this.options.footerTemplate) {
        pdfOptions.displayHeaderFooter = true;
        pdfOptions.headerTemplate = this.options.headerTemplate
          || '<span></span>'; // must be non-empty if displayHeaderFooter is true
        pdfOptions.footerTemplate = this.options.footerTemplate
          || '<span></span>';
      }

      await page.pdf(pdfOptions);

      log(`  OK: ${htmlFile} -> ${pdfFile}`);
      return { htmlFile, pdfFile: pdfOutputFile, success: true };
    } catch (err: any) {
      const errorMsg = err.message || String(err);
      log(`  FAIL: ${htmlFile} - ${errorMsg}`);
      return { htmlFile, pdfFile: pdfOutputFile, success: false, error: errorMsg };
    } finally {
      if (page) {
        await page.close();
      }
    }
  }

  /**
   * Screenshot each iframe and replace it with an inline <img>.
   *
   * For PDF iframes: headless Chrome doesn't render PDFs inside iframes,
   * so we open the PDF URL in a separate tab via our local server,
   * screenshot it there, then inject the image back into the main page.
   *
   * For HTML iframes: use elementHandle.screenshot() in-place.
   */
  private async screenshotIframes(page: Page, port: number): Promise<void> {
    const iframeData: { src: string; width: number; height: number }[] =
      await page.evaluate(() => {
        return Array.from(document.querySelectorAll('iframe')).map((iframe) => ({
          src: iframe.getAttribute('src') || '',
          width: iframe.getBoundingClientRect().width || iframe.clientWidth || 800,
          height: iframe.getBoundingClientRect().height || iframe.clientHeight || 400,
        }));
      });

    if (iframeData.length === 0) return;

    // Give iframes a moment to render
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 500)));

    const browser = page.browser();
    const baseUrl = this.options.baseUrl.replace(/\/$/, '');
    const localOrigin = `http://127.0.0.1:${port}`;

    for (let i = 0; i < iframeData.length; i++) {
      const info = iframeData[i];
      if (!info.src) continue;

      try {
        let screenshotBase64: string | undefined;
        const isPdf = /\.pdf([#?]|$)/i.test(info.src);

        if (isPdf) {
          // PDF iframes: open in a new tab and screenshot.
          // Resolve src to a local server URL.
          let pdfUrl = info.src;
          if (!pdfUrl.startsWith('http')) {
            // Relative URL — resolve against local server + baseUrl
            pdfUrl = `${localOrigin}${baseUrl}/${pdfUrl.replace(/^\//, '')}`;
          }

          const pdfPage = await browser.newPage();
          try {
            await pdfPage.setViewport({
              width: Math.round(info.width) || 800,
              height: Math.round(info.height) || 600,
            });
            // Use 'load' + short timeout — avoids the networkidle0 hang
            await pdfPage.goto(pdfUrl, { waitUntil: 'load', timeout: 8000 });
            // Give Chrome's PDF viewer time to paint
            await pdfPage.evaluate(() => new Promise(r => setTimeout(r, 2000)));

            screenshotBase64 = await pdfPage.screenshot({
              encoding: 'base64',
              type: 'png',
            }) as string;
          } finally {
            await pdfPage.close();
          }
        } else {
          // Non-PDF iframe: screenshot element in-place
          const handles = await page.$$('iframe');
          const handle = handles[i];
          if (handle) {
            const box = await handle.boundingBox();
            if (box && box.width > 0 && box.height > 0) {
              screenshotBase64 = await handle.screenshot({
                encoding: 'base64',
                type: 'png',
              }) as string;
            }
          }
        }

        if (screenshotBase64) {
          // Replace the iframe with an inline <img>
          await page.evaluate((idx: number, dataUrl: string) => {
            const el = document.querySelectorAll('iframe')[idx];
            if (!el) return;
            const img = document.createElement('img');
            img.src = dataUrl;
            img.style.maxWidth = '100%';
            img.style.height = 'auto';
            img.style.display = 'block';
            el.parentNode!.replaceChild(img, el);
          }, i, `data:image/png;base64,${screenshotBase64}`);
        }
      } catch {
        // If capture fails for any reason (timeout, etc.), leave the iframe
        // for the browser-side replaceIframes() to handle with a placeholder
      }
    }
  }

  /**
   * Extract page order from the site-nav in the built HTML.
   * Reads the first HTML file that contains a <nav id="site-nav"> and
   * extracts all <a href="..."> links in document order. Returns an
   * ordered list of relative HTML file paths.
   */
  private async extractNavOrder(): Promise<string[]> {
    const htmlFiles = await this.discoverHtmlFiles();
    const baseUrl = this.options.baseUrl.replace(/\/$/, '');

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
        if (baseUrl && href.startsWith(baseUrl)) {
          href = href.slice(baseUrl.length);
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
    const notInNav: PdfPageResult[] = [];

    for (const result of results) {
      if (orderMap.has(result.htmlFile)) {
        inNav.push(result);
      } else {
        notInNav.push(result);
      }
    }

    inNav.sort((a, b) => orderMap.get(a.htmlFile)! - orderMap.get(b.htmlFile)!);

    if (inNav.length > 0) {
      log(`Merge order: using site-nav order (${inNav.length} pages from nav, ${notInNav.length} appended)`);
    }

    return [...inNav, ...notInNav];
  }

  /**
   * Merge multiple PDFs into a single file using pdf-lib.
   */
  private async mergePdfs(results: PdfPageResult[], log: (msg: string) => void): Promise<void> {
    const { PDFDocument } = await import('pdf-lib');
    const merged = await PDFDocument.create();

    for (const result of results) {
      const buf = await fs.readFile(result.pdfFile);
      const pdf = await PDFDocument.load(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
      const pages = await merged.copyPages(pdf, pdf.getPageIndices());
      pages.forEach(p => merged.addPage(p));
    }

    const mergedPath = path.join(this.options.pdfOutputPath, this.options.mergeFilename);
    const mergedBytes = await merged.save();
    await fs.writeFile(mergedPath, mergedBytes);
    log(`Merged PDF written to ${mergedPath}`);
  }

  /**
   * Start a minimal static HTTP server serving the built site.
   */
  private startServer(): Promise<{ server: http.Server; port: number }> {
    return new Promise((resolve, reject) => {
      const siteRoot = this.options.siteOutputPath;
      const baseUrl = this.options.baseUrl.replace(/\/$/, '');

      const server = http.createServer((req, res) => {
        const urlPath = decodeURIComponent(req.url || '/');
        // Strip query string
        let cleanPath = urlPath.split('?')[0];

        // Strip baseUrl prefix so the path maps to the _site/ root.
        // MarkBind outputs files at _site/ root regardless of baseUrl,
        // but internal links include the baseUrl prefix.
        if (baseUrl && cleanPath.startsWith(baseUrl)) {
          cleanPath = cleanPath.slice(baseUrl.length) || '/';
        }

        let filePath = path.join(siteRoot, cleanPath);

        // If path is a directory, serve index.html
        if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
          filePath = path.join(filePath, 'index.html');
        }

        if (!fs.existsSync(filePath)) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }

        const ext = path.extname(filePath).toLowerCase();
        const mimeTypes: Record<string, string> = {
          '.html': 'text/html; charset=utf-8',
          '.css': 'text/css; charset=utf-8',
          '.js': 'application/javascript; charset=utf-8',
          '.json': 'application/json; charset=utf-8',
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.gif': 'image/gif',
          '.svg': 'image/svg+xml',
          '.ico': 'image/x-icon',
          '.woff': 'font/woff',
          '.woff2': 'font/woff2',
          '.ttf': 'font/ttf',
          '.eot': 'application/vnd.ms-fontobject',
          '.otf': 'font/otf',
          '.pdf': 'application/pdf',
          '.map': 'application/json',
        };

        const contentType = mimeTypes[ext] || 'application/octet-stream';
        const fileStream = fs.createReadStream(filePath);

        res.writeHead(200, { 'Content-Type': contentType });
        fileStream.pipe(res);
        fileStream.on('error', () => {
          res.writeHead(500);
          res.end('Internal server error');
        });
      });

      // Listen on a random available port on localhost
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('Failed to get server address'));
          return;
        }
        resolve({ server, port: address.port });
      });

      server.on('error', reject);
    });
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

  /**
   * Split an array into chunks of the given size.
   */
  private chunk<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }
}
