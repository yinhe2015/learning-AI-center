import { randomBytes, randomUUID, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { mkdirSync, realpathSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

process.umask(0o077);
export const dataDir = resolve(process.env.WORKBENCH_DATA_DIR || fileURLToPath(new URL('../.workbench-data/', import.meta.url)));
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
export const root = realpathSync(dataDir);
export const codexHome = join(root, 'codex');
export const workspace = join(root, 'workspaces');
export const uploadFolder = '.workbench-uploads';
mkdirSync(codexHome, { recursive: true, mode: 0o700 });
mkdirSync(workspace, { recursive: true, mode: 0o700 });

export const db = new DatabaseSync(join(root, 'workbench.sqlite'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, salt TEXT NOT NULL, password TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL,
    UNIQUE(user_id, name)
  );
  CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL,
    thread_id TEXT, updated INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id), role TEXT NOT NULL, text TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), name TEXT NOT NULL,
    size INTEGER NOT NULL, image_type TEXT
  );
  CREATE INDEX IF NOT EXISTS attachments_project ON attachments(project_id);
`);

const derive = promisify(scrypt);
const digest = token => createHash('sha256').update(token).digest('hex');
const dummySalt = randomBytes(16).toString('hex');
const expiry = 7 * 24 * 60 * 60 * 1000;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function authenticate(name, password, register) {
  name = typeof name === 'string' ? name.trim().toLowerCase() : '';
  if (!/^[a-z0-9_-]{3,32}$/.test(name) || typeof password !== 'string' || password.length < 8 || password.length > 128) {
    throw new HttpError(400, '用户名须为 3–32 位字母、数字、下划线或连字符，密码至少 8 位且至多 128 位。');
  }
  const current = db.prepare('SELECT * FROM users WHERE name = ?').get(name);
  if (!register) {
    const candidate = await derive(password, current?.salt ?? dummySalt, 64);
    if (!current || !timingSafeEqual(candidate, Buffer.from(current.password, 'hex'))) {
      throw new HttpError(401, '用户名或密码不正确。');
    }
    return { id: current.id, name };
  }
  const salt = randomBytes(16).toString('hex');
  const key = await derive(password, salt, 64);
  const id = randomUUID();
  db.exec('BEGIN');
  try {
    const inserted = db.prepare('INSERT OR IGNORE INTO users VALUES (?, ?, ?, ?)').run(id, name, salt, key.toString('hex'));
    if (!inserted.changes) throw new HttpError(409, '用户名已被使用。');
    mkdirSync(join(workspace, id), { mode: 0o700 });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { id, name };
}

function sessionCookie(token, maxAge, secure) {
  const name = secure ? '__Host-workbench' : 'workbench';
  return `${name}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

export function clearSessionCookie(secure) {
  return sessionCookie('', 0, secure);
}

export function login(user, secure) {
  const token = randomBytes(32).toString('hex');
  db.prepare('DELETE FROM sessions WHERE expires <= ?').run(Date.now());
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(digest(token), user.id, Date.now() + expiry);
  return sessionCookie(token, expiry / 1000, secure);
}

export function session(req, secure) {
  const pattern = secure ? /(?:^|;\s*)__Host-workbench=([a-f0-9]{64})(?:;|$)/ : /(?:^|;\s*)workbench=([a-f0-9]{64})(?:;|$)/;
  const token = req.headers.cookie?.match(pattern)?.[1];
  if (!token) return null;
  const hash = digest(token);
  const user = db.prepare('SELECT users.id, users.name, sessions.expires FROM sessions JOIN users ON users.id = user_id WHERE hash = ? AND expires > ?').get(hash, Date.now());
  return user ? { ...user, hash } : null;
}

export function projectPath(project) {
  const path = join(workspace, project.user_id, project.id);
  let resolved;
  try { resolved = realpathSync(path); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (resolved !== path) throw new HttpError(409, '项目目录已移动，请在 Mac 上检查工作目录。');
  return path;
}

export function createProject(userId, name) {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 60) throw new HttpError(400, '请输入 1–60 个字符的项目名称。');
  name = name.trim();
  const id = randomUUID();
  db.exec('BEGIN');
  try {
    const inserted = db.prepare('INSERT OR IGNORE INTO projects VALUES (?, ?, ?)').run(id, userId, name);
    if (!inserted.changes) throw new HttpError(409, '你已有同名项目。');
    mkdirSync(join(workspace, userId, id), { mode: 0o700 });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { id, name };
}
