// server.js
const express = require('express');
const puppeteer = require('puppeteer-core'); // we use system Chromium from the container
const os = require('os');

const CHROMIUM_PATH = process.env.CHROMIUM_PATH || '/usr/bin/chromium-browser';
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 7777;
const HOME = process.env.HOME_URL || 'https://htmlcsstoimage.com/';
const TAB_SELECTOR = 'button.tab-btn[data-tabs-target="#preview-image-content"]';
const IMAGE_DEMO_SUBSTR = '/image-demo';
const MAX_WAIT_MS = process.env.MAX_WAIT_MS ? parseInt(process.env.MAX_WAIT_MS,10) : 5000;
const KEEP_ALIVE_MS = process.env.KEEP_ALIVE_MS ? parseInt(process.env.KEEP_ALIVE_MS,10) : 30000;

// Use the exact flags you requested (add more if needed)
const PUPPETEER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage'
];

// Additional recommended flags for reliability (kept separate so you can edit)
const EXTRA_FLAGS = [
  '--disable-gpu',
  '--no-zygote',
  '--single-process',
  '--disable-extensions',
  '--no-first-run'
];

(async () => {
  console.log('Starting server; preferred Chromium path:', CHROMIUM_PATH);

  const launchOptionsBase = {
    headless: true,
    dumpio: (process.env.DUMP_IO === 'true'), // useful for debugging; set via env
    args: PUPPETEER_ARGS.concat(EXTRA_FLAGS),
    timeout: 60000,
  };

  // Try a small set of common chromium locations; let CHROMIUM_PATH env override first
  const tryPaths = [
    CHROMIUM_PATH,
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome-stable',
    '/snap/bin/chromium'
  ].filter(Boolean);

  let browser = null;
  for (const p of tryPaths) {
    try {
      console.log('Attempting to launch Chromium at', p);
      launchOptionsBase.executablePath = p;
      browser = await puppeteer.launch(launchOptionsBase);
      console.log('Launched Chromium from', p);
      break;
    } catch (err) {
      console.warn('Launch failed for', p, (err && err.message) ? err.message : err);
    }
  }

  if (!browser) {
    console.error('Unable to launch any Chromium binary. Check logs or CHROMIUM_PATH.');
    process.exit(1);
  }

  const page = await browser.newPage();

  // keep-alive: periodically evaluate a NO-OP to keep the browser process & page active
  let keepAliveTimer = setInterval(async () => {
    try {
      if (!page || (typeof page.isClosed === 'function' && page.isClosed())) return;
      await page.evaluate(() => 0);
    } catch (e) {
      // ignore transient navigation / detached frame issues
    }
  }, KEEP_ALIVE_MS);

  // Block images/fonts/styles for speed
  try {
    await page.setRequestInterception(true);
    page.on('request', req => {
      let t = '';
      try {
        t = (typeof req.resourceType === 'function') ? req.resourceType() : (req._resourceType || '');
      } catch (e) {
        t = req._resourceType || '';
      }
      if (t === 'image' || t === 'font' || t === 'stylesheet') return req.abort();
      req.continue();
    });
  } catch (e) {
    console.warn('Request interception not available:', e && e.message ? e.message : e);
  }

  // CDP for cookie ops and optional fallback
  const client = await page.target().createCDPSession();
  try { await client.send('Network.enable'); } catch (e) {}

  async function clearSiteData() {
    try { await client.send('Network.clearBrowserCookies'); } catch(e) {}
    try { await client.send('Network.clearBrowserCache'); } catch(e) {}
    try { await client.send('Storage.clearDataForOrigin', { origin: (new URL(HOME)).origin, storageTypes: 'all' }); } catch(e) {}
    try {
      await page.evaluate(() => {
        try { localStorage.clear(); } catch(e) {}
        try { sessionStorage.clear(); } catch(e) {}
        try {
          document.cookie.split(';').forEach(function(c) {
            document.cookie = c.replace(/=.*/, '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/;');
          });
        } catch(e) {}
      });
    } catch (e) {}
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

  app.get('/status', async (req, res) => {
    try {
      await clearSiteData();

      // guarded goto with single retry for transient detached-frame
      try {
        if (!page || (typeof page.isClosed === 'function' && page.isClosed())) {
          throw new Error('Page closed before navigation');
        }
        await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 20000 });
      } catch (e) {
        if (e && typeof e.message === 'string' && e.message.toLowerCase().includes('detached frame')) {
          console.warn('page.goto hit detached frame — retrying once');
          await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 20000 });
        } else throw e;
      }

      await page.waitForSelector(TAB_SELECTOR, { visible: true, timeout: 10000 });

      // one-shot response wait
      const respPromise = page.waitForResponse(r => {
        try { return r.url().includes(IMAGE_DEMO_SUBSTR); } catch (err) { return false; }
      }, { timeout: MAX_WAIT_MS });

      // safer click
      try {
        await page.click(TAB_SELECTOR);
      } catch (clickErr) {
        try {
          await page.evaluate((sel) => {
            const el = document.querySelector(sel);
            if (el) el.click();
          }, TAB_SELECTOR);
        } catch (e) {}
      }

      // get response
      let resp = null;
      try {
        const response = await respPromise;
        let body = null;
        try { body = await response.text().catch(() => null); } catch (e) { body = null; }
        const headers = (typeof response.headers === 'function') ? response.headers() : (response._headers || {});
        resp = { url: response.url(), status: response.status(), headers: headers || {}, body };
      } catch (e) {
        resp = null;
      }

      // cookies
      let cookies = [];
      try {
        const allCookies = await client.send('Network.getAllCookies');
        cookies = (allCookies.cookies || []).filter(c => c.domain && (c.domain.includes('htmlcsstoimage') || c.domain.includes('hcti.io')));
      } catch (e) {
        try { cookies = await page.cookies(); } catch (e2) { cookies = []; }
      }

      // token
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

  // graceful shutdown
  async function gracefulShutdown() {
    console.log('Shutting down...');
    clearInterval(keepAliveTimer);
    try { await browser.close(); } catch(e) {}
    process.exit(0);
  }
  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);
})();
