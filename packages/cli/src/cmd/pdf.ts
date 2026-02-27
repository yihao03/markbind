import path from 'path';
import { Site } from '@markbind/core';
import isBoolean from 'lodash/isBoolean';
import isError from 'lodash/isError';
import * as cliUtil from '../util/cliUtil';
import * as logger from '../util/logger';

const _ = {
  isBoolean,
  isError,
};

function pdf(userSpecifiedRoot: string, output: string, options: any) {
  // if --baseUrl contains no arguments (options.baseUrl === true) then set baseUrl to empty string
  const baseUrl = _.isBoolean(options.baseUrl) ? '' : options.baseUrl;

  let rootFolder: string;
  try {
    rootFolder = cliUtil.findRootFolder(userSpecifiedRoot, options.siteConfig);
  } catch (error) {
    if (_.isError(error)) {
      logger.error(error.message);
      logger.error('This directory does not appear to contain a valid MarkBind site. '
          + 'Check that you are running the command in the correct directory!\n'
          + '\n'
          + 'To create a new MarkBind site, run:\n'
          + '   markbind init');
    } else {
      logger.error(`Unknown error occurred: ${error}`);
    }
    cliUtil.cleanupFailedMarkbindBuild();
    process.exitCode = 1;
    process.exit();
  }

  const siteOutputFolder = path.join(rootFolder, '_site');
  const defaultPdfOutput = path.join(rootFolder, '_pdf');
  const pdfOutputFolder = output ? path.resolve(process.cwd(), output) : defaultPdfOutput;

  // Step 1: Build the site first (same as `markbind build`)
  logger.info('Building site...');
  const site = new Site(rootFolder, siteOutputFolder, '', undefined, options.siteConfig,
                        false, false, () => {});

  site.generate(baseUrl)
    .then(async () => {
      logger.info('Site built successfully. Starting PDF generation...');

      // Step 2: Dynamically import @markbind/core-pdf (optional dependency).
      let PdfGenerator: any;
      try {
        const corePdf = await import('@markbind/core-pdf');
        PdfGenerator = corePdf.PdfGenerator;
      } catch {
        logger.error(
          'PDF generation requires the @markbind/core-pdf package.\n'
          + 'Install it with:\n'
          + '  npm install @markbind/core-pdf',
        );
        process.exitCode = 1;
        return;
      }

      // Read the site config to get baseUrl
      const siteConfig = await site.readSiteConfig(baseUrl);
      const resolvedBaseUrl = siteConfig.baseUrl || '';

      // Build PDF options from CLI flags
      const pdfOptions: any = {
        siteOutputPath: siteOutputFolder,
        pdfOutputPath: pdfOutputFolder,
        baseUrl: resolvedBaseUrl,
        printBackground: true,
      };

      if (options.format) {
        pdfOptions.format = options.format;
      }
      if (options.merge) {
        pdfOptions.merge = true;
      }
      if (options.mergeFilename) {
        pdfOptions.mergeFilename = options.mergeFilename;
      }
      if (options.pages) {
        pdfOptions.pages = options.pages.split(',').map((p: string) => p.trim());
      }
      if (options.waitTimeout) {
        pdfOptions.waitTimeout = parseInt(options.waitTimeout, 10);
      }

      const generator = new PdfGenerator(pdfOptions);
      const results = await generator.generate((msg: string) => logger.info(msg));

      // Report summary
      const succeeded = results.filter((r: any) => r.success).length;
      const failed = results.filter((r: any) => !r.success).length;

      if (failed > 0) {
        logger.warn(`PDF generation complete: ${succeeded} succeeded, ${failed} failed.`);
        results
          .filter((r: any) => !r.success)
          .forEach((r: any) => logger.error(`  ${r.htmlFile}: ${r.error}`));
        process.exitCode = 1;
      } else {
        logger.info(`PDF generation complete: ${succeeded} page(s) exported to ${pdfOutputFolder}`);
      }
    })
    .catch((error) => {
      if (_.isError(error)) {
        logger.error(error.message);
      } else {
        logger.error(`Unknown error occurred: ${error}`);
      }
      process.exitCode = 1;
    });
}

export { pdf };
