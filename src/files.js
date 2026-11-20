import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HttpError, uploadFolder } from './store.js';
import { sandboxCommand } from './codex.js';

const run = promisify(execFile);
const preview = `
import { constants, closeSync, fstatSync, lstatSync, openSync, readdirSync, readSync } from 'node:fs';
import { join } from 'node:path';

const [root, relative, mode] = process.argv.slice(1);
function readProject() {
  let target = root;
  for (const part of relative ? relative.split('/') : []) {
    target = join(target, part);
    if (lstatSync(target).isSymbolicLink()) return { error: 'missing' };
  }
  if (mode === 'list') {
    const entries = readdirSync(target, { withFileTypes: true })
      .filter(entry => (entry.isDirectory() || entry.isFile()) && !['.codex', '.agents', ${JSON.stringify(uploadFolder)}].includes(entry.name))
      .map(entry => ({ name: entry.name, directory: entry.isDirectory() }))
      .sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
    return { entries: entries.slice(0, 400), limited: entries.length > 400 };
  }
  const fd = openSync(target, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) return { error: 'missing' };
    const limit = 256 * 1024;
    if (info.size > limit) return { error: 'size' };
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length);
      if (!count) break;
      length += count;
    }
    if (length > limit) return { error: 'size' };
    const content = bytes.subarray(0, length);
    if (content.includes(0)) return { error: 'binary' };
    try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(content) }; }
    catch { return { error: 'binary' }; }
  } finally {
    closeSync(fd);
  }
}
try { console.log(JSON.stringify(readProject())); }
catch { console.log(JSON.stringify({ error: 'missing' })); }
`;

export async function projectFiles(directory, relative, mode) {
  if (relative.length > 2048 || relative.includes('\0') || (mode === 'read' && !relative) ||
      (relative && relative.split('/').some(part => !part || ['.', '..', '.codex', '.agents'].includes(part)))) {
    throw new HttpError(400, '文件路径无效。');
  }
  const command = sandboxCommand(directory, [process.execPath, '--input-type=module', '--eval', preview, '--', directory, relative, mode]);
  let result;
  try {
    const { stdout } = await run(command.executable, command.args, { timeout: 5000, maxBuffer: 2_000_000, env: command.env });
    result = JSON.parse(stdout);
  } catch (error) {
    if (process.env.WORKBENCH_DEBUG === '1') console.error('File preview:', error.stderr || error.code);
    throw new HttpError(503, '无法读取项目目录，请稍后重试。');
  }
  if (result.error === 'missing') throw new HttpError(404, '文件或目录不存在，或无法预览。');
  if (result.error === 'size') throw new HttpError(413, '文件超过 256 KB，无法预览。');
  if (result.error === 'binary') throw new HttpError(415, '网页预览支持 UTF-8 文本文件。');
  return result;
}
