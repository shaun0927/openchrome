import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { AddressInfo } from 'net';

export interface FixtureServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

export async function startFixtureServer(rootDir: string): Promise<FixtureServer> {
  const server = http.createServer((req, res) => {
    const urlPath = (req.url || '/').split('?')[0];
    const safe = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
    const filePath = path.join(rootDir, safe === '/' ? 'index.html' : safe);
    if (!filePath.startsWith(path.resolve(rootDir))) {
      res.statusCode = 403;
      res.end('forbidden');
      return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(data);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
