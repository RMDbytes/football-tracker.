import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import Parser from 'rss-parser';
import { WebSocketServer } from 'ws';
import { rowFromMatch, mapEvents, mapStats, mapLineups, mapBoxScore, mapStandings, safeUrl } from './highlightly.js';
import { buildIndex, annotate } from './newsmatch.js';

const dir = path.dirname(fileURLToPath(import.meta.url));

// ---------- Settings (optional; set them as "environment variables" on your host) ----------
const API_KEY = process.env.API_KEY || '';                              // API-Football key. Empty = demo mode
const PORT = process.env.PORT || 3000;
const NEWS_FEEDS = process.env.NEWS_FEEDS || '';                        // RSS feed links, separated by commas or spaces
const NEWS_FEED_TIMEOUT_MS = Number(process.env.NEWS_FEED_TIMEOUT_MS || 10000);
const NEWS_IMAGES = process.env.NEWS_IMAGES || 'publisher';             // publisher = photos from the feeds + club badges, crests = club badges only, off = no pictures
const DAILY_LIMIT = Number(process.env.DAILY_LIMIT || 100);             // your plan's requests per day
const LIVE_POLL_SECONDS = Number(process.env.LIVE_POLL_SECONDS || 300); // 300 suits the free plan
const ERROR_RETRY_SECONDS = Number(process.env.ERROR_RETRY_SECONDS || 45); // wait before retrying after a temporary problem

const HIGHLIGHTLY_KEY = process.env.HIGHLIGHTLY_KEY || ''; // Highlightly key (data source, and the test page)
const MAX_LIVE_LEAGUES = Number(process.env.MAX_LIVE_LEAGUES || 3); // Highlightly: leagues refreshed per live check
const FOOTBALL_DATA_KEY = process.env.FOOTBALL_DATA_KEY || ''; // football-data.org key: used for league tables of 12 big competitions
const DIAG_TOKEN = process.env.DIAG_TOKEN || '';           // any secret word; turns the test page on

// Which data source feeds the app: set DATA_PROVIDER to apifootball, highlightly or demo, or leave it empty to pick by which key exists.
const wanted = process.env.DATA_PROVIDER || (HIGHLIGHTLY_KEY ? 'highlightly' : API_KEY ? 'apifootball' : 'demo');
const PROVIDER =
  wanted === 'highlightly' && HIGHLIGHTLY_KEY ? 'highlightly'
  : wanted === 'apifootball' && API_KEY ? 'apifootball'
  : 'demo';
const DEMO = PROVIDER === 'demo';
const BASE = 'https://v3.football.api-sports.io';
const LIVE_STATUSES = ['1H', 'HT', '2H', 'ET', 'BT', 'P', 'LIVE', 'INT'];
const isLive = (s) => LIVE_STATUSES.includes(s);
const DAY = 86400000;

// ---------- Matches storage (in memory; refills itself from the API) ----------
const fixtures = new Map();
const dayCache = new Map();

function save(rows) {
  const changes = [];
  for (const row of rows) {
    const old = fixtures.get(row.id);
    fixtures.set(row.id, row);
    if (!old) continue;
    const scoreChanged =
      old.homeGoals !== null && (old.homeGoals !== row.homeGoals || old.awayGoals !== row.awayGoals);
    if (scoreChanged) changes.push({ type: 'score', fixture: row });
    else if (old.status !== row.status) changes.push({ type: 'status', fixture: row });
  }
  return changes;
}

function prune() {
  const cutoff = Date.now() - 10 * DAY;
  for (const [id, f] of fixtures) if (f.kickoff < cutoff) fixtures.delete(id);
  for (const [key, v] of dayCache) if (Date.now() - v.at > 2 * DAY) dayCache.delete(key);
}
setInterval(prune, 3600_000);

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
  leagueLogo: safeUrl(x.league.logo),
  homeLogo: safeUrl(x.teams.home.logo),
  awayLogo: safeUrl(x.teams.away.logo),
});

// ---------- Live push to phones and browsers ----------
const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/live' });
function broadcast(message) {
  const data = JSON.stringify(message);
  for (const client of wss.clients) if (client.readyState === 1) client.send(data);
}

// ---------- API-Football client ----------
const usage = { day: '', count: 0 };
const today = () => new Date().toISOString().slice(0, 10);
const canSpend = (reserve = 0) => usage.day !== today() || usage.count < DAILY_LIMIT - reserve;

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

// ---------- Highlightly client ----------
const HL_BASE = 'https://soccer.highlightly.net';
async function hl(pathname, params = {}) {
  if (usage.day !== today()) Object.assign(usage, { day: today(), count: 0 });
  if (usage.count >= DAILY_LIMIT) throw new Error('Daily request limit reached');
  usage.count += 1;
  const url = new URL(HL_BASE + pathname);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { 'x-rapidapi-key': HIGHLIGHTLY_KEY } });
  const left = Number(res.headers.get('x-ratelimit-requests-remaining'));
  if (Number.isFinite(left) && res.headers.get('x-ratelimit-requests-remaining') !== null) usage.count = Math.max(usage.count, DAILY_LIMIT - left);
  const text = await res.text();
  if (!res.ok) throw new Error(`Highlightly HTTP ${res.status} on ${pathname}: ${text.slice(0, 160)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Highlightly sent unreadable data on ${pathname}`);
  }
}

// All matches of one day (Highlightly sends 100 per page).
async function hlDay(date, tz, from, to) {
  const pages = async (params) => {
    const rows = [];
    let offset = 0;
    for (let page = 0; page < 6; page++) {
      const r = await hl('/matches', { ...params, limit: 100, offset });
      const list = Array.isArray(r?.data) ? r.data : [];
      rows.push(...list.map(rowFromMatch));
      offset += list.length;
      if (!list.length || offset >= (r?.pagination?.totalCount ?? 0)) break;
    }
    return rows;
  };
  try {
    return await pages({ date, timezone: tz });
  } catch (err) {
    if (!/timezone/i.test(err.message)) throw err;
    const first = new Date(from).toISOString().slice(0, 10);
    const last = new Date(to - 1).toISOString().slice(0, 10);
    const rows = [];
    for (const d of first === last ? [first] : [first, last]) rows.push(...(await pages({ date: d })));
    return rows;
  }
}

// ---------- football-data.org client (league tables of big competitions) ----------
const FD_BASE = 'https://api.football-data.org/v4';
const fdCalls = [];
async function fd(pathname, params = {}) {
  const now = Date.now();
  while (fdCalls.length && now - fdCalls[0] > 60_000) fdCalls.shift();
  if (fdCalls.length >= 9) throw new Error('football-data.org: waiting for the per-minute limit');
  fdCalls.push(now);
  const url = new URL(FD_BASE + pathname);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { 'X-Auth-Token': FOOTBALL_DATA_KEY } });
  const text = await res.text();
  if (!res.ok) throw new Error(`football-data.org HTTP ${res.status} on ${pathname}: ${text.slice(0, 160)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`football-data.org sent unreadable data on ${pathname}`);
  }
}

// The competitions that football-data.org covers for free, matched by league name and country.
const FD_COMPETITIONS = [
  ['PL', /^premier league$/, /england/],
  ['ELC', /^(efl )?championship$/, /england/],
  ['PD', /^(la ?liga|primera division)$/, /spain/],
  ['SA', /^serie a$/, /italy/],
  ['BL1', /^bundesliga$/, /germany/],
  ['FL1', /^ligue 1$/, /france/],
  ['DED', /^eredivisie$/, /netherlands/],
  ['PPL', /^(primeira liga|liga portugal)$/, /portugal/],
  ['BSA', /^(serie a|brasileirao.*)$/, /brazil/],
  ['CL', /^(uefa )?champions league$/, /./],
  ['WC', /^(fifa )?world cup$/, /./],
  ['EC', /^(uefa )?euro(pean championship)?$/, /./],
];
const plain = (t) => String(t ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
function fdCodeFor(league, country) {
  const name = plain(league);
  const land = plain(country);
  const hit = FD_COMPETITIONS.find(([, n, c]) => n.test(name) && c.test(land));
  return hit ? hit[0] : null;
}
function mapFdStandings(r) {
  const groups = Array.isArray(r?.standings) ? r.standings : [];
  const total = groups.find((g) => g.type === 'TOTAL') || groups[0];
  return (total?.table || []).map((t) => ({
    rank: t.position,
    team: t.team?.shortName || t.team?.name || '',
    logo: safeUrl(t.team?.crest),
    played: t.playedGames ?? 0,
    goalDiff: t.goalDifference ?? 0,
    points: t.points ?? 0,
  }));
}

const cache = new Map();
async function cached(key, ttlMs, loader) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await loader();
  cache.set(key, { at: Date.now(), value });
  return value;
}

// ---------- Loading a day of matches ----------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TZ_RE = /^(UTC|[A-Za-z_]+(\/[A-Za-z0-9_+-]+){1,2})$/;

let lastError = null; // most recent problem talking to the data provider (shown on /api/health)
let planWindow = null; // { day, from, to } learned from the data provider when a day is not in the plan

// Returns '' when fine, 'plan' when the data plan does not cover the day, 'error' for a temporary problem.
async function loadDay(date, tz, from, to) {
  const key = `${date}|${tz}`;
  const now = Date.now();
  const isPast = to <= now;
  const isToday = from <= now && now < to;
  const ttl = isPast ? 12 * 3600_000 : isToday ? 30 * 60_000 : 3 * 3600_000;
  const hit = dayCache.get(key);
  const hold = hit && (hit.note === 'plan' ? 6 * 3600_000 : hit.note ? ERROR_RETRY_SECONDS * 1000 : ttl);
  if (hit && now - hit.at < hold) return hit.note || '';

  if (DEMO) {
    demoDay(from, to);
    dayCache.set(key, { at: now, note: '' });
    return '';
  }
  if (planWindow && planWindow.day === today() && (date < planWindow.from || date > planWindow.to)) {
    dayCache.set(key, { at: now, note: 'plan' });
    return 'plan';
  }
  if (!canSpend(10)) return 'error';
  try {
    let rows;
    if (PROVIDER === 'highlightly') {
      rows = await hlDay(date, tz, from, to);
    } else {
      let items;
      try {
        items = await api('/fixtures', { date, timezone: tz });
      } catch (err) {
        if (!/timezone/i.test(err.message)) throw err;
        // The provider did not accept this time zone: ask by UTC date instead (the app filters to the local day afterwards).
        items = [];
        const first = new Date(from).toISOString().slice(0, 10);
        const last = new Date(to - 1).toISOString().slice(0, 10);
        for (const d of first === last ? [first] : [first, last]) items.push(...(await api('/fixtures', { date: d })));
      }
      rows = items.map(toRow);
    }
    save(rows);
    dayCache.set(key, { at: now, note: '' });
    return '';
  } catch (err) {
    console.error(`Day ${key} failed:`, err.message);
    lastError = { at: new Date().toISOString(), day: key, message: String(err.message).slice(0, 300) };
    const note = /free plan|do not have access|upgrade|subscription|not included/i.test(err.message) ? 'plan' : 'error';
    if (note === 'plan') {
      const m = err.message.match(/(\d{4}-\d{2}-\d{2})\D+(\d{4}-\d{2}-\d{2})/);
      if (m) planWindow = { day: today(), from: m[1], to: m[2] };
    }
    dayCache.set(key, { at: now, note });
    return note;
  }
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
  save(items.map(toRow)).forEach(broadcast);
}

// Highlightly has no "all live matches" call, so each check refreshes a few leagues that have live or about-to-start matches.
let liveCursor = 0;
async function syncLiveHl() {
  const now = Date.now();
  const groups = new Map();
  for (const f of fixtures.values()) {
    const soon = f.status === 'NS' && f.kickoff <= now + 10 * 60000 && f.kickoff >= now - 3 * 3600000;
    if (!isLive(f.status) && !soon) continue;
    if (!groups.has(f.leagueId)) groups.set(f.leagueId, { leagueId: f.leagueId, date: new Date(f.kickoff).toISOString().slice(0, 10) });
  }
  const list = [...groups.values()].sort((a, b) => a.leagueId - b.leagueId);
  if (!list.length) return;
  const n = Math.min(MAX_LIVE_LEAGUES, list.length);
  for (let i = 0; i < n; i++) {
    if (!canSpend(Math.floor(DAILY_LIMIT * 0.4))) break; // keep some requests for browsing and match pages
    const g = list[(liveCursor + i) % list.length];
    const r = await hl('/matches', { leagueId: g.leagueId, date: g.date, limit: 100 });
    save((Array.isArray(r?.data) ? r.data : []).map(rowFromMatch)).forEach(broadcast);
  }
  liveCursor = (liveCursor + n) % list.length;
}

// ---------- Demo mode (no key needed) ----------
// Demo mode draws its own simple shield badges and avatar faces so the image features can be seen without a data key.
const hueOf = (t) => [...String(t)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
const svgUri = (svg) => `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
const letters = (t) => String(t).replace(/[^A-Za-z ]/g, '').split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
const demoCrest = (name) => {
  const h = hueOf(name);
  return svgUri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M8 6h48v30c0 12-10 20-24 24C18 56 8 48 8 36z" fill="hsl(${h},55%,36%)"/><path d="M8 6h48v11H8z" fill="hsl(${h},60%,72%)"/><text x="32" y="44" text-anchor="middle" font-family="sans-serif" font-size="19" font-weight="700" fill="#fff">${letters(name)}</text></svg>`);
};
const demoFace = (name) => {
  const h = hueOf(name);
  return svgUri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="hsl(${h},28%,30%)"/><circle cx="32" cy="26" r="12" fill="hsl(${22 + (h % 24)},45%,${52 + (h % 14)}%)"/><path d="M8 64c2-17 13-23 24-23s22 6 24 23z" fill="hsl(${h},50%,48%)"/></svg>`);
};
const withLogos = (r) => ({ ...r, homeLogo: demoCrest(r.home), awayLogo: demoCrest(r.away), leagueLogo: demoCrest(r.league) });

const DEMO_TEAMS = [
  ['Northgate United', 'Riverside Town', 'Harbor City', 'Eastfield Rovers', 'Kingsbridge', 'Oakhill Athletic'],
  ['Costa Verde', 'Sierra FC', 'Lakeshore SC', 'Prairie FC', 'Rio Azul', 'Paulista FC'],
].flat();
const DEMO_LEAGUES = [
  [39, 'Premier League', 'England'],
  [140, 'La Liga', 'Spain'],
  [71, 'Brasileirao', 'Brazil'],
];

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
    mk(9005, 140, 'La Liga', 'Spain', 'Lakeshore SC', 'Prairie FC', null, null, 'NS', null, now + 150 * min),
    mk(9007, 71, 'Brasileirao', 'Brazil', 'Rio Azul', 'Paulista FC', 2, 0, 'FT', 90, now - 200 * min),
  ].map(withLogos));
}

function demoDay(from, to) {
  const now = Date.now();
  if (from <= now && now < to) return; // today is the live demo
  const past = to <= now;
  const d = Math.floor(from / DAY);
  const rows = [];
  for (let i = 0; i < 6; i++) {
    const [leagueId, league, country] = DEMO_LEAGUES[i % 3];
    rows.push({
      id: 100000 + d * 10 + i,
      leagueId, league, country,
      home: DEMO_TEAMS[(d + i * 2) % 12],
      away: DEMO_TEAMS[(d + i * 2 + 1) % 12],
      homeGoals: past ? (d + i) % 4 : null,
      awayGoals: past ? (d * 3 + i) % 3 : null,
      status: past ? 'FT' : 'NS',
      elapsed: past ? 90 : null,
      kickoff: from + (11 + i * 2) * 3600_000,
    });
  }
  save(rows.map(withLogos));
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

const SURNAMES = ['Ortega', 'Valdez', 'Nkemelu', 'Bauer', 'Kowal', 'Hargreaves', 'Mensah', 'Tanaka', 'Lindqvist', 'Duarte',
  'Okafor', 'Brandt', 'Silveira', 'Novak', 'Petrov', 'Ionescu', 'Farrell', 'Costa', 'Moreau', 'Haddad',
  'Reyes', 'Jansen', 'Kaya', 'Lombardi', 'Adeyemi', 'Sato', 'Fischer', 'Marino', 'Bell', 'Quinn'];
const INITIALS = 'ABCDEFGHJKLMNPRST';
const demoName = (seed) => `${INITIALS[seed % INITIALS.length]}. ${SURNAMES[(seed * 7 + 3) % SURNAMES.length]}`;

function demoTeam(f, side) {
  const base = (f.id % 50) * 23 + (side === 'home' ? 0 : 11);
  const layout = [['G', 1, 1], ['D', 2, 1], ['D', 2, 2], ['D', 2, 3], ['D', 2, 4], ['M', 3, 1], ['M', 3, 2], ['M', 3, 3], ['F', 4, 1], ['F', 4, 2], ['F', 4, 3]];
  const numbers = [1, 2, 4, 5, 3, 6, 8, 10, 7, 9, 11];
  return {
    team: side === 'home' ? f.home : f.away,
    formation: '4-3-3',
    coach: SURNAMES[(base + 5) % SURNAMES.length],
    start: layout.map(([pos, r, c], i) => ({ name: demoName(base + i), number: numbers[i], pos, grid: `${r}:${c}` })),
    subs: [12, 13, 14, 15, 16].map((n, i) => ({ name: demoName(base + 20 + i), number: n, pos: ['G', 'D', 'M', 'M', 'F'][i] })),
  };
}

const demoLineups = (f) => (f.status === 'NS' ? [] : [demoTeam(f, 'home'), demoTeam(f, 'away')]);

function demoPlayers(f) {
  if (f.status === 'NS') return [];
  return ['home', 'away'].map((side) => {
    const t = demoTeam(f, side);
    let goals = (side === 'home' ? f.homeGoals : f.awayGoals) || 0;
    return {
      team: t.team,
      players: t.start.map((p, i) => {
        const scored = p.pos === 'F' && goals > 0;
        if (scored) goals -= 1;
        return {
          name: p.name, number: p.number, pos: p.pos,
          minutes: Math.min(90, f.elapsed ?? 90),
          rating: Number((6 + ((f.id + i * 3 + (side === 'home' ? 0 : 1)) % 30) / 10).toFixed(1)),
          goals: scored ? 1 : 0, assists: 0,
          shots: p.pos === 'F' ? 2 : p.pos === 'M' ? 1 : 0, onTarget: p.pos === 'F' ? 1 : 0,
          keyPasses: p.pos === 'M' ? 2 : 0, yellow: 0, red: 0,
          photo: demoFace(p.name),
          details: [
            { label: 'Minutes', value: String(Math.min(90, f.elapsed ?? 90)) },
            ...(scored ? [{ label: 'Goals', value: '1' }] : []),
            ...(p.pos === 'F' ? [{ label: 'Shots', value: '2 (1 on target)' }] : []),
            ...(p.pos === 'M' ? [{ label: 'Key passes', value: '2' }, { label: 'Passes', value: '38/45 (84%)' }] : []),
            ...(p.pos === 'D' ? [{ label: 'Tackles', value: '3' }, { label: 'Interceptions', value: '2' }] : []),
            ...(p.pos === 'G' ? [{ label: 'Saves', value: '3' }] : []),
          ],
        };
      }),
    };
  });
}

function demoDetail(f) {
  if (f.status === 'NS') return { events: [], stats: [] };
  const elapsed = f.elapsed ?? 90;
  const home = demoTeam(f, 'home');
  const away = demoTeam(f, 'away');
  const events = [];
  const addGoals = (n, t, shift) => {
    const fwd = t.start.filter((p) => p.pos === 'F');
    const mid = t.start.filter((p) => p.pos === 'M');
    for (let i = 0; i < (n || 0); i++) {
      const minute = Math.min(elapsed, Math.max(1, Math.floor(((i + 1) / ((n || 0) + 1)) * elapsed) + shift));
      events.push({ minute, team: t.team, type: 'Goal', detail: 'Normal Goal', player: fwd[i % 3].name, assist: mid[i % 3].name });
    }
  };
  addGoals(f.homeGoals, home, 0);
  addGoals(f.awayGoals, away, 3);
  if (elapsed > 20) events.push({ minute: Math.floor(elapsed / 2), team: away.team, type: 'Card', detail: 'Yellow Card', player: away.start[3].name, assist: null });
  if (elapsed > 62) events.push({ minute: 61, team: home.team, type: 'subst', detail: 'Substitution 1', player: home.start[9].name, assist: home.subs[4].name });
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
].map(([team, played, goalDiff, points], i) => ({ rank: i + 1, team, logo: demoCrest(team), played, goalDiff, points }));

const DEMO_NEWS = [
  ['Northgate United edge Riverside Town in a five-goal thriller', 'Premier League'],
  ['Premier League title race tightens as Harbor City close the gap', 'Premier League'],
  ['Kingsbridge confirm a new striker signing before the deadline', 'Premier League'],
  ['La Liga: Costa Verde extend their lead with a late winner', 'La Liga'],
  ['Sierra FC appoint a new coach after a poor run of form', 'La Liga'],
  ['Rio Azul beat Paulista FC to move up the Brasileirao table', 'Brasileirao'],
  ['Transfer window round-up: the biggest moves so far', 'Transfers'],
  ['Demo mode: add your news feed links in your settings to see real headlines', 'Demo'],
].map(([title, tag], i) => ({ title, link: '', source: 'Demo', published: new Date(Date.now() - i * 3600_000).toISOString(), tags: [tag] }));

// ---------- News (headlines and links only) ----------
const parser = new Parser({
  timeout: NEWS_FEED_TIMEOUT_MS,
  // Some publishers refuse requests that do not look like a browser or feed reader.
  headers: {
    'User-Agent': 'Mozilla/5.0 (compatible; FootballTracker/1.0)',
    Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5',
  },
  customFields: { item: [['media:thumbnail', 'mediaThumbnail'], ['media:content', 'mediaContent', { keepArray: true }], ['content:encoded', 'contentEncoded']] },
});

// Finds the picture a publisher attached to a headline (only a web address is kept; the picture itself stays on their server).
function feedImage(item) {
  const found = [];
  const th = item.mediaThumbnail;
  if (th) found.push({ url: th?.$?.url ?? th?.url, width: Number(th?.$?.width) || 0 });
  const mc = Array.isArray(item.mediaContent) ? item.mediaContent : item.mediaContent ? [item.mediaContent] : [];
  for (const m of mc) {
    const kind = m?.$?.type || m?.$?.medium || '';
    if (m?.$?.url && (!kind || /image/i.test(kind))) found.push({ url: m.$.url, width: Number(m.$.width) || 0 });
  }
  if (item.enclosure?.url && /image/i.test(item.enclosure.type ?? '')) found.push({ url: item.enclosure.url, width: 0 });
  const html = item.contentEncoded || item.content || '';
  const tag = /<img[^>]+src=["']([^"']+)["']/i.exec(html);
  if (tag) found.push({ url: tag[1], width: 0 });
  const good = found.map((f) => ({ ...f, url: safeUrl(f.url) })).filter((f) => f.url);
  // Prefer a picture that is big enough to look sharp but not huge.
  good.sort((a, b) => Math.abs((a.width || 480) - 480) - Math.abs((b.width || 480) - 480));
  return good.length ? good[0].url : '';
}
// Feed links may be separated by commas, spaces or new lines.
const feedList = () => [...new Set(NEWS_FEEDS.split(/[\s,;]+/).map((u) => u.trim()).filter((u) => /^https?:\/\//i.test(u)))];
const feedLabel = (u) => { try { const x = new URL(u); return `${x.host}${x.pathname}`.slice(0, 80); } catch { return u.slice(0, 60); } };
let feedStatus = []; // how each feed did on the last load (shown on /api/health)

async function loadNews() {
  const feeds = feedList();
  const results = await Promise.allSettled(feeds.map(async (url) => {
    const feed = await parser.parseURL(url);
    return feed.items.slice(0, 30).map((item) => {
      const catText = (c) => (c && typeof c === 'object' ? c._ ?? c['#'] ?? '' : c);
      const tags = (Array.isArray(item.categories) ? item.categories : []).map((c) => String(catText(c) ?? '').trim()).filter(Boolean).slice(0, 8).map((t) => t.slice(0, 40));
      return { title: item.title, link: item.link, source: feed.title, published: item.isoDate ?? null, tags, image: feedImage(item) };
    });
  }));
  const all = [];
  feedStatus = results.map((r, i) => {
    if (r.status === 'fulfilled') {
      all.push(...r.value);
      return { feed: feedLabel(feeds[i]), ok: true, items: r.value.length };
    }
    const error = String(r.reason?.message ?? r.reason).slice(0, 140);
    console.error('News feed failed:', feedLabel(feeds[i]), error);
    return { feed: feedLabel(feeds[i]), ok: false, error };
  });
  const seen = new Set();
  const unique = all.filter((n) => n.title && (n.link ? !seen.has(n.link) && seen.add(n.link) : true));
  return unique.sort((a, b) => (b.published ?? '').localeCompare(a.published ?? '')).slice(0, 120);
}

// Headlines are kept for 10 minutes, or 2 minutes if any feed failed, so a temporary problem clears quickly.
let newsCache = { at: 0, items: [], ttl: 0 };
async function getNews() {
  if (Date.now() - newsCache.at < newsCache.ttl) return newsCache.items;
  const items = await loadNews();
  newsCache = { at: Date.now(), items, ttl: feedStatus.some((f) => !f.ok) ? 120_000 : 600_000 };
  return items;
}

const wrap = (fn) => (req, res) =>
  fn(req, res).catch((err) => {
    console.error(err.message);
    res.status(502).json({ error: 'Data is unavailable right now' });
  });

// ---------- Web addresses the app uses ----------
app.use((_req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  next();
});

app.get('/api/matches', wrap(async (req, res) => {
  const now = Date.now();
  let from = Number(req.query.from);
  let to = Number(req.query.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 26 * 3600_000) {
    from = Date.parse(`${today()}T00:00:00Z`);
    to = from + DAY;
  }
  if (from < now - 400 * DAY || from > now + 400 * DAY) return res.status(400).json({ error: 'That day is out of range' });
  const date = DATE_RE.test(String(req.query.date)) ? String(req.query.date) : new Date(from).toISOString().slice(0, 10);
  const tz = TZ_RE.test(String(req.query.tz)) ? String(req.query.tz) : 'UTC';

  const note = await loadDay(date, tz, from, to);
  const matches = [...fixtures.values()]
    .filter((f) => f.kickoff >= from && f.kickoff < to)
    .sort((a, b) => a.league.localeCompare(b.league) || a.kickoff - b.kickoff);
  res.json({ matches, note });
}));

app.get('/api/matches/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const fixture = fixtures.get(id);
  if (!fixture) return res.status(404).json({ error: 'Match not found' });
  if (DEMO) return res.json({ fixture, ...demoDetail(fixture) });
  if (fixture.status === 'NS') return res.json({ fixture, events: [], stats: [] });
  if (PROVIDER === 'highlightly') {
    const ttl = isLive(fixture.status) ? 60_000 : 60 * 60_000;
    const detail = await cached(`hl-detail:${id}`, ttl, async () => {
      let r;
      try {
        r = await hl(`/matches/${id}`);
      } catch (err) {
        if (/HTTP 4\d\d/.test(err.message)) return { events: [], stats: [] }; // no extra detail for this match
        throw err;
      }
      const m = Array.isArray(r) ? r[0] : r;
      if (!m) return { events: [], stats: [] };
      const row = rowFromMatch(m);
      save([{ ...fixture, homeGoals: row.homeGoals, awayGoals: row.awayGoals, status: row.status, elapsed: row.elapsed }]).forEach(broadcast);
      return { events: mapEvents(m.events), stats: mapStats(m.statistics, m.homeTeam?.id) };
    });
    return res.json({ fixture: fixtures.get(id) ?? fixture, ...detail });
  }

  const ttl = isLive(fixture.status) ? 60_000 : 60 * 60_000;
  const events = await cached(`events:${id}`, ttl, async () => {
    const list = await api('/fixtures/events', { fixture: id });
    return list.map((e) => ({
      minute: e.time.elapsed, team: e.team.name, type: e.type, detail: e.detail, player: e.player?.name ?? null, assist: e.assist?.name ?? null,
    }));
  });
  const stats = await cached(`stats:${id}`, ttl, async () => {
    const list = await api('/fixtures/statistics', { fixture: id });
    if (list.length < 2) return [];
    return list[0].statistics.map((s, i) => ({ type: s.type, home: s.value, away: list[1].statistics[i]?.value ?? null }));
  });
  res.json({ fixture, events, stats });
}));

app.get('/api/matches/:id/lineups', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const fixture = fixtures.get(id);
  if (!fixture) return res.status(404).json({ error: 'Match not found' });
  if (DEMO) return res.json({ lineups: demoLineups(fixture) });
  if (PROVIDER === 'highlightly') {
    const lineups = await cached(`hl-lineups:${id}`, 5 * 60_000, async () => {
      try {
        return mapLineups(await hl(`/lineups/${id}`));
      } catch (err) {
        if (/HTTP 4\d\d/.test(err.message)) return []; // not announced yet
        throw err;
      }
    });
    return res.json({ lineups });
  }
  const lineups = await cached(`lineups:${id}`, 10 * 60_000, async () => {
    const list = await api('/fixtures/lineups', { fixture: id });
    return list.map((t) => ({
      team: t.team.name,
      formation: t.formation ?? null,
      coach: t.coach?.name ?? null,
      start: (t.startXI || []).map((x) => ({ name: x.player.name, number: x.player.number, pos: x.player.pos, grid: x.player.grid ?? null })),
      subs: (t.substitutes || []).map((x) => ({ name: x.player.name, number: x.player.number, pos: x.player.pos })),
    }));
  });
  res.json({ lineups });
}));

app.get('/api/matches/:id/players', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const fixture = fixtures.get(id);
  if (!fixture) return res.status(404).json({ error: 'Match not found' });
  if (DEMO) return res.json({ teams: demoPlayers(fixture) });
  if (fixture.status === 'NS') return res.json({ teams: [] });
  if (PROVIDER === 'highlightly') {
    const ttl = isLive(fixture.status) ? 60_000 : 60 * 60_000;
    const teams = await cached(`hl-box:${id}`, ttl, async () => {
      try {
        return mapBoxScore(await hl(`/box-score/${id}`));
      } catch (err) {
        if (/HTTP 4\d\d/.test(err.message)) return [];
        throw err;
      }
    });
    return res.json({ teams });
  }
  const ttl = isLive(fixture.status) ? 60_000 : 60 * 60_000;
  const teams = await cached(`players:${id}`, ttl, async () => {
    const list = await api('/fixtures/players', { fixture: id });
    return list.map((t) => ({
      team: t.team.name,
      players: (t.players || []).map((p) => {
        const st = (p.statistics && p.statistics[0]) || {};
        return {
          name: p.player.name,
          number: st.games?.number ?? null,
          pos: st.games?.position ?? null,
          photo: safeUrl(p.player.photo),
          details: [
            ['Minutes', st.games?.minutes], ['Goals', st.goals?.total], ['Assists', st.goals?.assists],
            ['Shots', st.shots?.total ? `${st.shots.total}${st.shots.on ? ` (${st.shots.on} on target)` : ''}` : null],
            ['Key passes', st.passes?.key], ['Passes', st.passes?.total ? `${st.passes.total}${st.passes.accuracy ? ` (${st.passes.accuracy} acc.)` : ''}` : null],
            ['Tackles', st.tackles?.total], ['Interceptions', st.tackles?.interceptions], ['Duels won', st.duels?.total ? `${st.duels.won ?? 0}/${st.duels.total}` : null],
            ['Dribbles', st.dribbles?.attempts ? `${st.dribbles.success ?? 0}/${st.dribbles.attempts}` : null],
            ['Fouls committed', st.fouls?.committed], ['Fouls won', st.fouls?.drawn], ['Saves', st.goals?.saves],
            ['Yellow cards', st.cards?.yellow], ['Red cards', st.cards?.red],
          ].filter(([, v]) => v !== null && v !== undefined && v !== '' && v !== 0).map(([label, value]) => ({ label, value: String(value) })),
          minutes: st.games?.minutes ?? 0,
          rating: st.games?.rating ? Number(st.games.rating) : null,
          goals: st.goals?.total ?? 0,
          assists: st.goals?.assists ?? 0,
          shots: st.shots?.total ?? 0,
          onTarget: st.shots?.on ?? 0,
          keyPasses: st.passes?.key ?? 0,
          yellow: st.cards?.yellow ?? 0,
          red: st.cards?.red ?? 0,
        };
      }).filter((p) => p.minutes > 0 || p.rating !== null),
    }));
  });
  res.json({ teams });
}));

app.get('/api/standings/:leagueId', wrap(async (req, res) => {
  if (DEMO) return res.json(DEMO_TABLE);
  if (FOOTBALL_DATA_KEY) {
    const known = [...fixtures.values()].find((f) => f.leagueId === Number(req.params.leagueId));
    const code = known ? fdCodeFor(known.league, known.country) : null;
    if (code) {
      try {
        const table = await cached(`fd-standings:${code}`, 60 * 60_000, async () => mapFdStandings(await fd(`/competitions/${code}/standings`)));
        if (table.length) return res.json(table);
      } catch (err) {
        console.error('football-data.org table failed, using the main source:', err.message);
        lastError = { at: new Date().toISOString(), day: `table ${code}`, message: String(err.message).slice(0, 300) };
      }
    }
  }
  if (PROVIDER === 'highlightly') {
    const league = Number(req.params.leagueId);
    const known = [...fixtures.values()].find((f) => f.leagueId === league);
    const nowD = new Date();
    const season = Number(req.query.season) || known?.season || (nowD.getUTCMonth() >= 6 ? nowD.getUTCFullYear() : nowD.getUTCFullYear() - 1);
    const table = await cached(`hl-standings:${league}:${season}`, 60 * 60_000, async () => {
      try {
        return mapStandings(await hl('/standings', { leagueId: league, season }));
      } catch (err) {
        if (/HTTP 4\d\d/.test(err.message)) return [];
        throw err;
      }
    });
    return res.json(table);
  }
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

// Finds teams by name so people can add favorites. Uses teams already seen in loaded matches first.
let teamSearchDay = { day: '', n: 0 };
app.get('/api/teams', wrap(async (req, res) => {
  const q = String(req.query.q ?? '').trim().toLowerCase().slice(0, 40);
  if (q.length < 2) return res.json({ teams: [] });
  const found = new Map();
  for (const f of fixtures.values()) {
    for (const [name, logo] of [[f.home, f.homeLogo], [f.away, f.awayLogo]]) if (name.toLowerCase().includes(q) && !found.has(name)) found.set(name, { league: f.league, logo: logo || '' });
  }
  const teams = [...found].map(([name, v]) => ({ name, league: v.league, logo: v.logo }));
  const apiQuery = q.replace(/[^a-z0-9 ]/g, '').trim();
  if (!DEMO && apiQuery.length >= 3 && teams.length < 5 && canSpend(20)) {
    try {
      const extra = await cached(`teams:${apiQuery}`, 24 * 3600_000, async () => {
        if (teamSearchDay.day !== today()) teamSearchDay = { day: today(), n: 0 };
        if (teamSearchDay.n >= 15) return [];
        teamSearchDay.n += 1;
        if (PROVIDER === 'highlightly') {
          const r = await hl('/teams', { name: apiQuery, limit: 20 });
          return (Array.isArray(r?.data) ? r.data : []).map((x) => ({ name: x.name, league: x.type === 'national' ? 'National team' : '', logo: safeUrl(x.logo) }));
        }
        const list = await api('/teams', { search: apiQuery });
        return list.map((x) => ({ name: x.team.name, league: x.team.country || '', logo: safeUrl(x.team.logo) }));
      });
      for (const t of extra) if (!teams.some((x) => x.name === t.name)) teams.push(t);
    } catch (err) {
      console.error('Team search failed:', err.message);
    }
  }
  teams.sort((a, b) => a.name.localeCompare(b.name));
  res.json({ teams: teams.slice(0, 20) });
}));

// Leagues seen in the matches loaded so far, for the Tables screen. Popular ones first.
const FIRST_LEAGUES = ['premier league|england', 'la liga|spain', 'laliga|spain', 'serie a|italy', 'bundesliga|germany', 'ligue 1|france',
  'uefa champions league|world', 'uefa champions league|europe', 'champions league|world', 'mls|usa', 'major league soccer|usa'];
app.get('/api/leagues', (req, res) => {
  const q = String(req.query.q ?? '').trim().toLowerCase().slice(0, 40);
  const map = new Map();
  for (const f of fixtures.values()) {
    if (!map.has(f.leagueId)) map.set(f.leagueId, { id: f.leagueId, name: f.league, country: f.country || '', season: f.season ?? null, n: 0 });
    map.get(f.leagueId).n += 1;
  }
  let list = [...map.values()];
  if (q) list = list.filter((l) => l.name.toLowerCase().includes(q) || l.country.toLowerCase().includes(q));
  const rank = (l) => {
    const i = FIRST_LEAGUES.indexOf(`${l.name}|${l.country}`.toLowerCase());
    return i < 0 ? 99 : i;
  };
  list.sort((a, b) => rank(a) - rank(b) || b.n - a.n || a.name.localeCompare(b.name));
  res.json({ leagues: list.slice(0, 30).map(({ n, ...l }) => l) });
});

let newsIndex = { at: 0, value: null };
app.get('/api/news', wrap(async (_req, res) => {
  const items = DEMO && !NEWS_FEEDS ? DEMO_NEWS : await getNews();
  if (NEWS_IMAGES === 'off') return res.json(items.map(({ image, ...rest }) => rest));
  if (Date.now() - newsIndex.at > 60_000) newsIndex = { at: Date.now(), value: buildIndex(fixtures.values()) };
  const withBadges = annotate(items, newsIndex.value);
  res.json(NEWS_IMAGES === 'crests' ? withBadges.map(({ image, ...rest }) => rest) : withBadges);
}));

// Checks whether a news site allows its pages to be shown inside another app (only the page's headers are read, never its content).
// Only links that are in the current news list can be checked.
app.get('/api/frame-check', wrap(async (req, res) => {
  const url = String(req.query.u ?? '');
  const items = DEMO && !NEWS_FEEDS ? DEMO_NEWS : await getNews();
  if (!url || !items.some((i) => i.link === url)) return res.status(400).json({ error: 'Unknown link' });
  const host = new URL(url).host;
  const ours = String(req.headers.host || '').toLowerCase();
  const result = await cached(`frame:${host}:${ours}`, 12 * 3600_000, async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    try {
      const r = await fetch(url, { redirect: 'follow', signal: ctrl.signal, headers: { 'user-agent': 'Mozilla/5.0 (compatible; FootballTracker/1.0)' } });
      r.body?.cancel?.().catch(() => {});
      const xfo = (r.headers.get('x-frame-options') || '').toLowerCase();
      const csp = /frame-ancestors([^;]*)/i.exec(r.headers.get('content-security-policy') || '');
      let ok = r.ok;
      if (/deny|sameorigin/.test(xfo)) ok = false;
      if (csp) {
        const allowed = csp[1].trim().toLowerCase();
        if (!(allowed.includes('*') || (ours && allowed.includes(ours)))) ok = false;
      }
      return { embeddable: ok };
    } catch {
      return { embeddable: false };
    } finally {
      clearTimeout(timer);
    }
  });
  res.json(result);
}));

app.get('/api/health', wrap(async (_req, res) => {
  if (NEWS_FEEDS && !newsCache.at) await getNews().catch(() => {});
  res.json({ ok: true, demo: DEMO, provider: PROVIDER, tables: FOOTBALL_DATA_KEY ? 'football-data.org for 12 big competitions, main source for the rest' : 'main source', requestsToday: usage.count, dailyLimit: DAILY_LIMIT, lastError, newsFeeds: feedStatus });
}));

// ----- Test page for the Highlightly data source (off unless DIAG_TOKEN is set) -----
// Open /api/diag/highlightly?token=YOURWORD to check the key and see what the free plan returns.
// Optional: &date=YYYY-MM-DD, or &what=lineups|events|statistics|box-score|matches&matchId=123 to look at one match.
// The key is never shown. Each call uses 1 request of your daily allowance.
app.get('/api/diag/highlightly', wrap(async (req, res) => {
  if (!DIAG_TOKEN || req.query.token !== DIAG_TOKEN) return res.status(404).json({ error: 'Not found' });
  if (!HIGHLIGHTLY_KEY) return res.json({ error: 'HIGHLIGHTLY_KEY is not set in your settings' });
  const what = String(req.query.what || 'day');
  const matchId = Number(req.query.matchId);
  let url;
  if (what === 'day') {
    const date = DATE_RE.test(String(req.query.date)) ? String(req.query.date) : today();
    url = `https://soccer.highlightly.net/matches?date=${date}&limit=100`;
  } else if (['lineups', 'events', 'statistics', 'box-score', 'matches'].includes(what) && Number.isInteger(matchId) && matchId > 0) {
    url = `https://soccer.highlightly.net/${what}/${matchId}`;
  } else {
    return res.status(400).json({ error: 'Use what=day, or what=lineups|events|statistics|box-score|matches together with matchId=123' });
  }
  const r = await fetch(url, { headers: { 'x-rapidapi-key': HIGHLIGHTLY_KEY } });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  const out = { http: r.status, requestsLeftToday: r.headers.get('x-ratelimit-requests-remaining'), planLimit: r.headers.get('x-ratelimit-requests-limit') };
  if (what === 'day' && json && Array.isArray(json.data)) {
    const counts = {};
    for (const m of json.data) {
      const k = `${m.league?.name ?? '?'} (${m.country?.name ?? '?'})`;
      counts[k] = (counts[k] || 0) + 1;
    }
    out.plan = json.plan ?? null;
    out.totalMatchesToday = json.pagination?.totalCount ?? null;
    out.returnedInThisPage = json.data.length;
    out.leagues = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 40).map(([name, n]) => `${name}: ${n}`);
    out.sample = json.data.slice(0, 3).map((m) => ({ id: m.id, league: m.league?.name, home: m.homeTeam?.name, away: m.awayTeam?.name, state: m.state }));
  } else {
    out.body = text.slice(0, 2500);
  }
  res.json(out);
}));

// ----- Test page for football-data.org (off unless DIAG_TOKEN is set) -----
// Open /api/diag/footballdata?token=YOURWORD . Optional: &code=PL to look at one league table.
app.get('/api/diag/footballdata', wrap(async (req, res) => {
  if (!DIAG_TOKEN || req.query.token !== DIAG_TOKEN) return res.status(404).json({ error: 'Not found' });
  if (!FOOTBALL_DATA_KEY) return res.json({ error: 'FOOTBALL_DATA_KEY is not set in your settings' });
  const code = String(req.query.code || 'PL').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  try {
    const table = mapFdStandings(await fd(`/competitions/${code}/standings`));
    res.json({ ok: true, code, rows: table.length, firstRows: table.slice(0, 5) });
  } catch (err) {
    res.json({ ok: false, code, problem: String(err.message).slice(0, 400) });
  }
}));

app.use(express.static(path.join(dir, 'public')));

// ---------- Start ----------
if (DEMO) {
  seedDemo();
  setInterval(tickDemo, 15_000);
  console.log('DEMO MODE: no API_KEY set, showing sample matches.');
} else {
  console.log(`Data source: ${PROVIDER}`);
  setInterval(() => {
    if (wss.clients.size > 0 && liveWindowOpen() && canSpend(10)) {
      const job = PROVIDER === 'highlightly' ? syncLiveHl() : syncLive();
      job.catch((e) => {
        console.error('Live sync failed:', e.message);
        lastError = { at: new Date().toISOString(), day: 'live', message: String(e.message).slice(0, 300) };
      });
    }
  }, LIVE_POLL_SECONDS * 1000);
}

server.listen(PORT, () => console.log(`Football Tracker running on port ${PORT}`));
