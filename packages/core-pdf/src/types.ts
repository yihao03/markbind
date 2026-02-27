export interface PdfOptions {
  /** Absolute path to the built site directory (e.g. _site/) */
  siteOutputPath: string;

  /** Absolute path to the directory where PDFs will be written */
  pdfOutputPath: string;

  /** Base URL of the site (from site.json), e.g. '' or '/mysite' */
  baseUrl: string;

  /** Paper format for PDF generation. Default: 'A4' */
  format?: 'A4' | 'Letter' | 'Legal' | 'Tabloid';

  /** PDF margins in CSS units. Defaults to 20mm top/bottom, 15mm left/right */
  margin?: {
    top?: string;
    bottom?: string;
    left?: string;
    right?: string;
  };

  /** Whether to print background colors/images. Default: true */
  printBackground?: boolean;

  /** Glob patterns of HTML files to include. Default: all .html files */
  pages?: string[];

  /** Glob patterns of HTML files to exclude */
  pagesExclude?: string[];

  /** Merge all page PDFs into a single file. Default: false */
  merge?: boolean;

  /** Filename for the merged PDF (only used if merge is true). Default: 'site.pdf' */
  mergeFilename?: string;

  /** Header template for each PDF page (Puppeteer header HTML template) */
  headerTemplate?: string;

  /** Footer template for each PDF page (Puppeteer footer HTML template) */
  footerTemplate?: string;

  /** Maximum time in ms to wait for Retrievers to load. Default: 10000 */
  waitTimeout?: number;

  /** Maximum number of pages to render concurrently. Default: 3 */
  concurrency?: number;

  /** Path to a Chrome, Chromium, or Edge executable.
   *  If not set, the system browser is auto-detected.
   *  Can also be set via PUPPETEER_EXECUTABLE_PATH environment variable. */
  executablePath?: string;
}

export interface PdfPageResult {
  /** Source HTML file path relative to siteOutputPath */
  htmlFile: string;

  /** Output PDF file path */
  pdfFile: string;

  /** Whether generation succeeded */
  success: boolean;

  /** Error message if generation failed */
  error?: string;
}
