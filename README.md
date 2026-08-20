# Oxford Quantum Information Group website

This is a Nova-based static academic group website. The root HTML files are the visual backbone of the site; `build.js` reads those templates, injects content from YAML and BibTeX, and writes the finished website to `dist/`.

There is no runtime database or server-side application on the deployed site. The data processing happens at build time, and the generated HTML, CSS, JavaScript, images, and vendor files are the only things published.

## Quick start

Requirements: Node.js 20 or a compatible modern Node.js release, plus npm.

```bash
npm ci
npm run build
```

To preview the generated site locally:

```bash
python3 -m http.server 8000 --directory dist
```

Open <http://localhost:8000>. Preview `dist/`, not the root directory, because the root pages are templates and do not contain the generated records.

## Repository layout

| Path | Purpose |
| --- | --- |
| `index.html`, `people.html`, `research.html`, `publications.html`, `news.html`, `join.html` | Root-level Nova/HTML templates. These are the page backbones and are not modified by the build. |
| `coming-soon.html`, `404.html` | Standalone maintenance and error-page templates. |
| `build.js` | Build-time renderer. It loads data, fills page sections, renders navigation and footer content, copies public assets, and creates `sitemap.xml`. |
| `files/data/` | Source-only YAML and BibTeX records. This directory is intentionally excluded from `dist/`. |
| `files/images/` | Public background, people, and favicon images. |
| `assets/` | Nova CSS, custom CSS, JavaScript, and vendor libraries. |
| `dist/` | Generated deployment directory. It is deleted and recreated by every build and is ignored by Git. |
| `.github/workflows/build.yml` | Builds the site and publishes `dist/` to the `gh-pages` branch after pushes to `main`. |

## The build pipeline

`npm run build` performs the following operations:

1. Loads the files in `files/data/`.
2. Parses `ref.bib` and sorts publications by year and bibliography order.
3. Reads only the root HTML templates enabled in `content.yml` under `navigation`.
4. Renders the navigation, page titles, metadata, footer, people, research areas, news, publications, abstracts, and publication actions.
5. Copies `assets/` and all public files under `files/`, except `files/data/`.
6. Writes `.nojekyll` and a sitemap to `dist/`.

When the `COMING_SOON` environment variable is set to `true`, `1`, `yes`, or `on`, the build publishes only `coming-soon.html` as `dist/index.html` and the custom `404.html`, together with the public assets. The full site source remains in the repository but its data-driven pages are not published.

The build clears `dist/` first. Do not edit generated files in `dist/`; make changes in the root templates, data files, CSS, JavaScript, or `build.js`, then rebuild.

To test the maintenance build locally:

```bash
COMING_SOON=true npm run build
python3 -m http.server 8000 --directory dist
```

The sitemap uses `https://ox-quant-info.github.io` by default. For another deployment URL, run:

```bash
SITE_URL=https://example.org npm run build
```

## Editing site content

### Site-wide settings: `files/data/site.yml`

Use this file for values shared across pages:

```yaml
title: Oxford Quantum Information Group
short_title: OxQInfo
tagline: Building useful quantum theory for the problems that matter.
description: A short site description used in metadata and fallback copy.
location: Mathematical Institute, University of Oxford
```

The title appears in the header, page titles, metadata, and footer. The current year in the footer is generated automatically by `build.js`.

### Navigation and page copy: `files/data/content.yml`

The `navigation` list controls the header menu and supplies page titles. Each item needs a `key`, `href`, and `label`:

```yaml
navigation:
  - key: home
    href: index.html
    label: Home
  - key: people
    href: people.html
    label: People
```

To keep a page under construction, remove or comment out its navigation item. The root template can remain in the repository, but it will not be rendered into `dist/` or included in the sitemap. A page title is looked up by matching the navigation `key` to the page key in `build.js`; there is no separate `page_titles` dictionary.

The same file contains copy and labels for:

- `home`: hero text and the homepage publication preview;
- `research`: research-page headings and labels;
- `people`: member-section labels;
- `publications`: filters, fallback text, and action labels;
- `news`: category labels;
- `meta`: site keywords.

### Join page: `files/data/join.yml`

The Join us page keeps its opportunities and collaboration copy in `join.yml`:

```yaml
collaborators:
  title: Collaborate with us
  text:
    - Information about possible collaborations.
opportunities:
  title: Opportunities
  description: Opportunities for DPhil students and postdoctoral researchers are outlined below.
  sections:
    - id: students
      icon: fa-solid fa-graduation-cap
      title: Student positions
      text:
        - Information for prospective students.
    - id: postdocs
      icon: fa-solid fa-flask
      title: Postdoctoral positions
      text:
        - Information for prospective postdoctoral researchers.
```

The `opportunities.sections` list becomes the two responsive position cards. The `collaborators` block is rendered as a simple full-width text section beneath them. Both can be edited without changing the HTML template.

Keep data records out of the HTML. Change text in `content.yml` whenever that text is meant to be reusable or generated.

### Research areas: `files/data/research.yml`

Each research item uses:

```yaml
- id: algorithms
  icon: fa-solid fa-microchip
  title: Quantum algorithms
  summary: A short description for cards and the homepage.
  detail: A longer description for research content.
```

Icons use Font Awesome classes. The `id` is also used for research anchors.

### People: `files/data/pi.yml`, `main_members.yml`, and `other_members.yml`

The principal investigator record supports `name`, `image`, `role`, `bio` (or `introduction`), and `links`:

```yaml
name: Example Name
image: files/images/people/example.webp
role: Professor of Quantum Information
bio: |
  First paragraph.

  Second paragraph.
links:
  - icon: fa-brands fa-orcid
    href: https://orcid.org/0000-0000-0000-0000
```

Blank lines in `bio` become separate paragraphs. Each main-member group is a top-level YAML key whose value is a list of members:

```yaml
Postdoctoral Researchers:
  - name: Example Researcher
    role: Postdoctoral Research Associate (2026–)
    image: files/images/people/example.webp
    links:
      - icon: fa-solid fa-building-columns
        href: https://www.maths.ox.ac.uk/people/example
```

`image` and `links` are optional. If a current member has no image, the build uses `files/images/people/blank.webp`. Current members are displayed as image cards. Entries in `other_members.yml` are rendered as a compact text list, so past members do not receive a large portrait block.

Use Font Awesome icons in `links`. For example:

```yaml
icon: fa-brands fa-orcid
icon: fa-brands fa-github
icon: fa-solid fa-building-columns
icon: fa-solid fa-globe
```

Add `alt_name` to a member record when their publication author name differs from their displayed group-member name. It can contain one or more display-name forms:

```yaml
- name: Example Researcher
  alt_name:
    - Example J. Researcher
    - Researcher, Example J.
```

These names are used only for publication matching and author emphasis; they do not create additional people cards. Canonical and alternate names are clickable on `publications.html` and apply the same member filter.

### News: `files/data/news.yml`

News entries are sorted newest first using `date`:

```yaml
- headline: >
    "[Paper title](https://example.org/paper)" was released.
  category: arxiv
  date: 2026-08-12
  description: Optional supporting text.
```

`headline` and `description` support the small Markdown subset handled by `build.js`, including links. Add category names to `content.yml` under `news.category_labels` when a new category needs a custom label.

## Publications

### Bibliography: `files/data/ref.bib`

Add one valid BibTeX entry per paper. Keep citation keys unique. The renderer uses the citation key to connect the bibliography to `aux.yml`.

Commonly used fields are:

```bibtex
@article{example2026paper,
  title = {A publication title},
  author = {Surname, Given and Other, Author},
  year = 2026,
  journal = {Journal Name},
  volume = 10,
  pages = {123--135},
  doi = {10.1234/example},
  url = {https://example.org/paper}
}
```

The displayed title is normalized to title case while preserving words that are intentionally all-capitalized. Authors matching people in the people YAML, including their `alt_name` forms, are emphasized automatically. On `publications.html`, emphasized member names are clickable filters; clicking a name shows that member's papers, and clicking it again clears the member filter. The paper link is chosen in this order: arXiv `eprint`, `url`, then `doi`.

The publication page has one list with three filters:

- `@article` and `@inproceedings` entries are grouped under **Publications**;
- other non-thesis entry types, such as `@misc`, are grouped under **Preprints**;
- `@phdthesis`, `@mastersthesis`, `@bachelorthesis`, and `@thesis` entries are grouped under **Theses**.

The homepage displays a short five-entry publication preview; the complete list is on `publications.html`.

### Abstracts and extra links: `files/data/aux.yml`

The top-level key in `aux.yml` must match the BibTeX citation key. Keys are normalized to lowercase, so lowercase keys are recommended:

```yaml
example2026paper:
  abs: >-
    We show that \(A^2 = B\) under the stated assumptions.
  code: https://github.com/example/project
  poster: https://example.org/poster.pdf
  note: Accepted at Example Conference 2026.
```

Supported special fields are:

- `abs`: expandable abstract;
- `note`: text shown below the publication metadata; and
- `code`, `demo`, `poster`, `showcase`, `slides`, `video`, `arxiv`, or any other non-empty key: an external action button.

Abstracts support Markdown links and MathJax delimiters such as `\(...\)`, `$...$`, `\[...\]`, and `$$...$$`. MathJax is typeset when an abstract is opened. Every bibliography entry also gets a responsive BibTeX lightbox with copy and download actions.

If an abstract or extra link does not appear, first check that the `aux.yml` key exactly matches the BibTeX key after lowercasing, and that the YAML indentation is valid.

## Editing the HTML and styling

The root pages are the Nova-compatible page backbones:

| Page | Generated content |
| --- | --- |
| `index.html` | Hero, research preview, Oxford location section, and five-publication preview |
| `people.html` | Principal-investigator About block, current-member cards, and past-member list |
| `research.html` | Research-area cards |
| `publications.html` | Single year-sorted publication list with Publications/Preprints/Theses filters |
| `news.html` | Line-by-line news list |
| `join.html` | Student/postdoctoral opportunities and collaboration information |

Edit these files when the structure or Nova layout needs to change. Leave empty data slots in place for `build.js` to fill. A new page requires a root HTML template plus a corresponding entry in `PAGES` and renderer logic in `build.js`; it is emitted only when its matching navigation item is enabled.

Use `assets/css/main.css` for site-specific styling and `assets/js/main.js` for browser behavior. The site primarily uses Font Awesome rather than Bootstrap Icons. Use `fa-solid`, `fa-regular`, or `fa-brands` classes consistently.

The palette is anchored by Oxford blue (`#002147`) and uses coordinated medium, light, and pale variants for links, buttons, section surfaces, maintenance pages, and research icons. Update the Oxford-blue variables in `assets/css/main.css` if the group palette changes.

The landing-page location photograph is credited in `files/data/content.yml`. Keep the linked creator, source-file, and license attribution with the image if the photograph is reused or replaced.

Image paths in data and templates should point to public paths such as `files/images/background/research.webp` or `files/images/people/example.webp`. Do not use obsolete `assets/img/` paths.

## Validation checklist

After changing content or code, run:

```bash
npm run build
node --check build.js
node --check assets/js/main.js
```

Then confirm that:

```bash
test -f dist/index.html
test -f dist/publications.html
test -f dist/sitemap.xml
test ! -d dist/files/data
```

Check the generated pages in the local preview, especially navigation, mobile layout, publication filters, abstract expansion, MathJax, BibTeX lightboxes, links, and member images.

## Deployment

Pushing to `main` runs `.github/workflows/build.yml`. GitHub Actions installs dependencies with `npm ci`, builds the site, and publishes `dist/` to the `gh-pages` branch. GitHub Pages should be configured to serve that branch.

The workflow currently sets `COMING_SOON: 'true'`, so the public `ox-quant-info.github.io` URL shows the maintenance page and custom 404 page. The complete website remains available in `main` for continued editing.

When the site is ready to launch, change this line in `.github/workflows/build.yml` to:

```yaml
COMING_SOON: 'false'
```

Commit and push that change. The next workflow run will publish the data-rendered pages currently enabled in `files/data/content.yml` instead of the maintenance page.
