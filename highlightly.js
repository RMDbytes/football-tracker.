// Translates Highlightly's data into the shapes the app already uses.
// (Field names follow Highlightly's published documentation.)

const STATUS = {
  'not started': 'NS',
  'first half': '1H',
  'second half': '2H',
  'half time': 'HT',
  'extra time': 'ET',
  'break time': 'BT',
  penalties: 'P',
  finished: 'FT',
  'finished after penalties': 'PEN',
  'finished after extra time': 'AET',
  postponed: 'PST',
  suspended: 'SUSP',
  cancelled: 'CANC',
  awarded: 'AWD',
  interrupted: 'SUSP',
  abandoned: 'ABD',
  'in progress': 'LIVE',
  unknown: 'NS',
  'to be announced': 'TBD',
};
// Only real web addresses are passed on to the app.
export const safeUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : '');

export const statusCode = (description) => STATUS[String(description ?? '').trim().toLowerCase()] || 'NS';

export function parseScore(text) {
  const m = /(\d+)\s*[-:]\s*(\d+)/.exec(String(text ?? ''));
  return m ? [Number(m[1]), Number(m[2])] : [null, null];
}

export function rowFromMatch(m) {
  const status = statusCode(m.state?.description);
  let [homeGoals, awayGoals] = parseScore(m.state?.score?.current);
  const started = !['NS', 'TBD', 'PST', 'CANC'].includes(status);
  if (started && homeGoals === null) {
    homeGoals = 0;
    awayGoals = 0;
  }
  const clock = m.state?.clock;
  return {
    id: m.id,
    leagueId: m.league?.id ?? 0,
    league: m.league?.name ?? 'Other',
    country: m.country?.name ?? '',
    season: m.league?.season ?? null,
    leagueLogo: safeUrl(m.league?.logo),
    homeLogo: safeUrl(m.homeTeam?.logo),
    awayLogo: safeUrl(m.awayTeam?.logo),
    home: m.homeTeam?.name ?? '?',
    away: m.awayTeam?.name ?? '?',
    homeGoals,
    awayGoals,
    status,
    elapsed: clock !== null && clock !== undefined && Number.isFinite(Number(clock)) ? Number(clock) : null,
    kickoff: Date.parse(String(m.date ?? '').replace(/"/g, '')),
  };
}

// "45+1" -> 45.01 so events sort correctly
const minuteOrder = (t) => {
  const m = /^(\d+)(?:\+(\d+))?/.exec(String(t ?? ''));
  return m ? Number(m[1]) + (m[2] ? Number(m[2]) / 100 : 0) : 0;
};
const clean = (v) => (v && v !== 'string' ? String(v) : null);

export function mapEvents(list) {
  return (Array.isArray(list) ? list : [])
    .map((e) => {
      const t = String(e.type ?? '');
      let type = t;
      let detail = t;
      if (/^goal$/i.test(t)) { type = 'Goal'; detail = 'Normal Goal'; }
      else if (/own goal/i.test(t)) { type = 'Goal'; detail = 'Own Goal'; }
      else if (/^penalty$/i.test(t)) { type = 'Goal'; detail = 'Penalty'; }
      else if (/missed penalty/i.test(t)) { type = 'Missed Penalty'; }
      else if (/yellow/i.test(t)) { type = 'Card'; detail = 'Yellow Card'; }
      else if (/red card/i.test(t)) { type = 'Card'; detail = 'Red Card'; }
      else if (/subst/i.test(t)) { type = 'subst'; detail = 'Substitution'; }
      else if (/^var/i.test(t)) { type = 'Var'; detail = t.replace(/^var\s*/i, '') || 'Check'; }
      return {
        minute: String(e.time ?? ''),
        order: minuteOrder(e.time),
        team: e.team?.name ?? '',
        type,
        detail,
        player: clean(e.player),
        assist: clean(e.assist) ?? clean(e.substituted),
      };
    })
    .sort((a, b) => a.order - b.order);
}

export function mapStats(list, homeId) {
  if (!Array.isArray(list) || list.length < 2) return [];
  const home = list.find((x) => x.team?.id === homeId) || list[0];
  const away = list.find((x) => x !== home) || list[1];
  const awayValues = new Map((away.statistics || []).map((s) => [s.displayName, s.value]));
  return (home.statistics || []).map((s) => ({ type: s.displayName, home: s.value, away: awayValues.get(s.displayName) ?? null }));
}

const POSITIONS = { goalkeeper: 'GK', defender: 'D', midfielder: 'M', forward: 'F', attacker: 'F' };
const shortPos = (p) => POSITIONS[String(p ?? '').toLowerCase()] || String(p ?? '').slice(0, 2).toUpperCase();

export function mapLineups(r) {
  if (!r || !r.homeTeam || !r.awayTeam) return [];
  const teams = [r.homeTeam, r.awayTeam].map((t) => ({
    team: t.name,
    formation: t.formation ?? null,
    coach: null,
    start: (t.initialLineup || []).flatMap((row, ri) =>
      (Array.isArray(row) ? row : []).map((p, ci) => ({ name: p.name, number: p.number, pos: shortPos(p.position), grid: `${ri + 1}:${ci + 1}` }))),
    subs: (t.substitutes || []).map((p) => ({ name: p.name, number: p.number, pos: shortPos(p.position) })),
  }));
  return teams.every((t) => t.start.length === 0) ? [] : teams;
}

// Turns one player's match numbers into a readable list (zero values are left out).
function detailList(p, s) {
  const rows = [];
  const add = (label, v, always) => {
    if (v === null || v === undefined || v === '') return;
    if (!always && (v === 0 || v === '0')) return;
    rows.push({ label, value: String(v) });
  };
  add('Minutes', p.minutesPlayed, true);
  add('Goals', s.goalsScored);
  add('Assists', s.assists);
  add('Shots', s.shotsTotal ? `${s.shotsTotal}${s.shotsOnTarget ? ` (${s.shotsOnTarget} on target)` : ''}` : null);
  add('Key passes', s.passesKey);
  add('Passes', s.passesTotal ? `${s.passesSuccessful ?? '?'}/${s.passesTotal}${s.passesAccuracy ? ` (${s.passesAccuracy})` : ''}` : null);
  add('Dribbles', s.dribblesTotal ? `${s.dribblesSuccessful ?? 0}/${s.dribblesTotal}` : null);
  add('Tackles', s.tacklesTotal);
  add('Interceptions', s.interceptionsTotal);
  add('Duels won', s.duelsTotal ? `${s.duelsWon ?? 0}/${s.duelsTotal}` : null);
  add('Fouls committed', s.fouledOthers);
  add('Fouls won', s.fouledByOthers);
  add('Saves', s.goalsSaved);
  add('Goals conceded', s.goalsConceded);
  add('Offsides', p.offsides);
  add('Expected goals (xG)', s.expectedGoals);
  add('Expected assists (xA)', s.expectedAssists);
  add('Yellow cards', s.cardsYellow);
  add('Red cards', s.cardsRed);
  return rows;
}

export function mapBoxScore(list) {
  return (Array.isArray(list) ? list : []).map((t) => ({
    team: t.team?.name ?? '',
    players: (t.players || [])
      .map((p) => {
        const s = (p.statistics && p.statistics[0]) || {};
        const rating = Number(p.matchRating);
        return {
          name: p.name,
          number: p.shirtNumber ?? null,
          pos: shortPos(p.position),
          photo: safeUrl(p.logo),
          captain: Boolean(p.isCaptain),
          minutes: p.minutesPlayed ?? 0,
          rating: Number.isFinite(rating) && rating > 0 ? rating : null,
          goals: s.goalsScored ?? 0,
          assists: s.assists ?? 0,
          shots: s.shotsTotal ?? 0,
          onTarget: s.shotsOnTarget ?? 0,
          keyPasses: s.passesKey ?? 0,
          yellow: s.cardsYellow ?? 0,
          red: s.cardsRed ?? 0,
          details: detailList(p, s),
        };
      })
      .filter((p) => p.minutes > 0 || p.rating !== null),
  }));
}

export function mapStandings(r) {
  const group = r?.groups?.[0];
  if (!group) return [];
  return (group.standings || []).map((s) => ({
    rank: s.position,
    team: s.team?.name ?? '',
    logo: safeUrl(s.team?.logo),
    played: s.total?.games ?? 0,
    goalDiff: (s.total?.scoredGoals ?? 0) - (s.total?.receivedGoals ?? 0),
    points: s.points ?? 0,
  }));
}
