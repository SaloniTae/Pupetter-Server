// server.js
const express = require('express');
const puppeteer = require('puppeteer-core');
const os = require('os');

const CHROMIUM_PATH = process.env.CHROMIUM_PATH || '/usr/bin/chromium';
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 7777;
const HOME = process.env.HOME_URL || 'https://htmlcsstoimage.com/';
const TAB_SELECTOR = 'button.tab-btn[data-tabs-target="#preview-image-content"]';
const IMAGE_DEMO_SUBSTR = '/image-demo';
const MAX_WAIT_MS = process.env.MAX_WAIT_MS ? parseInt(process.env.MAX_WAIT_MS,10) : 15000; // increased default
const KEEP_ALIVE_MS = process.env.KEEP_ALIVE_MS ? parseInt(process.env.KEEP_ALIVE_MS,10) : 30000;

// Use the flags you wanted
const PUPPETEER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage'
];
const EXTRA_FLAGS = ['--disable-gpu','--no-zygote','--single-process','--disable-extensions','--no-first-run'];

(async () => {
  console.log('Starting server; preferred Chromium path:', CHROMIUM_PATH);

  const launchOpts = {
    executablePath: CHROMIUM_PATH,
    headless: true,
    args: PUPPETEER_ARGS.concat(EXTRA_FLAGS),
    dumpio: (process.env.DUMP_IO === 'true'),
    timeout: 60000,
  };

  let browser;
  try {
    browser = await puppeteer.launch(launchOpts);
    console.log('Launched Chromium from', CHROMIUM_PATH);
  } catch (err) {
    console.error('Failed to launch Chromium:', err && err.message ? err.message : err);
    throw err;
  }

  const page = await browser.newPage();

  // keep-alive
  let keepAliveTimer = setInterval(async () => {
    try {
      if (!page || (typeof page.isClosed === 'function' && page.isClosed())) return;
      await page.evaluate(() => 0);
    } catch (e) {
      // ignore transient errors
    }
  }, KEEP_ALIVE_MS);

  // Initially block images/fonts/styles for speed
  async function enableResourceBlocking() {
    try {
      await page.setRequestInterception(true);
      page.on('request', req => {
        let t = '';
        try { t = typeof req.resourceType === 'function' ? req.resourceType() : (req._resourceType || ''); } catch (e) { t = req._resourceType || ''; }
        if (t === 'image' || t === 'font' || t === 'stylesheet') return req.abort();
        req.continue();
      });
    } catch (e) {
      console.warn('Request interception not available:', e && e.message ? e.message : e);
    }
  }
  // attempt to enable resource blocking — best-effort
  await enableResourceBlocking();

  // CDP session for cookies / fallback body extraction
  const client = await page.target().createCDPSession();
  try { await client.send('Network.enable'); } catch (e) {}

  // Clear site data
  async function clearSiteData() {
    try { await client.send('Network.clearBrowserCookies'); } catch(e){}
    try { await client.send('Network.clearBrowserCache'); } catch(e){}
    try { await client.send('Storage.clearDataForOrigin', { origin: (new URL(HOME)).origin, storageTypes: 'all' }); } catch(e){}
    try {
      await page.evaluate(() => {
        try { localStorage.clear(); } catch(e) {}
        try { sessionStorage.clear(); } catch(e) {}
        try { document.cookie.split(';').forEach(c => { document.cookie = c.replace(/=.*/, '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/;'); }); } catch(e) {}
      });
    } catch(e){}
  }

  function extractVerificationToken({ headers = {}, body = null } = {}) {
    for (const k of Object.keys(headers || {})) {
      if (k.toLowerCase().includes('requestverificationtoken') || k.toLowerCase().includes('request-verification-token')) {
        return headers[k];
      }
    }
    if (body && typeof body === 'string') {
      const m = body.match(/name=(?:'|")__RequestVerificationToken(?:'|")\s+value=(?:'|")([^'"]+)(?:'|")/i)
        || body.match(/<input[^>]*name="__RequestVerificationToken"[^>]*value="([^"]+)"/i)
        || body.match(/<meta[^>]*name="csrf-token"[^>]*content="([^"]+)"/i);
      if (m) return m[1];
    }
    return null;
  }

  const app = express();

  app.get('/ping', (req, res) => res.json({ ok: true, ts: new Date().toISOString(), host: os.hostname() }));

  // Wait helper: try Puppeteer waitForResponse, then fallback to CDP one-shot
  async function waitForImageDemoResponse(timeoutMs = MAX_WAIT_MS) {
    // 1) Try Puppeteer waitForResponse (one-shot)
    try {
      const resp = await page.waitForResponse(r => {
        try { return r.url().includes(IMAGE_DEMO_SUBSTR); } catch (e) { return false; }
      }, { timeout: timeoutMs });
      // try to get text; if fails, fall through to return headers-only
      let body = null;
      try { body = await resp.text().catch(() => null); } catch (e) { body = null; }
      const headers = (typeof resp.headers === 'function') ? resp.headers() : (resp._headers || {});
      console.log('[waitForResponse] saw URL:', resp.url());
      return { url: resp.url(), status: resp.status(), headers, body };
    } catch (e) {
      // timeout or other error — fall back to CDP
      if (!(e && e.name === 'TimeoutError')) {
        console.warn('waitForResponse error (non-timeout):', e && e.message ? e.message : e);
      } else {
        console.warn('waitForResponse timed out — falling back to CDP one-shot listener');
      }
    }

    // 2) Fallback: CDP one-shot listener that immediately calls getResponseBody
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (!done) { done = true; resolve(null); }
      }, timeoutMs);

      const handler = async (params) => {
        try {
          const url = params.response && params.response.url;
          if (!url || !url.includes(IMAGE_DEMO_SUBSTR)) return;
          if (done) return;
          done = true;
          clearTimeout(timer);
          // Grab body immediately
          let body = null;
          try {
            const resp = await client.send('Network.getResponseBody', { requestId: params.requestId });
            body = resp && resp.body ? resp.body : null;
          } catch (err) {
            body = null;
          }
          client.removeListener('Network.responseReceived', handler);
          console.log('[CDP fallback] saw URL:', url);
          resolve({ url, status: params.response.status, headers: params.response.headers || {}, body });
        } catch (err) {
          if (!done) { done = true; clearTimeout(timer); client.removeListener('Network.responseReceived', handler); resolve(null); }
        }
      };

      // One-shot attach
      client.on('Network.responseReceived', handler);
    });
  }

  app.get('/status', async (req, res) => {
    try {
      await clearSiteData();

      // Guarded goto with retry for detached-frame
      try {
        if (!page || (typeof page.isClosed === 'function' && page.isClosed())) throw new Error('Page already closed before navigation');
        await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 20000 });
      } catch (e) {
        if (e && typeof e.message === 'string' && e.message.toLowerCase().includes('detached frame')) {
          console.warn('page.goto hit detached frame — retrying once');
          await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 20000 });
        } else throw e;
      }

      await page.waitForSelector(TAB_SELECTOR, { visible: true, timeout: 10000 });

      // IMPORTANT: temporarily disable request interception before click/wait
      let hadInterception = false;
      try {
        if (page._client) {
          // Only attempt to change if interception was enabled earlier
          const currentIntercept = page._client && page._client._connection ? true : false;
        }
        // Try to disable interception safely
        try {
          await page.setRequestInterception(false);
          hadInterception = true;
        } catch (e) {
          // ignore if not enabled / can't disable
          hadInterception = false;
        }
      } catch(e) { hadInterception = false; }

      // Do the click (use page.click with fallback)
      try {
        await page.click(TAB_SELECTOR);
      } catch (clickErr) {
        try {
          await page.evaluate((sel) => { const el = document.querySelector(sel); if (el) el.click(); }, TAB_SELECTOR);
        } catch (e) {
          // ignore
        }
      }

      // Wait for the /image-demo response with fallback
      const resp = await waitForImageDemoResponse(MAX_WAIT_MS);

      // Re-enable request interception if we previously had it enabled (best-effort)
      try {
        if (hadInterception) {
          // remove existing request listeners (simple way: remove all listeners and re-enable)
          page.removeAllListeners('request');
          await page.setRequestInterception(true);
          page.on('request', req => {
            let t = '';
            try { t = typeof req.resourceType === 'function' ? req.resourceType() : (req._resourceType || ''); } catch (e) { t = req._resourceType || ''; }
            if (t === 'image' || t === 'font' || t === 'stylesheet') return req.abort();
            req.continue();
          });
        }
      } catch (e) { /* ignore */ }

      // collect cookies via CDP
      let cookies = [];
      try {
        const allCookies = await client.send('Network.getAllCookies');
        cookies = (allCookies.cookies || []).filter(c => c.domain && (c.domain.includes('htmlcsstoimage') || c.domain.includes('hcti.io')));
      } catch (e) {
        try { cookies = await page.cookies(); } catch (e2) { cookies = []; }
      }

      // token extraction
      let token = null;
      if (resp) token = extractVerificationToken({ headers: resp.headers || {}, body: resp.body });
      if (!token) {
        try {
          const tokenVal = await page.evaluate(() => {
            const inp = document.querySelector('input[name="__RequestVerificationToken"]');
            if (inp) return inp.value;
            const m = document.querySelector('meta[name="csrf-token"]');
            if (m) return m.getAttribute('content');
            return null;
          });
          if (tokenVal) token = tokenVal;
        } catch (e) {}
      }

      res.json({
        timestamp: new Date().toISOString(),
        cookies,
        requestVerificationToken: token || null,
        imageDemoResponseSeen: !!resp,
        imageDemoResponseSummary: resp ? { url: resp.url, status: resp.status, headerKeys: Object.keys(resp.headers || {}) } : null
      });
    } catch (err) {
      console.error('Error /status:', (err && err.stack) ? err.stack : err);
      res.status(500).json({ error: 'internal error', message: err && err.message ? err.message : String(err) });
    }
  });

  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    console.log('Endpoints: /ping, /status (public)');
  });

  // cleanup
  async function gracefulShutdown() {
    console.log('Shutting down...'); clearInterval(keepAliveTimer);
    try { await browser.close(); } catch (e) {}
    process.exit(0);
  }
  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);

})();
