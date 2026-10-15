import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { makeCode, cleanCode, scoreAnswer, rankPlayers } from './game.js';

// ---------- constants ----------
const CATEGORIES = [
  { id: '', name: 'Surprise mix' },
  { id: '9', name: 'General knowledge' },
  { id: '22', name: 'Geography' },
  { id: '23', name: 'History' },
  { id: '17', name: 'Science & nature' },
  { id: '21', name: 'Sports' },
  { id: '12', name: 'Music' },
  { id: '11', name: 'Movies' },
  { id: '14', name: 'TV' },
  { id: '15', name: 'Video games' },
  { id: '18', name: 'Computers' },
  { id: '27', name: 'Animals' },
  { id: '20', name: 'Mythology' },
  { id: '19', name: 'Maths' },
  { id: '28', name: 'Cars & vehicles' },
  { id: '31', name: 'Anime & manga' },
];
const TOPIC_IDEAS = [
  'Kenyan music hits',
  'African capitals & flags',
  'Premier League legends',
  'Kenyan history since 1963',
  'Nollywood & Bongo movies',
  'Famous inventions',
];
const SHAPES = ['▲', '●', '■', '◆'];
const REVEAL_MS = 5000;
const BOARD_MS = 4500;
const JOIN_TIMEOUT_MS = 7000;

// ---------- small helpers ----------
const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const store = {
  get(k, area = localStorage) { try { return area.getItem(k); } catch { return null; } },
  set(k, v, area = localStorage) { try { area.setItem(k, v); } catch { /* storage blocked */ } },
  del(k, area = localStorage) { try { area.removeItem(k); } catch { /* storage blocked */ } },
};
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());

let toastTimer;
function toast(msg, ms = 4000) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

const SCREENS = ['home', 'lobby', 'loading', 'question', 'board', 'final'];
function show(name) {
  for (const s of SCREENS) $(`#screen-${s}`).hidden = s !== name;
}

// ---------- state ----------
const me = {
  id: store.get('ft-id', sessionStorage) || newId(),
  name: store.get('ft-name') || '',
};
store.set('ft-id', me.id, sessionStorage);

let cfg = null;
let sb = null;
let channel = null;
let roomCode = null;
let isHost = false;
let host = null;          // host-only game state
let hostTimer = null;
let view = null;          // last snapshot received
let myAnswer = null;      // { qIndex, choice }
let renderedQ = -1;       // question index currently drawn
let deadline = 0;         // performance.now() when the timer hits zero
let rafId = 0;
let joinTimer = null;
let hostSeenAt = 0;

// ---------- boot ----------
init();

async function init() {
  $('#name').value = me.name;
  const params = new URLSearchParams(location.search);
  const roomParam = cleanCode(params.get('room'));
  if (roomParam) $('#join-code').value = roomParam;

  buildCategoryGrid();
  buildTopicIdeas();
  wireEvents();

  try {
    const r = await fetch('/api/config');
    cfg = await r.json();
  } catch {
    cfg = null;
  }
  if (!cfg?.supabaseUrl || !cfg?.supabaseKey) {
    const w = $('#setup-warning');
    w.textContent = 'This game isn\'t connected to Supabase yet. Add SUPABASE_URL and SUPABASE_ANON_KEY in Vercel, then redeploy.';
    w.hidden = false;
    $('#btn-create').disabled = true;
    $('#btn-join').disabled = true;
    show('home');
    return;
  }
  sb = createClient(cfg.supabaseUrl, cfg.supabaseKey, {
    auth: { persistSession: false },
    realtime: { params: { eventsPerSecond: 20 } },
  });
  $('#ai-off').hidden = cfg.aiEnabled;
  $('#custom-topic').disabled = !cfg.aiEnabled;

  // A host who refreshed their tab picks up where they left off.
  const saved = store.get('ft-host', sessionStorage);
  if (roomParam && saved) {
    try {
      const st = JSON.parse(saved);
      if (st.code === roomParam && st.hostId === me.id) {
        host = st;
        isHost = true;
        connect(roomParam);
        resumeHostTimers();
        return;
      }
    } catch { /* ignore */ }
  }
  show('home');
}

function wireEvents() {
  $('#btn-create').addEventListener('click', createRoom);
  $('#btn-join').addEventListener('click', joinRoom);
  $('#join-code').addEventListener('input', (e) => (e.target.value = cleanCode(e.target.value)));
  $('#join-code').addEventListener('keydown', (e) => e.key === 'Enter' && joinRoom());
  $('#name').addEventListener('keydown', (e) => e.key === 'Enter' && ($('#join-code').value ? joinRoom() : createRoom()));
  document.querySelectorAll('.btn-leave').forEach((b) => b.addEventListener('click', leaveRoom));
  $('#btn-copy').addEventListener('click', copyLink);
  $('#tab-category').addEventListener('click', () => setSource('category'));
  $('#tab-custom').addEventListener('click', () => setSource('custom'));
  $('#custom-topic').addEventListener('input', (e) => updateSetting({ topic: e.target.value.slice(0, 120) }, false));
  $('#custom-topic').addEventListener('change', () => hostBroadcast());
  $('#set-amount').addEventListener('change', (e) => updateSetting({ amount: +e.target.value }));
  $('#set-time').addEventListener('change', (e) => updateSetting({ time: +e.target.value }));
  $('#set-difficulty').addEventListener('change', (e) => updateSetting({ difficulty: e.target.value }));
  $('#btn-start').addEventListener('click', startGame);
  $('#btn-host-next').addEventListener('click', hostSkip);
  $('#btn-host-next-2').addEventListener('click', hostSkip);
  $('#btn-again').addEventListener('click', playAgain);
}

function readName() {
  const name = $('#name').value.replace(/\s+/g, ' ').trim().slice(0, 16);
  if (!name) {
    toast('Type your name first so your friends know who you are.');
    $('#name').focus();
    return null;
  }
  me.name = name;
  store.set('ft-name', name);
  return name;
}

// ---------- rooms ----------
function createRoom() {
  if (!readName() || !sb) return;
  const code = makeCode();
  isHost = true;
  host = {
    code,
    hostId: me.id,
    phase: 'lobby',
    settings: { source: 'category', category: '9', categoryName: 'General knowledge', topic: '', amount: 10, time: 20, difficulty: 'mixed' },
    players: { [me.id]: { name: me.name, score: 0, streak: 0, gain: 0 } },
    online: [me.id],
    questions: [],
    qIndex: -1,
    qStartedAt: 0,
    answers: {},
    reveal: null,
    phaseEndsAt: 0,
    loadingText: '',
  };
  connect(code);
}

function joinRoom() {
  if (!readName() || !sb) return;
  const code = cleanCode($('#join-code').value);
  if (code.length !== 4) {
    toast('Room codes are 4 letters. Ask your host for theirs.');
    $('#join-code').focus();
    return;
  }
  isHost = false;
  host = null;
  connect(code);
  show('loading');
  $('#loading-text').textContent = `Joining room ${code}…`;
  clearTimeout(joinTimer);
  joinTimer = setTimeout(() => {
    if (!view) {
      toast(`No game found for ${code}. Check the code with your host.`);
      leaveRoom();
    }
  }, JOIN_TIMEOUT_MS);
}

function connect(code) {
  roomCode = code;
  history.replaceState(null, '', `?room=${code}`);
  channel = sb.channel(`friends-trivia-${code}`, {
    config: { broadcast: { self: false }, presence: { key: me.id } },
  });
  channel.on('broadcast', { event: 'state' }, ({ payload }) => {
    if (!isHost) applySnapshot(payload);
  });
  channel.on('broadcast', { event: 'answer' }, ({ payload }) => {
    if (isHost && payload) hostHandleAnswer(payload.id, payload.qIndex, payload.choice);
  });
  channel.on('broadcast', { event: 'hello' }, () => {
    if (isHost) hostBroadcast();
  });
  channel.on('presence', { event: 'sync' }, onPresence);
  channel.subscribe(async (status) => {
    if (status === 'SUBSCRIBED') {
      await channel.track({ name: me.name, host: isHost });
      if (isHost) hostBroadcast();
      else channel.send({ type: 'broadcast', event: 'hello', payload: {} });
    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
      toast('Connection trouble. Check your internet; the game will reconnect when it can.');
    }
  });
}

function leaveRoom() {
  clearTimeout(joinTimer);
  clearTimeout(hostTimer);
  cancelAnimationFrame(rafId);
  if (channel) {
    channel.untrack().catch(() => {});
    sb.removeChannel(channel);
  }
  if (isHost) store.del('ft-host', sessionStorage);
  channel = null; roomCode = null; isHost = false; host = null; view = null;
  myAnswer = null; renderedQ = -1;
  $('#host-gone').hidden = true;
  history.replaceState(null, '', '/');
  show('home');
}

function onPresence() {
  const state = channel.presenceState();
  const online = Object.entries(state).map(([id, metas]) => ({ id, ...(metas[0] || {}) }));
  if (isHost) {
    host.online = online.map((p) => p.id);
    for (const p of online) {
      if (p.id === me.id) continue;
      const name = String(p.name || 'Player').slice(0, 16);
      if (!host.players[p.id]) host.players[p.id] = { name, score: 0, streak: 0, gain: 0 };
      else host.players[p.id].name = name;
    }
    if (!host.online.includes(me.id)) host.online.push(me.id);
    hostBroadcast();
    // Everyone still here may have already answered.
    if (host.phase === 'question' && everyoneAnswered()) endQuestion();
  } else if (view) {
    const hostHere = online.some((p) => p.id === view.hostId);
    if (hostHere) hostSeenAt = Date.now();
    $('#host-gone').hidden = hostHere;
  }
}

// ---------- host: settings ----------
function buildCategoryGrid() {
  const grid = $('#category-grid');
  for (const c of CATEGORIES) {
    const b = el('button', 'chip', c.name);
    b.dataset.id = c.id;
    b.setAttribute('aria-pressed', c.id === '9');
    b.addEventListener('click', () => {
      grid.querySelectorAll('.chip').forEach((x) => x.setAttribute('aria-pressed', x === b));
      updateSetting({ category: c.id, categoryName: c.name });
    });
    grid.append(b);
  }
}

function buildTopicIdeas() {
  const row = $('#topic-ideas');
  for (const t of TOPIC_IDEAS) {
    const b = el('button', 'idea', t);
    b.addEventListener('click', () => {
      if (!cfg?.aiEnabled) return;
      $('#custom-topic').value = t;
      updateSetting({ topic: t });
    });
    row.append(b);
  }
}

function setSource(source) {
  $('#tab-category').setAttribute('aria-selected', source === 'category');
  $('#tab-custom').setAttribute('aria-selected', source === 'custom');
  $('#panel-category').hidden = source !== 'category';
  $('#panel-custom').hidden = source !== 'custom';
  updateSetting({ source });
  if (source === 'custom' && cfg?.aiEnabled) $('#custom-topic').focus();
}

function updateSetting(patch, broadcast = true) {
  if (!isHost || !host) return;
  Object.assign(host.settings, patch);
  if (broadcast) hostBroadcast();
}

function settingsLabel(s) {
  const what = s.source === 'custom' ? (s.topic.trim() ? `“${s.topic.trim()}”` : 'a custom topic') : s.categoryName;
  return `${what} · ${s.amount} questions · ${s.time}s each · ${s.difficulty}`;
}

// ---------- host: game flow ----------
function hostSchedule(fn, ms) {
  clearTimeout(hostTimer);
  hostTimer = setTimeout(fn, Math.max(0, ms));
}

function snapshot() {
  const now = Date.now();
  const q = host.questions[host.qIndex];
  const durationMs = host.settings.time * 1000;
  const players = rankPlayers(host.players).map((p) => ({
    id: p.id, name: p.name, score: p.score, streak: p.streak, gain: p.gain,
    online: host.online.includes(p.id),
    answered: Boolean(host.answers[p.id]),
  }));
  const showQ = (host.phase === 'question' || host.phase === 'reveal') && q;
  return {
    code: host.code,
    hostId: host.hostId,
    hostName: host.players[host.hostId]?.name || 'the host',
    phase: host.phase,
    settingsText: settingsLabel(host.settings),
    players,
    qIndex: host.qIndex,
    total: host.questions.length,
    question: showQ ? { text: q.text, options: q.options, category: q.category } : null,
    durationMs,
    remainingMs: host.phase === 'question'
      ? Math.max(0, host.qStartedAt + durationMs - now)
      : Math.max(0, host.phaseEndsAt - now),
    answeredCount: Object.keys(host.answers).length,
    activeCount: players.filter((p) => p.online).length,
    reveal: host.phase === 'reveal' ? host.reveal : null,
    loadingText: host.loadingText,
  };
}

function hostBroadcast() {
  if (!isHost || !host) return;
  store.set('ft-host', JSON.stringify(host), sessionStorage);
  const snap = snapshot();
  if (channel) channel.send({ type: 'broadcast', event: 'state', payload: snap });
  applySnapshot(snap);
}

async function startGame() {
  if (!isHost) return;
  const s = host.settings;
  if (s.source === 'custom' && s.topic.trim().length < 2) {
    toast('Describe a topic first, or pick a category.');
    $('#custom-topic').focus();
    return;
  }
  host.phase = 'loading';
  host.loadingText = s.source === 'custom' ? `Writing questions about “${s.topic.trim()}”…` : `Getting ${s.categoryName} questions…`;
  hostBroadcast();
  try {
    const questions = await fetchQuestions(s);
    if (!isHost || !host) return;
    for (const p of Object.values(host.players)) Object.assign(p, { score: 0, streak: 0, gain: 0 });
    host.questions = questions;
    host.qIndex = -1;
    nextQuestion();
  } catch (err) {
    if (!host) return;
    host.phase = 'lobby';
    hostBroadcast();
    toast(err.message || 'Could not get questions. Try again.', 6000);
  }
}

async function fetchQuestions(s) {
  if (s.source === 'custom') return generate(s.topic.trim(), s);
  try {
    const qs = new URLSearchParams({ amount: s.amount, category: s.category, difficulty: s.difficulty === 'mixed' ? '' : s.difficulty });
    const r = await fetch(`/api/questions?${qs}`);
    const data = await r.json();
    if (r.ok && data.questions?.length) return data.questions;
    throw new Error(data.error);
  } catch (err) {
    // Open Trivia DB is down or empty: let Gemini cover the same category.
    if (cfg?.aiEnabled) return generate(s.category ? s.categoryName : 'general knowledge', s);
    throw new Error('Couldn\'t get questions from Open Trivia DB right now. Wait a few seconds and press Start again.');
  }
}

async function generate(topic, s) {
  const r = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ topic, amount: s.amount, difficulty: s.difficulty }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.questions?.length) throw new Error(data.error || 'Couldn\'t write questions for that topic. Try rewording it.');
  return data.questions;
}

function nextQuestion() {
  if (!host) return;
  host.qIndex += 1;
  host.reveal = null;
  host.answers = {};
  for (const p of Object.values(host.players)) p.gain = 0;
  if (host.qIndex >= host.questions.length) {
    host.phase = 'final';
    hostBroadcast();
    return;
  }
  host.phase = 'question';
  host.qStartedAt = Date.now();
  hostBroadcast();
  hostSchedule(endQuestion, host.settings.time * 1000);
}

function everyoneAnswered() {
  return host.online.length > 0 && host.online.every((id) => host.answers[id]);
}

function hostHandleAnswer(id, qIndex, choice) {
  if (!host || host.phase !== 'question' || qIndex !== host.qIndex) return;
  if (!host.players[id] || host.answers[id]) return;
  if (!Number.isInteger(choice) || choice < 0 || choice > 3) return;
  const elapsed = Date.now() - host.qStartedAt;
  if (elapsed > host.settings.time * 1000 + 1500) return;
  host.answers[id] = { choice, elapsed };
  if (everyoneAnswered()) endQuestion();
  else hostBroadcast();
}

function endQuestion() {
  if (!host || host.phase !== 'question') return;
  clearTimeout(hostTimer);
  const q = host.questions[host.qIndex];
  const durationMs = host.settings.time * 1000;
  const counts = [0, 0, 0, 0];
  const results = {};
  for (const [id, p] of Object.entries(host.players)) {
    const a = host.answers[id];
    if (a) counts[a.choice] += 1;
    const correct = Boolean(a) && a.choice === q.answer;
    const r = scoreAnswer({ correct, elapsedMs: a?.elapsed ?? durationMs, durationMs, streak: p.streak });
    p.score += r.points;
    p.streak = r.streak;
    p.gain = r.points;
    results[id] = { choice: a ? a.choice : null, correct, gained: r.points, streak: r.streak, bonus: r.bonus };
  }
  host.reveal = { answer: q.answer, counts, results, fact: q.fact || '' };
  host.phase = 'reveal';
  host.phaseEndsAt = Date.now() + REVEAL_MS;
  hostBroadcast();
  hostSchedule(afterReveal, REVEAL_MS);
}

function afterReveal() {
  if (!host || host.phase !== 'reveal') return;
  if (host.qIndex >= host.questions.length - 1) {
    host.qIndex = host.questions.length;
    host.phase = 'final';
    hostBroadcast();
    return;
  }
  host.phase = 'board';
  host.phaseEndsAt = Date.now() + BOARD_MS;
  hostBroadcast();
  hostSchedule(nextQuestion, BOARD_MS);
}

function hostSkip() {
  if (!isHost || !host) return;
  if (host.phase === 'question') endQuestion();
  else if (host.phase === 'reveal') afterReveal();
  else if (host.phase === 'board') nextQuestion();
}

function playAgain() {
  if (!isHost) return;
  clearTimeout(hostTimer);
  host.phase = 'lobby';
  host.questions = [];
  host.qIndex = -1;
  host.reveal = null;
  host.answers = {};
  hostBroadcast();
}

function resumeHostTimers() {
  const now = Date.now();
  if (host.phase === 'loading') { host.phase = 'lobby'; return; }
  if (host.phase === 'question') hostSchedule(endQuestion, host.qStartedAt + host.settings.time * 1000 - now);
  else if (host.phase === 'reveal') hostSchedule(afterReveal, host.phaseEndsAt - now);
  else if (host.phase === 'board') hostSchedule(nextQuestion, host.phaseEndsAt - now);
}

// ---------- everyone: rendering ----------
function applySnapshot(s) {
  if (!s || s.code !== roomCode) return;
  const first = !view;
  view = s;
  clearTimeout(joinTimer);
  if (first) hostSeenAt = Date.now();
  if (!isHost && first) $('#host-gone').hidden = true;

  if (s.phase !== 'question') stopTimer();
  switch (s.phase) {
    case 'lobby': renderLobby(s); break;
    case 'loading':
      $('#loading-text').textContent = s.loadingText || 'Getting questions…';
      show('loading');
      break;
    case 'question': renderQuestion(s); break;
    case 'reveal': renderReveal(s); break;
    case 'board': renderBoard(s); break;
    case 'final': renderFinal(s); break;
  }
}

function renderPlayerList(list, players, { showAnswered = false } = {}) {
  list.replaceChildren();
  for (const p of players) {
    const li = el('li', 'player');
    if (!p.online) li.classList.add('offline');
    li.append(el('span', 'avatar', initials(p.name)));
    const name = el('span', 'player-name', p.name);
    li.append(name);
    if (p.id === view.hostId) li.append(el('span', 'tag', 'host'));
    if (p.id === me.id) li.append(el('span', 'tag tag-me', 'you'));
    if (showAnswered && p.answered) li.append(el('span', 'tag', 'answered'));
    list.append(li);
  }
}

function initials(name) {
  return name.split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
}

function renderLobby(s) {
  myAnswer = null;
  renderedQ = -1;
  $('#lobby-code').textContent = s.code;
  const link = `${location.origin}/?room=${s.code}`;
  $('#btn-whatsapp').href = `https://wa.me/?text=${encodeURIComponent(`Join my trivia game! Room code ${s.code}: ${link}`)}`;
  const online = s.players.filter((p) => p.online);
  $('#player-count').textContent = String(online.length);
  renderPlayerList($('#lobby-players'), online);
  $('#host-settings').hidden = !isHost;
  $('#guest-wait').hidden = isHost;
  if (isHost && host) syncSettingsUI(host.settings);
  if (!isHost) {
    $('#guest-wait-text').textContent = `Waiting for ${s.hostName} to start…`;
    $('#guest-settings').textContent = s.settingsText;
  }
  show('lobby');
}

// Keeps the host's controls matching their saved settings (e.g. after a refresh).
function syncSettingsUI(st) {
  $('#tab-category').setAttribute('aria-selected', st.source === 'category');
  $('#tab-custom').setAttribute('aria-selected', st.source === 'custom');
  $('#panel-category').hidden = st.source !== 'category';
  $('#panel-custom').hidden = st.source !== 'custom';
  document.querySelectorAll('#category-grid .chip').forEach((b) => b.setAttribute('aria-pressed', b.dataset.id === st.category));
  if (document.activeElement !== $('#custom-topic')) $('#custom-topic').value = st.topic;
  $('#set-amount').value = String(st.amount);
  $('#set-time').value = String(st.time);
  $('#set-difficulty').value = st.difficulty;
}

function renderQuestion(s) {
  const q = s.question;
  if (!q) return;
  const fresh = renderedQ !== s.qIndex;
  if (fresh) {
    renderedQ = s.qIndex;
    if (!myAnswer || myAnswer.qIndex !== s.qIndex) myAnswer = null;
    $('#q-counter').textContent = `Question ${s.qIndex + 1} of ${s.total}`;
    $('#q-category').textContent = q.category || '';
    $('#q-text').textContent = q.text;
    const box = $('#answers');
    box.replaceChildren();
    q.options.forEach((opt, i) => {
      const b = el('button', `answer a${i}`);
      b.append(el('span', 'shape', SHAPES[i]), el('span', 'answer-text', opt));
      b.addEventListener('click', () => pickAnswer(i));
      box.append(b);
    });
    $('#reveal-box').hidden = true;
    $('#screen-question').classList.remove('revealed');
    show('question');
  }
  // Re-sync the clock if it drifted by more than half a second.
  const target = performance.now() + s.remainingMs;
  if (fresh || Math.abs(target - deadline) > 500) deadline = target;
  startTimer(s.durationMs);
  markAnswers();
  $('#q-status').textContent = myAnswer
    ? `Locked in. ${s.answeredCount} of ${s.activeCount} answered.`
    : `${s.answeredCount} of ${s.activeCount} answered`;
  $('#btn-host-next').hidden = !isHost;
  $('#btn-host-next').textContent = 'Show answer now';
}

function markAnswers() {
  document.querySelectorAll('#answers .answer').forEach((b, i) => {
    b.disabled = Boolean(myAnswer) || view?.phase !== 'question';
    b.classList.toggle('picked', myAnswer?.choice === i);
    b.classList.toggle('dim', Boolean(myAnswer) && myAnswer.choice !== i);
  });
}

function pickAnswer(choice) {
  if (!view || view.phase !== 'question' || myAnswer) return;
  myAnswer = { qIndex: view.qIndex, choice };
  navigator.vibrate?.(25);
  markAnswers();
  $('#q-status').textContent = 'Locked in. Waiting for the others…';
  if (isHost) hostHandleAnswer(me.id, view.qIndex, choice);
  else channel?.send({ type: 'broadcast', event: 'answer', payload: { id: me.id, qIndex: view.qIndex, choice } });
}

function startTimer(durationMs) {
  cancelAnimationFrame(rafId);
  const fill = $('#timer-fill');
  const num = $('#timer-num');
  const tick = () => {
    const left = Math.max(0, deadline - performance.now());
    fill.style.transform = `scaleX(${left / durationMs})`;
    const secs = Math.ceil(left / 1000);
    if (num.textContent !== String(secs)) num.textContent = String(secs);
    const urgent = left < 5000;
    fill.classList.toggle('urgent', urgent);
    num.classList.toggle('urgent', urgent);
    if (left > 0) rafId = requestAnimationFrame(tick);
  };
  tick();
}

function stopTimer() {
  cancelAnimationFrame(rafId);
}

function renderReveal(s) {
  if (renderedQ !== s.qIndex) {
    // Joined mid-reveal: draw the question first.
    renderQuestion({ ...s, phase: 'question', remainingMs: 0 });
  }
  show('question');
  $('#timer-fill').style.transform = 'scaleX(0)';
  $('#timer-num').textContent = '0';
  const r = s.reveal;
  $('#screen-question').classList.add('revealed');
  document.querySelectorAll('#answers .answer').forEach((b, i) => {
    b.disabled = true;
    b.classList.toggle('correct', i === r.answer);
    b.classList.toggle('wrong', i !== r.answer);
    let c = b.querySelector('.count');
    if (!c) { c = el('span', 'count'); b.append(c); }
    c.textContent = String(r.counts[i]);
  });
  const mine = r.results[me.id];
  const res = $('#reveal-result');
  res.className = 'reveal-result';
  if (!mine || mine.choice === null) {
    res.textContent = 'Too slow — no answer this time.';
    res.classList.add('is-miss');
  } else if (mine.correct) {
    res.textContent = `Correct! +${mine.gained}${mine.streak >= 2 ? ` · ${mine.streak} in a row` : ''}`;
    res.classList.add('is-right');
  } else {
    res.textContent = 'Not this time.';
    res.classList.add('is-wrong');
  }
  $('#reveal-fact').textContent = r.fact || '';
  $('#reveal-box').hidden = false;
  $('#q-status').textContent = '';
  $('#btn-host-next').hidden = !isHost;
  $('#btn-host-next').textContent = s.qIndex + 1 >= s.total ? 'See final scores' : 'Show scores';
}

function renderBoard(s) {
  $('#board-round').textContent = `${s.qIndex + 1} of ${s.total}`;
  const list = $('#board-list');
  list.replaceChildren();
  s.players.forEach((p, i) => {
    const li = el('li', 'board-row');
    if (p.id === me.id) li.classList.add('is-me');
    li.append(el('span', 'rank', String(i + 1)), el('span', 'board-name', p.name));
    if (p.gain) li.append(el('span', 'gain', `+${p.gain}`));
    li.append(el('span', 'score', p.score.toLocaleString()));
    list.append(li);
  });
  $('#board-next').textContent = 'Next question coming up…';
  $('#btn-host-next-2').hidden = !isHost;
  show('board');
}

function renderFinal(s) {
  const podium = $('#podium');
  podium.replaceChildren();
  const top = s.players.slice(0, 3);
  const order = [1, 0, 2].filter((i) => top[i]);
  for (const i of order) {
    const p = top[i];
    const col = el('div', `step step-${i + 1}`);
    col.append(el('span', 'step-name', p.name), el('span', 'step-score', p.score.toLocaleString()), el('span', 'step-block', String(i + 1)));
    podium.append(col);
  }
  const list = $('#final-list');
  list.replaceChildren();
  s.players.slice(3).forEach((p, i) => {
    const li = el('li', 'board-row');
    if (p.id === me.id) li.classList.add('is-me');
    li.append(el('span', 'rank', String(i + 4)), el('span', 'board-name', p.name), el('span', 'score', p.score.toLocaleString()));
    list.append(li);
  });
  $('#btn-again').hidden = !isHost;
  $('#final-wait').hidden = isHost;
  show('final');
}

async function copyLink() {
  const link = `${location.origin}/?room=${roomCode}`;
  try {
    await navigator.clipboard.writeText(link);
    toast('Link copied. Paste it to your friends.');
  } catch {
    toast(link, 8000);
  }
}

// Leave cleanly when the tab closes so others see you go.
addEventListener('pagehide', () => {
  try { channel?.untrack(); } catch { /* ignore */ }
});

// Expose a tiny hook for automated tests.
window.__trivia = { get view() { return view; }, get me() { return me; }, get isHost() { return isHost; } };
