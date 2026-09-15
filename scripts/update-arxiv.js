#!/usr/bin/env node

/*
 * Discover papers listed on arXiv author pages and merge their metadata into
 * the source bibliography. Abstracts are kept separately in aux.yml because
 * they are rendered as expandable page content.
 */

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const bibtexParse = require('bibtex-parse-js');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'files', 'data');
const BIB_FILE = path.join(DATA, 'ref.bib');
const AUX_FILE = path.join(DATA, 'aux.yml');
const GLOBAL_FEED_URL = 'https://rss.arxiv.org/atom/quant-ph';
const REQUEST_DELAY_MS = Math.max(0, Number(process.env.ARXIV_REQUEST_DELAY_MS || 3000));
const MAX_RETRIES = Math.min(5, Math.max(0, Number(
  process.env.ARXIV_MAX_RETRIES ?? process.env.ARXIV_RETRY_ATTEMPTS ?? 5
)));
const MAX_RETRY_DELAY_MS = Math.max(1000, Number(process.env.ARXIV_MAX_RETRY_DELAY_MS || 30000));
const USER_AGENT = process.env.ARXIV_USER_AGENT ||
  'ox-quant-info-site/1.0 (arXiv bibliography updater)';
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const ADDITION_ANNOUNCE_TYPES = new Set(['new', 'cross']);
const REPLACEMENT_ANNOUNCE_TYPES = new Set(['replace', 'replace-cross']);

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const KEY_STOP_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'in', 'into', 'of', 'on',
  'or', 'the', 'to', 'using', 'via', 'with'
]);
const LOOKBACK_DAYS = Math.max(1, Number(process.env.ARXIV_LOOKBACK_DAYS || 7));

function printHelp() {
  console.log(`Usage: node scripts/update-arxiv.js [--mode direct|pr] [--dry-run]

The direct mode scans configured author feeds and global replacement entries.
The pr mode scans global new and cross-list entries for a pull request.
For author feeds, equal updated and published timestamps are treated as new
submissions; differing timestamps are treated as replacements.

Options:
  --mode direct|pr
  --dry-run   show changes without writing files
  --help      show this message

Environment:
  ARXIV_REQUEST_DELAY_MS  delay between arXiv requests (default: 3000)
  ARXIV_MAX_RETRIES       total retries for transient failures (maximum: 5)
  ARXIV_MAX_RETRY_DELAY_MS maximum retry wait (default: 30000)
  ARXIV_LOOKBACK_DAYS     author-feed lookback (default: 7)
  ARXIV_USER_AGENT        user-agent sent to arXiv

429 responses are retried at most five times. All transient errors share the
same maximum retry budget per request.`);
}

function readYaml(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  const parsed = yaml.load(fs.readFileSync(filePath, 'utf8'));
  return parsed == null ? fallback : parsed;
}

function flattenStrings(value) {
  if (Array.isArray(value)) return value.flatMap(flattenStrings);
  if (typeof value === 'string') return [value];
  return [];
}

function normaliseArxivId(value) {
  const text = String(value || '').trim();
  const match = text.match(/(?:arxiv\.org\/(?:abs|pdf)\/)?((?:\d{4}\.\d{4,5}|[a-z][a-z-]+\/\d{7})(?:v\d+)?)/i);
  return match ? match[1].replace(/v\d+$/i, '') : '';
}

function arxivAuthorIds(member) {
  const ids = new Set();
  for (const value of flattenStrings(member && member['arxivId'])) {
    const id = value.match(/^[A-Za-z0-9_-]+$/) ? value : value.match(/arxiv\.org\/a\/([^/?#]+)/i)?.[1];
    if (id) ids.add(decodeURIComponent(id));
  }
  return [...ids];
}

function configuredMembers() {
  const pi = readYaml(path.join(DATA, 'pi.yml'), {});
  const main = readYaml(path.join(DATA, 'main_members.yml'), {});
  const members = [];

  if (pi && pi.name) members.push({ ...pi, source: 'pi.yml' });

  for (const [group, records] of Object.entries(main || {})) {
    if (/past|alumni|former/i.test(group)) continue;
    if (!Array.isArray(records)) continue;
    for (const member of records) {
      if (member && member.name) members.push({ ...member, source: `main_members.yml (${group})` });
    }
  }

  return members;
}

function memberAliases(member) {
  const aliases = flattenStrings(member?.alt_name ?? member?.alt_names);
  return [member?.name, ...aliases].filter(Boolean);
}

function normalisePersonName(value) {
  return String(value || '')
    .replace(/\\[a-z]+\s*/gi, '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function memberNameMap(members) {
  const names = new Map();
  for (const member of members) {
    for (const alias of memberAliases(member)) {
      const normalized = normalisePersonName(alias);
      if (normalized) names.set(normalized, member.name);
    }
  }
  return names;
}

function matchedMemberNames(paper, names) {
  return paper.authors
    .map(author => names.get(normalisePersonName(author)))
    .filter(Boolean);
}

function logMatchedEntries(label, papers) {
  if (!papers.length) return;
  console.log(`${label}:`);
  for (const paper of papers) {
    console.log(`  ${paper.id} [${paper.announceType}] ${paper.authors.join(', ')} — ${paper.title}`);
  }
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

let lastRequestAt = 0;

async function waitForRequestSlot() {
  const wait = REQUEST_DELAY_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

function retryAfterMilliseconds(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : Math.max(0, timestamp - Date.now());
}

async function fetchAtom(url, maxRetries = MAX_RETRIES) {
  let requestCount = 0;
  let retries = 0;
  while (true) {
    requestCount += 1;
    try {
      await waitForRequestSlot();
      const response = await fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'application/atom+xml'
        }
      });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        error.status = response.status;
        error.retryAfterMs = retryAfterMilliseconds(response.headers.get('retry-after'));
        throw error;
      }
      return await response.text();
    } catch (error) {
      const isRateLimited = error.status === 429;
      const isTransient = !error.status || RETRYABLE_STATUSES.has(error.status);
      if (!isTransient) throw error;
      if (retries >= maxRetries) throw error;
      retries += 1;
      const retryDelay = isRateLimited
        ? error.retryAfterMs ?? Math.min(30000 * (2 ** (retries - 1)), MAX_RETRY_DELAY_MS)
        : Math.min(Math.max(1000, REQUEST_DELAY_MS * retries), MAX_RETRY_DELAY_MS);
      console.warn(`Request attempt ${requestCount} failed for ${url}: ${error.message}; retrying in ${Math.ceil(retryDelay / 1000)}s`);
      await sleep(Math.min(retryDelay, MAX_RETRY_DELAY_MS));
    }
  }
}

function decodeXml(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Number(number)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function xmlText(block, tag) {
  const match = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? decodeXml(match[1]).trim() : '';
}

function atomAuthors(block) {
  const authors = [];
  for (const match of block.matchAll(/<author(?:\s[^>]*)?>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gi)) {
    const author = decodeXml(match[1]).replace(/\s+/g, ' ').trim();
    if (author) authors.push(author);
  }
  if (authors.length) return authors;
  return xmlText(block, 'dc:creator')
    .split(/\s*,\s*/)
    .map(author => author.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function atomAbstract(block) {
  const summary = xmlText(block, 'summary').replace(/\s+/g, ' ').trim();
  const abstract = summary.match(/\bAbstract:\s*([\s\S]*)$/i);
  return abstract ? abstract[1].trim() : summary;
}

function parseAtomEntries(xml) {
  const entries = [];
  for (const block of xml.match(/<entry(?:\s[^>]*)?>[\s\S]*?<\/entry>/gi) || []) {
    const id = normaliseArxivId(xmlText(block, 'id'));
    if (!id) continue;

    const authors = atomAuthors(block);

    const published = xmlText(block, 'published');
    const updated = xmlText(block, 'updated');
    const publishedDate = new Date(published);
    const updatedDate = new Date(updated);
    const categories = [...block.matchAll(/<category\b[^>]*\bterm=["']([^"']+)["']/gi)]
      .map(match => decodeXml(match[1]).trim()).filter(Boolean);
    const doi = xmlText(block, 'arxiv:doi') || xmlText(block, 'doi');

    entries.push({
      id,
      title: xmlText(block, 'title').replace(/\s+/g, ' ').trim(),
      abstract: atomAbstract(block),
      authors,
      announceType: (xmlText(block, 'arxiv:announce_type') || 'new').toLowerCase(),
      publishedAt: Number.isNaN(publishedDate.getTime()) ? null : publishedDate,
      updatedAt: Number.isNaN(updatedDate.getTime()) ? null : updatedDate,
      year: Number.isNaN(publishedDate.getTime()) ? new Date().getUTCFullYear() : publishedDate.getUTCFullYear(),
      month: Number.isNaN(publishedDate.getTime()) ? 'jan' : MONTHS[publishedDate.getUTCMonth()],
      primaryClass: categories[0] || '',
      doi: doi.replace(/^https?:\/\/doi\.org\//i, '').trim(),
      url: `https://arxiv.org/abs/${id}`
    });
  }
  return entries;
}

async function discoverAuthorFeed(authorId, now = new Date()) {
  const atom = await fetchAtom(`https://arxiv.org/a/${encodeURIComponent(authorId)}.atom`);
  const papers = parseAtomEntries(atom);
  return {
    papers,
    recent: papers.filter(paper => recentPaper(paper, now))
  };
}

function bibTags(entry) {
  return Object.fromEntries(Object.entries(entry.entryTags || {}).map(([key, value]) => [
    key.toLowerCase(), String(value || '')
  ]));
}

function normaliseTitle(title) {
  return String(title || '')
    .replace(/\\[a-z]+\s*/gi, '')
    .replace(/[{}]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function existingBibliography(raw) {
  const entries = bibtexParse.toJSON(raw) || [];
  const records = [];
  for (const entry of entries) {
    const tags = bibTags(entry);
    const arxivId = normaliseArxivId(tags.eprint || tags.arxiv || tags.url || '');
    records.push({
      key: String(entry.citationKey || entry.citation_key || '').toLowerCase(),
      type: String(entry.entryType || '').toLowerCase(),
      arxivId,
      doi: String(tags.doi || '').toLowerCase(),
      title: normaliseTitle(tags.title)
    });
  }
  return records;
}

function matchingAuxiliaryEntry(auxObject, key) {
  const target = String(key || '').toLowerCase();
  if (!target || !auxObject || typeof auxObject !== 'object') return null;
  const auxKey = Object.keys(auxObject).find(candidate => String(candidate).toLowerCase() === target);
  return auxKey == null ? null : { key: auxKey, value: auxObject[auxKey] };
}

function collectAuxiliaryArxivIds(value) {
  const ids = new Set();

  function collect(value, fieldName = '') {
    if (Array.isArray(value)) {
      value.forEach(item => collect(item, fieldName));
      return;
    }
    if (value && typeof value === 'object') {
      for (const [field, nestedValue] of Object.entries(value)) {
        if (/arxiv|eprint|url|link/i.test(field)) collect(nestedValue, field);
      }
      return;
    }
    if (!/arxiv|eprint|url|link/i.test(fieldName)) return;
    const id = normaliseArxivId(value);
    if (id) ids.add(id);
  }

  collect(value);
  return ids;
}

function cleanBibValue(value) {
  return String(value || '').replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim().replace(/[{}]/g, '');
}

const LATEX_AUTHOR_ACCENTS = {
  'á': "\\'{a}", 'Á': "\\'{A}", 'ä': '\\"{a}', 'Ä': '\\"{A}',
  'é': "\\'{e}", 'É': "\\'{E}", 'ë': '\\"{e}', 'Ë': '\\"{E}',
  'í': "\\'{i}", 'Í': "\\'{I}", 'ï': '\\"{i}', 'Ï': '\\"{I}',
  'ó': "\\'{o}", 'Ó': "\\'{O}", 'ö': '\\"{o}', 'Ö': '\\"{O}',
  'ú': "\\'{u}", 'Ú': "\\'{U}", 'ü': '\\"{u}', 'Ü': '\\"{U}',
  'ý': "\\'{y}", 'Ý': "\\'{Y}", 'ÿ': '\\"{y}', 'Ÿ': '\\"{Y}',
  'ñ': '\\~{n}', 'Ñ': '\\~{N}',
  'å': '\\aa', 'Å': '\\AA', 'æ': '\\ae', 'Æ': '\\AE',
  'œ': '\\oe', 'Œ': '\\OE', 'ø': '\\o', 'Ø': '\\O', 'ß': '\\ss'
};

function latexAuthor(value) {
  return String(value || '')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[áÁäÄéÉëËíÍïÏóÓöÖúÚüÜýÝÿŸñÑåÅæÆœŒøØß]/g, character => LATEX_AUTHOR_ACCENTS[character]);
}

function bibAuthorName(value) {
  const clean = String(value || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  if (clean.includes(',')) return clean;
  const parts = clean.split(' ');
  if (parts.length === 1) return clean;
  const lastName = parts.pop();
  return `${lastName}, ${parts.join(' ')}`;
}

function authorSurname(author) {
  const clean = cleanBibValue(author);
  if (clean.includes(',')) return clean.split(',')[0];
  return clean.split(/\s+/).filter(Boolean).at(-1) || 'paper';
}

function citationKey(paper, usedKeys) {
  const surname = authorSurname(paper.authors[0] || 'paper')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9]/g, '')
    .toLowerCase() || 'paper';
  const words = cleanBibValue(paper.title).toLowerCase().match(/[a-z0-9]+/g) || [];
  const firstImportantWord = words.find(word => !KEY_STOP_WORDS.has(word)) || 'arxiv';
  const base = `${surname}${paper.year}${firstImportantWord}`;
  let key = base;
  let suffix = 2;
  while (usedKeys.has(key.toLowerCase())) key = `${base}${suffix++}`;
  usedKeys.add(key.toLowerCase());
  return key;
}

function bibtexFor(paper, key) {
  const lines = [
    `@misc{${key},`,
    `  title = {${cleanBibValue(paper.title)}},`,
    `  author = {${paper.authors.map(author => latexAuthor(bibAuthorName(author))).join(' and ')}},`,
    `  year = ${paper.year},`,
    `  month = ${paper.month},`,
    `  url = {${paper.url}},`,
    `  eprint = {${paper.id}},`,
    '  archiveprefix = {arXiv}'
  ];
  if (paper.primaryClass) lines[lines.length - 1] += ',';
  if (paper.primaryClass) lines.push(`  primaryclass = {${cleanBibValue(paper.primaryClass)}}`);
  if (paper.doi) {
    lines[lines.length - 1] += ',';
    lines.push(`  doi = {${cleanBibValue(paper.doi)}}`);
  }
  lines.push('}');
  return lines.join('\n');
}

function yamlAbstractRecord(key, abstract) {
  const lines = String(abstract || '').split(/\r?\n/);
  return `${key}:\n  abs: >-\n${lines.map(line => `    ${line}`).join('\n')}`;
}

function yamlKeyPattern(key) {
  return new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*$`, 'm');
}

function setAbstractInAux(raw, auxEntry, abstract) {
  if (!auxEntry) return raw;
  const keyMatch = raw.match(yamlKeyPattern(auxEntry.key));
  if (!keyMatch) return raw;

  const entryStart = keyMatch.index;
  const nextKeyPattern = /^\S[^:\n]*:\s*$/gm;
  nextKeyPattern.lastIndex = entryStart + keyMatch[0].length;
  const nextKey = nextKeyPattern.exec(raw);
  const entryEnd = nextKey ? nextKey.index : raw.length;
  const entry = raw.slice(entryStart, entryEnd);
  const value = String(abstract).split(/\r?\n/).map(line => `    ${line}`).join('\n');
  const field = `  abs: >-\n${value}\n`;
  const abstractField = /^  (?:abs|abstract):[^\r\n]*(?:\r?\n|$)/m.exec(entry);

  if (!abstractField) {
    const insertAt = keyMatch[0].length;
    return `${raw.slice(0, entryStart)}${entry.slice(0, insertAt)}\n${field}${entry.slice(insertAt)}${raw.slice(entryEnd)}`;
  }

  const nextFieldPattern = /^  [A-Za-z_][\w-]*\s*:/gm;
  nextFieldPattern.lastIndex = abstractField.index + abstractField[0].length;
  const nextField = nextFieldPattern.exec(entry);
  const fieldEnd = nextField ? nextField.index : entry.length;
  const updatedEntry = `${entry.slice(0, abstractField.index)}${field}${entry.slice(fieldEnd)}`;
  return `${raw.slice(0, entryStart)}${updatedEntry}${raw.slice(entryEnd)}`;
}

function bibEntryRange(raw, key) {
  const escapedKey = String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const startPattern = new RegExp(`^@[^\\n{]+\\{${escapedKey},\\s*$`, 'm');
  const start = raw.match(startPattern);
  if (!start) return null;
  const nextEntry = raw.indexOf('\n@', start.index + start[0].length);
  return { start: start.index, end: nextEntry === -1 ? raw.length : nextEntry + 1 };
}

function replaceBibField(entry, field, value) {
  const pattern = new RegExp(`^(\\s*${field}\\s*=\\s*)\\{[^\\n]*\\}(,?)$`, 'm');
  if (pattern.test(entry)) return entry.replace(pattern, `$1{${value}}$2`);

  const insertAt = entry.lastIndexOf('\n}');
  return insertAt === -1
    ? entry
    : `${entry.slice(0, insertAt)}  ${field} = {${value}},\n${entry.slice(insertAt)}`;
}

function updateBibMetadata(raw, key, paper) {
  const range = bibEntryRange(raw, key);
  if (!range) return raw;
  const title = cleanBibValue(paper.title);
  const authors = paper.authors.map(author => latexAuthor(bibAuthorName(author))).join(' and ');
  let entry = raw.slice(range.start, range.end);
  entry = replaceBibField(entry, 'title', title);
  entry = replaceBibField(entry, 'author', authors);
  return `${raw.slice(0, range.start)}${entry}${raw.slice(range.end)}`;
}

function normalizeAbstract(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function prependAuxRecords(raw, records) {
  if (!records.length) return raw;
  const header = raw.match(/^---\s*\r?\n/);
  const insertAt = header ? header[0].length : 0;
  const block = `${records.join('\n')}\n`;
  return `${raw.slice(0, insertAt)}${block}${raw.slice(insertAt)}`;
}

function inLookback(date, now = new Date()) {
  const oldest = now.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  return date instanceof Date && !Number.isNaN(date.getTime()) &&
    date.getTime() >= oldest && date.getTime() <= now.getTime();
}

function recentPaper(paper, now = new Date()) {
  return inLookback(paper.updatedAt, now);
}

function newlyPublished(paper, now = new Date()) {
  return inLookback(paper.publishedAt, now);
}

function isNewSubmission(paper) {
  return paper.updatedAt instanceof Date && !Number.isNaN(paper.updatedAt.getTime()) &&
    paper.publishedAt instanceof Date && !Number.isNaN(paper.publishedAt.getTime()) &&
    paper.updatedAt.getTime() === paper.publishedAt.getTime();
}

function loadMergeState() {
  const bibRaw = fs.existsSync(BIB_FILE) ? fs.readFileSync(BIB_FILE, 'utf8') : '';
  const auxRaw = fs.existsSync(AUX_FILE) ? fs.readFileSync(AUX_FILE, 'utf8') : '---\n';
  const auxObject = readYaml(AUX_FILE, {}) || {};
  const existing = existingBibliography(bibRaw);
  const existingByKey = new Map(existing.map(record => [record.key, record]));
  const existingIds = new Set();
  const auxArxivIds = new Set();
  Object.values(auxObject).forEach(value => {
    collectAuxiliaryArxivIds(value).forEach(id => auxArxivIds.add(id));
  });
  const arxivKeyById = new Map();

  for (const record of existing) {
    const auxEntry = matchingAuxiliaryEntry(auxObject, record.key);
    const auxIds = collectAuxiliaryArxivIds(auxEntry?.value);
    const recordIds = new Set([record.arxivId, ...auxIds].filter(Boolean));
    recordIds.forEach(id => {
      existingIds.add(id);
      arxivKeyById.set(id, record.key);
    });
  }

  return {
    bibRaw,
    auxRaw,
    auxObject,
    existing,
    existingByKey,
    existingIds,
    auxArxivIds,
    arxivKeyById,
    existingDois: new Set(existing.map(record => record.doi).filter(Boolean)),
    existingTitles: new Set(existing.map(record => record.title).filter(Boolean)),
    usedKeys: new Set(existing.map(record => record.key).filter(Boolean)),
    newBib: [],
    newAuxRecords: [],
    nextBib: bibRaw,
    nextAux: auxRaw,
    abstractCount: 0,
    bibMetadataCount: 0
  };
}

function paperIsDuplicate(state, paper) {
  return state.existingIds.has(paper.id) ||
    state.auxArxivIds.has(paper.id) ||
    (paper.doi && state.existingDois.has(paper.doi.toLowerCase())) ||
    state.existingTitles.has(normaliseTitle(paper.title));
}

function paperCanUpdate(state, paper, key) {
  const existingRecord = key ? state.existingByKey.get(key) : null;
  return Boolean(existingRecord && existingRecord.type === 'misc');
}

function mergePaper(state, paper, {
  allowNew = false,
  allowUpdate = false,
  addMissingAbstract = false
} = {}) {
  const duplicate = paperIsDuplicate(state, paper);
  let key = state.arxivKeyById.get(paper.id);
  let added = false;
  let eligibleUpdate = false;

  if (allowNew && !duplicate) {
    key = citationKey(paper, state.usedKeys);
    state.newBib.push(bibtexFor(paper, key));
    state.arxivKeyById.set(paper.id, key);
    state.existingIds.add(paper.id);
    if (paper.doi) state.existingDois.add(paper.doi.toLowerCase());
    state.existingTitles.add(normaliseTitle(paper.title));
    added = true;
  } else if (allowUpdate && key && paperCanUpdate(state, paper, key)) {
    eligibleUpdate = true;
    const updatedBib = updateBibMetadata(state.nextBib, key, paper);
    if (updatedBib !== state.nextBib) {
      state.nextBib = updatedBib;
      state.bibMetadataCount += 1;
    }
  }

  const auxEntry = matchingAuxiliaryEntry(state.auxObject, key);
  const storedAbstract = auxEntry?.value?.abs || auxEntry?.value?.abstract || '';
  const abstractDiffers = normalizeAbstract(storedAbstract) !== normalizeAbstract(paper.abstract);
  const shouldAddAbstract = added || (addMissingAbstract && !storedAbstract);
  const shouldUpdateAbstract = eligibleUpdate && abstractDiffers;
  if (!key || !paper.abstract || (!shouldAddAbstract && !shouldUpdateAbstract)) return;

  if (auxEntry) {
    state.nextAux = setAbstractInAux(state.nextAux, auxEntry, paper.abstract);
  } else {
    state.newAuxRecords.push(yamlAbstractRecord(key, paper.abstract));
  }
  const auxKey = auxEntry?.key || key;
  state.auxObject[auxKey] = { ...(state.auxObject[auxKey] || {}), abs: paper.abstract };
  state.abstractCount += 1;
}

function finalizeMergeState(state) {
  state.nextAux = prependAuxRecords(state.nextAux, state.newAuxRecords);
  if (state.newBib.length) {
    state.nextBib = `${state.newBib.join('\n')}\n${state.nextBib.trimStart()}`.trimEnd();
  }
  return state;
}

function writeMergeState(state, dryRun, label) {
  finalizeMergeState(state);
  console.log(`${label} new bibliography records: ${state.newBib.length}`);
  console.log(`${label} BibTeX metadata records updated: ${state.bibMetadataCount}`);
  console.log(`${label} abstract records added or updated: ${state.abstractCount}`);

  if (dryRun) {
    if (state.newBib.length) console.log(`\n${state.newBib.join('\n\n')}`);
    return;
  }

  if (state.nextBib !== state.bibRaw) fs.writeFileSync(BIB_FILE, state.nextBib);
  if (state.nextAux !== state.auxRaw) fs.writeFileSync(AUX_FILE, state.nextAux.trimEnd());
}

async function scanAuthorFeeds(authorIds, now) {
  const recentPapers = new Map();

  console.log(`Scanning ${authorIds.size} arXiv author ID(s): ${[...authorIds.keys()].join(', ') || 'none'}`);
  for (const [authorId, names] of authorIds) {
    try {
      const feed = await discoverAuthorFeed(authorId, now);
      feed.recent.forEach(paper => recentPapers.set(paper.id, paper));
      console.log(`  ${authorId} (${names.join(', ')}): ${feed.recent.length} recent paper(s)`);
    } catch (error) {
      console.warn(`  Could not read arXiv author page ${authorId}: ${error.message}`);
    }
  }

  return { recentPapers };
}

async function scanGlobalFeed(members, state) {
  const atom = await fetchAtom(GLOBAL_FEED_URL);
  const papers = parseAtomEntries(atom);
  const names = memberNameMap(members);
  const matched = papers.filter(paper => {
    if (REPLACEMENT_ANNOUNCE_TYPES.has(paper.announceType)) {
      return state.existingIds.has(paper.id);
    }
    return ADDITION_ANNOUNCE_TYPES.has(paper.announceType) &&
      matchedMemberNames(paper, names).length > 0 &&
      !paperIsDuplicate(state, paper);
  });
  return { papers, matched };
}

function cliOption(argumentsList, name, fallback) {
  const equalsArgument = argumentsList.find(argument => argument.startsWith(`${name}=`));
  if (equalsArgument) return equalsArgument.slice(name.length + 1);
  const optionIndex = argumentsList.indexOf(name);
  return optionIndex === -1 ? fallback : argumentsList[optionIndex + 1];
}

async function main() {
  const argumentsList = process.argv.slice(2);
  const args = new Set(argumentsList);
  if (args.has('--help') || args.has('-h')) {
    printHelp();
    return;
  }

  const mode = String(cliOption(argumentsList, '--mode', 'direct') || '').toLowerCase();
  if (!['direct', 'pr'].includes(mode)) {
    throw new Error(`Unknown mode: ${mode}. Use --mode=direct or --mode=pr.`);
  }

  const dryRun = args.has('--dry-run');
  const scanNow = new Date();
  const members = configuredMembers();
  const state = loadMergeState();

  if (mode === 'direct') {
    const authorIds = new Map();
    for (const member of members) {
      for (const id of arxivAuthorIds(member)) {
        if (!authorIds.has(id)) authorIds.set(id, []);
        authorIds.get(id).push(member.name);
      }
    }

    const scan = await scanAuthorFeeds(authorIds, scanNow);
    const papers = [...scan.recentPapers.values()];
    for (const paper of papers.sort((a, b) => b.year - a.year || b.id.localeCompare(a.id))) {
      const newSubmission = isNewSubmission(paper);
      mergePaper(state, paper, {
        allowNew: newSubmission && newlyPublished(paper, scanNow),
        allowUpdate: !newSubmission,
        addMissingAbstract: newSubmission
      });
    }
    const global = await scanGlobalFeed(members, state);
    const replacements = global.matched.filter(paper => REPLACEMENT_ANNOUNCE_TYPES.has(paper.announceType));
    console.log(`Direct author-feed entries in lookback: ${papers.length}`);
    console.log(`Global quant-ph feed entries: ${global.papers.length}`);
    console.log(`Global replacement entries selected for direct update: ${replacements.length}`);
    for (const paper of replacements) mergePaper(state, paper, { allowUpdate: true });
    if (!papers.length && !replacements.length) {
      console.log('No direct arXiv changes require processing. No files changed.');
      return;
    }
    writeMergeState(state, dryRun, 'Direct arXiv');
    return;
  }

  const global = await scanGlobalFeed(members, state);
  const matchedPapers = global.matched
    .filter(paper => ADDITION_ANNOUNCE_TYPES.has(paper.announceType))
    .sort((a, b) => b.year - a.year || b.id.localeCompare(a.id));
  console.log(`Global quant-ph feed entries: ${global.papers.length}`);
  console.log(`Global new/cross entries selected for pull request: ${matchedPapers.length}`);
  if (!matchedPapers.length) {
    console.log('No global additions require a pull request. No files changed.');
    return;
  }

  logMatchedEntries('Matched pull-request entries', matchedPapers);
  for (const paper of matchedPapers) {
    mergePaper(state, paper, { allowNew: true });
  }
  writeMergeState(state, dryRun, 'Pull-request arXiv');
}

main().catch(error => {
  console.error(`arXiv update failed: ${error.stack || error.message}`);
  process.exitCode = 1;
});
