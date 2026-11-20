const byId = id => document.getElementById(id);
const authForm = byId('auth-form');
const projectForm = byId('project-form');
const composer = byId('composer');
const message = byId('message');
const timeline = byId('timeline');
const messages = byId('messages');
const questions = byId('questions');
const projectDialog = byId('project-dialog');
const previewDialog = byId('preview-dialog');
const previewForm = byId('preview-form');
const filePanel = byId('files');

const state = {
  user: null, register: false, projects: [], chats: [], project: null, chat: null,
  stream: null, snapshot: null, sending: false, filePath: '', fileRequest: 0,
  messageCount: 0, draft: null, sendingQuestion: new Set(), attachments: [], uploading: false,
  preview: null, previewBusy: false
};

async function api(path, post, file = false) {
  const options = post === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': file ? 'application/octet-stream' : 'application/json' },
    body: file ? post : JSON.stringify(post)
  };
  const response = await fetch('/api' + path, options);
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && state.user) showAuth();
    throw new Error(data.error || '请求失败，请重试。');
  }
  return data;
}

function element(tag, text, className) {
  const item = document.createElement(tag);
  if (text) item.textContent = text;
  if (className) item.className = className;
  return item;
}

function navItem(text, selected, action) {
  const button = element('button', text, 'nav-item');
  button.type = 'button';
  if (selected) button.setAttribute('aria-current', 'true');
  button.addEventListener('click', action);
  return button;
}

function setAuthMode(register) {
  state.register = register;
  byId('register-tab').setAttribute('aria-pressed', register);
  byId('login-tab').setAttribute('aria-pressed', !register);
  byId('auth-submit').textContent = register ? '创建账户' : '登录';
  authForm.elements.password.autocomplete = register ? 'new-password' : 'current-password';
  byId('auth-error').textContent = '';
}

function closeStream() {
  state.stream?.close();
  state.stream = null;
}

function showAuth() {
  closeStream();
  state.user = null;
  state.projects = [];
  state.chats = [];
  state.project = null;
  state.chat = null;
  state.sending = false;
  state.fileRequest++;
  filePanel.hidden = true;
  if (projectDialog.open) projectDialog.close();
  if (previewDialog.open) previewDialog.close();
  byId('workbench').hidden = true;
  byId('auth').hidden = false;
  authForm.reset();
  setAuthMode(false);
  resetConversation();
}

async function openWorkspace(user) {
  state.user = user;
  byId('username').textContent = user.name;
  byId('avatar').textContent = user.name[0].toUpperCase();
  byId('auth').hidden = true;
  byId('workbench').hidden = false;
  byId('chat-error').textContent = '';
  await loadProjects();
  if (state.user !== user) return;
  const last = localStorage.getItem('project:' + user.name);
  await chooseProject(state.projects.find(project => project.id === last) || state.projects[0]);
}

async function loadProjects() {
  const user = state.user;
  const { projects } = await api('/projects');
  if (state.user !== user) return;
  state.projects = projects;
  renderLists();
}

function renderLists() {
  byId('projects').replaceChildren(...(state.projects.length
    ? state.projects.map(project => navItem(project.name, project.id === state.project?.id, () => {
      if (project !== state.project) chooseProject(project).catch(showChatError);
    }))
    : [element('p', '暂无项目', 'nav-hint')]));
  byId('chats').replaceChildren(...(state.chats.length
    ? state.chats.map(chat => navItem(chat.title, chat.id === state.chat?.id, () => chooseChat(chat)))
    : [element('p', state.project ? '暂无会话' : '选择项目后显示', 'nav-hint')]));
  byId('new-chat').disabled = !state.project;
  byId('files-toggle').disabled = !state.project;
  byId('preview-project').disabled = !state.project;
  byId('project-name').textContent = state.project?.name || '工作区';
  byId('chat-name').textContent = state.chat?.title || '';
}

function resetConversation() {
  state.snapshot = null;
  state.messageCount = 0;
  state.draft = null;
  messages.replaceChildren();
  questions.replaceChildren();
  state.sendingQuestion.clear();
  state.attachments = [];
  renderAttachments();
  message.value = '';
  byId('chat-error').textContent = '';
  renderConversation();
}

async function chooseProject(project) {
  if (!state.user) return;
  const user = state.user;
  closeStream();
  state.project = project || null;
  state.chat = null;
  state.chats = [];
  state.sending = false;
  filePanel.hidden = true;
  state.fileRequest++;
  byId('upload-status').hidden = true;
  byId('files-toggle').setAttribute('aria-pressed', false);
  resetConversation();
  renderLists();
  if (!project) return;
  localStorage.setItem('project:' + user.name, project.id);
  const { chats } = await api('/projects/' + project.id + '/chats');
  if (state.user !== user || state.project !== project) return;
  state.chats = chats;
  const last = localStorage.getItem('chat:' + project.id);
  chooseChat(chats.find(chat => chat.id === last) || chats[0]);
}

function chooseChat(chat) {
  if (chat && chat.id === state.chat?.id) return;
  closeStream();
  state.chat = chat || null;
  state.sending = false;
  resetConversation();
  renderLists();
  if (!chat) return;
  localStorage.setItem('chat:' + state.project.id, chat.id);
  const stream = new EventSource('/api/chats/' + chat.id + '/events');
  state.stream = stream;
  stream.onmessage = event => {
    if (state.stream !== stream) return;
    state.snapshot = JSON.parse(event.data);
    renderConversation();
  };
  stream.onerror = async () => {
    if (state.stream !== stream) return;
    renderConversation();
    try {
      const { user } = await api('/me');
      if (!user && state.stream === stream) showAuth();
    } catch (error) { showChatError(error); }
  };
}

function renderConversation() {
  const snapshot = state.snapshot;
  const entries = snapshot?.messages || [];
  const hasChat = Boolean(state.chat);
  const showEmpty = !entries.length && !snapshot?.draft;
  byId('empty').hidden = !showEmpty;
  composer.hidden = !hasChat;
  byId('empty-title').textContent = hasChat ? '开始本轮对话' : state.project ? '新建一个会话' : '创建第一个项目';
  byId('empty-description').textContent = hasChat ? '告诉 Codex 你想在这个项目里做什么。'
    : state.project ? '在当前项目中打开一个 Codex 会话。' : '每个项目都有自己的目录和 Codex 会话。';
  byId('empty-action').hidden = hasChat;
  byId('empty-action').textContent = state.project ? '新建会话' : '创建项目';

  const atEnd = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 120;
  state.draft?.remove();
  for (const entry of entries.slice(state.messageCount)) messages.append(renderMessage(entry));
  state.messageCount = entries.length;
  state.draft = snapshot?.draft ? renderMessage({ role: 'assistant', text: snapshot.draft }) : null;
  if (state.draft) messages.append(state.draft);
  if (atEnd) timeline.scrollTop = timeline.scrollHeight;

  renderQuestions(snapshot?.questions || []);
  const connected = state.stream?.readyState === EventSource.OPEN;
  byId('send').disabled = !connected || !snapshot || snapshot.active || state.sending || state.uploading || (!message.value.trim() && !state.attachments.length);
  byId('attach-files').disabled = state.uploading || state.sending;
  byId('upload-files').disabled = state.uploading;
  byId('stop').hidden = !snapshot?.active;
  byId('activity').textContent = !hasChat ? '' : state.uploading ? '正在上传' : !connected ? '连接中' : snapshot?.activity
    || (snapshot?.active ? (snapshot.questions.length ? '等待回答' : 'Codex 正在运行') : '');
}

function renderMessage(entry) {
  const post = element('article', '', 'message ' + entry.role);
  if (entry.role !== 'status') post.append(element('header', entry.role === 'user' ? '你' : 'Codex'));
  post.append(element('div', entry.text, 'content'));
  return post;
}

function renderQuestions(requests) {
  const current = new Set(requests.map(request => request.id));
  for (const card of [...questions.children]) {
    if (!current.has(card.dataset.id)) card.remove();
  }
  for (const request of requests) {
    let card = [...questions.children].find(form => form.dataset.id === request.id);
    if (!card) {
      card = questionCard(request);
      questions.append(card);
    }
    const submit = card.querySelector('button');
    submit.disabled = request.submitted || state.sendingQuestion.has(request.id);
    submit.textContent = request.submitted ? '已提交' : '提交回答';
  }
}

function questionCard(request) {
  const card = element('form', '', 'question-card');
  card.dataset.id = request.id;
  card.append(element('h2', 'Codex 需要你回答'));
  const selectors = request.questions.map((question, index) => {
    const group = element('fieldset');
    const options = question.options || [];
    group.append(element('legend', question.question || question.header));
    const inputs = options.map(option => {
      const label = element('label', '', 'option');
      const input = element('input');
      input.type = 'radio';
      input.name = 'choice-' + index;
      input.value = option.label;
      const copy = element('span', option.label);
      if (option.description) copy.append(element('small', option.description));
      label.append(input, copy);
      group.append(label);
      return input;
    });
    let free;
    if (!options.length || question.isOther) {
      const label = element('label', options.length ? '或填写自己的答案' : '你的答案');
      free = element('input');
      free.type = question.isSecret ? 'password' : 'text';
      free.maxLength = 4000;
      free.autocomplete = 'off';
      label.append(free);
      group.append(label);
      free.addEventListener('input', () => {
        for (const input of inputs) input.checked = false;
      });
      for (const input of inputs) input.addEventListener('change', () => { free.value = ''; });
    }
    card.append(group);
    return { id: question.id, read: () => free?.value.trim() || inputs.find(input => input.checked)?.value || '' };
  });
  const submit = element('button', '提交回答', 'primary');
  submit.type = 'submit';
  card.append(submit);
  card.addEventListener('submit', async event => {
    event.preventDefault();
    const chat = state.chat;
    if (!chat || state.sendingQuestion.has(request.id)) return;
    const answers = Object.fromEntries(selectors.map(field => [field.id, field.read()]));
    if (Object.values(answers).some(value => !value)) return showChatError(new Error('请回答卡片上的每个问题。'));
    byId('chat-error').textContent = '';
    state.sendingQuestion.add(request.id);
    renderQuestions(state.snapshot?.questions || []);
    try {
      await api('/chats/' + chat.id + '/answers/' + request.id, { answers });
    } catch (error) {
      if (state.chat === chat) showChatError(error);
    } finally {
      state.sendingQuestion.delete(request.id);
      if (state.chat === chat) renderQuestions(state.snapshot?.questions || []);
    }
  });
  return card;
}

function showChatError(error) {
  byId('chat-error').textContent = error.message;
}

function newProject() {
  byId('project-error').textContent = '';
  projectForm.reset();
  projectDialog.showModal();
}

function renderPreview() {
  const running = state.preview?.status === 'running';
  const started = running || state.preview?.status === 'starting';
  const useCommand = previewForm.elements.mode.value === 'command';
  byId('preview-options').hidden = started;
  byId('preview-directory').hidden = useCommand;
  byId('preview-command').hidden = !useCommand;
  previewForm.elements.command.required = useCommand && !started;
  byId('start-preview').hidden = started;
  byId('start-preview').disabled = state.previewBusy;
  byId('stop-preview').hidden = !started;
  byId('stop-preview').disabled = state.previewBusy;
  const open = byId('open-preview');
  open.hidden = !running;
  if (running) open.href = state.preview.url;
  else open.removeAttribute('href');
  byId('preview-status').textContent = state.previewBusy ? '正在处理…' : running
    ? `预览正在运行，端口 ${state.preview.port}。` : started ? '预览正在启动。' : '';
}

async function updatePreview(project, action = '', options) {
  state.previewBusy = true;
  byId('preview-error').textContent = '';
  renderPreview();
  try {
    const status = await api('/projects/' + project.id + '/preview' + action, options);
    if (state.project === project) state.preview = status;
  } catch (error) {
    if (state.project === project) byId('preview-error').textContent = error.message;
  } finally {
    state.previewBusy = false;
    renderPreview();
  }
}

async function newChat() {
  const project = state.project;
  if (!project || byId('new-chat').disabled) return;
  byId('new-chat').disabled = true;
  try {
    const chat = await api('/projects/' + project.id + '/chats', {});
    if (state.project !== project) return;
    state.chats.unshift(chat);
    chooseChat(chat);
    message.focus();
  } catch (error) {
    if (state.project === project) showChatError(error);
  } finally {
    if (state.project === project) byId('new-chat').disabled = false;
  }
}

async function listFiles(path) {
  if (!state.project) return;
  const id = ++state.fileRequest;
  const list = byId('file-list');
  const preview = byId('file-preview');
  state.filePath = path;
  byId('file-path').textContent = path || '项目根目录';
  byId('parent-dir').hidden = !path;
  preview.hidden = true;
  byId('upload-preview').hidden = true;
  list.replaceChildren(element('p', '正在读取…', 'nav-hint'));
  try {
    const base = '/projects/' + state.project.id;
    const [result, uploaded] = await Promise.all([
      api(base + '/files?' + new URLSearchParams({ path })), path ? null : api(base + '/uploads')
    ]);
    if (id !== state.fileRequest) return;
    const entries = result.entries.map(entry => {
      const entryPath = [path, entry.name].filter(Boolean).join('/');
      return navItem(entry.directory ? entry.name + '/' : entry.name, false,
        () => entry.directory ? listFiles(entryPath) : viewFile(entryPath));
    });
    if (!entries.length) entries.push(element('p', '此目录暂无文件', 'nav-hint'));
    if (result.limited) entries.push(element('p', '目前显示前 400 项', 'nav-hint'));
    if (uploaded?.uploads.length) {
      entries.push(element('h3', '上传的资料', 'file-group-title'));
      for (const item of uploaded.uploads) entries.push(navItem(item.name, false, () => viewUpload(item)));
    }
    list.replaceChildren(...entries);
  } catch (error) {
    if (id === state.fileRequest) list.replaceChildren(element('p', error.message, 'nav-hint'));
  }
}

async function viewFile(path) {
  const id = ++state.fileRequest;
  const preview = byId('file-preview');
  byId('upload-preview').hidden = true;
  preview.hidden = false;
  preview.textContent = '正在读取…';
  try {
    const { text } = await api('/projects/' + state.project.id + '/file?' + new URLSearchParams({ path }));
    if (id === state.fileRequest) preview.textContent = text || '空文件';
  } catch (error) {
    if (id === state.fileRequest) preview.textContent = error.message;
  }
}

function renderAttachments() {
  const tray = byId('attached-files');
  tray.hidden = !state.attachments.length;
  tray.replaceChildren(...state.attachments.map(item => {
    const chip = element('span', '', 'attachment-chip');
    const name = element('span', item.name);
    name.title = item.name;
    const remove = element('button', '×', 'text-button');
    remove.type = 'button';
    remove.setAttribute('aria-label', '移除附件 ' + item.name);
    remove.addEventListener('click', () => {
      state.attachments = state.attachments.filter(attachment => attachment.id !== item.id);
      renderAttachments();
      renderConversation();
    });
    chip.append(name, remove);
    return chip;
  }));
}

function viewUpload(item) {
  state.fileRequest++;
  byId('file-preview').hidden = true;
  const preview = byId('upload-preview');
  const url = '/api/projects/' + state.project.id + '/uploads/' + item.id;
  const link = element('a', '下载资料', 'text-button');
  link.href = url + '?download=1';
  preview.replaceChildren(element('h3', item.name, 'file-group-title'), link);
  if (state.chat) {
    const attach = element('button', '附到消息', 'text-button');
    attach.type = 'button';
    attach.addEventListener('click', () => {
      if (state.attachments.some(attachment => attachment.id === item.id)) return;
      if (state.attachments.length >= 6) return showChatError(new Error('每条消息最多附上 6 个资料。'));
      state.attachments.push(item);
      renderAttachments();
      renderConversation();
    });
    preview.append(attach);
  }
  if (item.image_type) {
    const image = element('img');
    image.alt = item.name;
    image.src = url;
    preview.append(image);
  }
  preview.hidden = false;
}

async function uploadFiles(input, attach) {
  const selected = [...input.files];
  input.value = '';
  const { project, chat } = state;
  if (!selected.length || !project || state.uploading || (attach && !chat)) return;
  if (attach && state.attachments.length + selected.length > 6) {
    return showChatError(new Error('每条消息最多附上 6 个资料。'));
  }
  const feedback = byId('upload-status');
  state.uploading = true;
  feedback.textContent = '正在上传…';
  feedback.hidden = false;
  byId('chat-error').textContent = '';
  renderConversation();
  let uploaded = 0;
  const errors = [];
  for (const file of selected) {
    if (!state.user) break;
    try {
      const query = new URLSearchParams({ name: file.name });
      const item = await api('/projects/' + project.id + '/uploads?' + query, file, true);
      uploaded++;
      if (attach && state.chat === chat && state.attachments.length < 6) {
        state.attachments.push(item);
        renderAttachments();
      }
    } catch (error) {
      errors.push(file.name + ' · ' + error.message);
    }
  }
  state.uploading = false;
  if (state.project === project) {
    feedback.textContent = [`已上传 ${uploaded} 个资料`, ...errors].join('。');
    if (attach && errors.length && state.chat === chat) showChatError(new Error(errors.join('。')));
    if (!filePanel.hidden && !state.filePath) await listFiles('');
  }
  renderConversation();
}

byId('login-tab').addEventListener('click', () => setAuthMode(false));
byId('register-tab').addEventListener('click', () => setAuthMode(true));
authForm.addEventListener('submit', async event => {
  event.preventDefault();
  const button = byId('auth-submit');
  button.disabled = true;
  byId('auth-error').textContent = '';
  try {
    const { user } = await api(state.register ? '/register' : '/login', Object.fromEntries(new FormData(authForm)));
    await openWorkspace(user);
  } catch (error) {
    (state.user ? byId('chat-error') : byId('auth-error')).textContent = error.message;
  } finally { button.disabled = false; }
});
byId('logout').addEventListener('click', async () => {
  try { await api('/logout', {}); showAuth(); }
  catch (error) { showChatError(error); }
});
byId('new-project').addEventListener('click', newProject);
byId('preview-project').addEventListener('click', () => {
  if (!state.project || state.previewBusy) return;
  state.preview = null;
  previewForm.reset();
  previewDialog.showModal();
  void updatePreview(state.project);
});
byId('close-preview').addEventListener('click', () => previewDialog.close());
byId('stop-preview').addEventListener('click', () => {
  if (state.project && !state.previewBusy) void updatePreview(state.project, '/stop', {});
});
previewForm.elements.mode.addEventListener('change', renderPreview);
previewForm.addEventListener('submit', event => {
  event.preventDefault();
  if (!state.project || state.previewBusy) return;
  const { mode, command, directory } = previewForm.elements;
  const settings = mode.value === 'command' ? { command: command.value } : { directory: directory.value };
  void updatePreview(state.project, '', settings);
});
byId('new-chat').addEventListener('click', newChat);
byId('empty-action').addEventListener('click', () => state.project ? newChat() : newProject());
byId('cancel-project').addEventListener('click', () => projectDialog.close());
projectForm.addEventListener('submit', async event => {
  event.preventDefault();
  const button = projectForm.querySelector('button[type=submit]');
  button.disabled = true;
  byId('project-error').textContent = '';
  try {
    const project = await api('/projects', { name: projectForm.elements.name.value });
    projectDialog.close();
    await loadProjects();
    await chooseProject(state.projects.find(candidate => candidate.id === project.id) || project);
  } catch (error) {
    if (projectDialog.open) byId('project-error').textContent = error.message;
    else showChatError(error);
  } finally { button.disabled = false; }
});
message.addEventListener('input', renderConversation);
message.addEventListener('keydown', event => {
  if (event.key !== 'Enter' || event.isComposing || !(event.metaKey || event.ctrlKey) || byId('send').disabled) return;
  event.preventDefault();
  composer.requestSubmit();
});
composer.addEventListener('submit', async event => {
  event.preventDefault();
  const chat = state.chat;
  if (!chat || byId('send').disabled) return;
  state.sending = true;
  renderConversation();
  byId('chat-error').textContent = '';
  const text = message.value.trim();
  const attachments = state.attachments;
  try {
    await api('/chats/' + chat.id + '/turn', { text, plan: byId('plan').checked, attachments: attachments.map(item => item.id) });
    if (state.chat !== chat) return;
    message.value = '';
    state.attachments = [];
    renderAttachments();
    if (chat.title === '新会话') {
      chat.title = Array.from(text || attachments[0].name).slice(0, 35).join('');
      renderLists();
    }
  } catch (error) {
    if (state.chat === chat) showChatError(error);
  } finally {
    if (state.chat === chat) {
      state.sending = false;
      renderConversation();
    }
  }
});
byId('stop').addEventListener('click', async () => {
  if (!state.chat) return;
  const button = byId('stop');
  button.disabled = true;
  try { await api('/chats/' + state.chat.id + '/stop', {}); }
  catch (error) { showChatError(error); }
  finally { button.disabled = false; }
});
byId('files-toggle').addEventListener('click', () => {
  filePanel.hidden = !filePanel.hidden;
  byId('files-toggle').setAttribute('aria-pressed', !filePanel.hidden);
  if (!filePanel.hidden) listFiles('');
  else state.fileRequest++;
});
byId('refresh-files').addEventListener('click', () => listFiles(state.filePath));
byId('parent-dir').addEventListener('click', () => listFiles(state.filePath.split('/').slice(0, -1).join('/')));
byId('attach-files').addEventListener('click', () => byId('chat-file-input').click());
byId('upload-files').addEventListener('click', () => byId('project-file-input').click());
byId('chat-file-input').addEventListener('change', event => uploadFiles(event.target, true));
byId('project-file-input').addEventListener('change', event => uploadFiles(event.target, false));

try {
  const { user } = await api('/me');
  if (user) await openWorkspace(user);
} catch (error) {
  (state.user ? byId('chat-error') : byId('auth-error')).textContent = error.message;
}
