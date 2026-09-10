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
const REQUEST_DELAY_MS = Math.max(0, Number(process.env.ARXIV_REQUEST_DELAY_MS || 3000));
const USER_AGENT = process.env.ARXIV_USER_AGENT ||
  'ox-quant-info-site/1.0 (arXiv bibliography updater)';

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
  ARXIV_REQUEST_DELAY_MS  delay between arXiv requests (default: 3000)
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

async function fetchText(url, options = {}, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'application/atom+xml, text/html;q=0.9, */*;q=0.8',
          ...(options.headers || {})
        }
      });
      if (!response.ok) {
        const retryAfter = Number(response.headers.get('retry-after'));
        const delay = Number.isFinite(retryAfter) ? retryAfter * 1000 : REQUEST_DELAY_MS * attempt;
        throw new Error(`HTTP ${response.status} (${delay}ms retry suggested)`);
      }
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(Math.min(Math.max(1000, REQUEST_DELAY_MS * attempt), 30000));
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
  const html = await fetchText(`https://arxiv.org/a/${encodeURIComponent(authorId)}`);
  const ids = new Set();
  const pattern = /(?:https?:\/\/(?:export\.)?arxiv\.org)?\/abs\/([^"'?#<\s]+)/gi;
  for (const match of html.matchAll(pattern)) {
    const id = normaliseArxivId(match[1]);
    if (id) ids.add(id);
  }
  return [...ids];
}

async function fetchMetadata(ids) {
  const entries = [];
  const chunkSize = 20;
  for (let index = 0; index < ids.length; index += chunkSize) {
    if (index > 0 || REQUEST_DELAY_MS > 0) await sleep(REQUEST_DELAY_MS);
    const chunk = ids.slice(index, index + chunkSize);
    const query = chunk.map(id => encodeURIComponent(id)).join(',');
    const xml = await fetchText(`https://export.arxiv.org/api/query?id_list=${query}&max_results=${chunk.length}`);
    entries.push(...parseAtomEntries(xml));
  }
  return entries;
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

function cleanBibValue(value) {
  return String(value || '').replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim().replace(/[{}]/g, '');
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
    `  author = {${paper.authors.map(cleanBibValue).join(' and ')}},`,
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

function addAbstractToAux(raw, auxObject, key, abstract) {
  const existing = auxObject[key] || auxObject[key.toLowerCase()];
  if (existing && (existing.abs || existing.abstract)) return raw;

  if (Object.prototype.hasOwnProperty.call(auxObject, key)) {
    const match = raw.match(yamlKeyPattern(key));
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
  const discoveredIds = new Set();
  for (const [authorId, names] of authorIds) {
    try {
      const ids = await discoverAuthorPapers(authorId);
      ids.forEach(id => discoveredIds.add(id));
      console.log(`  ${authorId} (${names.join(', ')}): ${ids.length} paper(s)`);
    } catch (error) {
      console.warn(`  Could not read arXiv author page ${authorId}: ${error.message}`);
    }
    if (REQUEST_DELAY_MS > 0) await sleep(REQUEST_DELAY_MS);
  }

  if (!discoveredIds.size) {
    console.log('No arXiv papers discovered. No files changed.');
    return;
  }

  let metadata;
  try {
    metadata = (await fetchMetadata([...discoveredIds])).filter(paper => recentPaper(paper));
  } catch (error) {
    console.warn(`Could not read arXiv metadata: ${error.message}`);
    console.log('No files changed.');
    return;
  }
  console.log(`Papers first posted in the last ${LOOKBACK_DAYS} day(s): ${metadata.length}`);
  if (!metadata.length) {
    console.log('No recent arXiv papers found. No files changed.');
    return;
  }
  const bibRaw = fs.existsSync(BIB_FILE) ? fs.readFileSync(BIB_FILE, 'utf8') : '';
  const auxRaw = fs.existsSync(AUX_FILE) ? fs.readFileSync(AUX_FILE, 'utf8') : '---\n';
  const auxObject = readYaml(AUX_FILE, {}) || {};
  const existing = existingBibliography(bibRaw);
  const existingIds = new Set(existing.map(record => record.arxivId).filter(Boolean));
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
    let key = existing.find(record => record.arxivId === paper.id)?.key;

    if (!duplicate) {
      key = citationKey(paper, usedKeys);
      newBib.push(bibtexFor(paper, key));
      existingIds.add(paper.id);
      if (paper.doi) existingDois.add(paper.doi.toLowerCase());
      existingTitles.add(normaliseTitle(paper.title));
    }

    if (key && paper.abstract && !(auxObject[key] && (auxObject[key].abs || auxObject[key].abstract))) {
      if (Object.prototype.hasOwnProperty.call(auxObject, key)) {
        nextAux = addAbstractToAux(nextAux, auxObject, key, paper.abstract);
      } else {
        newAuxRecords.push(yamlAbstractRecord(key, paper.abstract));
      }
      auxObject[key] = { ...(auxObject[key] || {}), abs: paper.abstract };
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
