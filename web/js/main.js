// The browser client. Plain ES modules, no build step, no framework. It renders what the server streams, and it
// acknowledges a sentence only after that sentence is in the DOM (see ack-tracker.js).

import { api, ApiError } from './api.js';
import { AckTracker, createAckScheduler } from './ack-tracker.js';
import {
  conversationLabel,
  outcomeNote,
  safeHref,
  sentenceMarker,
  splitCitations,
} from './format.js';

const $ = (id) => document.getElementById(id);
const els = {
  banner: $('banner'),
  list: $('conversation-list'),
  log: $('log'),
  empty: $('empty'),
  suggestions: $('suggestions'),
  status: $('status'),
  form: $('composer'),
  input: $('message-input'),
  send: $('send'),
  newConversation: $('new-conversation'),
  remove: $('delete-conversation'),
};

const state = {
  conversationId: null,
  sending: false,
  scripted: false,
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
};

const tracker = new AckTracker();
const scheduler = createAckScheduler({
  tracker,
  send: (turnId, body) => api.ack(turnId, body),
});

const SUGGESTIONS = [
  'Hello',
  'What does Acme cost?',
  'What did I ask earlier today?',
  'What does Zeta cost? The search is offline.',
  'What does Acme cost? Add an unverified guess.',
];

// ---------------------------------------------------------------- small helpers

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setStatus(text) {
  els.status.textContent = text;
}

function nearBottom() {
  const log = els.log;
  return log.scrollHeight - log.scrollTop - log.clientHeight < 80;
}

function scrollDown() {
  els.log.scrollTop = els.log.scrollHeight;
}

function afterPaint() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function note(kind, text) {
  const p = el('p', `note note--${kind}`, text);
  return p;
}

function setSending(sending) {
  state.sending = sending;
  els.send.disabled = sending;
  els.input.disabled = sending;
  for (const b of els.log.querySelectorAll('.options button, .retry')) b.disabled = sending;
}

// ---------------------------------------------------------------- sentences

/** Fills a sentence element with its text, linking `[n]` markers to their sources. */
function fillSentence(span, text, sources) {
  span.textContent = '';
  for (const seg of splitCitations(text, sources)) {
    if (seg.type === 'text') {
      span.append(document.createTextNode(seg.text));
    } else {
      const a = el('a', 'cite', seg.text);
      a.href = seg.href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.title = seg.title;
      a.setAttribute('aria-label', `Source ${seg.n}: ${seg.title}`);
      span.append(a);
    }
  }
}

/** Sets the visible status of a sentence: classes plus a worded marker. */
function applyStatus(span, status, issues) {
  for (const cls of [...span.classList]) {
    if (cls.startsWith('sentence--') && cls !== 'sentence--unseen') span.classList.remove(cls);
  }
  span.dataset.status = status;
  span.querySelector(':scope > .marker')?.remove();
  const marker = sentenceMarker(status, issues);
  if (!marker) return;
  span.classList.add(`sentence--${marker.kind}`);
  const m = el('span', `marker marker--${marker.kind}`, marker.label);
  m.title = marker.title;
  span.append(m);
}

// ---------------------------------------------------------------- an assistant message

function createAssistant(turnId) {
  const article = el('article', 'msg msg--assistant');
  article.append(el('h3', 'visually-hidden', 'Assistant'));
  const body = el('div', 'msg-body');
  const sourceList = el('ul', 'sources');
  sourceList.hidden = true;
  const extras = el('div', 'extras');
  article.append(body, sourceList, extras);
  return {
    turnId,
    article,
    body,
    sourceList,
    extras,
    sentences: new Map(),
    sources: [],
    sawSentenceEnd: new Set(),
  };
}

function sentenceSpan(msg, index) {
  let span = msg.sentences.get(index);
  if (!span) {
    span = el('span', 'sentence');
    span.dataset.index = String(index);
    msg.sentences.set(index, span);
    msg.body.append(span);
  }
  return span;
}

function addSource(msg, source) {
  msg.sources.push(source);
  msg.sourceList.hidden = false;
  const li = el('li');
  const href = safeHref(source.url);
  const label = `[${source.n}] ${source.title ?? source.domain}`;
  if (href) {
    const a = el('a', null, label);
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    li.append(a, document.createTextNode(` (${source.domain})`));
  } else {
    li.textContent = `${label} (${source.domain})`;
  }
  msg.sourceList.append(li);
}

function addClarification(msg, clarification, onChoose) {
  msg.extras.querySelector('.options')?.remove();
  if (!clarification || clarification.options.length === 0) return;
  const group = el('div', 'options');
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', 'Choose one');
  for (const option of clarification.options) {
    const b = el('button', 'button', option.label);
    b.type = 'button';
    b.addEventListener('click', () => onChoose(option.label));
    group.append(b);
  }
  msg.extras.append(group);
}

/** Marks a sentence rendered once it is really in the document and painted. */
async function markRendered(msg, index) {
  await afterPaint();
  const span = msg.sentences.get(index);
  if (!span || !span.isConnected || (span.textContent ?? '').length === 0) return;
  tracker.sentenceRendered(msg.turnId, index);
  scheduler.notify(msg.turnId);
}

// ---------------------------------------------------------------- live stream

function handleEvent(msg, { event, data }) {
  const stick = nearBottom();
  switch (event) {
    case 'progress':
      setStatus(data.text);
      break;
    case 'clarification':
      msg.clarification = data;
      break;
    case 'source':
      addSource(msg, {
        n: msg.sources.length + 1,
        sourceId: data.sourceId,
        url: data.url,
        domain: data.domain,
        title: data.title,
      });
      break;
    case 'answer.delta': {
      setStatus('');
      const span = sentenceSpan(msg, data.sentenceIndex);
      span.append(document.createTextNode(data.text));
      break;
    }
    case 'answer.sentence_end': {
      const span = sentenceSpan(msg, data.index);
      fillSentence(span, span.textContent ?? '', msg.sources);
      applyStatus(span, data.status, data.issues);
      msg.sawSentenceEnd.add(data.index);
      tracker.sentenceStreamed(msg.turnId, data.index);
      void markRendered(msg, data.index);
      break;
    }
    case 'verification': {
      const span = msg.sentences.get(data.index);
      if (span) applyStatus(span, data.status, data.issues);
      break;
    }
    case 'answer.completed': {
      for (const s of data.sentences) {
        const span = msg.sentences.get(s.index);
        if (span) applyStatus(span, s.status, s.issues);
      }
      tracker.answerStored(msg.turnId);
      scheduler.notify(msg.turnId);
      break;
    }
    case 'warning':
      msg.extras.append(note('warning', data.text));
      break;
    case 'error':
      msg.extras.append(note('error', data.text));
      break;
    case 'turn.completed': {
      setStatus('');
      const n = outcomeNote(data.status, { hasAnswer: msg.sentences.size > 0 });
      if (n) msg.extras.append(note(n.kind, n.text));
      if (data.status === 'clarify' || msg.clarification) {
        addClarification(msg, msg.clarification, (label) => void send(label));
      }
      break;
    }
    default:
      break; // context, plan, finding: not shown in this client
  }
  if (stick) scrollDown();
}

// ---------------------------------------------------------------- stored messages

function userBubble(text) {
  const article = el('article', 'msg msg--user');
  article.append(el('h3', 'visually-hidden', 'You'));
  article.append(document.createTextNode(text));
  return article;
}

function renderStored(messages) {
  els.log.querySelectorAll('.msg').forEach((n) => n.remove());
  els.empty.hidden = messages.length > 0;
  const last = messages.at(-1);
  for (const m of messages) {
    if (m.role === 'user') {
      const bubble = userBubble(m.content);
      els.log.append(bubble);
      const noAnswer =
        m.turn && !messages.some((o) => o.role === 'assistant' && o.turnId === m.turnId);
      if (noAnswer && m.turn.status !== 'running') {
        const n = outcomeNote(m.turn.status, { hasAnswer: false });
        if (n) bubble.append(note(n.kind, n.text));
        if (m.turn.status === 'interrupted' || m.turn.status === 'failed') {
          const retry = el('button', 'button retry', 'Retry');
          retry.type = 'button';
          retry.addEventListener('click', () => void send(m.content, m.turnId));
          bubble.append(retry);
        }
      } else if (noAnswer) {
        bubble.append(
          note('warning', 'This message is still being processed. Reload in a moment.'),
        );
      }
      continue;
    }
    const msg = createAssistant(m.turnId);
    for (const s of m.sources) addSource(msg, s);
    for (const s of m.sentences ?? []) {
      const span = sentenceSpan(msg, s.index);
      fillSentence(span, s.text, m.sources);
      applyStatus(span, s.status, s.issues);
      if (s.delivery === 'not_streamed') {
        span.classList.add('sentence--unseen');
        span.title = 'This sentence was written but never shown to you before';
      }
    }
    if (m.sentences === null || m.sentences.length === 0) msg.body.textContent = m.content;
    const n = outcomeNote(m.status === 'interrupted' ? 'interrupted' : m.turn?.status, {
      hasAnswer: true,
    });
    if (n) msg.extras.append(note(n.kind, n.text));
    if (m === last && m.clarification) {
      addClarification(msg, m.clarification, (label) => void send(label));
    }
    els.log.append(msg.article);
    // Acknowledge what the server streamed and this page has now rendered (ADR-23).
    if (m.turnId !== null && m.streamedThrough !== null && m.streamedThrough >= 0) {
      tracker.restore(m.turnId, {
        streamedThrough: m.streamedThrough,
        renderedThrough: m.renderedThrough,
      });
      void afterPaint().then(() => {
        for (let i = 0; i <= m.streamedThrough; i += 1) {
          const span = msg.sentences.get(i);
          if (span?.isConnected) tracker.sentenceRendered(m.turnId, i);
        }
        scheduler.notify(m.turnId);
      });
    }
  }
  scrollDown();
}

// ---------------------------------------------------------------- conversations

async function refreshList() {
  let list;
  try {
    list = (await api.conversations()).conversations;
  } catch {
    return;
  }
  els.list.textContent = '';
  for (const c of list) {
    const li = el('li');
    const b = el('button', 'conversation-item');
    b.type = 'button';
    b.setAttribute('aria-current', String(c.id === state.conversationId));
    b.append(el('span', 'label', conversationLabel(c)));
    b.append(el('small', null, new Date(c.updatedAt).toLocaleString()));
    b.addEventListener('click', () => void openConversation(c.id));
    li.append(b);
    els.list.append(li);
  }
}

async function openConversation(id) {
  state.conversationId = id;
  els.remove.hidden = false;
  setStatus('');
  try {
    const { messages } = await api.messages(id);
    renderStored(messages);
  } catch (error) {
    setStatus(error instanceof ApiError ? error.message : 'Could not load the conversation.');
  }
  void refreshList();
}

function newConversation() {
  state.conversationId = null;
  els.remove.hidden = true;
  els.log.querySelectorAll('.msg').forEach((n) => n.remove());
  els.empty.hidden = false;
  setStatus('');
  void refreshList();
  els.input.focus();
}

async function deleteConversation() {
  const id = state.conversationId;
  if (!id) return;
  const ok = window.confirm(
    'Delete this conversation and everything derived from it? This cannot be undone.',
  );
  if (!ok) return;
  try {
    await api.deleteConversation(id);
    newConversation();
  } catch (error) {
    setStatus(error instanceof ApiError ? error.message : 'Could not delete the conversation.');
  }
}

// ---------------------------------------------------------------- sending

async function send(text, retryOfTurnId) {
  const message = text.trim();
  if (state.sending || message.length === 0) return;
  setSending(true);
  els.empty.hidden = true;
  let assistant = null;
  try {
    if (!state.conversationId) {
      const { conversation } = await api.createConversation();
      state.conversationId = conversation.id;
      els.remove.hidden = false;
    }
    els.log.append(userBubble(message));
    scrollDown();
    // Previous option buttons are spent once a choice or a new message goes out.
    els.log.querySelectorAll('.options').forEach((n) => n.remove());

    assistant = createAssistant('pending');
    const payload = {
      text: message,
      idempotencyKey: crypto.randomUUID(),
      tz: state.timeZone,
      ...(retryOfTurnId ? { retryOfTurnId } : {}),
    };
    setStatus('Sending');
    let started = false;
    const completed = await api.streamTurn(state.conversationId, payload, (e) => {
      if (e.event === 'turn.started') {
        assistant.turnId = e.data.turnId;
        els.log.append(assistant.article);
        started = true;
      }
      if (started) handleEvent(assistant, e);
    });
    if (!completed) {
      setStatus('The connection ended early. Checking what was saved.');
      await new Promise((resolve) => setTimeout(resolve, 1200));
      await openConversation(state.conversationId);
    }
  } catch (error) {
    const text =
      error instanceof ApiError
        ? error.code === 'turn_in_progress'
          ? 'A previous message in this conversation is still being processed. Try again in a moment.'
          : error.message
        : 'The connection was lost. Checking what was saved.';
    setStatus(text);
    if (!(error instanceof ApiError) && state.conversationId) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      await openConversation(state.conversationId);
    }
  } finally {
    setSending(false);
    els.input.focus();
    void refreshList();
  }
}

// ---------------------------------------------------------------- wiring

els.form.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = els.input.value;
  if (text.trim().length === 0) return;
  els.input.value = '';
  void send(text);
});

els.input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    els.form.requestSubmit();
  }
});

els.newConversation.addEventListener('click', newConversation);
els.remove.addEventListener('click', () => void deleteConversation());

// Hand over any acknowledgement still due when the page is going away (architecture, delivery boundary).
function flushBeacons() {
  for (const { turnId, body } of scheduler.due()) api.beaconAck(turnId, body);
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushBeacons();
});
window.addEventListener('pagehide', flushBeacons);

async function start() {
  try {
    const health = await api.health();
    state.scripted = health.components === 'scripted';
    if (health.banner) {
      els.banner.textContent = health.banner;
      els.banner.hidden = false;
    }
  } catch {
    setStatus('Cannot reach the server.');
  }
  if (state.scripted) {
    els.suggestions.hidden = false;
    for (const text of SUGGESTIONS) {
      const b = el('button', 'button', text);
      b.type = 'button';
      b.addEventListener('click', () => void send(text));
      els.suggestions.append(b);
    }
  }
  await refreshList();
  const first = els.list.querySelector('button');
  if (first) first.click();
  els.input.focus();
}

void start();
