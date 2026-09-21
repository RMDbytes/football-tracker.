import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import Parser from 'rss-parser';
import { WebSocketServer } from 'ws';

const dir = path.dirname(fileURLToPath(import.meta.url));

// ---------- Settings (all optional; set them as "environment variables" on your host) ----------
const API_KEY = process.env.API_KEY || '';                       // API-Football key. Empty = demo mode
const PORT = process.env.PORT || 3000;
const NEWS_FEEDS = process.env.NEWS_FEEDS || '';                 // comma-separated RSS feed links
const DAILY_LIMIT = Number(process.env.DAILY_LIMIT || 100);      // your plan's requests per day
const LIVE_POLL_SECONDS = Number(process.env.LIVE_POLL_SECONDS || 300); // 300 suits the free plan

const DEMO = !API_KEY;
const BASE = 'https://v3.football.api-sports.io';
const LIVE_STATUSES = ['1H', 'HT', '2H', 'ET', 'BT', 'P', 'LIVE', 'INT'];
const isLive = (s) => LIVE_STATUSES.includes(s);

// ---------- Storage (in memory; it refills itself from the API after a restart) ----------
const fixtures = new Map();

function save(rows) {
  const changes = [];
  for (const row of rows) {
    const old = fixtures.get(row.id);
    fixtures.set(row.id, row);
    if (!old) continue;
    const scoreChanged =
      old.homeGoals !== null &&
      (old.homeGoals !== row.homeGoals || old.awayGoals !== row.awayGoals);
    if (scoreChanged) changes.push({ type: 'score', fixture: row });
    else if (old.status !== row.status) changes.push({ type: 'status', fixture: row });
  }
  return changes;
}

function prune() {
  const cutoff = Date.now() - 3 * 86400000;
  for (const [id, f] of fixtures) if (f.kickoff < cutoff) fixtures.delete(id);
}

const toRow = (x) => ({
  id: x.fixture.id,
  leagueId: x.league.id,
  league: x.league.name,
  country: x.league.country,
  home: x.teams.home.name,
  away: x.teams.away.name,
  homeGoals: x.goals.home,
  awayGoals: x.goals.away,
  status: x.fixture.status.short,
  elapsed: x.fixture.status.elapsed,
  kickoff: x.fixture.timestamp * 1000,
});

// ---------- Live push to phones and browsers ----------
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/live' });
function broadcast(message) {
  const data = JSON.stringify(message);
  for (const client of wss.clients) if (client.readyState === 1) client.send(data);
}

// ---------- API-Football client ----------
const usage = { day: '', count: 0 };
const canSpend = (reserve = 0) => usage.day !== today() || usage.count < DAILY_LIMIT - reserve;
function today() {
  return new Date().toISOString().slice(0, 10);
}

async function api(pathname, params = {}) {
  if (usage.day !== today()) Object.assign(usage, { day: today(), count: 0 });
  if (usage.count >= DAILY_LIMIT) throw new Error('Daily request limit reached');
  usage.count += 1;

  const url = new URL(BASE + pathname);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { 'x-apisports-key': API_KEY } });
  if (!res.ok) throw new Error(`API-Football HTTP ${res.status} on ${pathname}`);
  const json = await res.json();
  if (json.errors && Object.keys(json.errors).length > 0) {
    throw new Error(`API-Football error: ${JSON.stringify(json.errors)}`);
  }
  return json.response ?? [];
}

const cache = new Map();
async function cached(key, ttlMs, loader) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await loader();
  cache.set(key, { at: Date.now(), value });
  return value;
}

// ---------- Real data jobs ----------
async function syncDays() {
  for (const offset of [-1, 0, 1]) {
    if (!canSpend(10)) return;
    const date = new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
    const items = await api('/fixtures', { date });
    save(items.map(toRow));
  }
  prune();
  console.log(`Fixtures loaded: ${fixtures.size}`);
}

function liveWindowOpen() {
  const now = Date.now();
  for (const f of fixtures.values()) {
    if (isLive(f.status)) return true;
    if (f.status === 'NS' && f.kickoff <= now + 10 * 60000 && f.kickoff >= now - 3 * 3600000) return true;
  }
  return false;
}

async function syncLive() {
  // One request returns every live match in the world.
  const items = await api('/fixtures', { live: 'all' });
  const changes = save(items.map(toRow));
  changes.forEach(broadcast);
}

// ---------- Demo mode (no key needed) ----------
function seedDemo() {
  const now = Date.now();
  const min = 60000;
  const mk = (id, leagueId, league, country, home, away, hg, ag, status, elapsed, kickoff) => ({
    id, leagueId, league, country, home, away, homeGoals: hg, awayGoals: ag, status, elapsed, kickoff,
  });
  save([
    mk(9001, 39, 'Premier League', 'England', 'Northgate United', 'Riverside Town', 1, 0, '1H', 34, now - 36 * min),
    mk(9002, 39, 'Premier League', 'England', 'Harbor City', 'Eastfield Rovers', 2, 2, '2H', 67, now - 82 * min),
    mk(9003, 39, 'Premier League', 'England', 'Kingsbridge', 'Oakhill Athletic', null, null, 'NS', null, now + 90 * min),
    mk(9004, 140, 'La Liga', 'Spain', 'Costa Verde', 'Sierra FC', 3, 1, 'FT', 90, now - 190 * min),
    mk(9005, 135, 'Serie A', 'Italy', 'Bella Citta', 'Torre Calcio', null, null, 'NS', null, now + 150 * min),
    mk(9006, 253, 'MLS', 'USA', 'Lakeshore SC', 'Prairie FC', null, null, 'NS', null, now + 240 * min),
    mk(9007, 71, 'Brasileirao', 'Brazil', 'Rio Azul', 'Paulista FC', 2, 0, 'FT', 90, now - 200 * min),
  ]);
}

function tickDemo() {
  const now = Date.now();
  for (const f of [...fixtures.values()]) {
    const next = { ...f };
    if (f.status === 'NS' && f.kickoff <= now) {
      Object.assign(next, { status: '1H', elapsed: 1, homeGoals: 0, awayGoals: 0 });
    } else if (isLive(f.status)) {
      next.elapsed = f.elapsed + 1;
      if (next.elapsed >= 90) next.status = 'FT';
      else if (Math.random() < 0.12) {
        if (Math.random() < 0.5) next.homeGoals += 1;
        else next.awayGoals += 1;
      }
    } else continue;
    save([next]).forEach(broadcast);
  }
}

function demoDetail(f) {
  if (f.status === 'NS') return { events: [], stats: [] };
  const elapsed = f.elapsed ?? 90;
  const events = [];
  const addGoals = (n, team, shift) => {
    for (let i = 0; i < (n || 0); i++) {
      const minute = Math.min(elapsed, Math.max(1, Math.floor(((i + 1) / ((n || 0) + 1)) * elapsed) + shift));
      events.push({ minute, team, type: 'Goal', detail: 'Normal Goal', player: null });
    }
  };
  addGoals(f.homeGoals, f.home, 0);
  addGoals(f.awayGoals, f.away, 3);
  if (elapsed > 20) events.push({ minute: Math.floor(elapsed / 2), team: f.away, type: 'Card', detail: 'Yellow Card', player: null });
  events.sort((a, b) => a.minute - b.minute);
  const s = f.id % 7;
  const stats = [
    { type: 'Ball Possession', home: `${50 + s}%`, away: `${50 - s}%` },
    { type: 'Total Shots', home: 8 + s, away: 6 },
    { type: 'Shots on Goal', home: 3 + (s % 3), away: 2 },
    { type: 'Corner Kicks', home: 5, away: 3 + (s % 3) },
    { type: 'Fouls', home: 9, away: 11 },
  ];
  return { events, stats };
}

const DEMO_TABLE = [
  ['Northgate United', 6, 9, 16], ['Harbor City', 6, 8, 14], ['Kingsbridge', 6, 5, 13], ['Riverside Town', 6, 4, 11],
  ['Oakhill Athletic', 6, 2, 10], ['Eastfield Rovers', 6, 1, 9], ['Westmoor', 6, 0, 8], ['Fairview', 6, -2, 7],
].map(([team, played, goalDiff, points], i) => ({ rank: i + 1, team, played, goalDiff, points }));

const DEMO_NEWS = [
  { title: 'Demo mode: headlines from your news feeds show up here', link: '', source: 'Demo', published: new Date().toISOString() },
  { title: 'Add a news feed link in your settings to see real headlines', link: '', source: 'Demo', published: new Date().toISOString() },
];

// ---------- News (headlines and links only) ----------
const parser = new Parser();
async function loadNews() {
  const feeds = NEWS_FEEDS.split(',').map((s) => s.trim()).filter(Boolean);
  const all = [];
  for (const url of feeds) {
    try {
      const feed = await parser.parseURL(url);
      for (const item of feed.items.slice(0, 15)) {
        all.push({ title: item.title, link: item.link, source: feed.title, published: item.isoDate ?? null });
      }
    } catch (err) {
      console.error('News feed failed:', url, err.message);
    }
  }
  return all.sort((a, b) => (b.published ?? '').localeCompare(a.published ?? '')).slice(0, 40);
}

// ---------- Web addresses the app uses ----------
const wrap = (fn) => (req, res) =>
  fn(req, res).catch((err) => {
    console.error(err.message);
    res.status(502).json({ error: 'Data is unavailable right now' });
  });

app.get('/api/matches', (req, res) => {
  const from = Number(req.query.from) || Date.parse(`${today()}T00:00:00Z`);
  const to = Number(req.query.to) || from + 86400000;
  const rows = [...fixtures.values()]
    .filter((f) => f.kickoff >= from && f.kickoff < to)
    .sort((a, b) => a.league.localeCompare(b.league) || a.kickoff - b.kickoff);
  res.json(rows);
});

app.get('/api/matches/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const fixture = fixtures.get(id);
  if (!fixture) return res.status(404).json({ error: 'Match not found' });
  if (DEMO) return res.json({ fixture, ...demoDetail(fixture) });
  if (fixture.status === 'NS') return res.json({ fixture, events: [], stats: [] });

  const ttl = isLive(fixture.status) ? 60_000 : 60 * 60_000;
  const events = await cached(`events:${id}`, ttl, async () => {
    const list = await api('/fixtures/events', { fixture: id });
    return list.map((e) => ({
      minute: e.time.elapsed, team: e.team.name, type: e.type, detail: e.detail, player: e.player?.name ?? null,
    }));
  });
  const stats = await cached(`stats:${id}`, ttl, async () => {
    const list = await api('/fixtures/statistics', { fixture: id });
    if (list.length < 2) return [];
    return list[0].statistics.map((s, i) => ({ type: s.type, home: s.value, away: list[1].statistics[i]?.value ?? null }));
  });
  res.json({ fixture, events, stats });
}));

app.get('/api/standings/:leagueId', wrap(async (req, res) => {
  if (DEMO) return res.json(DEMO_TABLE);
  const now = new Date();
  const season = Number(req.query.season) || (now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1);
  const league = Number(req.params.leagueId);
  const table = await cached(`standings:${league}:${season}`, 60 * 60_000, async () => {
    const data = await api('/standings', { league, season });
    const rows = data[0]?.league?.standings?.[0] ?? [];
    return rows.map((r) => ({ rank: r.rank, team: r.team.name, played: r.all.played, goalDiff: r.goalsDiff, points: r.points }));
  });
  res.json(table);
}));

app.get('/api/news', wrap(async (_req, res) => {
  if (DEMO && !NEWS_FEEDS) return res.json(DEMO_NEWS);
  res.json(await cached('news', 10 * 60_000, loadNews));
}));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, demo: DEMO, requestsToday: usage.count, dailyLimit: DAILY_LIMIT });
});

app.use(express.static(path.join(dir, 'public')));

// ---------- Start ----------
if (DEMO) {
  seedDemo();
  setInterval(tickDemo, 15_000);
  console.log('DEMO MODE: no API_KEY set, showing sample matches.');
} else {
  const safe = (fn) => () => fn().catch((e) => console.error(e.message));
  safe(syncDays)();
  setInterval(safe(syncDays), 3 * 3600_000);
  setInterval(safe(async () => {
    if (liveWindowOpen() && canSpend(10)) await syncLive();
  }), LIVE_POLL_SECONDS * 1000);
}

server.listen(PORT, () => console.log(`Football Tracker running on port ${PORT}`));
