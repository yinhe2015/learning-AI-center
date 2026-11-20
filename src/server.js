import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { randomUUID } from 'node:crypto';
import { constants, createReadStream, openSync, readFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { db, authenticate, clearSessionCookie, login, session, createProject, projectPath, HttpError } from './store.js';
import { snapshot, subscribe, startTurn, stopTurn, answerQuestion, shutdownTurns } from './codex.js';
import { projectFiles } from './files.js';
import { prepareLan } from './lan.js';
import { createUpload, getUpload, listUploads, turnUploads } from './uploads.js';
import { previewStatus, shutdownPreviews, startPreview, stopPreview } from './preview.js';

if (process.platform !== 'darwin') throw new Error('本服务需要 macOS 和本机 Codex。');
const port = Number(process.env.PORT || 8765);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 无效。');
const lan = process.argv.includes('--lan') ? prepareLan() : null;
const localHosts = new Set(['127.0.0.1', 'localhost'].flatMap(address =>
  port === 80 ? [address, `${address}:${port}`] : [`${address}:${port}`]
));
const remoteOrigins = new Map();
for (const host of lan ? [lan.address, lan.hostname].filter(Boolean) : []) {
  const url = new URL(`https://${host}:${port}`);
  remoteOrigins.set(url.host, url.origin);
  remoteOrigins.set(`${host}:${port}`, url.origin);
}
const styles = "default-src 'self'; style-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const assets = new Map([
  ['/', ['index.html', 'text/html']],
  ['/app.js', ['app.js', 'text/javascript']],
  ['/style.css', ['style.css', 'text/css']]
].map(([route, [file, type]]) => [route, { type, data: readFileSync(new URL(`../public/${file}`, import.meta.url)) }]));

const streams = new Map();
const getProject = db.prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?');
const getChat = db.prepare(`
  SELECT chats.* FROM chats JOIN projects ON projects.id = chats.project_id
  WHERE chats.id = ? AND projects.user_id = ?
`);
let pendingAuth = 0;

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function body(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new HttpError(415, '需要 JSON 请求。');
  if (Number(req.headers['content-length']) > 96_000) throw new HttpError(413, '请求内容过长。');
  const parts = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 96_000) throw new HttpError(413, '请求内容过长。');
    parts.push(chunk);
  }
  let result;
  try { result = JSON.parse(Buffer.concat(parts)); } catch { throw new HttpError(400, '请求内容无效。'); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new HttpError(400, '请求内容无效。');
  return result;
}

async function sendUpload(res, item, download) {
  const fd = openSync(item.path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  const name = encodeURIComponent(item.name).replace(/[!'()*]/g, character => '%' + character.charCodeAt(0).toString(16));
  const inline = Boolean(item.image_type && !download);
  res.setHeader('Content-Type', inline ? item.image_type : 'application/octet-stream');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${name}`);
  await pipeline(createReadStream(item.path, { fd }), res);
}

function eventStream(req, res, user, chatId, secure) {
  const group = streams.get(user.hash) || new Set();
  if (group.size >= 10) throw new HttpError(429, '打开的会话页面过多。');
  streams.set(user.hash, group);
  group.add(res);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const send = state => {
    if (res.writableEnded) return;
    if (res.writableLength > 1_000_000) return res.destroy();
    res.write(`data: ${JSON.stringify(state)}\n\n`);
  };
  const unsubscribe = subscribe(chatId, send);
  const heartbeat = setInterval(() => {
    if (!session(req, secure)) res.end();
    else res.write(': heartbeat\n\n');
  }, 15_000);
  res.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
    group.delete(res);
    if (!group.size) streams.delete(user.hash);
  });
  send(snapshot(chatId));
}

async function serve(req, res, secure) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', styles);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');

  try {
    if (!(secure ? remoteOrigins : localHosts).has(req.headers.host)) {
      throw new HttpError(403, '请使用工作台启动时显示的地址。');
    }
    const origin = secure ? remoteOrigins.get(req.headers.host) : new URL(`http://${req.headers.host}`).origin;
    const { pathname, searchParams } = new URL(req.url, origin);
    const method = req.method;
    if (method !== 'GET' && (method !== 'POST' || req.headers.origin !== origin)) {
      throw new HttpError(403, '请求来源无效。');
    }
    if (method === 'GET' && assets.has(pathname)) {
      const asset = assets.get(pathname);
      res.writeHead(200, { 'Content-Type': `${asset.type}; charset=utf-8` });
      return res.end(asset.data);
    }
    const user = session(req, secure);
    if (method === 'GET' && pathname === '/api/me') return json(res, 200, { user: user ? { name: user.name } : null });
    if (method === 'POST' && ['/api/register', '/api/login'].includes(pathname)) {
      const data = await body(req);
      if (pendingAuth >= 8) throw new HttpError(429, '登录请求较多，请稍后重试。');
      pendingAuth++;
      try {
        const account = await authenticate(data.name, data.password, pathname === '/api/register');
        if (user) {
          db.prepare('DELETE FROM sessions WHERE hash = ?').run(user.hash);
          for (const stream of streams.get(user.hash) || []) stream.end();
        }
        res.setHeader('Set-Cookie', login(account, secure));
        return json(res, 200, { user: { name: account.name } });
      } finally { pendingAuth--; }
    }
    if (!user) throw new HttpError(401, '请先登录。');

    if (method === 'POST' && pathname === '/api/logout') {
      db.prepare('DELETE FROM sessions WHERE hash = ?').run(user.hash);
      for (const stream of streams.get(user.hash) || []) stream.end();
      res.setHeader('Set-Cookie', clearSessionCookie(secure));
      return json(res, 200, {});
    }
    if (pathname === '/api/projects') {
      if (method === 'GET') {
        const projects = db.prepare('SELECT id, name FROM projects WHERE user_id = ? ORDER BY name COLLATE NOCASE').all(user.id);
        return json(res, 200, { projects });
      }
      return json(res, 201, createProject(user.id, (await body(req)).name));
    }
    const projectMatch = pathname.match(/^\/api\/projects\/([a-f0-9-]+)\/(chats|files|file|preview(?:\/stop)?|uploads(?:\/([a-f0-9-]+))?)$/);
    if (projectMatch) {
      const [, id, action, uploadId] = projectMatch;
      const project = getProject.get(id, user.id);
      if (!project) throw new HttpError(404, '项目不存在。');
      if (action === 'preview') {
        const hostname = secure ? new URL(origin).hostname : null;
        if (method === 'GET') return json(res, 200, previewStatus(id, hostname));
        return json(res, 200, await startPreview(project, await body(req), lan, hostname));
      }
      if (action === 'preview/stop') {
        if (method !== 'POST') throw new HttpError(405, '此地址用于停止项目预览。');
        return json(res, 200, stopPreview(id));
      }
      if (uploadId) {
        if (method !== 'GET') throw new HttpError(405, '此地址用于读取项目资料。');
        return await sendUpload(res, getUpload(project, uploadId), searchParams.has('download'));
      }
      if (action === 'uploads') {
        if (method === 'GET') return json(res, 200, { uploads: listUploads(project) });
        return json(res, 201, await createUpload(req, project, searchParams.get('name')));
      }
      if (action === 'chats' && method === 'GET') {
        const chats = db.prepare('SELECT id, title, updated FROM chats WHERE project_id = ? ORDER BY updated DESC').all(id);
        return json(res, 200, { chats });
      }
      if (action === 'chats') {
        const chat = { id: randomUUID(), title: '新会话', updated: Date.now() };
        db.prepare('INSERT INTO chats (id, project_id, title, updated) VALUES (?, ?, ?, ?)').run(chat.id, id, chat.title, chat.updated);
        return json(res, 201, chat);
      }
      if (method === 'GET') {
        const directory = projectPath(project);
        return json(res, 200, await projectFiles(directory, searchParams.get('path') || '', action === 'files' ? 'list' : 'read'));
      }
    }
    const chatMatch = pathname.match(/^\/api\/chats\/([a-f0-9-]+)\/(events|turn|stop|answers\/([a-f0-9-]+))$/);
    if (chatMatch) {
      const [, chatId, action, questionId] = chatMatch;
      const chat = getChat.get(chatId, user.id);
      if (!chat) throw new HttpError(404, '会话不存在。');
      if (method === 'GET' && action === 'events') return eventStream(req, res, user, chatId, secure);
      if (method === 'POST' && action === 'turn') {
        const { text, plan, attachments } = await body(req);
        const project = getProject.get(chat.project_id, user.id);
        startTurn(chat, project, text, plan === true, turnUploads(project, attachments));
        return json(res, 202, {});
      }
      if (method === 'POST' && action === 'stop') {
        await stopTurn(chatId);
        return json(res, 200, {});
      }
      if (method === 'POST' && questionId) {
        answerQuestion(chatId, questionId, (await body(req)).answers);
        return json(res, 200, {});
      }
    }
    throw new HttpError(404, '找不到该页面。');
  } catch (error) {
    if (res.headersSent || res.destroyed) return res.end();
    if (req.method === 'POST' && !req.complete) res.setHeader('Connection', 'close');
    if (!(error instanceof HttpError)) console.error('HTTP:', error.message);
    json(res, error.status || 500, { error: error.status ? error.message : '本机服务发生错误。' });
  }
}

const server = createHttpServer((req, res) => serve(req, res, false));
const remote = lan && createHttpsServer({ key: lan.key, cert: lan.cert }, (req, res) => serve(req, res, true));
let closing = false;

function shutdown() {
  if (closing) return;
  closing = true;
  shutdownPreviews();
  shutdownTurns();
  for (const group of streams.values()) for (const res of group) res.end();
  server.close();
  remote?.close();
}

server.listen(port, '127.0.0.1', () => console.log(`Codex 工作台正在运行 http://127.0.0.1:${port}`));
remote?.listen(port, lan?.address, () => {
  for (const origin of new Set(remoteOrigins.values())) console.log(`局域网入口 ${origin}`);
  console.log(`远程设备信任证书 ${lan.caCert}`);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, shutdown);
