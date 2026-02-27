/**
 * PDF preparation script.
 * Injected and executed inside the page (via Puppeteer's page.evaluate)
 * before PDF capture. Expands all panels, loads all Retriever content,
 * and waits for everything to settle.
 *
 * This runs in the browser context, NOT in Node.js.
 */

/* eslint-env browser */

async function preparePdfContent(waitTimeout) {
  const RETRIEVER_POLL_INTERVAL = 200;

  // ------------------------------------------------------------------
  // 1. Expand every collapsed panel by clicking its header.
  //    This triggers the Vue component's toggle() or open() method,
  //    which in turn causes the Retriever to fetch its src content.
  // ------------------------------------------------------------------

  // First, handle minimized panels (they render as a button with .morph-display-wrapper).
  // Clicking them calls open(), which sets localMinimized=false, localExpanded=true,
  // and triggers the Retriever.
  const minimizedButtons = document.querySelectorAll('.morph-display-wrapper');
  for (const btn of minimizedButtons) {
    btn.click();
  }

  // Small yield to let Vue process the minimized → expanded transition
  await sleep(100);

  // Now expand all collapsed expandable panels.
  // NestedPanel: .expandable-card .card-header.header-toggle triggers toggle()
  // MinimalPanel: .header-toggle triggers minimalToggle()
  //
  // We only click headers whose panel is currently collapsed.
  // A collapsed panel has .card-collapse with max-height of "0px" or a small peek value.
  const panelHeaders = document.querySelectorAll('.header-toggle');
  for (const header of panelHeaders) {
    const card = header.closest('.card');
    if (!card) continue;

    const collapse = card.querySelector('.card-collapse');
    if (!collapse) continue;

    // If the panel body is not yet rendered (wasRetrieverLoaded is false),
    // the card-body div won't exist or will show "Loading...".
    // Either way, if max-height is not 'none', the panel is collapsed.
    const maxHeight = collapse.style.maxHeight;
    if (maxHeight !== 'none' && maxHeight !== '') {
      header.click();
    }
  }

  // Yield to let Vue process expansions and kick off Retriever fetches
  await sleep(300);

  // ------------------------------------------------------------------
  // 2. Some panels may have been opened but their Retriever hasn't
  //    finished fetching yet. We also need to handle panels that were
  //    not expandable but had preload=false and src set.
  //    Click any remaining collapsed headers (second pass).
  // ------------------------------------------------------------------
  const remainingHeaders = document.querySelectorAll('.header-toggle');
  for (const header of remainingHeaders) {
    const card = header.closest('.card');
    if (!card) continue;
    const collapse = card.querySelector('.card-collapse');
    if (!collapse) continue;
    const maxHeight = collapse.style.maxHeight;
    if (maxHeight !== 'none' && maxHeight !== '') {
      header.click();
    }
  }

  await sleep(200);

  // ------------------------------------------------------------------
  // 3. Wait for all Retrievers to finish loading.
  //    A Retriever that hasn't loaded shows "Loading..." text.
  //    Once loaded, the Retriever's $el is replaced by the fetched content.
  // ------------------------------------------------------------------
  await waitForRetrievers(waitTimeout);

  // ------------------------------------------------------------------
  // 4. Force all card-collapse elements to have max-height: none
  //    in case any transitions didn't complete.
  // ------------------------------------------------------------------
  document.querySelectorAll('.card-collapse').forEach(function(el) {
    el.style.maxHeight = 'none';
    el.style.overflow = 'visible';
    el.style.transition = 'none';
  });

  // ------------------------------------------------------------------
  // 5. Remove d-print-none from card bodies so content is visible.
  // ------------------------------------------------------------------
  document.querySelectorAll('.card-body.d-print-none').forEach(function(el) {
    el.classList.remove('d-print-none');
  });

  // ------------------------------------------------------------------
  // 6. Remove peek collapsed styling.
  // ------------------------------------------------------------------
  document.querySelectorAll('.card-peek-collapsed').forEach(function(el) {
    el.classList.remove('card-peek-collapsed');
  });

  // ------------------------------------------------------------------
  // 7. Trigger the beforeprint event so that page-nav-print containers
  //    get populated (from print.js).
  // ------------------------------------------------------------------
  window.dispatchEvent(new Event('beforeprint'));

  // ------------------------------------------------------------------
  // 8. Small final settle time for any remaining DOM updates.
  // ------------------------------------------------------------------
  await sleep(200);
}

/**
 * Poll until no elements with text "Loading..." remain inside .card-body,
 * or until the timeout is reached.
 */
function waitForRetrievers(timeout) {
  return new Promise(function(resolve) {
    var start = Date.now();

    function check() {
      var stillLoading = false;
      // Retrievers render as a <div> with "Loading..." text
      var cardBodies = document.querySelectorAll('.card-body');
      for (var i = 0; i < cardBodies.length; i++) {
        var body = cardBodies[i];
        // Check for direct child divs that only contain "Loading..."
        var children = body.children;
        for (var j = 0; j < children.length; j++) {
          if (children[j].textContent.trim() === 'Loading...') {
            stillLoading = true;
            break;
          }
        }
        if (stillLoading) break;
      }

      if (!stillLoading || (Date.now() - start) > timeout) {
        resolve();
      } else {
        setTimeout(check, RETRIEVER_POLL_INTERVAL);
      }
    }

    var RETRIEVER_POLL_INTERVAL = 200;
    check();
  });
}

function sleep(ms) {
  return new Promise(function(resolve) {
    setTimeout(resolve, ms);
  });
}
