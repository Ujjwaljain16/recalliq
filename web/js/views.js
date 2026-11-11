// DOM building blocks for the parts of a turn around the answer text: the activity trail, the "what I
// remembered" chips and the findings card. Text only ever goes in through textContent; links through safeHref.

import { activeStep, summaryOf } from './trail.js';
import { duration, localTimeLabel } from './time.js';
import { findingRow } from './findings.js';

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

export function link(href, text, title) {
  const a = el('a', null, text);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  if (title) a.title = title;
  return a;
}

// ---------------------------------------------------------------- activity trail

/** An empty trail: a toggle line and a step list. Expanded while it runs, collapsed when done. */
export function createTrailView() {
  const root = el('section', 'trail');
  root.setAttribute('aria-label', 'What the assistant did');
  // The conversation log is a live region; the trail is announced through its own status line instead.
  root.setAttribute('aria-live', 'off');
  const head = el('button', 'trail-head');
  head.type = 'button';
  const icon = el('span', 'trail-icon');
  icon.setAttribute('aria-hidden', 'true');
  const title = el('span', 'trail-title');
  const time = el('span', 'trail-time');
  head.append(icon, title, time);
  const steps = el('ol', 'trail-steps');
  steps.id = `trail-${Math.random().toString(36).slice(2, 10)}`;
  head.setAttribute('aria-controls', steps.id);
  root.append(head, steps);
  const view = { root, head, title, time, steps, expanded: true, state: null };
  head.addEventListener('click', () => {
    view.expanded = !view.expanded;
    paintExpanded(view);
  });
  return view;
}

function paintExpanded(view) {
  view.head.setAttribute('aria-expanded', String(view.expanded));
  view.steps.hidden = !view.expanded;
}

/** Elapsed time of a running trail. */
export function tickTrail(view, now) {
  if (view.state?.running) view.time.textContent = duration(now - view.state.startedAt);
}

/** Draws `state` into the view. A trail that has just finished collapses to its summary. */
export function paintTrail(view, state, now) {
  const wasRunning = view.state?.running ?? true;
  view.state = state;
  view.root.classList.toggle('trail--running', state.running);
  if (state.running) {
    view.title.textContent = activeStep(state)?.label ?? 'Working';
    tickTrail(view, now);
  } else {
    view.title.textContent = summaryOf(state);
    view.time.textContent = '';
    if (wasRunning) view.expanded = false;
  }
  view.steps.textContent = '';
  for (const step of state.steps) {
    const li = el('li', `trail-step trail-step--${step.state}`);
    if (step.state === 'active') li.setAttribute('aria-current', 'step');
    li.append(el('span', 'trail-step-label', step.label));
    if (step.detail) li.append(el('q', 'trail-detail', step.detail));
    if (step.chips.length > 0) {
      const chips = el('span', 'chips');
      for (const domain of step.chips) chips.append(el('span', 'chip', domain));
      if (step.more) chips.append(el('span', 'chip chip--more', `+${step.more}`));
      li.append(chips);
    }
    view.steps.append(li);
  }
  paintExpanded(view);
}

// ---------------------------------------------------------------- what I remembered

/**
 * Chips for the earlier messages a turn recalled. `find(messageId)` returns the message element when it is in
 * the open conversation; otherwise the chip shows the excerpt in a small panel.
 */
export function recalledChips(hits, find) {
  const box = el('div', 'recalled');
  box.append(el('span', 'recalled-label', 'What I remembered'));
  const chips = el('div', 'chips');
  const panel = el('div', 'recalled-panel');
  panel.hidden = true;
  panel.id = `recalled-${Math.random().toString(36).slice(2, 10)}`;
  for (const hit of hits) {
    const when = localTimeLabel(hit.localTime);
    const short = hit.excerpt.length > 48 ? `${hit.excerpt.slice(0, 47).trimEnd()}…` : hit.excerpt;
    const chip = el('button', 'chip chip--button');
    chip.type = 'button';
    chip.append(el('span', 'chip-date', when), document.createTextNode(` ${short}`));
    chip.title = hit.excerpt;
    chip.addEventListener('click', () => {
      const target = find(hit.messageId);
      if (target) {
        panel.hidden = true;
        target.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
        target.classList.remove('msg--flash');
        void target.offsetWidth; // restart the highlight
        target.classList.add('msg--flash');
        return;
      }
      const open = !panel.hidden && panel.dataset.for === hit.messageId;
      for (const c of chips.children) c.setAttribute('aria-expanded', 'false');
      panel.hidden = open;
      if (open) return;
      chip.setAttribute('aria-expanded', 'true');
      panel.dataset.for = hit.messageId;
      panel.textContent = '';
      panel.append(el('span', 'recalled-when', `You wrote, ${when}:`), el('q', null, hit.excerpt));
    });
    chip.setAttribute('aria-controls', panel.id);
    chip.setAttribute('aria-expanded', 'false');
    chips.append(chip);
  }
  box.append(chips, panel);
  return box;
}

function reducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

// ---------------------------------------------------------------- findings card

function badge(b) {
  const span = el('span', `badge badge--${b.kind}`, b.label);
  if (b.title) span.title = b.title;
  return span;
}

/** The findings card: one row per entity, compact; null when there is nothing to show. */
export function findingsCard(findings, sources, opts) {
  if (findings.length === 0) return null;
  const card = el('section', 'findings');
  card.setAttribute('aria-label', 'Findings');
  const list = el('ul', 'findings-list');
  for (const f of [...findings].sort((a, b) => a.ord - b.ord)) {
    const row = findingRow(f, sources, opts);
    const li = el('li', 'finding');
    const main = el('div', 'finding-main');
    main.append(el('span', 'finding-name', row.name), el('span', 'finding-value', row.value));
    const badges = el('div', 'finding-badges');
    if (row.status) badges.append(badge(row.status));
    if (row.verdict) badges.append(badge(row.verdict));
    main.append(badges);
    li.append(main);
    if (row.baseline) li.append(el('p', 'finding-meta', row.baseline));
    if (row.releases.length > 0) {
      const ul = el('ul', 'finding-releases');
      for (const r of row.releases) {
        const item = el('li', r.major ? 'release release--major' : 'release', r.title);
        if (r.date) item.append(el('span', 'release-date', ` · ${r.date}`));
        ul.append(item);
      }
      li.append(ul);
    }
    if (row.citations.length > 0) {
      const cites = el('p', 'finding-meta finding-cites');
      for (const c of row.citations) {
        const a = link(c.href, `[${c.n}] ${c.label}`, c.title);
        a.setAttribute('aria-label', `Source ${c.n}: ${c.title}`);
        cites.append(a);
      }
      li.append(cites);
    }
    list.append(li);
  }
  card.append(list);
  return card;
}
