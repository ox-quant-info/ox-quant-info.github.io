const fs = require('fs-extra');
const path = require('path');
const cheerio = require('cheerio');
const yaml = require('js-yaml');
const bibtexParse = require('bibtex-parse-js');

const ROOT = process.cwd();
const DATA = path.join(ROOT, 'files', 'data');
const DIST = path.join(ROOT, 'dist');
const SITE_URL = (process.env.SITE_URL || 'https://ox-quant-info.github.io').replace(/\/+$/, '');
const COMING_SOON = ['1', 'true', 'yes', 'on'].includes(String(process.env.COMING_SOON || '').toLowerCase());

// These root HTML files are the visual backbone templates. The build reads them
// without modifying them and writes the data-rendered versions into dist/.
const PAGES = [
  { file: 'index.html', page: 'home', bodyClass: 'index-page', active: 'home' },
  { file: 'people.html', page: 'people', bodyClass: 'team-page', active: 'people' },
  { file: 'research.html', page: 'research', bodyClass: 'services-page', active: 'research' },
  { file: 'publications.html', page: 'publications', bodyClass: 'portfolio-page', active: 'publications' },
  { file: 'news.html', page: 'news', bodyClass: 'blog-page', active: 'news' },
  { file: 'join.html', page: 'join', bodyClass: 'contact-page', active: 'join' },
];

const PAGE_IMAGES = {
  landing: 'files/images/background/landing.png',
  research: 'files/images/background/research.webp',
  publications: 'files/images/background/publications.jpg',
  people: 'files/images/background/people.jpg',
  news: 'files/images/background/news.jpg',
  join: 'files/images/background/join.jpg',
};

const ICON_COLORS = ['#002147', '#2b6d9e', '#356b91', '#5289a8', '#72a3bd', '#94bad0'];
function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll('`', '&#96;');
}

function escapeXml(value) {
  return escapeHtml(value).replaceAll('&#39;', '&apos;');
}

function readYAML(relativePath, fallback) {
  const filePath = path.join(DATA, relativePath);
  if (!fs.existsSync(filePath)) return fallback;

  try {
    return yaml.load(fs.readFileSync(filePath, 'utf8')) ?? fallback;
  } catch (error) {
    console.warn(`YAML parse error in ${relativePath}: ${error.message}`);
    return fallback;
  }
}

function contentTitle(content, page) {
  return content?.navigation?.find(item => item.key === page)?.label || '';
}

function contentHref(content, key) {
  return content?.navigation?.find(item => item.key === key)?.href || '';
}

function renderNavigation(navigation, activeKey) {
  return (Array.isArray(navigation) ? navigation : [])
    .filter(item => item && item.href && item.label)
    .map(item => {
      const isActive = item.key === activeKey;
      return `<li><a href="${escapeAttr(item.href)}" class="${isActive ? 'active' : ''}"${isActive ? ' aria-current="page"' : ''}>${escapeHtml(item.label)}</a></li>`;
    })
    .join('');
}

function toDateString(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

function toISODate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

function normalizeText(value) {
  let text = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();

  while (text.startsWith('{') && text.endsWith('}')) {
    text = text.slice(1, -1).trim();
  }

  const directMap = {
    "\\'{a}": 'á', "\\'{A}": 'Á', '\\"{a}': 'ä', '\\"{A}': 'Ä',
    "\\'{e}": 'é', "\\'{E}": 'É', '\\"{e}': 'ë', '\\"{E}': 'Ë',
    "\\'{i}": 'í', "\\'{I}": 'Í', '\\"{i}': 'ï', '\\"{I}': 'Ï',
    "\\'{o}": 'ó', "\\'{O}": 'Ó', '\\"{o}': 'ö', '\\"{O}': 'Ö',
    "\\'{u}": 'ú', "\\'{U}": 'Ú', '\\"{u}': 'ü', '\\"{U}': 'Ü',
    "\\'{y}": 'ý', '\\"{y}': 'ÿ', "\\'{Y}": 'Ý', '\\"{Y}': 'Ÿ',
    '\\~{n}': 'ñ', '\\~{N}': 'Ñ',
  };

  Object.entries(directMap).forEach(([needle, replacement]) => {
    text = text.split(needle).join(replacement);
  });

  const replacements = [
    [/\\textendash/g, '–'],
    [/\\textemdash/g, '—'],
    [/\\\\/g, '\\'],
    [/\\&/g, '&'],
    [/\\%/g, '%'],
    [/\\_/g, '_'],
    [/\\#/g, '#'],
    [/\\(["'`^~=.])\{?([A-Za-z])\}?/g, '$2'],
    [/\\aa\b/g, 'å'],
    [/\\AA\b/g, 'Å'],
    [/\\ae\b/g, 'æ'],
    [/\\AE\b/g, 'Æ'],
    [/\\oe\b/g, 'œ'],
    [/\\OE\b/g, 'Œ'],
    [/\\o\b/g, 'ø'],
    [/\\O\b/g, 'Ø'],
    [/\\ss\b/g, 'ß'],
    [/\{\\([A-Za-z]+)\}/g, '$1'],
    [/\\(emph|textit|textbf)\{([^{}]+)\}/gi, '$2'],
    [/\{([^{}]+)\}/g, '$1'],
  ];

  replacements.forEach(([pattern, replacement]) => {
    text = text.replace(pattern, replacement);
  });

  return text.replace(/\\url\{([^}]+)\}/gi, '$1').replace(/\\(emph|textit)\{([^}]+)\}/gi, '$2').trim();
}

function normalizeAbstractText(value) {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\\(emph|textit|textbf)\{([^{}]*)\}/gi, '$2')
    .trim();
}

const TITLE_CASE_SMALL_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'if',
  'in', 'nor', 'of', 'on', 'or', 'per', 'the', 'to', 'via',
]);

function titleCaseWordPart(part, forceCapital) {
  const letters = part.match(/[A-Za-zÀ-ÖØ-öø-ÿ]/g) || [];
  if (!letters.length) return part;

  const letterText = letters.join('');
  const isAllCaps = letterText.length > 1 && letterText === letterText.toUpperCase();
  const isMixedCase = /[A-Z]/.test(letterText.slice(1)) && /[a-z]/.test(letterText);
  if (isAllCaps || isMixedCase) return part;

  const lower = part.toLocaleLowerCase();
  if (!forceCapital) return lower;
  return lower.replace(/[A-Za-zÀ-ÖØ-öø-ÿ]/, character => character.toLocaleUpperCase());
}

function titleCasePublicationTitle(value) {
  const mathFragments = [];
  const protectedText = String(value ?? '').replace(/(\$\$[\s\S]*?\$\$|\$[^$\n]+\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\])/g, fragment => {
    const index = mathFragments.push(fragment) - 1;
    return `@@MATH${index}@@`;
  });
  const tokens = protectedText.split(/(\s+)/);
  const wordIndexes = tokens
    .map((token, index) => (/\S/.test(token) ? index : -1))
    .filter(index => index >= 0);
  const firstWordIndex = wordIndexes[0];
  const lastWordIndex = wordIndexes[wordIndexes.length - 1];

  const title = tokens.map((token, index) => {
    if (!/\S/.test(token) || token.includes('@@MATH')) return token;

    const afterBoundary = index > 0 && /[:.!?]$/.test(tokens[index - 1]);
    const parts = token.split(/(-)/);
    const wordParts = parts.filter(part => part !== '-');
    let wordPartIndex = 0;
    return parts.map(part => {
      if (part === '-') return part;

      const lexical = part.replace(/^[^A-Za-zÀ-ÖØ-öø-ÿ]+|[^A-Za-zÀ-ÖØ-öø-ÿ]+$/g, '').toLocaleLowerCase();
      const forceCapital = index === firstWordIndex
        || index === lastWordIndex
        || afterBoundary
        || !TITLE_CASE_SMALL_WORDS.has(lexical)
        || (wordPartIndex === 0 && index === firstWordIndex)
        || (wordPartIndex === wordParts.length - 1 && index === lastWordIndex);
      wordPartIndex += 1;
      return titleCaseWordPart(part, forceCapital);
    }).join('');
  }).join('');

  return title.replace(/@@MATH(\d+)@@/g, (_, index) => mathFragments[Number(index)] || '').trim();
}

function renderInline(value) {
  return escapeHtml(value)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

function renderMarkdown(value) {
  const source = String(value ?? '');
  const linkPattern = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let html = '';
  let lastIndex = 0;

  for (const match of source.matchAll(linkPattern)) {
    const [fullMatch, label, url] = match;
    html += renderInline(source.slice(lastIndex, match.index));
    html += `<a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">${renderInline(label)}</a>`;
    lastIndex = match.index + fullMatch.length;
  }

  return html + renderInline(source.slice(lastIndex));
}

function monthToNumber(month) {
  const months = {
    jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
    apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
    aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10,
    october: 10, nov: 11, november: 11, dec: 12, december: 12,
  };
  return months[String(month ?? '').trim().toLowerCase()] || 0;
}

function publicationSortKey(tags) {
  return (Number.parseInt(tags.year, 10) || 0) * 100 + monthToNumber(tags.month);
}

function normalizeTags(tags) {
  return Object.fromEntries(Object.entries(tags || {}).map(([key, value]) => [key.toLowerCase(), String(value)]));
}

function extractRawBibEntry(raw, citationKey) {
  const pattern = new RegExp(`@\\w+\\s*\\{\\s*${citationKey}\\s*,`, 'i');
  const match = raw.match(pattern);
  if (!match) return '';

  const openBrace = raw.indexOf('{', match.index);
  let depth = 0;
  for (let index = openBrace; index < raw.length; index += 1) {
    if (raw[index] === '{') depth += 1;
    if (raw[index] === '}') {
      depth -= 1;
      if (depth === 0) return raw.slice(match.index, index + 1).trim();
    }
  }
  return '';
}

function loadPublications() {
  const filePath = path.join(DATA, 'ref.bib');
  if (!fs.existsSync(filePath)) return [];

  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = bibtexParse.toJSON(raw) || [];

  return parsed.map((entry, originalIndex) => {
    const citationKey = String(entry.citationKey || '').trim().toLowerCase();
    return {
      citationKey,
      entryType: String(entry.entryType || 'misc').toUpperCase(),
      tags: normalizeTags(entry.entryTags),
      rawBibtex: extractRawBibEntry(raw, citationKey),
      originalIndex,
    };
  }).sort((left, right) => publicationSortKey(right.tags) - publicationSortKey(left.tags) || left.originalIndex - right.originalIndex);
}

function splitAuthors(value) {
  return String(value || '').split(/\s+and\s+(?![^{}]*\})/i).map(author => author.trim()).filter(Boolean);
}

function formatAuthor(value) {
  const parts = String(value).split(/\s*,\s*/);
  if (parts.length === 1) return normalizeText(parts[0]);
  return normalizeText(`${parts[1]} ${parts[0]}`.trim());
}

function peopleData() {
  return {
    pi: readYAML('pi.yml', {}),
    main: readYAML('main_members.yml', {}),
    other: readYAML('other_members.yml', {}),
    altNames: readYAML('alt_names.yml', []),
  };
}

function memberNames(people) {
  const names = [];
  if (people.pi?.name) names.push(people.pi.name);
  Object.values(people.main || {}).forEach(members => (members || []).forEach(member => names.push(member.name)));
  Object.values(people.other || {}).forEach(members => (members || []).forEach(member => names.push(member.name)));
  if (Array.isArray(people.altNames)) names.push(...people.altNames);
  return new Set(names.filter(Boolean).map(name => normalizeText(name).toLowerCase()));
}

function renderAuthors(value, people) {
  const known = memberNames(people);
  return splitAuthors(value).map((author, index, authors) => {
    const formatted = formatAuthor(author);
    const output = known.has(formatted.toLowerCase()) ? `<strong>${escapeHtml(formatted)}</strong>` : escapeHtml(formatted);
    if (index === 0) return output;
    if (index === authors.length - 1) return authors.length === 2 ? ` and ${output}` : `, and ${output}`;
    return `, ${output}`;
  }).join('');
}

const FONT_AWESOME_BRANDS = new Set([
  'fa-github',
  'fa-google',
  'fa-linkedin',
  'fa-linkedin-in',
  'fa-orcid',
  'fa-researchgate',
]);

function normalizeFontAwesomeIcon(value, fallback = 'fa-solid fa-globe') {
  const classes = String(value || '')
    .trim()
    .split(/\s+/)
    .filter(className => /^fa-[a-z0-9-]+$/i.test(className));
  if (!classes.length) return fallback;

  const hasStyle = classes.some(className => /^fa-(solid|regular|light|thin|duotone|brands|sharp|classic|v4)$/i.test(className));
  if (!hasStyle) {
    const iconName = classes.find(className => className !== 'fa') || '';
    classes.unshift(FONT_AWESOME_BRANDS.has(iconName) ? 'fa-brands' : 'fa-solid');
  }
  return classes.join(' ');
}

function iconForLink(href) {
  const value = String(href || '').toLowerCase();
  if (value.startsWith('mailto:')) return 'fa-solid fa-envelope';
  if (value.includes('google.com/citations')) return 'fa-solid fa-graduation-cap';
  if (value.includes('linkedin')) return 'fa-brands fa-linkedin-in';
  if (value.includes('github')) return 'fa-brands fa-github';
  if (value.includes('orcid')) return 'fa-brands fa-orcid';
  if (value.includes('researchgate')) return 'fa-brands fa-researchgate';
  return 'fa-solid fa-globe';
}

function renderSocialLinks(links = []) {
  return (links || []).filter(link => link?.href).map(link => {
    const href = escapeAttr(link.href);
    const target = String(link.href).startsWith('mailto:') ? '' : ' target="_blank" rel="noopener noreferrer"';
    const icon = normalizeFontAwesomeIcon(link.icon, iconForLink(link.href));
    const label = link.label || link.title || link.href;
    return `<a href="${href}"${target} aria-label="${escapeAttr(label)}" title="${escapeAttr(label)}"><i class="${escapeAttr(icon)}" aria-hidden="true"></i></a>`;
  }).join('');
}

function personImage(person, index = 0) {
  return person.image || 'files/images/people/blank.webp';
}

function renderTeamCards(members, startIndex = 0) {
  return (members || []).map((member, offset) => {
    const index = startIndex + offset;
    return `
      <div class="col-lg-3 col-md-6 d-flex align-items-stretch" data-aos="fade-up" data-aos-delay="${100 + (offset % 4) * 100}">
        <div class="team-member">
          <div class="member-img">
            <img src="${escapeAttr(personImage(member, index))}" class="img-fluid" alt="Portrait of ${escapeAttr(member.name)}" loading="lazy">
            <div class="social">${renderSocialLinks(member.links)}</div>
          </div>
          <div class="member-info">
            <h4>${escapeHtml(member.name || '')}</h4>
            <span>${escapeHtml(member.role || '')}</span>
          </div>
        </div>
      </div>`;
  }).join('');
}

function allMainMembers(people) {
  return Object.values(people.main || {}).flatMap(members => members || []);
}

function renderTextPeopleList(members) {
  return (members || []).map(member => `
    <div class="person-list-row d-flex flex-column flex-md-row align-items-md-center justify-content-between gap-2">
      <div>
        <h4>${escapeHtml(member.name || '')}</h4>
        <p>${escapeHtml(member.role || '')}</p>
      </div>
      <div class="person-links">${renderSocialLinks(member.links)}</div>
    </div>`).join('');
}

function linkLabel(link) {
  const href = String(link?.href || '').toLowerCase();
  const icon = String(link?.icon || '').toLowerCase();
  if (icon.includes('orcid') || href.includes('orcid')) return 'ORCID profile';
  if (href.includes('maths.ox.ac.uk')) return 'Oxford profile';
  if (href.includes('appliedqc.org')) return 'AppliedQC';
  if (href.includes('arturekert.org')) return 'Personal website';
  return 'External profile';
}

function renderPiLinks(links = []) {
  return (links || []).filter(link => link?.href).map(link => {
    const href = escapeAttr(link.href);
    const target = String(link.href).startsWith('mailto:') ? '' : ' target="_blank" rel="noopener noreferrer"';
    const icon = normalizeFontAwesomeIcon(link.icon, iconForLink(link.href));
    const label = linkLabel(link);
    return `<a class="pi-link" href="${href}"${target} aria-label="${escapeAttr(label)}"><i class="${escapeAttr(icon)}" aria-hidden="true"></i><span>${escapeHtml(label)}</span></a>`;
  }).join('');
}

function paragraphList(value) {
  if (Array.isArray(value)) return value.map(item => String(item || '').trim()).filter(Boolean);
  return String(value || '').split(/\r?\n\s*\r?\n/).map(item => item.trim()).filter(Boolean);
}

function renderPrincipalInvestigatorAbout($, pi, site) {
  const about = $('#about');
  if (!about.length) return;
  if (!pi?.name) {
    about.remove();
    return;
  }

  about.find('img')
    .attr('src', personImage(pi))
    .attr('alt', `Portrait of ${pi.name}`);
  about.find('.pi-name').text(pi.name);
  about.find('.pi-role').text(pi.role || '');
  const bio = paragraphList(pi.introduction || pi.bio || site.description || '');
  about.find('.pi-introduction').html(bio.map(paragraph => `<p>${renderMarkdown(paragraph)}</p>`).join(''));
  about.find('.pi-links').html(renderPiLinks(pi.links));
}

function renderResearchSlides(research) {
  return (research || []).slice(0, 4).map(item => `
    <div class="swiper-slide">
      <div class="item">
        <h3 class="mb-3">${escapeHtml(item.title || '')}</h3>
        <h4 class="mb-3">${escapeHtml(item.summary || '')}</h4>
        <p>${escapeHtml(item.detail || '')}</p>
      </div>
    </div>`).join('');
}

function renderServiceItems(research, content) {
  const readMore = content?.research?.read_more || '';
  const researchHref = contentHref(content, 'research');
  return (research || []).map((item, index) => `
    <div class="col-lg-4 col-md-6 service-item d-flex" data-aos="fade-up" data-aos-delay="${100 + index * 100}">
      <div class="icon flex-shrink-0"><i class="${escapeAttr(normalizeFontAwesomeIcon(item.icon, 'fa-solid fa-star'))}" style="color: ${ICON_COLORS[index % ICON_COLORS.length]};"></i></div>
      <div>
        <h4 class="title">${escapeHtml(item.title || '')}</h4>
        <p class="description">${escapeHtml(item.summary || item.detail || '')}</p>
        <a href="${escapeAttr(researchHref)}#${escapeAttr(item.id || '')}" class="readmore stretched-link"><span>${escapeHtml(readMore)}</span><i class="fa-solid fa-arrow-right"></i></a>
      </div>
    </div>`).join('');
}

function newsCategory(category, content) {
  const labels = content?.news?.category_labels || {};
  return labels[String(category || '').toLowerCase()] || content?.news?.default_category || '';
}

function sortedNews(news) {
  return (Array.isArray(news) ? news : []).map(item => ({ ...item, dateValue: new Date(item.date) })).sort((left, right) => right.dateValue - left.dateValue);
}

function publicationType(entryType, content) {
  const labels = content?.publications?.type_labels || {};
  return labels[entryType] || labels.DEFAULT || '';
}

function publicationUrl(entry) {
  if (entry.tags.eprint) return `https://arxiv.org/abs/${entry.tags.eprint}`;
  if (entry.tags.url) return entry.tags.url;
  if (entry.tags.doi) return `https://doi.org/${entry.tags.doi}`;
  return '';
}

function auxiliaryPublication(auxData, citationKey) {
  return auxData?.[String(citationKey || '').toLowerCase()] || {};
}

function publicationActionLabel(key) {
  const labels = {
    abs: 'Abstract',
    bibtex: 'BibTeX',
    arxiv: 'arXiv',
    code: 'Code',
    demo: 'Demo',
    poster: 'Poster',
    showcase: 'Showcase',
    slides: 'Slides',
    video: 'Video',
  };
  const normalized = String(key || '').toLowerCase();
  if (labels[normalized]) return labels[normalized];
  return String(key || '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, character => character.toUpperCase());
}

function publicationActionIcon(key, href = '') {
  const normalized = String(key || '').toLowerCase();
  if (normalized === 'abs') return 'fa-solid fa-align-left';
  if (normalized === 'bibtex') return 'fa-solid fa-book';
  if (normalized === 'code') return 'fa-solid fa-code';
  if (normalized === 'demo') return 'fa-solid fa-laptop-code';
  if (normalized === 'poster') return 'fa-solid fa-image';
  if (normalized === 'showcase') return 'fa-solid fa-display';
  if (normalized === 'slides') return 'fa-solid fa-person-chalkboard';
  if (normalized === 'video') return 'fa-solid fa-video';
  if (normalized === 'arxiv') return 'fa-solid fa-file-pdf';
  if (String(href).toLowerCase().startsWith('mailto:')) return 'fa-solid fa-envelope';
  return 'fa-solid fa-arrow-up-right-from-square';
}

function publicationActionButton({ action, key, label, icon, target, controls, lightbox = false }) {
  const className = lightbox ? 'publication-action glightbox' : 'publication-action';
  const attributes = [
    `class="${className}"`,
    `data-publication-action="${escapeAttr(action)}"`,
    key ? `data-publication-key="${escapeAttr(key)}"` : '',
    controls ? `aria-controls="${escapeAttr(controls)}"` : '',
    action === 'abstract' ? 'aria-expanded="false"' : '',
    lightbox ? 'data-glightbox="type: inline"' : '',
  ].filter(Boolean).join(' ');
  const linkAttributes = target
    ? ` href="${escapeAttr(target)}"${lightbox ? '' : ' target="_blank" rel="noopener noreferrer"'}`
    : '';
  const element = target ? 'a' : 'button';
  const typeAttribute = element === 'button' ? ' type="button"' : '';
  return `<${element} ${attributes}${typeAttribute}${linkAttributes}><i class="${escapeAttr(icon)}" aria-hidden="true"></i><span>${escapeHtml(label)}</span></${element}>`;
}

function renderPublicationInfo(entry, content) {
  const tags = entry.tags;
  const parts = [];

  if (tags.journal) parts.push(escapeHtml(normalizeText(tags.journal)));

  if (tags.booktitle) {
    parts.push(`In ${escapeHtml(normalizeText(tags.booktitle))}`);
  }

  if (tags.volume) {
    const volume = `<strong>${escapeHtml(normalizeText(tags.volume))}${tags.pages ? ',' : ''}</strong>`;
    parts.push(volume);
  }

  if (tags.pages) parts.push(escapeHtml(normalizeText(tags.pages)));

  if (tags.archiveprefix) {
    const archiveParts = [escapeHtml(normalizeText(tags.archiveprefix)) + ':'];
    if (tags.eprint) archiveParts.push(escapeHtml(normalizeText(tags.eprint)));
    if (tags.primaryclass) archiveParts.push(`[${escapeHtml(normalizeText(tags.primaryclass))}]`);
    parts.push(archiveParts.join(' '));
  }

  // if (tags.year) parts.push(`(${escapeHtml(normalizeText(tags.year))}).`);
  if (tags.note) parts.push(renderMarkdown(normalizeText(tags.note)));

  if (!parts.length) return escapeHtml(publicationType(entry.entryType, content));
  return parts.join(' ');
}

function publicationAnchor(entry, index = 0) {
  const key = String(entry.citationKey || `publication-${index}`).replace(/[^a-z0-9_-]+/gi, '-');
  return `pub-${key || index}`;
}

function renderPublicationRow(entry, people, content, auxData, index = 0, isotope = false) {
  const filter = ['ARTICLE', 'INPROCEEDINGS'].includes(entry.entryType) ? 'publication' : 'preprint';
  const title = titleCasePublicationTitle(normalizeText(entry.tags.title || content?.publications?.missing_title || ''));
  const url = publicationUrl(entry);
  const auxEntry = auxiliaryPublication(auxData, entry.citationKey);
  const anchor = publicationAnchor(entry, index);
  const abstractId = `${anchor}-abstract`;
  const bibtexId = `${anchor}-bibtex`;
  const year = normalizeText(entry.tags.year || '');
  const authors = renderAuthors(entry.tags.author || '', people);
  const meta = renderPublicationInfo(entry, content);
  const wrapperClass = isotope ? `col-12 portfolio-item isotope-item filter-${filter}` : 'publication-list-item';
  const labels = content?.publications?.action_labels || {};
  const missingAuthors = content?.publications?.missing_authors || '';
  const actionButtons = [];

  if (auxEntry.abs) {
    actionButtons.push(publicationActionButton({
      action: 'abstract',
      key: anchor,
      label: labels.abstract || publicationActionLabel('abs'),
      icon: publicationActionIcon('abs'),
      controls: abstractId,
    }));
  }

  if (entry.rawBibtex) {
    actionButtons.push(publicationActionButton({
      action: 'bibtex',
      key: entry.citationKey,
      label: labels.bibtex || publicationActionLabel('bibtex'),
      icon: publicationActionIcon('bibtex'),
      target: `#${bibtexId}`,
      lightbox: true,
    }));
  }

  if (url) {
    const linkLabel = entry.tags.eprint ? publicationActionLabel('arxiv') : labels.link || 'Paper';
    actionButtons.push(publicationActionButton({
      action: 'link',
      label: linkLabel,
      icon: publicationActionIcon(entry.tags.eprint ? 'arxiv' : 'link', url),
      target: url,
    }));
  }

  Object.entries(auxEntry).forEach(([key, value]) => {
    if (!value || ['abs', 'note'].includes(String(key).toLowerCase())) return;
    actionButtons.push(publicationActionButton({
      action: 'link',
      label: publicationActionLabel(key),
      icon: publicationActionIcon(key, value),
      target: value,
    }));
  });

  const abstract = auxEntry.abs
    ? `<div id="${escapeAttr(abstractId)}" class="publication-abstract" aria-hidden="true"><p>${renderMarkdown(normalizeAbstractText(auxEntry.abs))}</p></div>`
    : '';
  const note = auxEntry.note ? `<p class="publication-note">${renderMarkdown(normalizeText(auxEntry.note))}</p>` : '';
  const bibtex = entry.rawBibtex ? `
    <div id="${escapeAttr(bibtexId)}" class="publication-bibtex-content" style="display: none;">
      <section class="publication-modal-dialog" role="dialog" aria-labelledby="${escapeAttr(bibtexId)}-title">
        <h2 id="${escapeAttr(bibtexId)}-title" class="publication-modal-title">BibTeX — ${escapeHtml(title)}</h2>
        <pre class="publication-modal-text">${escapeHtml(entry.rawBibtex)}</pre>
        <p class="publication-modal-status" aria-live="polite"></p>
        <div class="publication-modal-actions">
          <button type="button" class="publication-modal-action" data-publication-copy data-publication-key="${escapeAttr(entry.citationKey)}">
            <i class="fa-solid fa-copy" aria-hidden="true"></i><span>Copy BibTeX</span>
          </button>
          <button type="button" class="publication-modal-action" data-publication-download data-publication-key="${escapeAttr(entry.citationKey)}">
            <i class="fa-solid fa-download" aria-hidden="true"></i><span>Download BibTeX</span>
          </button>
        </div>
      </section>
    </div>` : '';

  return `
    <div id="${escapeAttr(anchor)}" class="${wrapperClass}">
      <article class="publication-row d-flex flex-column flex-md-row align-items-start gap-3">
        <div class="publication-year flex-shrink-0">${escapeHtml(year)}</div>
        <div class="publication-body flex-grow-1">
          <h3 class="publication-title">${url ? `<a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(title)}</a>` : escapeHtml(title)}</h3>
          <p class="publication-authors">${authors || escapeHtml(missingAuthors)}</p>
          <p class="publication-meta">${meta}</p>
          ${note}
          ${actionButtons.length ? `<div class="publication-actions">${actionButtons.join('')}</div>` : ''}
          ${abstract}
          ${bibtex}
        </div>
      </article>
    </div>`;
}

function renderPortfolioItems(publications, people, content, auxData) {
  return (publications || []).map((entry, index) => renderPublicationRow(entry, people, content, auxData, index, true)).join('');
}

function renderPublicationPreview(publications, people, content, auxData) {
  return (publications || []).slice(0, 5).map((entry, index) => renderPublicationRow(entry, people, content, auxData, index)).join('');
}

function renderBlogPosts(news, content) {
  const newsHref = contentHref(content, 'news');
  return sortedNews(news).map((item, index) => `
    <div class="col-12">
      <article id="news-${index}" class="news-row d-flex flex-column flex-md-row align-items-start gap-3">
        <time class="news-date flex-shrink-0" datetime="${escapeAttr(toISODate(item.date))}">${escapeHtml(toDateString(item.date))}</time>
        <div class="news-content">
          <p class="post-category">${escapeHtml(newsCategory(item.category, content))}</p>
          <h2 class="title"><a href="${escapeAttr(newsHref)}#news-${index}">${renderMarkdown(item.headline || '')}</a></h2>
          ${item.description ? `<p class="news-summary">${renderMarkdown(item.description)}</p>` : ''}
        </div>
      </article>
    </div>`).join('');
}

function setPageTitle($, title, background) {
  const pageTitle = $('.page-title');
  if (!pageTitle.length) return;
  pageTitle.find('h1').text(title);
  pageTitle.find('.breadcrumbs .current').text(title);
  if (background) pageTitle.attr('style', `background-image: url(${background});`);
}

function renderSiteChrome($, page, site, content) {
  const title = site.title || '';
  const description = site.description || site.tagline || '';
  const shortTitle = site.short_title || title;
  const pageTitle = contentTitle(content, page.page);
  const homeHref = contentHref(content, 'home');
  const navigation = content.navigation || [];

  $('title').text(`${pageTitle} - ${title}`);
  $('meta[name="description"]').attr('content', `${pageTitle} — ${description}`);
  $('meta[name="keywords"]').attr('content', content.meta?.keywords || '');
  $('body').attr('class', page.bodyClass).attr('data-page', page.page);

  $('.header .sitename').text(shortTitle);
  $('a.logo').attr('href', homeHref).attr('aria-label', `${title} home`);

  $('#navmenu > ul').html(renderNavigation(navigation, page.active));
  $('.footer').html(`
    <div class="container copyright text-center">
      <p>© <span>${new Date().getFullYear()}</span> <strong class="px-1 sitename">${escapeHtml(title)}</strong> <span>All Rights Reserved</span></p>
    </div>`);
  $('.credits').remove();
}

function renderIndex($, context) {
  const { site, research, people, publications, content, aux } = context;
  const copy = content.home || {};
  const hero = copy.hero || {};
  const researchCopy = content.research || {};
  const publicationCopy = copy.publications || {};
  const peopleHref = contentHref(content, 'people');
  const publicationsHref = contentHref(content, 'publications');
  const researchHref = contentHref(content, 'research')
  const fallbackPeopleHref = $('#hero .btn-watch-video').attr('href') || 'people.html';
  $('#hero img').attr('src', PAGE_IMAGES.landing || '').attr('alt', hero.image_alt || '');
  $('#hero h1').html(`${escapeHtml(hero.title_line || '')}`);
  $('#hero blockquote p').text(`${site.tagline || ''} ${hero.description || ''}`.trim());
  $('#hero .btn-get-started').attr('href', publicationsHref).html(`<i class="fa-solid fa-atom"></i><span>${escapeHtml(hero.primary_label || '')}</span>`);
  $('#hero .btn-watch-video').attr('href', peopleHref || fallbackPeopleHref).html(`<i class="fa-solid fa-users"></i><span>${escapeHtml(hero.secondary_label || '')}</span>`);

  $('#why-us .img-bg img').attr('src', PAGE_IMAGES.research || '').attr('alt', researchCopy.image_alt || '');
  $('#why-us .swiper-wrapper').html(renderResearchSlides(research));

  if ($('#publications-preview').length) {
    $('#publications-preview .section-title h2').text(publicationCopy.title || '');
    $('#publications-preview .section-title p').text(publicationCopy.description || '');
    $('#publications-preview .publication-list').html(renderPublicationPreview(publications, people, content, aux));
    $('#publications-preview .btn-get-started').attr('href', publicationsHref).text(publicationCopy.link_label || '');
  }
}

function renderResearchPage($, context) {
  const { research, content } = context;
  const copy = content.research || {};
  setPageTitle($, contentTitle(content, 'research'), PAGE_IMAGES.research);
  $('#services .section-title h2').text(copy.title || '');
  $('#services .section-title p').text(copy.description || '');
  $('#services .container').last().find('.row').html(renderServiceItems(research, content));
  const cards = (research || []).map((item, index) => `
    <div class="col-lg-6" data-aos="fade-up" data-aos-delay="${100 + index * 100}">
      <div class="card-item"><div class="row"><div class="col-xl-5"><div class="card-bg"><img src="files/images/background/research.webp" alt=""></div></div><div class="col-xl-7 d-flex align-items-center"><div class="card-body"><h4 class="card-title">${escapeHtml(item.title)}</h4><p>${escapeHtml(item.detail || item.summary || '')}</p></div></div></div></div>
    </div>`).join('');
  $('#service-cards .container-fluid .row').html(cards);
}

function renderPublicationsPage($, context) {
  const { publications, people, content, aux } = context;
  const filters = content.publications?.filters || [];
  setPageTitle($, contentTitle(content, 'publications'), PAGE_IMAGES.publications);
  $('#portfolio .portfolio-filters').html(filters.map((item, index) => `<li data-filter="${escapeAttr(item.filter || '')}" class="${index === 0 ? 'filter-active' : ''}">${escapeHtml(item.label || '')}</li>`).join(''));
  $('#portfolio .isotope-layout').attr('data-default-filter', '*');
  $('#portfolio .isotope-container').html(renderPortfolioItems(publications, people, content, aux));
}

function renderTeamPage($, context) {
  const { people, site, content } = context;
  const copy = content.people || {};
  setPageTitle($, contentTitle(content, 'people'), PAGE_IMAGES.people);
  renderPrincipalInvestigatorAbout($, people.pi, site);
  const groups = Object.entries(people.main || {});
  const alumni = Object.values(people.other || {}).flatMap(members => members || []);
  const html = `<div class="section-title" data-aos="fade-up"><h2>${escapeHtml(copy.section_title || '')}</h2></div>`
    + groups.filter(([, members]) => members.length).map(([label, members]) => `<div class="mb-5"><h3 class="mb-4">${escapeHtml(label)}</h3><div class="row gy-4">${renderTeamCards(members)}</div></div>`).join('')
    + (alumni.length ? `<div><h3 class="mb-4">${escapeHtml(copy.alumni_label || '')}</h3><div class="people-list">${renderTextPeopleList(alumni)}</div></div>` : '');
  $('#team > .container').html(html);
}

function renderNewsPage($, context) {
  const { news, content } = context;
  setPageTitle($, contentTitle(content, 'news'), PAGE_IMAGES.news);
  $('#blog-posts').closest('.col-lg-8').removeClass('col-lg-8').addClass('col-lg-12');
  $('.sidebar').remove();
  $('#blog-posts .container').last().find('.row').html(renderBlogPosts(news, content));
  $('#blog-pagination').remove();
}

function renderJoinPage($, context) {
  const { site, content } = context;
  const copy = content.join || {};
  setPageTitle($, contentTitle(content, 'join'), PAGE_IMAGES.join);
  const intro = copy.intro_fallback || site.description || '';
  const introBlock = $('#contact .col-lg-5').first().find('.mb-5').first();
  if (introBlock.length) {
    introBlock.find('h2').text(copy.intro_title || '');
    introBlock.find('p').html(renderMarkdown(intro));
  } else {
    $('#contact .col-lg-5').prepend(`<div class="mb-5"><h2>${escapeHtml(copy.intro_title || '')}</h2><p>${renderMarkdown(intro)}</p></div>`);
  }
  const email = escapeAttr(site.email || '');
  const location = escapeHtml(site.location || '');
  $('#contact .info-item').eq(0).find('h3').text(copy.location_label || '').end().find('p').text(location);
  $('#contact .info-item').eq(1).find('i').attr('class', 'fa-solid fa-users flex-shrink-0').end().find('h3').text(copy.audience_label || '').end().find('p').text(copy.audience_text || '');
  $('#contact .info-item').eq(2).find('h3').text(copy.email_label || '').end().find('p').html(`<a href="mailto:${email}">${escapeHtml(site.email || '')}</a>`);
}

function renderMaintenancePage($, site, mode = 'coming-soon') {
  const title = site.title || 'Oxford Quantum Information Group';
  const shortTitle = site.short_title || title;
  const description = site.description || site.tagline || '';
  const isNotFound = mode === 'not-found';

  $('title').text(isNotFound ? `Page not found - ${title}` : `${title} - Coming soon`);
  $('meta[name="description"]').attr('content', isNotFound ? `Page not found - ${title}` : description);
  $('[data-site-name]').text(title);
  $('[data-site-short-title]').text(shortTitle);
  $('[data-site-title]').text(title);
  $('[data-site-tagline]').text(site.tagline || '');
  $('[data-site-description]').text(description);
  $('[data-current-year]').text(new Date().getFullYear());

  const contact = $('[data-maintenance-contact]');
  if (site.email) {
    contact.attr('href', `mailto:${site.email}`).removeAttr('hidden');
  } else {
    contact.remove();
  }
}

function applyTransforms($, page, context) {
  renderSiteChrome($, page, context.site, context.content);
  if (page.page === 'home') renderIndex($, context);
  if (page.page === 'research') renderResearchPage($, context);
  if (page.page === 'publications') renderPublicationsPage($, context);
  if (page.page === 'people') renderTeamPage($, context);
  if (page.page === 'news') renderNewsPage($, context);
  if (page.page === 'join') renderJoinPage($, context);

  $('a[target="_blank"]').attr('rel', 'noopener noreferrer');
}

function pageURL(file) {
  return new URL(file === 'index.html' ? '/' : `/${file}`, `${SITE_URL}/`).href;
}

async function writeSitemap(urls) {
  const entries = urls.sort().map(url => `  <url>\n    <loc>${escapeXml(url)}</loc>\n  </url>`).join('\n');
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`;
  await fs.writeFile(path.join(DIST, 'sitemap.xml'), sitemap, 'utf8');
}

async function renderStandalonePage(sourceFile, destinationFile, site, mode) {
  const sourceHTML = await fs.readFile(path.join(ROOT, sourceFile), 'utf8');
  const $ = cheerio.load(sourceHTML, { decodeEntities: false });
  renderMaintenancePage($, site, mode);
  await fs.writeFile(path.join(DIST, destinationFile), $.html(), 'utf8');
  console.log(`Rendered dist/${destinationFile} from ${sourceFile}`);
}

async function copyPublicFiles() {
  for (const directory of ['assets']) {
    const source = path.join(ROOT, directory);
    if (await fs.pathExists(source)) {
      await fs.copy(source, path.join(DIST, directory));
      console.log(`Copied ${directory}`);
    }
  }

  const filesSource = path.join(ROOT, 'files');
  const filesDestination = path.join(DIST, 'files');
  if (await fs.pathExists(filesSource)) {
    await fs.mkdirp(filesDestination);
    for (const entry of await fs.readdir(filesSource)) {
      if (entry === 'data') continue;
      await fs.copy(path.join(filesSource, entry), path.join(filesDestination, entry));
    }
    console.log('Copied public files excluding files/data');
  }
}

async function build() {
  const site = readYAML('site.yml', {});
  const content = readYAML('content.yml', {});
  const research = readYAML('research.yml', []);
  const people = peopleData();
  const news = readYAML('news.yml', []);
  const aux = readYAML('aux.yml', {});
  const publications = loadPublications();
  const context = { site, content, research, people, news, aux, publications };

  await fs.remove(DIST);
  await fs.mkdirp(DIST);

  if (COMING_SOON) {
    await renderStandalonePage('coming-soon.html', 'index.html', site, 'coming-soon');
    await renderStandalonePage('404.html', '404.html', site, 'not-found');
    await copyPublicFiles();
    await fs.writeFile(path.join(DIST, '.nojekyll'), '', 'utf8');
    await writeSitemap([pageURL('index.html')]);
    console.log('Coming-soon mode enabled; full site pages were not published');
    return;
  }

  const sitemapURLs = [];
  for (const page of PAGES) {
    const sourcePath = path.join(ROOT, page.file);
    const sourceHTML = await fs.readFile(sourcePath, 'utf8');
    const $ = cheerio.load(sourceHTML, { decodeEntities: false });
    applyTransforms($, page, context);
    const renderedPage = $.html();

    await fs.writeFile(path.join(DIST, page.file), renderedPage, 'utf8');
    sitemapURLs.push(pageURL(page.file));
    console.log(`Rendered dist/${page.file} from root HTML template`);
  }

  await renderStandalonePage('404.html', '404.html', site, 'not-found');
  await copyPublicFiles();

  await fs.writeFile(path.join(DIST, '.nojekyll'), '', 'utf8');
  await writeSitemap(sitemapURLs);
  console.log(`Generated ${sitemapURLs.length} URLs in sitemap.xml`);
}

build().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
