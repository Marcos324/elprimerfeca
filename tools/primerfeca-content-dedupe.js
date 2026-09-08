#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_LOG = path.join(ROOT, 'state', 'daily-reels-log.json');

const STOPWORDS = new Set([
  'a', 'al', 'algo', 'ante', 'argentina', 'argentino', 'argentinos', 'asi', 'bajo', 'como',
  'con', 'contra', 'cuando', 'de', 'del', 'desde', 'dia', 'dos', 'el', 'ella', 'en', 'entre',
  'era', 'es', 'esa', 'ese', 'eso', 'esta', 'este', 'esto', 'feca', 'fue', 'hay', 'hoy',
  'la', 'las', 'le', 'lo', 'los', 'mas', 'me', 'no', 'para', 'pero', 'por', 'primer',
  'que', 'se', 'sin', 'sobre', 'son', 'su', 'sus', 'tambien', 'un', 'una', 'y', 'ya'
]);

function usage() {
  console.error(`Usage:
  node scripts/primerfeca-content-dedupe.js check --candidate candidate-story.json [--log state/daily-reels-log.json]
  node scripts/primerfeca-content-dedupe.js check --title "TITLE" --story "summary" [--source URL ...]

Candidate JSON fields: title, selected_story or story, sources, date, slot.`);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = { command, sources: [] };
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith('--')) {
      throw new Error(`Unexpected argument: ${token}`);
    }
    const key = token.slice(2);
    if (key === 'source') {
      args.sources.push(rest[++i]);
    } else if (key === 'json') {
      args.json = true;
    } else {
      args[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = rest[++i];
    }
  }
  return args;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(value) {
  return normalizeText(value)
    .split(' ')
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word));
}

function termSet(item) {
  return new Set(tokenize([item.title, item.selected_story || item.story, item.summary].filter(Boolean).join(' ')));
}

function titleSet(item) {
  return new Set(tokenize(item.title || ''));
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const value of a) {
    if (b.has(value)) intersection += 1;
  }
  return intersection / (a.size + b.size - intersection);
}

function overlapTerms(a, b) {
  return [...a].filter((value) => b.has(value)).sort();
}

function normalizeUrl(value) {
  try {
    const url = new URL(value);
    url.hash = '';
    url.search = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return normalizeText(value);
  }
}

function sourceSet(item) {
  return new Set((item.sources || []).filter(Boolean).map(normalizeUrl));
}

function sameExactSource(a, b) {
  const left = sourceSet(a);
  const right = sourceSet(b);
  const matches = [...left].filter((value) => right.has(value));
  return matches;
}

function candidateFromArgs(args) {
  if (args.candidate) {
    const file = path.resolve(process.cwd(), args.candidate);
    const candidate = readJson(file, null);
    if (!candidate || typeof candidate !== 'object') {
      throw new Error(`Candidate file did not contain an object: ${file}`);
    }
    return candidate;
  }

  if (!args.title && !args.story) {
    throw new Error('Missing --candidate or --title/--story.');
  }

  return {
    date: args.date,
    slot: args.slot,
    title: args.title,
    selected_story: args.story,
    sources: args.sources
  };
}

function compare(candidate, prior) {
  const candidateTerms = termSet(candidate);
  const priorTerms = termSet(prior);
  const candidateTitle = titleSet(candidate);
  const priorTitle = titleSet(prior);
  const termSimilarity = jaccard(candidateTerms, priorTerms);
  const titleSimilarity = jaccard(candidateTitle, priorTitle);
  const exactSources = sameExactSource(candidate, prior);
  const sharedTerms = overlapTerms(candidateTerms, priorTerms);

  const duplicate =
    exactSources.length > 0 ||
    titleSimilarity >= 0.5 ||
    termSimilarity >= 0.42 ||
    (sharedTerms.length >= 4 && termSimilarity >= 0.3);

  return {
    duplicate,
    title_similarity: Number(titleSimilarity.toFixed(3)),
    topic_similarity: Number(termSimilarity.toFixed(3)),
    shared_terms: sharedTerms.slice(0, 12),
    matching_sources: exactSources.slice(0, 5)
  };
}

function check(candidate, log) {
  const published = log.filter((item) => item && item.published !== false && item.status !== 'blocked');
  const comparisons = published
    .filter((item) => !(candidate.date && candidate.slot && item.date === candidate.date && item.slot === candidate.slot))
    .map((item) => ({ prior: item, match: compare(candidate, item) }))
    .filter(({ match }) => match.duplicate)
    .sort((a, b) => {
      const aScore = Math.max(a.match.title_similarity, a.match.topic_similarity);
      const bScore = Math.max(b.match.title_similarity, b.match.topic_similarity);
      return bScore - aScore;
    });

  return {
    ok: comparisons.length === 0,
    status: comparisons.length === 0 ? 'pass' : 'duplicate_blocked',
    candidate: {
      date: candidate.date || null,
      slot: candidate.slot || null,
      title: candidate.title || null,
      selected_story: candidate.selected_story || candidate.story || null,
      sources: candidate.sources || []
    },
    checked_against_count: published.length,
    matches: comparisons.slice(0, 5).map(({ prior, match }) => ({
      prior_date: prior.date || null,
      prior_slot: prior.slot || null,
      prior_title: prior.title || null,
      prior_story: prior.selected_story || null,
      prior_permalink: prior.permalink || null,
      ...match
    }))
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command !== 'check') {
    usage();
    process.exit(1);
  }

  const logPath = args.log ? path.resolve(process.cwd(), args.log) : DEFAULT_LOG;
  const log = readJson(logPath, []);
  if (!Array.isArray(log)) {
    throw new Error(`Log must be an array: ${logPath}`);
  }

  const candidate = candidateFromArgs(args);
  const result = check(candidate, log);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 2);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  usage();
  process.exit(1);
}
