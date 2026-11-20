import { randomUUID } from 'node:crypto';
import { constants, lstatSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { db, HttpError, projectPath, uploadFolder } from './store.js';

const mib = 1024 * 1024;
const maxFile = 25 * mib;
const maxImage = 10 * mib;
const maxProject = 512 * mib;
const idPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const add = db.prepare('INSERT INTO attachments (id, project_id, name, size, image_type) VALUES (?, ?, ?, ?, ?)');
const find = db.prepare('SELECT id, name, size, image_type FROM attachments WHERE id = ? AND project_id = ?');
const list = db.prepare('SELECT id, name, size, image_type FROM attachments WHERE project_id = ? ORDER BY rowid DESC');
const total = db.prepare('SELECT COALESCE(SUM(size), 0) AS bytes FROM attachments WHERE project_id = ?');
let reading = 0;

function imageType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) return 'image/jpeg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function attachmentPath(item) {
  return `${uploadFolder}/${item.id}/${item.name}`;
}

function checkedFile(project, item) {
  const path = join(projectPath(project), attachmentPath(item));
  try {
    if (realpathSync(path) === path && lstatSync(path).isFile()) return path;
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR' && error.code !== 'ELOOP') throw error;
  }
  throw new HttpError(404, '资料文件不存在。');
}

export function listUploads(project) {
  return list.all(project.id);
}

export function getUpload(project, id) {
  const upload = idPattern.test(id) && find.get(id, project.id);
  if (!upload) throw new HttpError(404, '资料不存在。');
  return { ...upload, relative: attachmentPath(upload), path: checkedFile(project, upload) };
}

export function turnUploads(project, ids = []) {
  if (!Array.isArray(ids) || ids.length > 6 || !ids.every(id => typeof id === 'string' && idPattern.test(id)) || new Set(ids).size !== ids.length) {
    throw new HttpError(400, '每条消息最多附上 6 个不同的项目资料。');
  }
  const items = ids.map(id => getUpload(project, id));
  if (items.reduce((size, item) => size + (item.image_type ? item.size : 0), 0) > 20 * mib) {
    throw new HttpError(413, '每条消息的图片总大小最多 20 MB。');
  }
  return items;
}

export async function createUpload(req, project, name) {
  if (!name || !name.trim() || name === '.' || name === '..' || /[\\/\u0000-\u001f\u007f]/.test(name) || Buffer.byteLength(name) > 200) {
    throw new HttpError(400, '文件名无效或过长。');
  }
  if (req.headers['content-type'] !== 'application/octet-stream') throw new HttpError(415, '需要上传文件内容。');
  if (Number(req.headers['content-length']) > maxFile) throw new HttpError(413, '单个资料最多 25 MB。');
  if (reading >= 3) throw new HttpError(429, '上传过多，请稍后重试。');
  const directory = projectPath(project);
  const chunks = [];
  let size = 0;
  reading++;
  try {
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      size += chunk.length;
      if (size > maxFile) throw new HttpError(413, '单个资料最多 25 MB。');
      chunks.push(chunk);
    }
    if (!size) throw new HttpError(400, '无法上传空文件。');
    if (total.get(project.id).bytes + size > maxProject) throw new HttpError(413, '这个项目的资料已超过 512 MB。');
    const bytes = Buffer.concat(chunks, size);
    const image_type = imageType(bytes);
    if (image_type && size > maxImage) throw new HttpError(413, '单张图片最多 10 MB。');
    const uploads = join(directory, uploadFolder);
    try { mkdirSync(uploads, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (!lstatSync(uploads).isDirectory() || realpathSync(uploads) !== uploads) {
      throw new HttpError(409, '项目资料目录无效，请在 Mac 上检查。');
    }
    const id = randomUUID();
    const slot = join(uploads, id);
    mkdirSync(slot, { mode: 0o700 });
    try {
      writeFileSync(join(slot, name), bytes, { flag: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode: 0o600 });
      add.run(id, project.id, name, size, image_type);
    } catch (error) {
      rmSync(slot, { recursive: true, force: true });
      throw error;
    }
    return { id, name, size, image_type };
  } finally {
    reading--;
  }
}
