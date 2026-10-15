import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { makeCode, cleanCode, scoreAnswer, rankPlayers } from './game.js';
import { sfx, unlockAudio, isMuted, setMuted } from './sound.js';

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
const JOIN_TIMEOUT_MS = 8000;
const HEARTBEAT_MS = 2000;       // host re-sends the game state this often
const HOST_STALE_MS = 8000;      // no word from the host for this long = host is frozen
const HOST_GONE_GRACE_MS = 5000; // host missing for this long = pick a new host
const REJOIN_MS = 6 * 3600e3;    // how long a phone remembers which room it was in
const DRUMROLL_MS = 2300;

// ---------- small helpers ----------
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
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
const clone = (o) => JSON.parse(JSON.stringify(o));

let toastTimer;
function toast(msg, ms = 4500) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

const SCREENS = ['home', 'lobby', 'loading', 'question', 'board', 'final', 'season'];
let currentScreen = 'home';
function show(name) {
  currentScreen = name;
  for (const s of SCREENS) $(`#screen-${s}`).hidden = s !== name;
}

// ---------- identity & remembered rooms (for rejoining) ----------
const me = {
  id: store.get('ft-id', sessionStorage) || '',
  name: store.get('ft-name') || '',
};

function loadRooms() {
  try {
    const all = JSON.parse(store.get('ft-rooms') || '{}');
    for (const [code, r] of Object.entries(all)) if (!r || Date.now() - r.at > REJOIN_MS) delete all[code];
    return all;
  } catch { return {}; }
}
function rememberRoom(code) {
  const all = loadRooms();
  all[code] = { id: me.id, name: me.name, at: Date.now() };
  store.set('ft-rooms', JSON.stringify(all));
}
function forgetRoom(code) {
  const all = loadRooms();
  delete all[code];
  store.set('ft-rooms', JSON.stringify(all));
}
// Keep the same player id for a room so a reconnecting phone gets its score back.
function useIdFor(code) {
  const saved = loadRooms()[code];
  if (!me.id) me.id = saved?.id || newId();
  store.set('ft-id', me.id, sessionStorage);
}

// ---------- state ----------
let cfg = null;
let sb = null;
let channel = null;
let roomCode = null;
let isHost = false;
let host = null;           // full game state, only on the hosting phone
let hostTimer = null;
let backup = null;         // latest copy of the host's state, in case the host drops
let view = null;           // last snapshot shown
let myAnswer = null;       // { qIndex, choice }
let myTopic = '';
let renderedQ = -1;
let revealedFor = '';
let finalShownFor = '';
let deadline = 0;
let lastTickSecond = -1;
let rafId = 0;
let joinTimer = null;
let loopTimer = null;
let loopCount = 0;
let lastStateAt = 0;
let joinedAt = 0;
let missingSince = 0;
let lastOnlineCount = 0;
let viewingSeason = false;
let seasonPeriod = 'month';
let wakeLock = null;

// ---------- boot ----------
init();

async function init() {
  $('#name').value = me.name;
  const roomParam = cleanCode(new URLSearchParams(location.search).get('room'));
  if (roomParam) $('#join-code').value = roomParam;

  buildCategoryGrid();
  buildTopicIdeas();
  wireEvents();
  updateMuteButton();

  try {
    cfg = await (await fetch('/api/config')).json();
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
  $$('.btn-season').forEach((b) => (b.hidden = !cfg.leaderboardEnabled));

  if (roomParam) {
    // A host who refreshed picks up where they left off.
    const saved = store.get('ft-host', sessionStorage);
    if (saved) {
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
    // A player whose phone dropped out goes straight back in.
    const remembered = loadRooms()[roomParam];
    if (remembered?.name) {
      me.name = remembered.name;
      $('#name').value = me.name;
      joinRoom({ code: roomParam, auto: true });
      return;
    }
  }
  show('home');
}

function wireEvents() {
  document.addEventListener('pointerdown', unlockAudio, { passive: true });
  $('#btn-mute').addEventListener('click', () => {
    setMuted(!isMuted());
    updateMuteButton();
  });
  $('#btn-create').addEventListener('click', createRoom);
  $('#btn-join').addEventListener('click', () => joinRoom());
  $('#join-code').addEventListener('input', (e) => (e.target.value = cleanCode(e.target.value)));
  $('#join-code').addEventListener('keydown', (e) => e.key === 'Enter' && joinRoom());
  $('#name').addEventListener('keydown', (e) => e.key === 'Enter' && ($('#join-code').value ? joinRoom() : createRoom()));
  $$('.btn-leave').forEach((b) => b.addEventListener('click', leaveRoom));
  $$('.btn-season').forEach((b) => b.addEventListener('click', () => openSeason()));
  $('#btn-season-back').addEventListener('click', closeSeason);
  $('#tab-month').addEventListener('click', () => openSeason('month'));
  $('#tab-all').addEventListener('click', () => openSeason('all'));
  $('#btn-copy').addEventListener('click', copyLink);
  $('#tab-category').addEventListener('click', () => setSource('category'));
  $('#tab-custom').addEventListener('click', () => setSource('custom'));
  $('#tab-everyone').addEventListener('click', () => setSource('everyone'));
  $('#custom-topic').addEventListener('input', (e) => updateSetting({ topic: e.target.value.slice(0, 120) }, false));
  $('#custom-topic').addEventListener('change', () => hostBroadcast());
  $('#set-amount').addEventListener('change', (e) => updateSetting({ amount: +e.target.value }));
  $('#set-time').addEventListener('change', (e) => updateSetting({ time: +e.target.value }));
  $('#set-difficulty').addEventListener('change', (e) => updateSetting({ difficulty: e.target.value }));
  $('#btn-save-topic').addEventListener('click', saveMyTopic);
  $('#my-topic-input').addEventListener('keydown', (e) => e.key === 'Enter' && saveMyTopic());
  $('#btn-start').addEventListener('click', startGame);
  $('#btn-host-next').addEventListener('click', hostSkip);
  $('#btn-host-next-2').addEventListener('click', hostSkip);
  $('#btn-again').addEventListener('click', playAgain);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && roomCode) {
      keepAwake();
      if (!isHost && view) channel?.send({ type: 'broadcast', event: 'hello', payload: {} });
    }
  });
  addEventListener('pagehide', () => {
    try { channel?.untrack(); } catch { /* ignore */ }
  });
}

function updateMuteButton() {
  const b = $('#btn-mute');
  b.setAttribute('aria-pressed', String(isMuted()));
  b.setAttribute('aria-label', isMuted() ? 'Turn sound on' : 'Turn sound off');
  b.classList.toggle('is-muted', isMuted());
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

// ---------- keep the screen awake during a game ----------
async function keepAwake() {
  try {
    if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    if (wakeLock && !wakeLock.released) return;
    wakeLock = await navigator.wakeLock.request('screen');
  } catch { /* not supported or refused; the game still works */ }
}
function letSleep() {
  try { wakeLock?.release(); } catch { /* ignore */ }
  wakeLock = null;
}

// ---------- rooms ----------
async function createRoom() {
  if (!readName() || !sb) return;
  unlockAudio();
  const code = makeCode();
  useIdFor(code);
  isHost = true;
  host = {
    code,
    hostId: me.id,
    epoch: 1,
    ticket: null,
    phase: 'lobby',
    settings: { source: 'category', category: '9', categoryName: 'General knowledge', topic: '', amount: 10, time: 20, difficulty: 'mixed' },
    players: { [me.id]: { name: me.name, score: 0, streak: 0, gain: 0 } },
    topics: {},
    online: [me.id],
    questions: [],
    qIndex: -1,
    qStartedAt: 0,
    answers: {},
    reveal: null,
    phaseEndsAt: 0,
    loadingText: '',
    gameId: '',
    seasonNote: '',
  };
  connect(code);
  getTicket(code).catch(() => {});
}

// Asks the server for a signed ticket proving this room was made in the game.
async function getTicket(code) {
  const r = await fetch('/api/room', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ticket) throw new Error(data.error || 'Could not register the room.');
  if (host && host.code === code) {
    host.ticket = data.ticket;
    store.set('ft-host', JSON.stringify(host), sessionStorage);
  }
  return data.ticket;
}

function ticketHoursLeft(ticket) {
  try {
    const payload = JSON.parse(atob(ticket.split('.')[0].replace(/-/g, '+').replace(/_/g, '/')));
    return (payload.e - Date.now()) / 3600e3;
  } catch { return 0; }
}

function joinRoom({ code: given, auto = false } = {}) {
  if (!auto && !readName()) return;
  if (!sb) return;
  unlockAudio();
  const code = cleanCode(given ?? $('#join-code').value);
  if (code.length !== 4) {
    toast('Room codes are 4 letters. Ask your host for theirs.');
    $('#join-code').focus();
    return;
  }
  useIdFor(code);
  isHost = false;
  host = null;
  connect(code);
  show('loading');
  $('#loading-text').textContent = auto ? `Rejoining room ${code}…` : `Joining room ${code}…`;
  clearTimeout(joinTimer);
  joinTimer = setTimeout(() => {
    if (!view) {
      toast(auto ? `The game in room ${code} has ended.` : `No game found for ${code}. Check the code with your host.`);
      forgetRoom(code);
      leaveRoom();
    }
  }, JOIN_TIMEOUT_MS);
}

function connect(code) {
  roomCode = code;
  rememberRoom(code);
  history.replaceState(null, '', `?room=${code}`);
  channel = sb.channel(`friends-trivia-${code}`, {
    config: { broadcast: { self: false }, presence: { key: me.id } },
  });
  channel.on('broadcast', { event: 'state' }, ({ payload }) => onState(payload));
  channel.on('broadcast', { event: 'backup' }, ({ payload }) => {
    if (!isHost && payload?.code === roomCode && (payload.epoch || 0) >= (view?.epoch || 0)) backup = payload;
  });
  channel.on('broadcast', { event: 'answer' }, ({ payload }) => {
    if (isHost && payload) hostHandleAnswer(payload.id, payload.qIndex, payload.choice);
  });
  channel.on('broadcast', { event: 'topic' }, ({ payload }) => {
    if (isHost && payload) hostSetTopic(payload.id, payload.topic);
  });
  channel.on('broadcast', { event: 'hello' }, () => {
    if (isHost) hostBroadcast();
  });
  channel.on('broadcast', { event: 'leaving' }, ({ payload }) => {
    // The host left on purpose: pick a new host straight away.
    if (!isHost && view && payload?.id === view.hostId) {
      lastStateAt = 0;
      missingSince = Date.now() - HOST_GONE_GRACE_MS;
      checkHost();
    }
  });
  channel.on('presence', { event: 'sync' }, onPresence);
  channel.subscribe(async (status) => {
    if (status === 'SUBSCRIBED') {
      joinedAt = Date.now();
      await channel.track({ name: me.name, host: isHost });
      if (isHost) hostBroadcast();
      else channel.send({ type: 'broadcast', event: 'hello', payload: {} });
    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
      toast('Connection trouble. The game will reconnect when your internet is back.');
    }
  });
  clearInterval(loopTimer);
  loopCount = 0;
  loopTimer = setInterval(roomLoop, 1000);
  keepAwake();
}

function leaveRoom() {
  clearTimeout(joinTimer);
  clearTimeout(hostTimer);
  clearInterval(loopTimer);
  cancelAnimationFrame(rafId);
  if (channel) {
    // Hand the game over instead of freezing everyone.
    if (isHost && host && host.online.some((id) => id !== me.id)) {
      channel.send({ type: 'broadcast', event: 'backup', payload: backupOf(host) });
      channel.send({ type: 'broadcast', event: 'leaving', payload: { id: me.id } });
    }
    channel.untrack().catch(() => {});
    sb.removeChannel(channel);
  }
  if (roomCode) forgetRoom(roomCode);
  if (isHost) store.del('ft-host', sessionStorage);
  letSleep();
  channel = null; roomCode = null; isHost = false; host = null; view = null; backup = null;
  myAnswer = null; renderedQ = -1; missingSince = 0; viewingSeason = false;
  me.id = '';
  store.del('ft-id', sessionStorage);
  $('#host-gone').hidden = true;
  history.replaceState(null, '', '/');
  show('home');
}

function onlineIds() {
  if (!channel) return [];
  return Object.keys(channel.presenceState());
}

function onPresence() {
  const state = channel.presenceState();
  const online = Object.entries(state).map(([id, metas]) => ({ id, ...(metas[0] || {}) }));
  if (online.length > lastOnlineCount && lastOnlineCount > 0 && (view?.phase === 'lobby')) sfx.join();
  lastOnlineCount = online.length;
  if (isHost) {
    host.online = online.map((p) => p.id);
    if (!host.online.includes(me.id)) host.online.push(me.id);
    for (const p of online) {
      if (p.id === me.id) continue;
      const name = String(p.name || 'Player').slice(0, 16);
      if (!host.players[p.id]) host.players[p.id] = { name, score: 0, streak: 0, gain: 0 };
      else host.players[p.id].name = name;
    }
    hostBroadcast({ backup: false });
    if (host.phase === 'question' && everyoneAnswered()) endQuestion();
  } else {
    checkHost();
  }
}

// Runs every second while in a room.
function roomLoop() {
  loopCount += 1;
  if (isHost) {
    // Heartbeat: re-send the state so everyone knows the host is alive;
    // every few beats also send a full backup for a possible takeover.
    if (loopCount % (HEARTBEAT_MS / 1000) === 0) hostBroadcast({ backup: loopCount % 6 === 0 });
  } else {
    checkHost();
  }
}

// ---------- host handover ----------
function checkHost() {
  if (isHost || !view || !channel) return;
  const online = onlineIds();
  const present = online.includes(view.hostId);
  const stale = Date.now() - lastStateAt > HOST_STALE_MS;
  if (present && !stale) {
    missingSince = 0;
    $('#host-gone').hidden = true;
    return;
  }
  // Don't blame the host if it's our own connection that is down.
  if (channel.state && channel.state !== 'joined') return;
  if (Date.now() - joinedAt < HOST_STALE_MS + 1000 && present) return;
  if (!missingSince) missingSince = Date.now();
  // A silent host has already been quiet for HOST_STALE_MS, so it needs less extra waiting.
  if (Date.now() - missingSince < (present ? 2000 : HOST_GONE_GRACE_MS)) return;
  $('#host-gone').hidden = false;
  // Everyone runs the same rule, so they agree on who takes over: lowest player id still here.
  const candidates = online.filter((id) => id !== view.hostId).sort();
  if (candidates[0] === me.id) takeOver();
}

function hostFromSnapshot(s) {
  const players = {};
  for (const p of s.players) players[p.id] = { name: p.name, score: p.score, streak: p.streak, gain: 0 };
  return {
    code: s.code, hostId: s.hostId, epoch: s.epoch || 1, ticket: null,
    phase: s.phase === 'final' ? 'final' : 'lobby',
    settings: s.settings, players, topics: {}, online: [],
    questions: [], qIndex: -1, qStartedAt: 0, answers: {}, reveal: null,
    phaseEndsAt: 0, loadingText: '', gameId: s.gameId || '', seasonNote: s.seasonNote || '',
  };
}

function takeOver() {
  const base = backup && backup.code === roomCode && (backup.epoch || 0) >= (view.epoch || 0) ? clone(backup) : hostFromSnapshot(view);
  const oldHost = view.hostId;
  host = base;
  host.hostId = me.id;
  host.epoch = Math.max(base.epoch || 1, view.epoch || 1) + 1;
  host.online = onlineIds().filter((id) => id !== oldHost);
  if (!host.online.includes(me.id)) host.online.push(me.id);
  if (!host.players[me.id]) host.players[me.id] = { name: me.name, score: 0, streak: 0, gain: 0 };
  isHost = true;
  missingSince = 0;
  const now = Date.now();
  switch (host.phase) {
    case 'question':
      // Answers sent to the old host are lost, so replay this question from the start.
      host.answers = {};
      host.qStartedAt = now;
      myAnswer = null;
      renderedQ = -1;
      hostSchedule(endQuestion, host.settings.time * 1000);
      break;
    case 'reveal':
      host.phaseEndsAt = now + 2500;
      hostSchedule(afterReveal, 2500);
      break;
    case 'board':
      host.phaseEndsAt = now + 2500;
      hostSchedule(nextQuestion, 2500);
      break;
    case 'loading':
      host.phase = 'lobby';
      break;
  }
  channel.track({ name: me.name, host: true });
  $('#host-gone').hidden = true;
  hostBroadcast();
  toast('The host dropped out, so you\'re hosting now. Keep this screen open.', 6000);
  keepAwake();
}

function stepDown(s) {
  clearTimeout(hostTimer);
  isHost = false;
  host = null;
  store.del('ft-host', sessionStorage);
  channel?.track({ name: me.name, host: false });
  lastStateAt = Date.now();
  renderedQ = -1;
  applySnapshot(s);
}

function onState(s) {
  if (!s || s.code !== roomCode) return;
  if (isHost) {
    if (s.hostId === me.id) return;
    // Two hosts (e.g. the old one came back): the newer handover wins.
    if (s.epoch > host.epoch || (s.epoch === host.epoch && s.hostId < me.id)) stepDown(s);
    else hostBroadcast();
    return;
  }
  if (view && (s.epoch || 0) < (view.epoch || 0)) return; // an old host that just woke up
  lastStateAt = Date.now();
  missingSince = 0;
  $('#host-gone').hidden = true;
  applySnapshot(s);
}

// ---------- host: settings & topics ----------
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
  if ((source === 'custom' || source === 'everyone') && !cfg?.aiEnabled) {
    toast('Custom topics need a Gemini key on the server.');
    return;
  }
  updateSetting({ source });
  if (host) syncSettingsUI(host.settings);
  if (source === 'custom') $('#custom-topic').focus();
}

function updateSetting(patch, broadcast = true) {
  if (!isHost || !host) return;
  Object.assign(host.settings, patch);
  if (broadcast) hostBroadcast();
}

function saveMyTopic() {
  const topic = $('#my-topic-input').value.replace(/\s+/g, ' ').trim().slice(0, 80);
  if (topic.length < 2) {
    toast('Type a topic first, like "Afrobeats" or "Formula 1".');
    return;
  }
  myTopic = topic;
  if (isHost) hostSetTopic(me.id, topic);
  else channel?.send({ type: 'broadcast', event: 'topic', payload: { id: me.id, topic } });
  $('#my-topic-status').textContent = 'Saved. It stays secret until the questions appear.';
  sfx.lockIn();
}

function hostSetTopic(id, topic) {
  if (!host || !host.players[id] || host.phase !== 'lobby') return;
  const t = String(topic || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (t.length >= 2) host.topics[id] = t;
  else delete host.topics[id];
  hostBroadcast({ backup: false });
}

function settingsLabel(s, topicCount = 0) {
  let what = s.categoryName;
  if (s.source === 'custom') what = s.topic.trim() ? `“${s.topic.trim()}”` : 'a custom topic';
  if (s.source === 'everyone') what = `everyone's topics (${topicCount} in so far)`;
  return `${what} · ${s.amount} questions · ${s.time}s each · ${s.difficulty}`;
}

// ---------- host: game flow ----------
function hostSchedule(fn, ms) {
  clearTimeout(hostTimer);
  hostTimer = setTimeout(fn, Math.max(0, ms));
}

function activeTopics() {
  return Object.entries(host.topics).filter(([id]) => host.online.includes(id) && host.players[id]);
}

function snapshot() {
  const now = Date.now();
  const q = host.questions[host.qIndex];
  const durationMs = host.settings.time * 1000;
  const players = rankPlayers(host.players).map((p) => ({
    id: p.id, name: p.name, score: p.score, streak: p.streak, gain: p.gain,
    online: host.online.includes(p.id),
    answered: Boolean(host.answers[p.id]),
    picked: Boolean(host.topics[p.id]),
  }));
  const topicCount = activeTopics().length;
  const showQ = (host.phase === 'question' || host.phase === 'reveal') && q;
  return {
    code: host.code,
    hostId: host.hostId,
    epoch: host.epoch,
    hostName: host.players[host.hostId]?.name || 'the host',
    phase: host.phase,
    settings: host.settings,
    settingsText: settingsLabel(host.settings, topicCount),
    topicCount,
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
    gameId: host.gameId,
    seasonNote: host.seasonNote,
  };
}

function backupOf(h) {
  return clone(h);
}

function hostBroadcast({ backup: withBackup = true } = {}) {
  if (!isHost || !host) return;
  store.set('ft-host', JSON.stringify(host), sessionStorage);
  const snap = snapshot();
  if (channel) {
    channel.send({ type: 'broadcast', event: 'state', payload: snap });
    if (withBackup) channel.send({ type: 'broadcast', event: 'backup', payload: backupOf(host) });
  }
  applySnapshot(snap);
}

async function ensureTicket() {
  if (host.ticket && ticketHoursLeft(host.ticket) > 1) return host.ticket;
  return getTicket(host.code);
}

async function startGame() {
  if (!isHost) return;
  const s = host.settings;
  if (s.source === 'custom' && s.topic.trim().length < 2) {
    toast('Describe a topic first, or pick a category.');
    $('#custom-topic').focus();
    return;
  }
  if (s.source === 'everyone' && !activeTopics().length) {
    toast('Nobody has saved a topic yet. Type yours in the box above.');
    $('#my-topic-input').focus();
    return;
  }
  host.phase = 'loading';
  host.loadingText = s.source === 'custom'
    ? `Writing questions about “${s.topic.trim()}”…`
    : s.source === 'everyone'
      ? `Mixing questions from ${activeTopics().length} topic${activeTopics().length > 1 ? 's' : ''}…`
      : `Getting ${s.categoryName} questions…`;
  hostBroadcast();
  try {
    const questions = await fetchQuestions(s);
    if (!isHost || !host) return;
    for (const [id, p] of Object.entries(host.players)) {
      Object.assign(p, { score: 0, streak: 0, gain: 0, played: host.online.includes(id) });
    }
    host.questions = questions;
    host.qIndex = -1;
    host.gameId = newId();
    host.seasonNote = '';
    nextQuestion();
  } catch (err) {
    if (!host) return;
    host.phase = 'lobby';
    hostBroadcast();
    toast(err.message || 'Could not get questions. Try again.', 6500);
  }
}

async function fetchQuestions(s) {
  if (s.source === 'custom') return generate([s.topic.trim()], s);
  if (s.source === 'everyone') {
    const picks = activeTopics();
    const questions = await generate(picks.map(([, t]) => t), s);
    // Label each question with whose pick it was.
    return questions.map((q) => {
      const owners = picks.filter(([, t]) => t.toLowerCase() === String(q.category).toLowerCase()).map(([id]) => host.players[id].name);
      return { ...q, category: owners.length ? `${owners.join(' & ')}'s pick: ${q.category}` : q.category };
    });
  }
  try {
    const qs = new URLSearchParams({ amount: s.amount, category: s.category, difficulty: s.difficulty === 'mixed' ? '' : s.difficulty });
    const r = await fetch(`/api/questions?${qs}`);
    const data = await r.json();
    if (r.ok && data.questions?.length) return data.questions;
    throw new Error(data.error);
  } catch {
    // Open Trivia DB is down or empty: let Gemini cover the same category.
    if (cfg?.aiEnabled) return generate([s.category ? s.categoryName : 'general knowledge'], s);
    throw new Error('Couldn\'t get questions from Open Trivia DB right now. Wait a few seconds and press Start again.');
  }
}

async function generate(topics, s) {
  const ticket = await ensureTicket();
  const r = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ topics, amount: s.amount, difficulty: s.difficulty, ticket }),
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
    finishGame();
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
  host.players[id].played = true;
  if (everyoneAnswered()) endQuestion();
  else hostBroadcast({ backup: false });
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
    finishGame();
    return;
  }
  host.phase = 'board';
  host.phaseEndsAt = Date.now() + BOARD_MS;
  hostBroadcast();
  hostSchedule(nextQuestion, BOARD_MS);
}

function finishGame() {
  host.phase = 'final';
  host.seasonNote = '';
  hostBroadcast();
  saveSeason().catch(() => {});
}

// Sends the final scores to the season leaderboard (once per game).
async function saveSeason() {
  if (!cfg?.leaderboardEnabled || !host?.gameId || host.savedGameId === host.gameId) return;
  host.savedGameId = host.gameId;
  const players = Object.values(host.players).filter((p) => p.played).map((p) => ({ name: p.name, score: p.score }));
  if (players.length < 2) {
    host.seasonNote = 'Solo games don\'t count towards the season leaderboard.';
    hostBroadcast({ backup: false });
    return;
  }
  try {
    const ticket = await ensureTicket();
    const r = await fetch('/api/results', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticket, gameId: host.gameId, players }),
    });
    const data = await r.json().catch(() => ({}));
    host.seasonNote = r.ok && data.saved ? 'Saved to the season leaderboard.' : (data.reason || data.error || 'Couldn\'t save to the season leaderboard.');
  } catch {
    host.seasonNote = 'Couldn\'t save to the season leaderboard.';
  }
  if (host) hostBroadcast({ backup: false });
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
  if (first) {
    lastStateAt = Date.now();
    rememberRoom(roomCode);
  }
  if (viewingSeason) {
    if (s.phase === 'lobby' || s.phase === 'final') return;
    viewingSeason = false;
  }
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

function renderPlayerList(list, players, { showPicked = false } = {}) {
  list.replaceChildren();
  for (const p of players) {
    const li = el('li', 'player');
    if (!p.online) li.classList.add('offline');
    li.append(el('span', 'avatar', initials(p.name)));
    li.append(el('span', 'player-name', p.name));
    if (showPicked) li.append(el('span', p.picked ? 'tag tag-ok' : 'tag', p.picked ? 'topic in' : 'no topic yet'));
    if (p.id === view.hostId) li.append(el('span', 'tag', 'host'));
    if (p.id === me.id) li.append(el('span', 'tag tag-me', 'you'));
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
  $('#btn-whatsapp').href = `https://wa.me/?text=${encodeURIComponent(`Join my MITO Friends Trivia game! Room code ${s.code}: ${link}`)}`;
  const online = s.players.filter((p) => p.online);
  const everyone = s.settings?.source === 'everyone';
  $('#player-count').textContent = String(online.length);
  renderPlayerList($('#lobby-players'), online, { showPicked: everyone });

  $('#my-topic').hidden = !everyone;
  if (everyone) {
    const mine = s.players.find((p) => p.id === me.id);
    if (document.activeElement !== $('#my-topic-input') && !$('#my-topic-input').value && myTopic) $('#my-topic-input').value = myTopic;
    $('#my-topic-status').textContent = mine?.picked
      ? 'Saved. It stays secret until the questions appear.'
      : 'Type a topic you\'d love to be quizzed on, then save it.';
  }

  $('#host-settings').hidden = !isHost;
  $('#guest-wait').hidden = isHost;
  if (isHost && host) {
    syncSettingsUI(host.settings);
    $('#everyone-count').textContent = `${s.topicCount} of ${online.length} players have saved a topic.`;
  } else {
    $('#guest-wait-text').textContent = `Waiting for ${s.hostName} to start…`;
    $('#guest-settings').textContent = s.settingsText;
  }
  show('lobby');
}

// Keeps the host's controls matching their settings (e.g. after a refresh or takeover).
function syncSettingsUI(st) {
  for (const src of ['category', 'custom', 'everyone']) {
    $(`#tab-${src}`).setAttribute('aria-selected', String(st.source === src));
    $(`#panel-${src}`).hidden = st.source !== src;
  }
  $$('#category-grid .chip').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.id === st.category)));
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
    lastTickSecond = -1;
    if (!myAnswer || myAnswer.qIndex !== s.qIndex) myAnswer = null;
    // Rejoined after already answering this one: stay locked in.
    if (!myAnswer && s.players.find((p) => p.id === me.id)?.answered) myAnswer = { qIndex: s.qIndex, choice: -1 };
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
  } else if (currentScreen !== 'question') {
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
  $$('#answers .answer').forEach((b, i) => {
    b.disabled = Boolean(myAnswer) || view?.phase !== 'question';
    b.classList.toggle('picked', myAnswer?.choice === i);
    b.classList.toggle('dim', Boolean(myAnswer) && myAnswer.choice !== i);
  });
}

function pickAnswer(choice) {
  if (!view || view.phase !== 'question' || myAnswer) return;
  myAnswer = { qIndex: view.qIndex, choice };
  sfx.lockIn();
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
    if (secs !== lastTickSecond) {
      if (lastTickSecond !== -1 && secs > 0 && secs <= 5) sfx.tick(secs);
      lastTickSecond = secs;
    }
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
  stopTimer();
  show('question');
  $('#timer-fill').style.transform = 'scaleX(0)';
  $('#timer-num').textContent = '0';
  const r = s.reveal;
  $('#screen-question').classList.add('revealed');
  $$('#answers .answer').forEach((b, i) => {
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
  let sound = 'wrong';
  if (!mine || mine.choice === null) {
    res.textContent = 'Too slow — no answer this time.';
    res.classList.add('is-miss');
  } else if (mine.correct) {
    res.textContent = `Correct! +${mine.gained}${mine.streak >= 2 ? ` · ${mine.streak} in a row` : ''}`;
    res.classList.add('is-right');
    sound = 'correct';
  } else {
    res.textContent = 'Not this time.';
    res.classList.add('is-wrong');
  }
  const key = `${s.gameId}:${s.qIndex}`;
  if (revealedFor !== key) {
    revealedFor = key;
    sfx[sound]();
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
  s.players.filter((p) => p.online || p.score > 0).forEach((p, i) => {
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
  const players = s.players.filter((p) => p.online || p.score > 0);
  const podium = $('#podium');
  podium.replaceChildren();
  const top = players.slice(0, 3);
  for (const i of [1, 0, 2].filter((n) => top[n])) {
    const p = top[i];
    const col = el('div', `step step-${i + 1}`);
    col.append(el('span', 'step-name', p.name), el('span', 'step-score', p.score.toLocaleString()), el('span', 'step-block', String(i + 1)));
    podium.append(col);
  }
  const list = $('#final-list');
  list.replaceChildren();
  players.slice(3).forEach((p, i) => {
    const li = el('li', 'board-row');
    if (p.id === me.id) li.classList.add('is-me');
    li.append(el('span', 'rank', String(i + 4)), el('span', 'board-name', p.name), el('span', 'score', p.score.toLocaleString()));
    list.append(li);
  });
  $('#season-note').textContent = s.seasonNote || '';
  $('#season-note').hidden = !s.seasonNote;
  $('#btn-again').hidden = !isHost;
  $('#final-wait').hidden = isHost;

  // First time we see this game's final: drumroll, then the podium.
  const key = `${s.code}:${s.gameId}`;
  if (finalShownFor !== key) {
    finalShownFor = key;
    $('#drumroll').hidden = false;
    $('#final-body').hidden = true;
    sfx.drumroll(DRUMROLL_MS);
    setTimeout(() => {
      $('#drumroll').hidden = true;
      $('#final-body').hidden = false;
      sfx.fanfare();
    }, DRUMROLL_MS);
  }
  show('final');
}

// ---------- season leaderboard ----------
async function openSeason(period = seasonPeriod) {
  seasonPeriod = period;
  viewingSeason = true;
  $('#tab-month').setAttribute('aria-selected', String(period === 'month'));
  $('#tab-all').setAttribute('aria-selected', String(period === 'all'));
  const list = $('#season-list');
  const empty = $('#season-empty');
  list.replaceChildren();
  empty.hidden = false;
  empty.textContent = 'Loading…';
  show('season');
  try {
    const r = await fetch(`/api/leaderboard?period=${period}`);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error);
    if (seasonPeriod !== period) return;
    list.replaceChildren();
    if (!data.players.length) {
      empty.textContent = period === 'month' ? 'No games saved this month yet. Play one!' : 'No games saved yet. Play one!';
      return;
    }
    empty.hidden = true;
    data.players.forEach((p, i) => {
      const li = el('li', 'board-row season-row');
      if (p.player_name.toLowerCase() === me.name.toLowerCase()) li.classList.add('is-me');
      const who = el('span', 'board-name');
      who.append(el('span', null, p.player_name), el('span', 'season-meta', `${p.wins} win${p.wins === 1 ? '' : 's'} · ${p.games} game${p.games === 1 ? '' : 's'}`));
      li.append(el('span', 'rank', String(i + 1)), who, el('span', 'score', Number(p.points).toLocaleString()));
      list.append(li);
    });
  } catch (err) {
    empty.textContent = err.message || 'Couldn\'t load the leaderboard.';
  }
}

function closeSeason() {
  viewingSeason = false;
  if (view && roomCode) applySnapshot(view);
  else show('home');
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

// A tiny hook for automated tests.
window.__trivia = {
  get view() { return view; },
  get me() { return me; },
  get isHost() { return isHost; },
};
