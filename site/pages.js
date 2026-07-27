'use strict';

// Shared behaviour for the Q&A, Support and Docs pages: live search over the
// accordions, category filtering, and the docs sidebar scrollspy.

// ---- FAQ search + category filter -----------------------------------------
(() => {
  const input = document.getElementById('faqSearch');
  const list = document.querySelector('.faq-list');
  if (!list) return;

  const wrap = input ? input.closest('.search-wrap') : null;
  const clearBtn = document.querySelector('.search-clear');
  const countEl = document.getElementById('searchCount');
  const empty = document.querySelector('.no-results');
  const chips = [...document.querySelectorAll('.chip')];
  const items = [...list.querySelectorAll('.faq')];
  const groups = [...list.querySelectorAll('.faq-group')];

  // Cache the searchable text and the original question markup once, so that
  // repeated highlighting never compounds on already-highlighted HTML.
  const entries = items.map((el) => {
    const q = el.querySelector('.faq-q');
    const a = el.querySelector('.faq-a');
    return {
      el, q,
      questionHTML: q.innerHTML,
      haystack: `${q.textContent} ${a ? a.textContent : ''}`.toLowerCase(),
      tags: (el.dataset.tags || '').toLowerCase(),
    };
  });

  let activeChip = 'all';

  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function highlight(entry, term) {
    if (!term) { entry.q.innerHTML = entry.questionHTML; return; }
    const re = new RegExp(`(${escapeRe(term)})`, 'gi');
    // Split the original markup into tag and text runs, then highlight only the
    // text runs — so a match is never injected inside an attribute or tag name.
    entry.q.innerHTML = entry.questionHTML
      .split(/(<[^>]+>)/g)
      .map((part) => (part.startsWith('<') ? part : part.replace(re, '<mark>$1</mark>')))
      .join('');
  }

  function apply() {
    const term = (input ? input.value : '').trim().toLowerCase();
    let shown = 0;

    for (const entry of entries) {
      const matchesChip = activeChip === 'all' || entry.tags.split(/\s+/).includes(activeChip);
      const matchesTerm = !term || entry.haystack.includes(term);
      const visible = matchesChip && matchesTerm;

      entry.el.hidden = !visible;
      if (visible) {
        shown++;
        highlight(entry, term);
        // Open matches while searching so the answer is visible immediately.
        if (term) entry.el.open = true;
        else if (entry.el.dataset.userOpened !== '1') entry.el.open = false;
      }
    }

    // Hide a category heading when every question under it is filtered out.
    for (const g of groups) {
      const any = [...g.querySelectorAll('.faq')].some((el) => !el.hidden);
      g.hidden = !any;
    }

    if (countEl) {
      if (term || activeChip !== 'all') {
        countEl.innerHTML = shown
          ? `<b>${shown}</b> ${shown === 1 ? 'answer' : 'answers'}`
          : '';
      } else {
        countEl.innerHTML = '';
      }
    }
    if (empty) empty.classList.toggle('show', shown === 0);
    if (wrap) wrap.classList.toggle('has-value', !!(input && input.value));
  }

  // Remember manual opens so clearing the search doesn't collapse them.
  items.forEach((el) => {
    el.addEventListener('toggle', () => {
      if (!input || !input.value.trim()) el.dataset.userOpened = el.open ? '1' : '0';
    });
  });

  if (input) {
    input.addEventListener('input', apply);
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') { input.value = ''; apply(); }
    });
  }
  if (clearBtn) {
    clearBtn.addEventListener('click', () => { input.value = ''; input.focus(); apply(); });
  }
  chips.forEach((chip) => {
    chip.addEventListener('click', () => {
      activeChip = chip.dataset.filter || 'all';
      chips.forEach((c) => c.classList.toggle('is-on', c === chip));
      apply();
    });
  });

  // Deep link: ?q=term prefills the search (used by the "search support" links).
  const q = new URLSearchParams(location.search).get('q');
  if (q && input) input.value = q;

  // "/" focuses the search box, like most docs sites.
  document.addEventListener('keydown', (ev) => {
    if (ev.key === '/' && input && document.activeElement !== input
        && !/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) {
      ev.preventDefault();
      input.focus();
    }
  });

  apply();
})();

// ---- Docs sidebar scrollspy ------------------------------------------------
(() => {
  const nav = document.querySelector('.docs-nav');
  if (!nav) return;
  const links = [...nav.querySelectorAll('a[href^="#"]')];
  const sections = links
    .map((a) => document.getElementById(a.getAttribute('href').slice(1)))
    .filter(Boolean);
  if (!sections.length) return;

  const setCurrent = (id) => {
    for (const a of links) {
      a.classList.toggle('is-current', a.getAttribute('href') === `#${id}`);
    }
  };

  // Track the section nearest the top of the viewport rather than whichever
  // happens to intersect, so short sections don't get skipped.
  const onScroll = () => {
    let current = sections[0].id;
    for (const s of sections) {
      if (s.getBoundingClientRect().top <= 120) current = s.id;
    }
    setCurrent(current);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  nav.addEventListener('click', (ev) => {
    const a = ev.target.closest('a[href^="#"]');
    if (a) setTimeout(onScroll, 500);
  });
})();
