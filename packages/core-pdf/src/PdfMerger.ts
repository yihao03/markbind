import path from 'path';
import fs from 'fs-extra';
import { PDFDocument, PDFDict, PDFName, PDFArray, PDFString, PDFNull } from 'pdf-lib';
import type { PDFRef, PDFContext } from 'pdf-lib';
import { PdfPageResult } from './types';

interface Bookmark {
  title: string;
  pageIndex: number;
}

/**
 * Merge multiple per-page PDFs into a single file with a PDF outline
 * (bookmarks) so viewers show a clickable TOC sidebar.
 */
export async function mergePdfs(
  results: PdfPageResult[],
  outputPath: string,
  filename: string,
  log: (msg: string) => void,
): Promise<void> {
  const merged = await PDFDocument.create();

  // Track the first page index of each source document in the merged PDF
  const bookmarks: Bookmark[] = [];
  let currentPageIndex = 0;

  for (const result of results) {
    bookmarks.push({ title: result.title, pageIndex: currentPageIndex });
    const buf = await fs.readFile(result.pdfFile);
    const pdf = await PDFDocument.load(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
    const pages = await merged.copyPages(pdf, pdf.getPageIndices());
    pages.forEach(p => merged.addPage(p));
    currentPageIndex += pages.length;
  }

  if (bookmarks.length > 0) {
    addOutline(merged, bookmarks);
    log(`Added ${bookmarks.length} bookmark(s) to merged PDF.`);
  }

  const mergedPath = path.join(outputPath, filename);
  const mergedBytes = await merged.save();
  await fs.writeFile(mergedPath, mergedBytes);
  log(`Merged PDF written to ${mergedPath}`);
}

/**
 * Add a PDF outline (bookmarks/TOC) to a PDFDocument using low-level pdf-lib API.
 * Each bookmark points to the first page of a source document.
 */
function addOutline(doc: PDFDocument, bookmarks: Bookmark[]): void {
  const context: PDFContext = doc.context;
  const pages = doc.getPages();

  // Create outline item refs first so we can link Prev/Next
  const outlineItemRefs: PDFRef[] = [];

  for (let i = 0; i < bookmarks.length; i++) {
    outlineItemRefs.push(context.nextRef());
  }

  // Create the root /Outlines dictionary
  const outlinesDict = context.obj({
    Type: 'Outlines',
    First: outlineItemRefs[0],
    Last: outlineItemRefs[outlineItemRefs.length - 1],
    Count: bookmarks.length,
  });
  const outlinesRef = context.register(outlinesDict);

  // Create each outline item
  for (let i = 0; i < bookmarks.length; i++) {
    const { title, pageIndex } = bookmarks[i];
    const targetPage = pages[pageIndex];

    // Destination: [pageRef /XYZ null null null] — top of the page
    const dest = PDFArray.withContext(context);
    dest.push(targetPage.ref);
    dest.push(PDFName.of('XYZ'));
    dest.push(PDFNull);
    dest.push(PDFNull);
    dest.push(PDFNull);

    const map = new Map();
    map.set(PDFName.of('Title'), PDFString.of(title));
    map.set(PDFName.of('Parent'), outlinesRef);
    map.set(PDFName.of('Dest'), dest);

    if (i > 0) {
      map.set(PDFName.of('Prev'), outlineItemRefs[i - 1]);
    }
    if (i < bookmarks.length - 1) {
      map.set(PDFName.of('Next'), outlineItemRefs[i + 1]);
    }

    const itemDict = PDFDict.fromMapWithContext(map, context);
    context.assign(outlineItemRefs[i], itemDict);
  }

  // Set /Outlines on the document catalog
  doc.catalog.set(PDFName.of('Outlines'), outlinesRef);
}
