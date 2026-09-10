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
const REQUEST_DELAY_MS = Math.max(0, Number(process.env.ARXIV_REQUEST_DELAY_MS || 5000));
const RETRY_ATTEMPTS = Math.max(1, Number(process.env.ARXIV_RETRY_ATTEMPTS || 5));
const MAX_RETRY_DELAY_MS = Math.max(1000, Number(process.env.ARXIV_MAX_RETRY_DELAY_MS || 900000));
const USER_AGENT = process.env.ARXIV_USER_AGENT ||
  'ox-quant-info-site/1.0 (arXiv bibliography updater; contact: ox-quant-info@maths.ox.ac.uk)';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const KEY_STOP_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'in', 'into', 'of', 'on',
  'or', 'the', 'to', 'using', 'via', 'with'
]);
const LOOKBACK_DAYS = Math.max(1, Number(process.env.ARXIV_LOOKBACK_DAYS || 7));

function printHelp() {
  console.log(`Usage: node scripts/update-arxiv.js [--dry-run]

Find arXiv papers listed on the author pages configured in pi.yml and
main_members.yml. New records are prepended to ref.bib and their verbatim
abstracts are prepended to aux.yml.

Options:
  --dry-run   show changes without writing files
  --scheduled enforce the 04:00 UTC schedule guard
  --help      show this message

Environment:
  ARXIV_REQUEST_DELAY_MS  delay between arXiv requests (default: 5000)
  ARXIV_RETRY_ATTEMPTS    attempts for transient failures (default: 5)
  ARXIV_MAX_RETRY_DELAY_MS maximum retry wait (default: 900000)
  ARXIV_LOOKBACK_DAYS     posting-time lookback (default: 7)
  ARXIV_USER_AGENT        user-agent sent to arXiv`);
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

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function isUtcScheduledRun(date = new Date()) {
  return [1, 2, 3, 4, 5].includes(date.getUTCDay()) && date.getUTCHours() === 4;
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

async function fetchText(url, options = {}, attempts = RETRY_ATTEMPTS) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await waitForRequestSlot();
      const response = await fetch(url, {
        ...options,
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'application/atom+xml, text/html;q=0.9, */*;q=0.8',
          ...(options.headers || {})
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
      lastError = error;
      if (attempt < attempts) {
        const retryDelay = error.status === 429
          ? error.retryAfterMs ?? Math.min(30000 * (2 ** (attempt - 1)), MAX_RETRY_DELAY_MS)
          : Math.min(Math.max(1000, REQUEST_DELAY_MS * attempt), 30000);
        console.warn(`Request attempt ${attempt}/${attempts} failed for ${url}: ${error.message}; retrying in ${Math.ceil(retryDelay / 1000)}s`);
        await sleep(Math.min(retryDelay, MAX_RETRY_DELAY_MS));
      }
    }
  }
  throw lastError;
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

function xmlAttribute(block, tag, attribute) {
  const match = block.match(new RegExp(`<${tag}\\b[^>]*\\b${attribute}=["']([^"']+)["']`, 'i'));
  return match ? decodeXml(match[1]).trim() : '';
}

function parseAtomEntries(xml) {
  const entries = [];
  for (const block of xml.match(/<entry(?:\s[^>]*)?>[\s\S]*?<\/entry>/gi) || []) {
    const id = normaliseArxivId(xmlText(block, 'id'));
    if (!id) continue;

    const authors = [];
    for (const match of block.matchAll(/<author(?:\s[^>]*)?>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gi)) {
      const author = decodeXml(match[1]).replace(/\s+/g, ' ').trim();
      if (author) authors.push(author);
    }

    const published = xmlText(block, 'published');
    const date = new Date(published);
    const categories = [...block.matchAll(/<category\b[^>]*\bterm=["']([^"']+)["']/gi)]
      .map(match => decodeXml(match[1]).trim()).filter(Boolean);
    const doi = xmlText(block, 'arxiv:doi') || xmlText(block, 'doi');

    entries.push({
      id,
      title: xmlText(block, 'title').replace(/\s+/g, ' ').trim(),
      abstract: xmlText(block, 'summary').replace(/\s+/g, ' ').trim(),
      authors,
      publishedAt: Number.isNaN(date.getTime()) ? null : date,
      year: Number.isNaN(date.getTime()) ? new Date().getUTCFullYear() : date.getUTCFullYear(),
      month: Number.isNaN(date.getTime()) ? 'jan' : MONTHS[date.getUTCMonth()],
      primaryClass: categories[0] || '',
      doi: doi.replace(/^https?:\/\/doi\.org\//i, '').trim(),
      url: `https://arxiv.org/abs/${id}`
    });
  }
  return entries;
}

async function discoverAuthorPapers(authorId) {
  const atom = await fetchText(`https://arxiv.org/a/${encodeURIComponent(authorId)}.atom`);
  return parseAtomEntries(atom).filter(paper => recentPaper(paper));
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

function hasAbstract(entry) {
  return Boolean(entry && typeof entry === 'object' && (entry.abs || entry.abstract));
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
    `  author = {${paper.authors.map(latexAuthor).join(' and ')}},`,
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

function addAbstractToAux(raw, auxEntry, abstract) {
  if (auxEntry) {
    const match = raw.match(yamlKeyPattern(auxEntry.key));
    if (!match) return raw;
    const insertAt = match.index + match[0].length;
    return `${raw.slice(0, insertAt)}\n  abs: >-\n${String(abstract).split(/\r?\n/).map(line => `    ${line}`).join('\n')}${raw.slice(insertAt)}`;
  }

  return raw;
}

function prependAuxRecords(raw, records) {
  if (!records.length) return raw;
  const header = raw.match(/^---\s*\r?\n/);
  const insertAt = header ? header[0].length : 0;
  const block = `${records.join('\n')}\n`;
  return `${raw.slice(0, insertAt)}${block}${raw.slice(insertAt)}`;
}

function recentPaper(paper, now = new Date()) {
  if (!(paper.publishedAt instanceof Date) || Number.isNaN(paper.publishedAt.getTime())) return false;
  const oldest = now.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  return paper.publishedAt.getTime() >= oldest && paper.publishedAt.getTime() <= now.getTime();
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--help') || args.has('-h')) {
    printHelp();
    return;
  }
  if (args.has('--scheduled') && !isUtcScheduledRun()) {
    console.log('Outside the configured 04:00 UTC schedule window. No files changed.');
    return;
  }
  const dryRun = args.has('--dry-run');
  const members = configuredMembers();
  const authorIds = new Map();

  for (const member of members) {
    for (const id of arxivAuthorIds(member)) {
      if (!authorIds.has(id)) authorIds.set(id, []);
      authorIds.get(id).push(member.name);
    }
  }

  if (!authorIds.size) {
    console.log('No arXiv author IDs found in pi.yml or main_members.yml.');
    return;
  }

  console.log(`Scanning ${authorIds.size} arXiv author ID(s): ${[...authorIds.keys()].join(', ')}`);
  const discoveredPapers = new Map();
  for (const [authorId, names] of authorIds) {
    try {
      const papers = await discoverAuthorPapers(authorId);
      papers.forEach(paper => discoveredPapers.set(paper.id, paper));
      console.log(`  ${authorId} (${names.join(', ')}): ${papers.length} recent paper(s)`);
    } catch (error) {
      console.warn(`  Could not read arXiv author page ${authorId}: ${error.message}`);
    }
  }

  if (!discoveredPapers.size) {
    console.log('No recent arXiv papers discovered. No files changed.');
    return;
  }

  const bibRaw = fs.existsSync(BIB_FILE) ? fs.readFileSync(BIB_FILE, 'utf8') : '';
  const auxRaw = fs.existsSync(AUX_FILE) ? fs.readFileSync(AUX_FILE, 'utf8') : '---\n';
  const auxObject = readYaml(AUX_FILE, {}) || {};
  const existing = existingBibliography(bibRaw);
  const existingIds = new Set();
  const auxArxivIds = new Set();
  const arxivKeyById = new Map();
  const missingAbstractIds = new Set();
  for (const record of existing) {
    const auxEntry = matchingAuxiliaryEntry(auxObject, record.key);
    const auxIds = collectAuxiliaryArxivIds(auxEntry?.value);
    const recordIds = new Set([record.arxivId, ...auxIds].filter(Boolean));
    recordIds.forEach(id => {
      existingIds.add(id);
      arxivKeyById.set(id, record.key);
    });
    auxIds.forEach(id => auxArxivIds.add(id));
    if (!hasAbstract(auxEntry?.value)) recordIds.forEach(id => missingAbstractIds.add(id));
  }
  const candidateIds = [...discoveredPapers.keys()].filter(id => !existingIds.has(id));
  const candidateIdSet = new Set(candidateIds);
  const metadata = [...discoveredPapers.values()]
    .filter(paper => candidateIdSet.has(paper.id) || missingAbstractIds.has(paper.id));
  console.log(`Known arXiv IDs from ref.bib or matching aux.yml entries: ${existingIds.size}`);
  console.log(`Known arXiv IDs found in matching aux.yml entries: ${auxArxivIds.size}`);
  console.log(`New arXiv ID candidates within the Atom lookback range: ${candidateIds.length}`);
  console.log(`Matching BibTeX records missing abstracts: ${missingAbstractIds.size}`);
  console.log(`Recent Atom entries used for BibTeX and abstract updates: ${metadata.length}`);
  if (!metadata.length) {
    console.log('No eligible Atom entries require a BibTeX or abstract update. No files changed.');
    return;
  }

  const existingDois = new Set(existing.map(record => record.doi).filter(Boolean));
  const existingTitles = new Set(existing.map(record => record.title).filter(Boolean));
  const usedKeys = new Set(existing.map(record => record.key).filter(Boolean));
  const newBib = [];
  let nextAux = auxRaw;
  const newAuxRecords = [];
  let abstractCount = 0;

  for (const paper of metadata.sort((a, b) => b.year - a.year || b.id.localeCompare(a.id))) {
    const duplicate = existingIds.has(paper.id) ||
      (paper.doi && existingDois.has(paper.doi.toLowerCase())) ||
      existingTitles.has(normaliseTitle(paper.title));
    let key = arxivKeyById.get(paper.id);

    if (!duplicate) {
      key = citationKey(paper, usedKeys);
      newBib.push(bibtexFor(paper, key));
      arxivKeyById.set(paper.id, key);
      existingIds.add(paper.id);
      if (paper.doi) existingDois.add(paper.doi.toLowerCase());
      existingTitles.add(normaliseTitle(paper.title));
    }

    const auxEntry = key ? matchingAuxiliaryEntry(auxObject, key) : null;
    if (key && paper.abstract && !hasAbstract(auxEntry?.value)) {
      if (auxEntry) {
        nextAux = addAbstractToAux(nextAux, auxEntry, paper.abstract);
      } else {
        newAuxRecords.push(yamlAbstractRecord(key, paper.abstract));
      }
      const auxKey = auxEntry?.key || key;
      auxObject[auxKey] = { ...(auxObject[auxKey] || {}), abs: paper.abstract };
      abstractCount += 1;
    }
  }

  nextAux = prependAuxRecords(nextAux, newAuxRecords);

  console.log(`New bibliography records: ${newBib.length}`);
  console.log(`Abstract records added or completed: ${abstractCount}`);
  if (dryRun) {
    if (newBib.length) console.log(`\n${newBib.join('\n\n')}`);
    if (abstractCount) console.log('\n(dry run: aux.yml changes are not written)');
    return;
  }

  if (newBib.length) {
    fs.writeFileSync(BIB_FILE, `${newBib.join('\n')}\n${bibRaw.trimStart()}`.trimEnd());
  }
  if (nextAux !== auxRaw) fs.writeFileSync(AUX_FILE, nextAux.trimEnd());
}

main().catch(error => {
  console.error(`arXiv update failed: ${error.stack || error.message}`);
  process.exitCode = 1;
});
