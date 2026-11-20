import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';

const project = process.cwd();
const roots = process.argv[2] ? [process.argv[2]] : ['.', 'dist', 'build', 'out', 'public'];
const inside = (root, file) => file === root || file.startsWith(root + sep);
let root;
for (const name of roots) {
  const candidate = resolve(project, name);
  try {
    if (inside(project, candidate) && await realpath(candidate) === candidate &&
        (await stat(join(candidate, 'index.html'))).isFile()) {
      root = candidate;
      break;
    }
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
  }
}
if (!root) throw new Error('找不到 index.html，请指定静态目录，或使用项目启动命令。');

const mime = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8', '.wasm': 'application/wasm'
};

createServer(async (req, res) => {
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pathname.split('/').some(part => part.startsWith('.'))) return res.writeHead(404).end('Not found');
    let file = resolve(root, '.' + pathname);
    if (!inside(root, file) || await realpath(file) !== file) return res.writeHead(404).end('Not found');
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    if (await realpath(file) !== file) return res.writeHead(404).end('Not found');
    const info = await stat(file);
    if (!info.isFile()) return res.writeHead(404).end('Not found');
    res.writeHead(200, { 'Content-Type': mime[extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': info.size });
    if (req.method === 'HEAD') return res.end();
    await pipeline(createReadStream(file), res);
  } catch {
    if (res.headersSent) return res.destroy();
    res.writeHead(404).end('Not found');
  }
}).listen(process.env.WORKBENCH_PREVIEW_SOCKET);
