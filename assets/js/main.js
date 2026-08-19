(function() {
  "use strict";

  /**
   * Apply .scrolled class to the body as the page is scrolled down
   */
  function toggleScrolled() {
    const selectBody = document.querySelector('body');
    const selectHeader = document.querySelector('#header');
    if (!selectHeader.classList.contains('scroll-up-sticky') && !selectHeader.classList.contains('sticky-top') && !selectHeader.classList.contains('fixed-top')) return;
    window.scrollY > 100 ? selectBody.classList.add('scrolled') : selectBody.classList.remove('scrolled');
  }

  document.addEventListener('scroll', toggleScrolled);
  window.addEventListener('load', toggleScrolled);

  /**
   * Mobile nav toggle
   */
  const mobileNavToggleBtn = document.querySelector('.mobile-nav-toggle');

  function mobileNavToogle() {
    document.querySelector('body').classList.toggle('mobile-nav-active');
    mobileNavToggleBtn.classList.toggle('fa-bars');
    mobileNavToggleBtn.classList.toggle('fa-xmark');
  }
  mobileNavToggleBtn.addEventListener('click', mobileNavToogle);

  /**
   * Hide mobile nav on same-page/hash links
   */
  document.querySelectorAll('#navmenu a').forEach(navmenu => {
    navmenu.addEventListener('click', () => {
      if (document.querySelector('.mobile-nav-active')) {
        mobileNavToogle();
      }
    });

  });

  /**
   * Toggle mobile nav dropdowns
   */
  document.querySelectorAll('.navmenu .toggle-dropdown').forEach(navmenu => {
    navmenu.addEventListener('click', function(e) {
      e.preventDefault();
      this.parentNode.classList.toggle('active');
      this.parentNode.nextElementSibling.classList.toggle('dropdown-active');
      e.stopImmediatePropagation();
    });
  });

  /**
   * Preloader
   */
  const preloader = document.querySelector('#preloader');
  if (preloader) {
    window.addEventListener('load', () => {
      preloader.remove();
    });
  }

  /**
   * Scroll top button
   */
  let scrollTop = document.querySelector('.scroll-top');

  function toggleScrollTop() {
    if (scrollTop) {
      window.scrollY > 100 ? scrollTop.classList.add('active') : scrollTop.classList.remove('active');
    }
  }
  scrollTop.addEventListener('click', (e) => {
    e.preventDefault();
    window.scrollTo({
      top: 0,
      behavior: 'smooth'
    });
  });

  window.addEventListener('load', toggleScrollTop);
  document.addEventListener('scroll', toggleScrollTop);

  /**
   * Animation on scroll function and init
   */
  function aosInit() {
    AOS.init({
      duration: 600,
      easing: 'ease-in-out',
      once: true,
      mirror: false
    });
  }
  window.addEventListener('load', aosInit);

  /**
   * Initiate glightbox
   */
  const glightbox = GLightbox({
    selector: '.glightbox',
    openEffect: 'fade',
    closeEffect: 'fade'
  });

  /**
   * Init swiper sliders
   */
  function initSwiper() {
    document.querySelectorAll(".init-swiper").forEach(function(swiperElement) {
      let config = JSON.parse(
        swiperElement.querySelector(".swiper-config").innerHTML.trim()
      );

      if (swiperElement.classList.contains("swiper-tab")) {
        initSwiperWithCustomPagination(swiperElement, config);
      } else {
        new Swiper(swiperElement, config);
      }
    });
  }

  window.addEventListener("load", initSwiper);

  /**
   * Init isotope layout and filters
   */
  document.querySelectorAll('.isotope-layout').forEach(function(isotopeItem) {
    let layout = isotopeItem.getAttribute('data-layout') ?? 'masonry';
    let filter = isotopeItem.getAttribute('data-default-filter') ?? '*';
    let sort = isotopeItem.getAttribute('data-sort') ?? 'original-order';

    let initIsotope;
    let activeFilter = filter;
    let activeMember = '';

    function updateMemberFilterState() {
      isotopeItem.querySelectorAll('.publication-member-filter').forEach(function(member) {
        const isActive = Boolean(activeMember) && member.getAttribute('data-publication-member') === activeMember;
        member.classList.toggle('member-filter-active', isActive);
        member.setAttribute('aria-pressed', String(isActive));
      });
    }

    function refreshPublicationAos() {
      if (typeof AOS !== 'undefined' && typeof AOS.refresh === 'function') {
        AOS.refresh();
      }
    }

    function matchesActivePublication(item) {
      const matchesCategory = activeFilter === '*' || item.matches(activeFilter);
      if (!matchesCategory || !activeMember) return matchesCategory;
      const members = String(item.getAttribute('data-publication-members') || '').split(/\s+/).filter(Boolean);
      return members.includes(activeMember);
    }

    function filteredBibtexEntries() {
      return Array.from(isotopeItem.querySelectorAll('.isotope-item'))
        .filter(matchesActivePublication)
        .map(item => item.querySelector('.publication-modal-text')?.textContent.trim() || '')
        .filter(Boolean);
    }

    function exportSlug(value) {
      return String(value || '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'filtered';
    }

    function exportFilename() {
      const categoryNames = {
        '*': 'papers',
        '.filter-publication': 'publications',
        '.filter-preprint': 'preprints',
        '.filter-thesis': 'theses',
      };
      let filename = categoryNames[activeFilter] || 'filtered-publications';
      if (activeMember) {
        const member = Array.from(isotopeItem.querySelectorAll('.publication-member-filter'))
          .find(button => button.getAttribute('data-publication-member') === activeMember);
        filename += `-${exportSlug(member?.textContent.trim() || activeMember)}`;
      }
      return `${filename}.bib`;
    }

    function updateExportButton() {
      const button = isotopeItem.querySelector('[data-publication-export]');
      if (!button) return;
      const count = filteredBibtexEntries().length;
      button.disabled = count === 0;
      button.title = count ? `Export ${count} BibTeX entr${count === 1 ? 'y' : 'ies'}` : 'No BibTeX entries in the current filter';
      button.setAttribute('aria-label', button.title);
    }

    function exportFilteredBibtex() {
      const entries = filteredBibtexEntries();
      if (!entries.length) return;

      const blob = new Blob([`${entries.join('\n\n')}\n`], { type: 'application/x-bibtex;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = exportFilename();
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    }

    function syncPublicationLightbox() {
      if (!glightbox || typeof glightbox.setElements !== 'function') return;
      const elements = Array.from(isotopeItem.querySelectorAll('.glightbox[data-publication-action="bibtex"]'))
        .filter(link => {
          const item = link.closest('.isotope-item');
          return !item || matchesActivePublication(item);
        });
      glightbox.setElements(elements);
      if (Array.isArray(glightbox.elements)) {
        glightbox.elements.forEach((element, index) => {
          element.node = elements[index];
        });
      }
    }

    function arrangeIsotope() {
      if (!initIsotope) return;

      const filterFunction = activeMember
        ? matchesActivePublication
        : activeFilter;

      if (typeof initIsotope.once === 'function') {
        initIsotope.once('arrangeComplete', function() {
          refreshPublicationAos();
          syncPublicationLightbox();
          updateExportButton();
        });
      }
      initIsotope.arrange({ filter: filterFunction });
      window.requestAnimationFrame(function() {
        refreshPublicationAos();
        syncPublicationLightbox();
        updateExportButton();
      });
    }

    imagesLoaded(isotopeItem.querySelector('.isotope-container'), function() {
      initIsotope = new Isotope(isotopeItem.querySelector('.isotope-container'), {
        itemSelector: '.isotope-item',
        layoutMode: layout,
        filter: filter,
        sortBy: sort
      });
      arrangeIsotope();
    });

    const exportButton = isotopeItem.querySelector('[data-publication-export]');
    if (exportButton) exportButton.addEventListener('click', exportFilteredBibtex, false);

    isotopeItem.querySelectorAll('.isotope-filters li').forEach(function(filters) {
      filters.addEventListener('click', function() {
        const activeFilterElement = isotopeItem.querySelector('.isotope-filters .filter-active');
        if (activeFilterElement) activeFilterElement.classList.remove('filter-active');
        this.classList.add('filter-active');
        activeFilter = this.getAttribute('data-filter') || '*';
        activeMember = '';
        updateMemberFilterState();
        arrangeIsotope();
      }, false);
    });

    isotopeItem.querySelectorAll('.publication-member-filter').forEach(function(member) {
      member.addEventListener('click', function(event) {
        event.preventDefault();
        const selectedMember = this.getAttribute('data-publication-member') || '';
        activeMember = activeMember === selectedMember ? '' : selectedMember;
        updateMemberFilterState();
        arrangeIsotope();
      }, false);
    });

  });

  /**
   * Publication abstracts and BibTeX actions
   */
  function initPublicationActions() {
    function bibtexContext(button) {
      const panel = button.closest('.publication-bibtex-content');
      if (!panel) return null;
      return {
        panel,
        text: panel.querySelector('.publication-modal-text'),
        status: panel.querySelector('.publication-modal-status'),
        citationKey: button.dataset.publicationKey || 'publication',
      };
    }

    function setStatus(context, message) {
      if (context?.status) context.status.textContent = message;
    }

    function fallbackCopy(text) {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      let copied = false;
      try {
        copied = document.execCommand('copy');
      } catch (error) {
        copied = false;
      }
      textarea.remove();
      return copied;
    }

    function copyBibtex(button) {
      const context = bibtexContext(button);
      if (!context?.text) return;
      const text = context.text.textContent;
      if (navigator.clipboard?.writeText && window.isSecureContext) {
        navigator.clipboard.writeText(text)
          .then(() => setStatus(context, 'BibTeX copied to the clipboard.'))
          .catch(() => setStatus(context, fallbackCopy(text) ? 'BibTeX copied to the clipboard.' : 'Copy failed; select the BibTeX text manually.'));
        return;
      }
      setStatus(context, fallbackCopy(text) ? 'BibTeX copied to the clipboard.' : 'Copy failed; select the BibTeX text manually.');
    }

    function downloadBibtex(button) {
      const context = bibtexContext(button);
      if (!context?.text) return;
      const blob = new Blob([context.text.textContent], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = context.citationKey + '.bib';
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setStatus(context, 'BibTeX download started.');
    }

    function relayoutPublicationGrid(abstract) {
      const container = abstract.closest('.isotope-container');
      if (!container || typeof Isotope === 'undefined' || typeof Isotope.data !== 'function') return;
      const isotope = Isotope.data(container);
      if (isotope) isotope.layout();
    }

    function beginPublicationReflow(abstract) {
      const container = abstract.closest('.isotope-container');
      const item = abstract.closest('.isotope-item');
      if (!container || !item || typeof Isotope === 'undefined' || typeof Isotope.data !== 'function' || typeof ResizeObserver === 'undefined') {
        return () => {};
      }

      const isotope = Isotope.data(container);
      if (!isotope) return () => {};

      const previousTransitionDuration = isotope.options.transitionDuration;
      isotope.options.transitionDuration = 0;
      let frameId = 0;
      const relayout = () => {
        if (frameId) return;
        frameId = window.requestAnimationFrame(() => {
          frameId = 0;
          isotope.layout();
        });
      };
      const observer = new ResizeObserver(relayout);
      observer.observe(item);
      relayout();

      return () => {
        observer.disconnect();
        if (frameId) window.cancelAnimationFrame(frameId);
        isotope.options.transitionDuration = previousTransitionDuration;
        isotope.layout();
      };
    }

    function updatePublicationAbstractHeight(abstract) {
      if (!abstract.classList.contains('is-open') || abstract.style.maxHeight === 'none') return;
      abstract.style.maxHeight = `${abstract.scrollHeight}px`;
    }

    function togglePublicationAbstract(abstract, open) {
      if (typeof abstract.publicationTransitionCleanup === 'function') {
        abstract.publicationTransitionCleanup();
      }

      const cleanupReflow = beginPublicationReflow(abstract);
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        abstract.removeEventListener('transitionend', onTransitionEnd);
        abstract.style.maxHeight = open ? 'none' : '';
        cleanupReflow();
        abstract.publicationTransitionCleanup = null;
      };
      const onTransitionEnd = event => {
        if (event.target === abstract && event.propertyName === 'max-height') finish();
      };

      abstract.publicationTransitionCleanup = finish;
      abstract.addEventListener('transitionend', onTransitionEnd);

      if (open) {
        abstract.classList.add('is-open');
        abstract.style.maxHeight = '0px';
        abstract.offsetHeight;
        window.requestAnimationFrame(() => {
          abstract.style.maxHeight = `${abstract.scrollHeight}px`;
          relayoutPublicationGrid(abstract);
        });
      } else {
        abstract.style.maxHeight = `${abstract.getBoundingClientRect().height}px`;
        abstract.offsetHeight;
        abstract.classList.remove('is-open');
        window.requestAnimationFrame(() => {
          abstract.style.maxHeight = '0px';
          relayoutPublicationGrid(abstract);
        });
      }

      window.setTimeout(finish, 500);
    }

    function typesetPublicationMath(abstract) {
      if (!window.MathJax?.typesetPromise) return Promise.resolve();
      return window.MathJax.typesetPromise([abstract]).catch(() => {});
    }

    document.addEventListener('click', event => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;

      const action = target.closest('[data-publication-action]');
      if (action?.dataset.publicationAction === 'abstract') {
        event.preventDefault();
        const abstract = document.getElementById(action.getAttribute('aria-controls'));
        if (!abstract) return;
        const open = !abstract.classList.contains('is-open');
        abstract.setAttribute('aria-hidden', String(!open));
        action.setAttribute('aria-expanded', String(open));
        togglePublicationAbstract(abstract, open);
        typesetPublicationMath(abstract).then(() => {
          updatePublicationAbstractHeight(abstract);
          relayoutPublicationGrid(abstract);
        });
        return;
      }

      const copyButton = target.closest('[data-publication-copy]');
      if (copyButton) {
        event.preventDefault();
        copyBibtex(copyButton);
        return;
      }

      const downloadButton = target.closest('[data-publication-download]');
      if (downloadButton) {
        event.preventDefault();
        downloadBibtex(downloadButton);
      }
    });
  }

  initPublicationActions();

})();
