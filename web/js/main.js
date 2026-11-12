// The browser client. Plain ES modules, no build step, no framework. It renders what the server streams, and it
// acknowledges a sentence only after that sentence is in the DOM (see ack-tracker.js).

import { api, ApiError } from './api.js';
import { AckTracker, createAckScheduler } from './ack-tracker.js';
import {
  conversationLabel,
  leadingBreak,
  outcomeNote,
  paragraphStarts,
  sentenceBasis,
  sourceLabel,
  sentenceGap,
  safeHref,
  sentenceMarker,
  splitCitations,
} from './format.js';
import { listStamp } from './time.js';
import { activeStep, createTrail, finishTrail, reduceTrail, summaryOf } from './trail.js';
import {
  createTrailView,
  el,
  findingsCard,
  link,
  paintTrail,
  recalledChips,
  tickTrail,
} from './views.js';

const $ = (id) => document.getElementById(id);
const els = {
  banner: $('banner'),
  list: $('conversation-list'),
  log: $('log'),
  empty: $('empty'),
  suggestions: $('suggestions'),
  example: $('example'),
  loadExample: $('load-example'),
  status: $('status'),
  announcer: $('announcer'),
  form: $('composer'),
  input: $('message-input'),
  send: $('send'),
  newConversation: $('new-conversation'),
  remove: $('delete-conversation'),
  menu: $('menu-toggle'),
  scrim: $('scrim'),
};

const state = {
  conversationId: null,
  sending: false,
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  ticker: null,
};

const tracker = new AckTracker();
const scheduler = createAckScheduler({
  tracker,
  send: (turnId, body) => api.ack(turnId, body),
});

/** Scripted demo: canned questions the scripted components know how to answer. */
const SCRIPTED_PROMPTS = [
  'Hello',
  'What does Acme cost?',
  'What did I ask earlier today?',
  'What does Zeta cost? The search is offline.',
  'What does Acme cost? Add an unverified guess.',
];

/** Live: questions that show what the product does. */
const LIVE_PROMPTS = [
  'On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?',
  'What did I ask you on 3 November? Is your answer still correct today?',
  'Last Tuesday I asked about Postgres hosting. Has any pricing changed since then?',
  "What's new in Node.js 24?",
];

// ---------------------------------------------------------------- small helpers

function setStatus(text) {
  els.status.textContent = text;
}

function announce(text) {
  if (els.announcer.textContent !== text) els.announcer.textContent = text;
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

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function note(kind, text) {
  return el('p', `note note--${kind}`, text);
}

function setSending(sending) {
  state.sending = sending;
  els.send.disabled = sending;
  els.input.disabled = sending;
  for (const b of els.log.querySelectorAll('.options button, .retry:not([data-waiting])')) {
    b.disabled = sending;
  }
}

/** Removes every message, trail and note from the log; the empty state stays. */
function clearLog() {
  for (const node of [...els.log.children]) if (node !== els.empty) node.remove();
}

function findMessage(messageId) {
  for (const node of els.log.querySelectorAll('[data-message-id]')) {
    if (node.dataset.messageId === messageId) return node;
  }
  return null;
}

// ---------------------------------------------------------------- sentences

/** Fills a sentence element with its text, linking `[n]` markers to their sources. */
function fillSentence(span, text, sources) {
  span.textContent = '';
  for (const seg of splitCitations(text, sources)) {
    if (seg.type === 'text') {
      span.append(document.createTextNode(seg.text));
    } else {
      const a = link(seg.href, seg.text, seg.title);
      a.className = 'cite';
      a.setAttribute('aria-label', `Source ${seg.n}: ${seg.title}`);
      span.append(a);
    }
  }
}

const KIND_TITLE = {
  verified: 'Checked against a verified finding',
  sourced: 'According to the cited source; not independently verified',
  unconfirmed: 'No verified value for this; my own checks did not confirm it',
};

/** Sets the visible status of a sentence: classes, a worded marker, and what it rests on. */
function applyStatus(span, status, issues, kind) {
  for (const cls of [...span.classList]) {
    if (cls.startsWith('sentence--') && cls !== 'sentence--unseen') span.classList.remove(cls);
  }
  span.dataset.status = status;
  span.querySelector(':scope > .marker')?.remove();
  const marker = sentenceMarker(status, issues);
  if (marker) {
    span.classList.add(`sentence--${marker.kind}`);
    const m = el('span', `marker marker--${marker.kind}`, marker.label);
    m.title = marker.title;
    span.append(m);
    return;
  }
  // A sourced sentence reports what a cited page says; a verified one renders a checked finding.
  const basis = sentenceBasis(status, kind, span.dataset.kind);
  if (basis !== null) {
    span.dataset.kind = basis;
    span.classList.add(`sentence--${basis}`);
    if (!span.classList.contains('sentence--unseen')) span.title = KIND_TITLE[basis];
  }
}

/** A one-line key under the first answer in view that has both kinds of statement. */
function maybeLegend(msg) {
  if (els.log.querySelector('.legend')) return;
  const kinds = new Set([...msg.sentences.values()].map((s) => s.dataset.kind));
  if (!kinds.has('verified') || !kinds.has('sourced')) return;
  const p = el('p', 'legend');
  p.append(
    el('span', 'legend-verified', 'checked against a verified finding'),
    el('span', 'legend-sourced', 'according to the cited source'),
  );
  msg.body.after(p);
}

// ---------------------------------------------------------------- an assistant message

function createAssistant(turnId) {
  const article = el('article', 'msg msg--assistant');
  article.append(el('h3', 'visually-hidden', 'Assistant'));
  const recalled = el('div', 'recalled-slot');
  const body = el('div', 'msg-body');
  const findings = el('div', 'findings-slot');
  const sourceList = el('ol', 'sources');
  sourceList.setAttribute('aria-label', 'Sources');
  sourceList.hidden = true;
  const extras = el('div', 'extras');
  article.append(recalled, body, findings, sourceList, extras);
  return {
    turnId,
    article,
    recalled,
    body,
    findingsSlot: findings,
    sourceList,
    extras,
    paragraph: null,
    sentences: new Map(),
    sources: [],
    findings: [],
  };
}

function sentenceSpan(msg, index, newParagraph = false) {
  let span = msg.sentences.get(index);
  if (!span) {
    if (!msg.paragraph || (newParagraph && msg.paragraph.childNodes.length > 0)) {
      msg.paragraph = el('p', 'para');
      msg.body.append(msg.paragraph);
    }
    // sentences of one paragraph are separated by one space (the sentence text itself carries none)
    const gap = sentenceGap(false, msg.paragraph.childNodes.length > 0);
    if (gap) msg.paragraph.append(document.createTextNode(gap));
    span = el('span', 'sentence');
    span.dataset.index = String(index);
    msg.sentences.set(index, span);
    msg.paragraph.append(span);
  }
  return span;
}

function addSource(msg, source) {
  msg.sources.push(source);
  msg.sourceList.hidden = false;
  const li = el('li');
  li.value = source.n;
  const href = safeHref(source.url);
  const label = sourceLabel(source);
  if (href) li.append(link(href, label));
  else li.append(document.createTextNode(label));
  // the domain is shown beside the label unless the label already is the domain
  if (label !== source.domain) li.append(el('span', 'source-domain', source.domain));
  msg.sourceList.append(li);
}

function showRecalled(msg, hits) {
  msg.recalled.textContent = '';
  if (hits.length > 0) msg.recalled.append(recalledChips(hits, findMessage));
}

function showFindings(msg) {
  msg.findingsSlot.textContent = '';
  const card = findingsCard(msg.findings, msg.sources, {
    now: Date.now(),
    timeZone: state.timeZone,
  });
  if (card) msg.findingsSlot.append(card);
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

// ---------------------------------------------------------------- the activity trail

function startTicker(trail) {
  stopTicker();
  state.ticker = setInterval(() => tickTrail(trail.view, Date.now()), 1000);
}

function stopTicker() {
  if (state.ticker !== null) clearInterval(state.ticker);
  state.ticker = null;
}

function updateTrail(trail, next) {
  trail.state = next;
  paintTrail(trail.view, next, Date.now());
  if (next.running) {
    announce(activeStep(next)?.label ?? '');
  } else {
    stopTicker();
    announce(summaryOf(next));
  }
}

/** The collapsed trail of a stored answer, rebuilt from what a reload returns. */
function storedTrail(m, userMessageId) {
  let s = createTrail(0);
  const feed = (e) => {
    s = reduceTrail(s, e, 0);
  };
  feed({ event: 'turn.started', data: { turnId: m.turnId, userMessageId } });
  if (m.memoryHits.length > 0) {
    feed({
      event: 'context',
      data: { lane: m.turn?.lane ?? 'recall', resolvedDates: [], memoryHits: m.memoryHits },
    });
  }
  if (m.activity.plannedSearches) {
    const intents = [...new Set(m.findings.map((f) => f.intent))];
    feed({
      event: 'plan',
      data: {
        entities: [...new Set(m.findings.map((f) => f.entityName))],
        intents: intents.length > 0 ? intents : ['general'],
        plannedSearches: m.activity.plannedSearches,
      },
    });
  }
  for (const source of m.sources) feed({ event: 'source', data: source });
  if (m.sentences?.length) feed({ event: 'answer.delta', data: {} });
  s = finishTrail(s, m.turn?.status ?? 'complete', m.activity.elapsedMs ?? 0);
  if (m.activity.elapsedMs === null) s = { ...s, endedAt: null };
  const view = createTrailView();
  paintTrail(view, s, 0);
  return view.root;
}

// ---------------------------------------------------------------- live stream

function handleEvent(msg, trail, e) {
  const { event, data } = e;
  const stick = nearBottom();
  updateTrail(trail, reduceTrail(trail.state, e, Date.now()));
  switch (event) {
    case 'context':
      showRecalled(msg, trail.state.memoryHits);
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
    case 'finding':
      msg.findings.push(data);
      break;
    case 'answer.delta': {
      setStatus('');
      const fresh = !msg.sentences.has(data.sentenceIndex);
      const { newParagraph, text } = fresh
        ? leadingBreak(data.text)
        : { newParagraph: false, text: data.text };
      const span = sentenceSpan(msg, data.sentenceIndex, newParagraph);
      span.append(document.createTextNode(text));
      break;
    }
    case 'answer.sentence_end': {
      const span = sentenceSpan(msg, data.index);
      fillSentence(span, span.textContent ?? '', msg.sources);
      applyStatus(span, data.status, data.issues, data.kind);
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
      msg.article.dataset.messageId = data.assistantMessageId;
      for (const s of data.sentences) {
        const span = msg.sentences.get(s.index);
        if (span) applyStatus(span, s.status, s.issues, s.kind);
      }
      tracker.answerStored(msg.turnId);
      scheduler.notify(msg.turnId);
      break;
    }
    case 'warning': {
      // Withheld sentences are one quiet note per answer; the technical reasons stay in its tooltip.
      if (data.code === 'sentence_withheld') {
        msg.withheld = (msg.withheld ?? 0) + 1;
        const n = msg.withheld;
        const text =
          n === 1
            ? 'One sentence was left out because it could not be checked against its source.'
            : `${n} sentences were left out because they could not be checked against their sources.`;
        if (!msg.withheldNote) {
          msg.withheldNote = note('quiet', text);
          msg.extras.append(msg.withheldNote);
        } else msg.withheldNote.textContent = text;
        msg.withheldNote.title = [msg.withheldNote.title, data.text].filter(Boolean).join('\n');
        break;
      }
      msg.seenWarnings ??= new Set();
      if (msg.seenWarnings.has(data.text)) break;
      msg.seenWarnings.add(data.text);
      msg.extras.append(note('warning', data.text));
      break;
    }
    case 'error':
      msg.extras.append(note('error', data.text));
      break;
    case 'turn.completed': {
      setStatus('');
      showFindings(msg);
      maybeLegend(msg);
      const n = outcomeNote(data.status, { hasAnswer: msg.sentences.size > 0 });
      if (n) msg.extras.append(note(n.kind, n.text));
      if (data.status === 'clarify' || msg.clarification) {
        addClarification(msg, msg.clarification, (label) => void send(label));
      }
      break;
    }
    default:
      break;
  }
  if (stick) scrollDown();
}

// ---------------------------------------------------------------- stored messages

function userBubble(text, messageId) {
  const article = el('article', 'msg msg--user');
  if (messageId) article.dataset.messageId = messageId;
  article.append(el('h3', 'visually-hidden', 'You'));
  article.append(document.createTextNode(text));
  return article;
}

function retryButton(onClick) {
  const retry = el('button', 'button retry', 'Retry');
  retry.type = 'button';
  retry.addEventListener('click', onClick);
  return retry;
}

function renderStored(messages) {
  clearLog();
  els.empty.hidden = messages.length > 0;
  const last = messages.at(-1);
  for (const m of messages) {
    if (m.role === 'user') {
      const bubble = userBubble(m.content, m.id);
      els.log.append(bubble);
      const noAnswer =
        m.turn && !messages.some((o) => o.role === 'assistant' && o.turnId === m.turnId);
      if (noAnswer && m.turn.status !== 'running') {
        const n = outcomeNote(m.turn.status, { hasAnswer: false });
        if (n) bubble.append(note(n.kind, n.text));
        if (m.turn.status === 'interrupted' || m.turn.status === 'failed') {
          bubble.append(retryButton(() => void send(m.content, { retryOfTurnId: m.turnId })));
        }
      } else if (noAnswer) {
        bubble.append(
          note('warning', 'This message is still being processed. Reload in a moment.'),
        );
      }
      continue;
    }
    const question = messages.find((o) => o.role === 'user' && o.turnId === m.turnId);
    if (m.activity) els.log.append(storedTrail(m, question?.id ?? null));
    const msg = createAssistant(m.turnId);
    msg.article.dataset.messageId = m.id;
    for (const s of m.sources) addSource(msg, s);
    showRecalled(
      msg,
      m.memoryHits.filter((h) => h.messageId !== question?.id),
    );
    const sentences = m.sentences ?? [];
    const starts = paragraphStarts(
      m.content,
      sentences.map((s) => s.text),
    );
    sentences.forEach((s, i) => {
      const span = sentenceSpan(msg, s.index, starts[i]);
      fillSentence(span, s.text, m.sources);
      if (s.delivery === 'not_streamed') {
        span.classList.add('sentence--unseen');
        span.title = 'This sentence was written but never shown to you before';
      }
      applyStatus(span, s.status, s.issues, s.kind);
    });
    if (sentences.length === 0) msg.body.append(el('p', 'para', m.content));
    msg.findings = m.findings;
    showFindings(msg);
    const n = outcomeNote(m.status === 'interrupted' ? 'interrupted' : m.turn?.status, {
      hasAnswer: true,
    });
    if (n) msg.extras.append(note(n.kind, n.text));
    if (m === last && m.clarification) {
      addClarification(msg, m.clarification, (label) => void send(label));
    }
    els.log.append(msg.article);
    maybeLegend(msg);
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

function setNav(open) {
  document.body.classList.toggle('nav-open', open);
  els.menu.setAttribute('aria-expanded', String(open));
  if (open) els.newConversation.focus();
}

async function refreshList() {
  let list;
  try {
    list = (await api.conversations()).conversations;
  } catch {
    return;
  }
  els.list.textContent = '';
  const now = Date.now();
  for (const c of list) {
    const li = el('li');
    const b = el('button', 'conversation-item');
    b.type = 'button';
    if (c.id === state.conversationId) b.setAttribute('aria-current', 'true');
    b.append(el('span', 'label', conversationLabel(c)));
    const stamp = el('small', null, listStamp(c.updatedAt, now, state.timeZone));
    stamp.title = new Date(c.updatedAt).toLocaleString();
    b.append(stamp);
    b.addEventListener('click', () => {
      setNav(false);
      void openConversation(c.id);
    });
    li.append(b);
    els.list.append(li);
  }
}

/** Loads and shows a conversation. Returns false when it could not be loaded. */
async function openConversation(id) {
  state.conversationId = id;
  els.remove.hidden = false;
  setStatus('');
  let ok = true;
  try {
    const { messages } = await api.messages(id);
    renderStored(messages);
  } catch (error) {
    ok = false;
    setStatus(error instanceof ApiError ? error.message : 'Could not load the conversation.');
  }
  void refreshList();
  return ok;
}

function newConversation() {
  state.conversationId = null;
  els.remove.hidden = true;
  clearLog();
  els.empty.hidden = false;
  setStatus('');
  setNav(false);
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

// ---------------------------------------------------------------- errors and limits

/** What to say when the server refused a message. */
function refusalText(error) {
  const seconds = Number(error.details?.retryAfter);
  const when = seconds > 0 ? ` You can try again in ${seconds} s.` : '';
  switch (error.code) {
    case 'too_many_turns':
      return `Another answer is still being written.${when}`;
    case 'turn_rate_limited':
      return `You are sending messages faster than the limit allows.${when}`;
    case 'too_many_sessions':
      return `Too many new sessions were started from this address.${when}`;
    case 'misdirected_request':
      return 'This server does not answer for the address in your browser. Open RecallIQ at the address it printed when it started.';
    case 'turn_in_progress':
      return 'A previous message in this conversation is still being processed. Try again in a moment.';
    default:
      return error.message;
  }
}

/**
 * Shows a refusal or a lost connection under the message that failed, with a Retry button that first waits
 * out the server's Retry-After. Without `retry` there is nothing to press (a wrong address stays wrong).
 */
function showFailure(bubble, text, { retryAfter = 0, retry = null } = {}) {
  bubble.querySelectorAll('.note, .retry').forEach((n) => n.remove());
  bubble.append(note('error', text));
  if (!retry) return;
  const button = retryButton(retry);
  bubble.append(button);
  let left = retryAfter;
  const tick = () => {
    if (left <= 0) {
      delete button.dataset.waiting;
      button.disabled = state.sending;
      button.textContent = 'Retry';
      return;
    }
    button.dataset.waiting = 'true';
    button.disabled = true;
    button.textContent = `Retry in ${left} s`;
    left -= 1;
    setTimeout(tick, 1000);
  };
  tick();
}

// ---------------------------------------------------------------- sending

/**
 * Sends a message and streams the answer. A retry after a lost connection reuses `options.idempotencyKey`, so
 * the server replays a turn it already ran instead of running it twice.
 */
async function send(text, options = {}) {
  const message = text.trim();
  if (state.sending || message.length === 0) return;
  setSending(true);
  els.empty.hidden = true;
  const idempotencyKey = options.idempotencyKey ?? crypto.randomUUID();

  // Previous option buttons are spent once a choice or a new message goes out.
  els.log.querySelectorAll('.options').forEach((n) => n.remove());
  const bubble = userBubble(message);
  els.log.append(bubble);
  const trail = { view: createTrailView(), state: createTrail(Date.now()) };
  els.log.append(trail.view.root);
  updateTrail(trail, reduceTrail(trail.state, { event: 'turn.started', data: {} }, Date.now()));
  startTicker(trail);
  scrollDown();
  const retrySame = () => {
    bubble.remove();
    trail.view.root.remove();
    void send(message, { ...options, idempotencyKey });
  };

  const assistant = createAssistant('pending');
  let lost = false;
  try {
    if (!state.conversationId) {
      const { conversation } = await api.createConversation();
      state.conversationId = conversation.id;
      els.remove.hidden = false;
    }
    const payload = {
      text: message,
      idempotencyKey,
      tz: state.timeZone,
      ...(options.retryOfTurnId ? { retryOfTurnId: options.retryOfTurnId } : {}),
    };
    let started = false;
    const completed = await api.streamTurn(state.conversationId, payload, (e) => {
      if (e.event === 'turn.started') {
        assistant.turnId = e.data.turnId;
        bubble.dataset.messageId = e.data.userMessageId;
        els.log.append(assistant.article);
        started = true;
      }
      if (started) handleEvent(assistant, trail, e);
    });
    lost = !completed;
  } catch (error) {
    if (!(error instanceof ApiError)) {
      lost = true;
    } else {
      stopTicker();
      trail.view.root.remove();
      assistant.article.remove();
      const text = refusalText(error);
      showFailure(bubble, text, {
        retryAfter: Number(error.details?.retryAfter) || 0,
        retry: error.status === 421 ? null : retrySame,
      });
      announce(text);
    }
  }
  if (lost) {
    updateTrail(trail, finishTrail(trail.state, 'interrupted', Date.now()));
    setStatus('The connection ended early. Checking what was saved.');
    await wait(1200);
    const reloaded = state.conversationId ? await openConversation(state.conversationId) : false;
    setStatus('');
    if (!reloaded) {
      showFailure(bubble, 'The connection was lost. Check your network, then retry.', {
        retry: retrySame,
      });
    }
  }
  setSending(false);
  els.input.focus();
  void refreshList();
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
els.menu.addEventListener('click', () => setNav(!document.body.classList.contains('nav-open')));
els.scrim.addEventListener('click', () => setNav(false));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && document.body.classList.contains('nav-open')) {
    setNav(false);
    els.menu.focus();
  }
});

// Hand over any acknowledgement still due when the page is going away (architecture, delivery boundary).
function flushBeacons() {
  for (const { turnId, body } of scheduler.due()) api.beaconAck(turnId, body);
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushBeacons();
});
window.addEventListener('pagehide', flushBeacons);

/**
 * Adds the example earlier conversations the history questions refer to. A first-time visitor has no session
 * yet: the conversation they would start anyway is created first, which also sets the session cookie.
 */
async function loadExampleHistory() {
  els.loadExample.disabled = true;
  try {
    if (!state.conversationId) {
      const { conversation } = await api.createConversation();
      state.conversationId = conversation.id;
    }
    const { created } = await api.exampleHistory(state.timeZone);
    setStatus(
      created > 0
        ? 'Added three example conversations. Ask one of the questions below.'
        : 'The example conversations are already there.',
    );
    els.example.hidden = true;
    await refreshList();
  } catch (error) {
    els.loadExample.disabled = false;
    setStatus(error instanceof ApiError ? error.message : 'Could not add the example history.');
  }
}
els.loadExample.addEventListener('click', () => void loadExampleHistory());

function showPrompts(prompts) {
  els.suggestions.hidden = prompts.length === 0;
  for (const text of prompts) {
    const b = el('button', 'button suggestion', text);
    b.type = 'button';
    b.addEventListener('click', () => void send(text));
    els.suggestions.append(b);
  }
}

async function start() {
  let scripted = false;
  let demo = false;
  try {
    const health = await api.health();
    scripted = health.components === 'scripted';
    if (health.banner) {
      demo = true;
      els.banner.textContent = health.banner;
      els.banner.hidden = false;
    }
  } catch {
    setStatus('Cannot reach the server.');
  }
  // The scripted components only know their canned questions; a live agent gets questions that show it off.
  showPrompts(scripted ? SCRIPTED_PROMPTS : demo ? [] : LIVE_PROMPTS);
  await refreshList();
  // Offered on a fresh start of the live agent, where the history questions have nothing to refer to yet.
  const hasHistory = els.list.querySelector('button') !== null;
  els.example.hidden = scripted || demo || hasHistory;
  const first = els.list.querySelector('button');
  if (first) first.click();
  els.input.focus();
}

void start();
