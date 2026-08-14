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

    function arrangeIsotope() {
      if (!initIsotope) return;

      const filterFunction = activeMember
        ? function(item) {
          const matchesCategory = activeFilter === '*' || item.matches(activeFilter);
          const members = String(item.getAttribute('data-publication-members') || '').split(/\s+/).filter(Boolean);
          return matchesCategory && members.includes(activeMember);
        }
        : activeFilter;

      initIsotope.arrange({ filter: filterFunction });
      if (typeof aosInit === 'function') {
        aosInit();
      }
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
        abstract.classList.toggle('is-open', open);
        abstract.setAttribute('aria-hidden', String(!open));
        action.setAttribute('aria-expanded', String(open));
        relayoutPublicationGrid(abstract);
        window.requestAnimationFrame(() => relayoutPublicationGrid(abstract));
        typesetPublicationMath(abstract).then(() => relayoutPublicationGrid(abstract));
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
