import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { sandboxCommand } from './codex.js';
import { HttpError, projectPath } from './store.js';

const shim = fileURLToPath(new URL('./preview-listen.cjs', import.meta.url));
const staticServer = fileURLToPath(new URL('./preview-static.js', import.meta.url));
const active = new Map();
const hopHeaders = ['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization',
  'transfer-encoding', 'upgrade', 'te', 'trailer'];

function proxyHeaders(headers, upgrade = false) {
  const result = { ...headers };
  const connection = String(result.connection || '').split(',').map(value => value.trim().toLowerCase());
  for (const key of [...hopHeaders, ...connection]) delete result[key];
  if (upgrade) {
    result.connection = 'Upgrade';
    result.upgrade = headers.upgrade;
  }
  return result;
}

function authorized(run, req) {
  const origin = run.origins.get(req.headers.host);
  if (!origin || (req.headers.origin && req.headers.origin !== origin)) return false;
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none' &&
      !(req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document' && req.method === 'GET')) return false;
  return (req.headers.cookie || '').split(/;\s*/).includes(`${run.cookieName}=${run.token}`);
}

function backendRequest(run, req, upgrade = false) {
  const headers = proxyHeaders(req.headers, upgrade);
  if (headers.cookie) {
    const cookies = headers.cookie.split(/;\s*/);
    headers.cookie = (run.lan
      ? cookies.filter(value => value.startsWith(run.appCookiePrefix)).map(value => value.slice(run.appCookiePrefix.length))
      : cookies.filter(value => !value.startsWith(run.cookieName + '='))).join('; ');
    if (!headers.cookie) delete headers.cookie;
  }
  delete headers.forwarded;
  headers['x-forwarded-host'] = req.headers.host;
  headers['x-forwarded-proto'] = run.lan ? 'https' : 'http';
  return request({ socketPath: run.socket, path: req.url, method: req.method, headers });
}

function gateway(run) {
  const handler = (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!run.origins.has(req.headers.host)) return res.writeHead(404).end();
    if (req.url === '/__workbench_open/' + run.token && req.method === 'GET') {
      res.writeHead(303, {
        Location: '/',
        'Referrer-Policy': 'no-referrer',
        'Set-Cookie': `${run.cookieName}=${run.token}; HttpOnly; SameSite=Lax; Path=/${run.lan ? '; Secure' : ''}`
      }).end();
      return;
    }
    if (!authorized(run, req)) return res.writeHead(403).end('从工作台打开此项目预览。');
    const upstream = backendRequest(run, req);
    upstream.on('response', response => {
      const headers = proxyHeaders(response.headers);
      // The browser sends host cookies across ports, so each LAN preview gets its own cookie names.
      if (run.lan) {
        delete headers['clear-site-data'];
        delete headers['strict-transport-security'];
      }
      if (headers['set-cookie']) {
        headers['set-cookie'] = run.lan
          ? headers['set-cookie'].map(cookie => run.appCookiePrefix + cookie.trimStart().replace(/;\s*Domain=[^;]*/gi, ''))
          : headers['set-cookie'].filter(cookie => !/^\s*wb_preview=/i.test(cookie));
      }
      res.writeHead(response.statusCode, headers);
      response.on('error', () => res.destroy());
      response.pipe(res);
    });
    upstream.on('error', () => {
      if (res.headersSent) return res.destroy();
      res.writeHead(502).end('项目预览暂不可用。');
    });
    res.once('close', () => upstream.destroy());
    req.pipe(upstream);
  };
  const server = run.lan ? createHttpsServer({ key: run.lan.key, cert: run.lan.cert }, handler) : createServer(handler);
  server.on('upgrade', (req, socket, head) => {
    if (!authorized(run, req)) return socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    const upstream = backendRequest(run, req, true);
    upstream.on('upgrade', (response, backend, backendHead) => {
      const fields = Object.entries(proxyHeaders(response.headers, true))
        .filter(([key]) => key !== 'set-cookie').flatMap(([key, value]) => [].concat(value).map(entry => `${key}: ${entry}\r\n`));
      socket.write('HTTP/1.1 101 Switching Protocols\r\n' + fields.join('') + '\r\n');
      if (backendHead.length) socket.write(backendHead);
      if (head.length) backend.write(head);
      socket.on('error', () => backend.destroy());
      backend.on('error', () => socket.destroy());
      socket.on('close', () => backend.destroy());
      backend.on('close', () => socket.destroy());
      socket.pipe(backend).pipe(socket);
    });
    upstream.on('response', response => { response.resume(); socket.destroy(); });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
    upstream.end();
  });
  run.connections = new Set();
  server.on('connection', socket => {
    run.connections.add(socket);
    socket.once('close', () => run.connections.delete(socket));
  });
  return server;
}

function probe(socket) {
  return new Promise(resolve => {
    const connection = connect(socket);
    connection.once('error', () => resolve(false));
    connection.once('connect', () => { connection.destroy(); resolve(true); });
  });
}

function stop(run) {
  if (active.get(run.id) !== run) return;
  active.delete(run.id);
  run.gateway.close();
  for (const socket of run.connections) socket.destroy();
  if (run.worker.pid) {
    try { process.kill(-run.worker.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    setTimeout(() => {
      try { process.kill(-run.worker.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') console.error(error.message); }
    }, 1000);
  }
  rmSync(run.scratch, { recursive: true, force: true });
}

export function previewStatus(projectId, hostname) {
  const run = active.get(projectId);
  if (!run) return { status: 'stopped' };
  if (!run.ready) return { status: 'starting' };
  const origin = run.origins.get(`${hostname}:${run.port}`) || run.origins.values().next().value;
  return { status: 'running', port: run.port, url: origin + '/__workbench_open/' + run.token };
}

function previewPorts(lan) {
  if (!lan) return [0, 0];
  const range = (process.env.WORKBENCH_PREVIEW_PORTS || '49152-49215').match(/^(\d{1,5})-(\d{1,5})$/);
  const start = Number(range?.[1]), end = Number(range?.[2]);
  if (!range || start < 1024 || end > 65535 || end < start || end - start > 1023) {
    throw new HttpError(500, 'WORKBENCH_PREVIEW_PORTS 无效，请使用 49152-49215 这样的端口范围。');
  }
  return [start, end];
}

async function listenPreview(run, [from, to]) {
  for (let port = from; port <= to && active.get(run.id) === run; port++) {
    try {
      await new Promise((resolve, reject) => {
        const server = run.gateway;
        const cleanup = () => {
          server.removeListener('error', failed);
          server.removeListener('listening', listening);
          server.removeListener('close', closed);
        };
        const failed = error => { cleanup(); reject(error); };
        const closed = () => failed(new Error('项目预览已停止。'));
        const listening = () => { cleanup(); resolve(); };
        server.once('error', failed);
        server.once('listening', listening);
        server.once('close', closed);
        server.listen(port, run.lan?.address || '::1');
      });
      return run.gateway.address().port;
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error('没有可用的预览端口，请先停止其他预览或检查端口范围。');
}

export async function startPreview(project, { command = '', directory = '' }, lan, hostname) {
  if (active.has(project.id)) return previewStatus(project.id, hostname);
  if (typeof command !== 'string' || command.length > 1500 || command.includes('\0') ||
      typeof directory !== 'string' || directory.length > 256 || directory.includes('\0') ||
      directory.startsWith('/') || directory.split('/').includes('..') || (command.trim() && directory.trim())) {
    throw new HttpError(400, '请输入项目启动命令，或填写项目内的静态目录。');
  }
  if (active.size >= 12) throw new HttpError(429, '当前预览较多，请先停止一个预览。');
  const ports = previewPorts(lan);
  const cwd = projectPath(project);
  const scratch = mkdtempSync('/private/tmp/workbench-preview-');
  const socket = join(scratch, 'app.sock');
  const nodeOptions = '--require=' + JSON.stringify(shim);
  const launch = sandboxCommand(cwd,
    command.trim() ? ['/bin/sh', '-c', command] : [process.execPath, staticServer, directory.trim()], {
      socket, writable: [scratch], readable: [shim, staticServer],
      environment: {
        WORKBENCH_PREVIEW_SOCKET: socket, NODE_OPTIONS: nodeOptions, PORT: '3000', HOST: '127.0.0.1',
        ...(lan?.hostname ? { __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: lan.hostname } : {})
      }
    });
  const worker = spawn(launch.executable, launch.args, { cwd, env: launch.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const tag = randomBytes(8).toString('hex');
  const run = {
    id: project.id, worker, socket, scratch, lan, token: randomBytes(32).toString('hex'),
    origins: new Map(), cookieName: lan ? `__Host-wb-preview-${tag}` : 'wb_preview',
    appCookiePrefix: `wb-app-${tag}-`, log: '', ready: false
  };
  run.gateway = gateway(run);
  active.set(project.id, run);
  for (const stream of [worker.stdout, worker.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', chunk => { run.log = (run.log + chunk).slice(-4000); });
  }
  worker.once('error', error => { run.log += error.message; stop(run); });
  worker.once('exit', () => stop(run));
  try {
    for (let count = 0; count < 150 && active.get(project.id) === run; count++) {
      if (await probe(socket) && active.get(project.id) === run) {
        run.port = await listenPreview(run, ports);
        if (active.get(project.id) !== run) break;
        const hosts = lan ? [lan.hostname, lan.address].filter(Boolean) : [`preview-${tag}.localhost`];
        for (const host of hosts) run.origins.set(`${host}:${run.port}`, `${lan ? 'https' : 'http'}://${host}:${run.port}`);
        run.ready = true;
        return previewStatus(project.id, hostname);
      }
      await delay(100);
    }
  } catch (error) { run.log += error.message; }
  stop(run);
  throw new HttpError(422, '无法启动项目预览。' + (run.log.trim() ? '\n' + run.log.trim() : '请检查启动命令是否提供 HTTP 服务。'));
}

export function stopPreview(projectId) {
  const run = active.get(projectId);
  if (run) stop(run);
  return previewStatus(projectId);
}

export function shutdownPreviews() {
  for (const run of active.values()) stop(run);
}
