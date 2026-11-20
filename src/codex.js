import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { chmodSync, copyFileSync, existsSync, renameSync, statSync } from 'node:fs';
import { codexHome, db, HttpError, projectPath, root, uploadFolder } from './store.js';

const executable = process.env.WORKBENCH_CODEX || 'codex';
const path = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
const disabled = [
  'apps', 'plugins', 'remote_plugin', 'hooks', 'browser_use', 'browser_use_external',
  'in_app_browser', 'computer_use', 'in_app_local_automation', 'shell_snapshot',
  'skill_mcp_dependency_install', 'multi_agent', 'multi_agent_v2'
];
const profile = 'workbench-project';
const runtimeReads = [
  '/opt/homebrew/bin', '/opt/homebrew/Cellar', '/opt/homebrew/opt',
  '/opt/homebrew/lib/node_modules/@openai/codex', '/usr/local/bin', '/usr/local/Cellar',
  '/usr/local/opt', '/usr/local/lib/node_modules/@openai/codex', process.execPath
];
const proxySettings = Object.fromEntries(
  ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']
    .filter(name => process.env[name])
    .map(name => [name, process.env[name]])
);

function prepareAuth() {
  const source = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json');
  const destination = join(codexHome, 'auth.json');
  if (!existsSync(source)) {
    throw new HttpError(503, '找不到本机 Codex 登录文件，请先在终端运行 codex login。');
  }
  if (source !== destination &&
      (!existsSync(destination) || statSync(source).mtimeMs > statSync(destination).mtimeMs)) {
    const temporary = join(codexHome, 'auth-import.json');
    copyFileSync(source, temporary);
    chmodSync(temporary, 0o600);
    renameSync(temporary, destination);
  }
}

function settings(directory, { readable = [], writable = [], environment = {} } = {}) {
  const filesystem = {
    ':minimal': 'read',
    ...Object.fromEntries(runtimeReads.map(path => [path, 'read'])),
    '/private/tmp': 'deny',
    [directory]: 'write',
    ...Object.fromEntries(readable.map(path => [path, 'read'])),
    ...Object.fromEntries(writable.map(path => [path, 'write'])),
    [join(directory, uploadFolder)]: 'read',
    [join(directory, '.codex')]: 'deny',
    [join(directory, '.agents')]: 'deny',
    [codexHome]: 'deny',
    [join(root, 'tls')]: 'deny'
  };
  const rules = Object.entries(filesystem).map(([key, mode]) => `${JSON.stringify(key)} = "${mode}"`).join(', ');
  return [
    'approval_policy="never"',
    'allow_login_shell=false',
    'cli_auth_credentials_store="file"',
    'web_search="disabled"',
    'project_root_markers=[]',
    'shell_environment_policy.inherit="none"',
    `shell_environment_policy.set.PATH=${JSON.stringify(path)}`,
    `shell_environment_policy.set.HOME=${JSON.stringify(directory)}`,
    'shell_environment_policy.set.SHELL="/bin/sh"',
    'shell_environment_policy.set.GIT_CONFIG_NOSYSTEM="1"',
    'shell_environment_policy.set.GIT_CONFIG_GLOBAL="/dev/null"',
    'shell_environment_policy.set.PYTHONNOUSERSITE="1"',
    'shell_environment_policy.set.OPENSSL_CONF="/dev/null"',
    ...Object.entries(environment).map(([key, value]) => `shell_environment_policy.set.${key}=${JSON.stringify(value)}`),
    `projects={ ${JSON.stringify(directory)} = { trust_level = "untrusted" } }`,
    `default_permissions="${profile}"`,
    `permissions={ ${profile} = { filesystem = { ${rules} }, network = { enabled = false } } }`,
    'features.default_mode_request_user_input=true',
    ...disabled.map(feature => `features.${feature}=false`)
  ];
}


export function sandboxCommand(directory, command, options = {}) {
  const socket = options.socket ? ['--allow-unix-socket', options.socket] : [];
  const args = ['sandbox', '-C', directory, '-P', profile, ...settings(directory, options).flatMap(setting => ['-c', setting]), ...socket, '--', ...command];
  return { executable, args, env: { HOME: homedir(), CODEX_HOME: codexHome, PATH: path, LANG: 'en_US.UTF-8' } };
}

export class CodexProcess {
  constructor(directory, onEvent, onExit) {
    if (process.platform !== 'darwin' || !isAbsolute(directory)) throw new Error('Codex 项目隔离需要本机 macOS。');
    prepareAuth();
    this.directory = directory;
    this.sequence = 0;
    this.requests = new Map();
    this.closed = false;
    this.child = spawn(executable, ['app-server', '--listen', 'stdio://', ...settings(directory).flatMap(setting => ['-c', setting])], {
      cwd: directory,
      env: { HOME: homedir(), CODEX_HOME: codexHome, PATH: path, SHELL: '/bin/sh', LANG: 'en_US.UTF-8', ...proxySettings },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    if (process.env.WORKBENCH_DEBUG === '1') this.child.stderr.pipe(process.stderr, { end: false });
    else this.child.stderr.resume();
    this.child.stdin.on('error', () => this.child.kill());
    this.child.once('error', terminate);
    this.child.once('close', () => terminate(new Error('本机 Codex 进程已退出。')));
    const self = this;
    function terminate(error) {
      if (self.closed) return;
      self.closed = true;
      for (const pending of self.requests.values()) pending.reject(error);
      self.requests.clear();
      onExit?.(error);
    }
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.method) {
        try { onEvent?.(message); } catch (error) {
          console.error('Codex event:', error.message);
          this.child.kill();
        }
      } else if (this.requests.has(message.id)) {
        const pending = this.requests.get(message.id);
        this.requests.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      }
    });
  }

  send(message) {
    if (this.closed || !this.child.stdin.writable) throw new Error('本机 Codex 进程已关闭。');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  call(method, params, timeout = 30_000) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(id);
        reject(new Error('本机 Codex 响应超时。'));
      }, timeout);
      this.requests.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); }
      });
      try { this.send({ id, method, params }); } catch (error) {
        this.requests.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  async initialize() {
    await this.call('initialize', {
      clientInfo: { name: 'learning_ai_center', title: 'Learning AI Center', version: '0.1.0' },
      capabilities: { experimentalApi: true, requestAttestation: false }
    });
    this.send({ method: 'initialized' });
  }

  end() {
    this.child.stdin.end();
    setTimeout(() => {
      if (this.child.exitCode === null) this.child.kill();
    }, 1200).unref();
  }
}

const runs = new Map();
const listeners = new Map();
const addMessage = db.prepare('INSERT INTO messages (chat_id, role, text) VALUES (?, ?, ?)');
const updateChat = db.prepare('UPDATE chats SET updated = ? WHERE id = ?');

export function snapshot(chatId) {
  const run = runs.get(chatId);
  return {
    messages: db.prepare('SELECT role, text FROM messages WHERE chat_id = ? ORDER BY id').all(chatId),
    active: Boolean(run),
    draft: run ? [...run.drafts.values()].join('\n\n') : '',
    activity: run?.activity || '',
    questions: run ? [...run.questions].map(([id, question]) => ({ id, questions: question.questions, submitted: question.submitted })) : []
  };
}

export function subscribe(chatId, listener) {
  if (!listeners.has(chatId)) listeners.set(chatId, new Set());
  const group = listeners.get(chatId);
  group.add(listener);
  return () => {
    group.delete(listener);
    if (!group.size) listeners.delete(chatId);
  };
}

function publish(chatId) {
  const group = listeners.get(chatId);
  if (!group?.size) return;
  const state = snapshot(chatId);
  for (const listener of group) listener(state);
}

function queuePublish(run) {
  run.publishTimer ??= setTimeout(() => {
    run.publishTimer = null;
    publish(run.id);
  }, 55);
}

function finish(run, note) {
  if (runs.get(run.id) !== run) return;
  clearTimeout(run.publishTimer);
  clearTimeout(run.turnTimer);
  runs.delete(run.id);
  if (note) addMessage.run(run.id, 'status', note);
  updateChat.run(Date.now(), run.id);
  run.worker?.end();
  publish(run.id);
}

function saveReply(run, itemId, text) {
  run.drafts.delete(itemId);
  if (text?.trim()) addMessage.run(run.id, 'assistant', text);
}

function handleEvent(run, event) {
  if (runs.get(run.id) !== run) return;
  const { id, method, params = {} } = event;
  const { threadId, turn, item } = params;
  if (id !== undefined && typeof id !== 'object') {
    if (method === 'item/tool/requestUserInput' && threadId === run.threadId && Array.isArray(params.questions)) {
      run.questions.set(randomUUID(), { rpcId: id, questions: params.questions, submitted: false });
      publish(run.id);
      return;
    }
    run.worker.send({ id, error: { code: -32601, message: 'This request is disabled by the local workspace policy.' } });
    return;
  }
  if (threadId !== run.threadId) return;
  switch (method) {
    case 'turn/started':
      run.turnId = turn.id;
      break;
    case 'item/agentMessage/delta':
    case 'item/plan/delta':
      run.drafts.set(params.itemId, (run.drafts.get(params.itemId) || '') + params.delta);
      break;
    case 'item/started':
      if (item.type === 'commandExecution') run.activity = '正在执行项目命令';
      if (item.type === 'fileChange') run.activity = '正在修改项目文件';
      break;
    case 'item/completed':
      if (item.type === 'agentMessage' || item.type === 'plan') saveReply(run, item.id, item.text);
      if (['commandExecution', 'fileChange'].includes(item.type)) run.activity = '';
      break;
    case 'serverRequest/resolved':
      for (const [key, question] of run.questions) {
        if (question.rpcId === params.requestId) run.questions.delete(key);
      }
      break;
    case 'turn/completed':
      for (const [key, draft] of run.drafts) saveReply(run, key, draft);
      if (turn.status === 'failed') finish(run, 'Codex 执行失败。请检查本机登录状态或稍后重试。');
      else finish(run, turn.status === 'interrupted' ? '本轮已停止。' : '');
      return;
    default:
      return;
  }
  queuePublish(run);
}

export function startTurn(chat, project, prompt, plan, attachments = []) {
  if (runs.has(chat.id) || [...runs.values()].some(run => run.projectId === project.id)) {
    throw new HttpError(409, '该项目已有一轮正在运行。');
  }
  if (typeof prompt !== 'string' || prompt.length > 24_000 || (!prompt.trim() && !attachments.length)) {
    throw new HttpError(400, '请输入消息或添加附件，消息最多 24,000 个字符。');
  }
  const message = prompt.trim() || '请查看这些附件。';
  const attachmentNames = attachments.map(attachment => attachment.name);
  const paths = attachments.map(attachment => attachment.relative);
  const content = attachments.length ? `${message}\n\n本轮附件的项目相对路径为：\n${paths.map(path => `- ${JSON.stringify(path)}`).join('\n')}` : message;
  const stored = attachments.length ? `${prompt.trim()}\n\n附件：${attachmentNames.join('、')}`.trim() : message;

  const directory = projectPath(project);
  const run = { id: chat.id, projectId: project.id, drafts: new Map(), questions: new Map(), activity: '正在连接本机 Codex' };
  run.worker = new CodexProcess(directory, event => handleEvent(run, event), () => finish(run, '本机 Codex 已断开，可以发送新消息继续。'));
  runs.set(chat.id, run);
  try {
    addMessage.run(chat.id, 'user', stored);
    if (chat.title === '新会话') {
      db.prepare('UPDATE chats SET title = ? WHERE id = ?').run(Array.from(prompt.trim() || attachmentNames[0]).slice(0, 35).join(''), chat.id);
    }
  } catch (error) {
    finish(run);
    throw error;
  }
  updateChat.run(Date.now(), chat.id);
  publish(chat.id);

  void (async () => {
    try {
      await run.worker.initialize();
      const params = {
        cwd: directory, runtimeWorkspaceRoots: [directory], approvalPolicy: 'never', permissions: profile,
        developerInstructions: 'Project commands in this workbench cannot bind TCP ports. When the user wants to open a project website, point them to the project’s 项目预览 button, which starts a managed preview and shows its URL. Give them the static output directory or the exact foreground Node startup command. Do not claim the project is reachable until a preview has been started by the workbench.'
      };
      const info = chat.thread_id
        ? await run.worker.call('thread/resume', { ...params, threadId: chat.thread_id, excludeTurns: true })
        : await run.worker.call('thread/start', params);
      if (runs.get(run.id) !== run) return;
      if (info.activePermissionProfile?.id !== profile || info.approvalPolicy !== 'never' ||
          info.cwd !== directory || info.runtimeWorkspaceRoots?.join() !== directory) {
        throw new Error('Codex did not select the required project sandbox.');
      }
      run.threadId = info.thread.id;
      db.prepare('UPDATE chats SET thread_id = ? WHERE id = ?').run(run.threadId, chat.id);
      run.activity = '';
      const result = await run.worker.call('turn/start', {
        threadId: run.threadId,
        input: [
          { type: 'text', text: content, text_elements: [] },
          ...attachments.filter(attachment => attachment.image_type).map(attachment => ({ type: 'localImage', path: attachment.path }))
        ],
        collaborationMode: {
          mode: plan ? 'plan' : 'default',
          settings: { model: info.model, reasoning_effort: null, developer_instructions: null }
        }
      });
      if (runs.get(run.id) !== run) return;
      run.turnId = result.turn.id;
      publish(run.id);
      run.turnTimer = setTimeout(() => finish(run, '本轮运行超时，请发送新消息继续。'), 60 * 60 * 1000);
    } catch (error) {
      if (runs.get(run.id) !== run) return;
      console.error('Codex turn:', error.message);
      finish(run, '无法启动本轮。请检查本机 Codex 登录和项目沙盒后重试。');
    }
  })();
}

export function answerQuestion(chatId, questionId, answers) {
  const run = runs.get(chatId);
  const request = run?.questions.get(questionId);
  if (!request || request.submitted) throw new HttpError(409, '该问题已结束或已提交。');
  const response = Object.create(null);
  for (const question of request.questions) {
    const answer = answers && Object.hasOwn(answers, question.id) ? answers[question.id] : null;
    if (typeof answer !== 'string' || !answer.trim() || answer.length > 4000 ||
        (question.options?.length && !question.isOther && !question.options.some(option => option.label === answer))) {
      throw new HttpError(400, '请为每个问题填写有效回答。');
    }
    response[question.id] = { answers: [answer] };
  }
  run.worker.send({ id: request.rpcId, result: { answers: response } });
  request.submitted = true;
  publish(chatId);
}

export async function stopTurn(chatId) {
  const run = runs.get(chatId);
  if (!run) return;
  if (!run.turnId) {
    finish(run, '本轮已停止。');
    return;
  }
  try {
    await run.worker.call('turn/interrupt', { threadId: run.threadId, turnId: run.turnId }, 5000);
  } catch {
    finish(run, '本轮已停止。');
  }
}

export function shutdownTurns() {
  for (const run of runs.values()) finish(run, '本机服务已关闭，本轮已中断。');
}
