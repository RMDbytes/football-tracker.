// Works out which club or league a headline is about, so the app can show that club's badge.
// Matching is by name in the headline, so it is a best guess.

const norm = (t) => String(t ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
export const plainText = (t) => norm(t).replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();

const CLUB_SUFFIX = new Set(['fc', 'cf', 'afc', 'sc', 'ac', 'ssc', 'fk', 'sk', 'bk', 'if', 'club', 'calcio', 'de', 'the', 'sv', 'vfb', 'vfl', 'rc', 'cd', 'ud', 'sd']);
const GENERIC_TAIL = new Set(['united', 'city', 'town', 'rovers', 'athletic', 'wanderers', 'hotspur', 'albion', 'county', 'rangers']);
const AMBIGUOUS = new Set(['manchester', 'sheffield', 'real', 'west', 'nottingham', 'atletico', 'borussia', 'olympique', 'inter', 'paris', 'san', 'saint', 'st', 'north', 'south', 'east']);
// Words that are also ordinary English or too generic to identify a club on their own.
const STOP = new Set(['nice', 'united', 'city', 'union', 'real', 'sporting', 'athletic', 'racing', 'olympic', 'star', 'young boys', 'town', 'rovers',
  'national', 'sport', 'victory', 'unity', 'hope', 'arrows', 'crown', 'south', 'north', 'east', 'west', 'central', 'metro', 'stars', 'lions', 'eagles']);
const CLUB_ALIASES = {
  'manchester united': ['man united', 'man utd'], 'manchester city': ['man city'], 'tottenham hotspur': ['tottenham', 'spurs'],
  'wolverhampton wanderers': ['wolves', 'wolverhampton'], 'newcastle united': ['newcastle'], 'brighton and hove albion': ['brighton'],
  'west ham united': ['west ham'], 'paris saint germain': ['psg'], 'bayern munich': ['bayern'], 'borussia dortmund': ['dortmund'],
  'juventus': ['juve'], 'barcelona': ['barca'], 'atletico madrid': ['atletico', 'atleti'], 'internazionale': ['inter milan'], 'ac milan': ['milan'],
};

export function teamTerms(name) {
  const words = plainText(name).split(' ').filter((w) => w && !CLUB_SUFFIX.has(w));
  const base = words.join(' ');
  const out = new Set([base]);
  (CLUB_ALIASES[base] || []).forEach((a) => out.add(a));
  if (words.length >= 2 && GENERIC_TAIL.has(words[words.length - 1]) && !AMBIGUOUS.has(words[0])) {
    const short = words.slice(0, -1).join(' ');
    if (short.length >= 5) out.add(short);
  }
  return [...out].filter((t) => t.length >= 4 && !STOP.has(t));
}

const LEAGUE_ALIASES = { 'la liga': ['laliga'], 'primera division': ['la liga', 'laliga'], 'major league soccer': ['mls'], 'efl championship': ['championship'] };
export function leagueTerms(name) {
  const n = plainText(name).replace(/^(uefa|fifa|efl|conmebol|afc|caf) /, '');
  const out = new Set([n]);
  (LEAGUE_ALIASES[n] || []).forEach((a) => out.add(a));
  return [...out].filter((t) => t.length >= 6);
}

// Popular competitions rank first when several could match.
const POPULAR = [
  [/^premier league$/, /england/], [/^(la ?liga|primera division)$/, /spain/], [/^serie a$/, /italy/], [/^bundesliga$/, /germany/], [/^ligue 1$/, /france/],
  [/^(uefa )?champions league$/, /./], [/^(uefa )?europa league$/, /./], [/^(fifa )?world cup/, /./], [/^(mls|major league soccer)$/, /usa|united states/],
  [/^(efl )?championship$/, /england/], [/^eredivisie$/, /netherlands/], [/^(primeira liga|liga portugal)$/, /portugal/], [/^(serie a|brasileirao.*)$/, /brazil/],
];
const rankOf = (league, country) => {
  const n = plainText(league), c = plainText(country);
  const i = POPULAR.findIndex(([a, b]) => a.test(n) && b.test(c));
  return i < 0 ? 99 : i;
};

// Builds a lookup of clubs and leagues (with their logos) from the matches the server has loaded.
export function buildIndex(fixtures) {
  const teams = new Map();
  const leagues = new Map();
  for (const f of fixtures) {
    const rank = rankOf(f.league, f.country);
    for (const [name, logo] of [[f.home, f.homeLogo], [f.away, f.awayLogo]]) {
      if (!name || !logo) continue;
      const old = teams.get(name);
      if (!old || rank < old.rank) teams.set(name, { name, logo, rank, terms: old ? old.terms : teamTerms(name) });
    }
    if (f.league && f.leagueLogo && !leagues.has(`${f.league}|${f.country}`)) {
      leagues.set(`${f.league}|${f.country}`, { name: f.league, logo: f.leagueLogo, rank, terms: leagueTerms(f.league) });
    }
  }
  return { teams: [...teams.values()].filter((t) => t.terms.length), leagues: [...leagues.values()].filter((l) => l.terms.length) };
}

// Adds teamName / teamLogo (or leagueName / leagueLogo) to each headline when one can be identified.
export function annotate(items, index) {
  return items.map((item) => {
    const text = ` ${plainText(`${item.title} ${(item.tags || []).join(' ')}`)} `;
    let best = null;
    for (const t of index.teams) {
      for (const term of t.terms) {
        if (!text.includes(` ${term} `)) continue;
        const score = term.length + (t.rank < 99 ? 40 : 0);
        if (!best || score > best.score) best = { t, score };
      }
    }
    if (best) return { ...item, teamName: best.t.name, teamLogo: best.t.logo };
    let league = null;
    for (const l of index.leagues) {
      if (l.terms.some((term) => text.includes(` ${term} `)) && (!league || l.rank < league.rank)) league = l;
    }
    return league ? { ...item, leagueName: league.name, leagueLogo: league.logo } : item;
  });
}
