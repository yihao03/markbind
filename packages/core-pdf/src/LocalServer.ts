import path from 'path';
import http from 'http';
import fs from 'fs';

const MIME_TYPES: Record<string, string> = {
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

/**
 * Start a minimal static HTTP server serving the built site.
 * Strips the baseUrl prefix from incoming requests so paths map to
 * the site output directory root.
 */
export function startLocalServer(
  siteRoot: string,
  baseUrl: string,
): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const normalizedBase = baseUrl.replace(/\/$/, '');

    const server = http.createServer(async (req, res) => {
      const urlPath = decodeURIComponent(req.url || '/');
      let cleanPath = urlPath.split('?')[0];

      // Strip baseUrl prefix so the path maps to the _site/ root.
      // MarkBind outputs files at _site/ root regardless of baseUrl,
      // but internal links include the baseUrl prefix.
      if (normalizedBase && cleanPath.startsWith(normalizedBase)) {
        cleanPath = cleanPath.slice(normalizedBase.length) || '/';
      }

      let filePath = path.join(siteRoot, cleanPath);

      try {
        const stat = await fs.promises.stat(filePath);
        if (stat.isDirectory()) {
          filePath = path.join(filePath, 'index.html');
          // Verify the index.html exists
          await fs.promises.stat(filePath);
        }
      } catch {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
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
