// server.js (fixed request-interception handling)
const express = require('express');
const puppeteer = require('puppeteer-core');
const os = require('os');

const CHROMIUM_PATH = process.env.CHROMIUM_PATH || '/usr/bin/chromium';
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 7777;
const HOME = process.env.HOME_URL || 'https://htmlcsstoimage.com/';
const TAB_SELECTOR = 'button.tab-btn[data-tabs-target="#preview-image-content"]';
const IMAGE_DEMO_SUBSTR = '/image-demo';
const MAX_WAIT_MS = process.env.MAX_WAIT_MS ? parseInt(process.env.MAX_WAIT_MS,10) : 15000;
const KEEP_ALIVE_MS = process.env.KEEP_ALIVE_MS ? parseInt(process.env.KEEP_ALIVE_MS,10) : 30000;

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

  const browser = await puppeteer.launch(launchOpts);
  console.log('Launched Chromium from', CHROMIUM_PATH);

  const page = await browser.newPage();

  // keep-alive
  let keepAliveTimer = setInterval(async () => {
    try {
      if (!page || (typeof page.isClosed === 'function' && page.isClosed())) return;
      await page.evaluate(() => 0);
    } catch (e) { /* ignore transient */ }
  }, KEEP_ALIVE_MS);

  // We'll manage request interception handler explicitly
  let requestHandler = null;
  let interceptionEnabled = false;

  async function addRequestInterception() {
    if (interceptionEnabled) return;
    try {
      await page.setRequestInterception(true);
      requestHandler = (req) => {
        try {
          let t = '';
          try { t = typeof req.resourceType === 'function' ? req.resourceType() : (req._resourceType || ''); } catch (_) { t = req._resourceType || ''; }
          if (t === 'image' || t === 'font' || t === 'stylesheet') {
            try { req.abort(); } catch (e) { /* ignore */ }
            return;
          }
          try { req.continue(); } catch (e) { /* ignore */ }
        } catch (e) {
          // defensive: if something unexpected happens, try continue and ignore errors
          try { req.continue(); } catch (err) { /* ignore */ }
        }
      };
      page.on('request', requestHandler);
      interceptionEnabled = true;
      console.log('Request interception enabled');
    } catch (e) {
      // interception not available on this environment
      interceptionEnabled = false;
      requestHandler = null;
      console.warn('Could not enable request interception:', e && e.message ? e.message : e);
    }
  }

  async function removeRequestInterception() {
    // remove listener first to avoid handler running while disabling
    try {
      if (requestHandler) {
        page.removeListener('request', requestHandler);
        requestHandler = null;
      }
    } catch (e) { /* ignore */ }

    try {
      // Only try to disable if it was enabled
      if (interceptionEnabled) {
        await page.setRequestInterception(false);
      }
    } catch (e) {
      // Some environments may throw; ignore
    } finally {
      interceptionEnabled = false;
      requestHandler = null;
      console.log('Request interception disabled');
    }
  }

  // initially try to enable resource blocking (best-effort)
  await addRequestInterception();

  // CDP for cookies / fallback
  const client = await page.target().createCDPSession();
  try { await client.send('Network.enable'); } catch (e) {}

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

  app.get('/ping', (req,res) => res.json({ ok:true, ts:new Date().toISOString(), host: os.hostname() }));

  // wait helper same as before (keeps Puppeteer & CDP fallback)
  async function waitForImageDemoResponse(timeoutMs = MAX_WAIT_MS) {
    try {
      const resp = await page.waitForResponse(r => {
        try { return r.url().includes(IMAGE_DEMO_SUBSTR); } catch (e) { return false; }
      }, { timeout: timeoutMs });
      let body = null;
      try { body = await resp.text().catch(() => null); } catch (e) { body = null; }
      const headers = (typeof resp.headers === 'function') ? resp.headers() : (resp._headers || {});
      console.log('[waitForResponse] saw URL:', resp.url());
      return { url: resp.url(), status: resp.status(), headers, body };
    } catch (e) {
      console.warn('waitForResponse timed out / failed; falling back to CDP');
    }

    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; resolve(null); } }, timeoutMs);

      const handler = async (params) => {
        try {
          const url = params.response && params.response.url;
          if (!url || !url.includes(IMAGE_DEMO_SUBSTR)) return;
          if (done) return;
          done = true;
          clearTimeout(timer);
          let body = null;
          try {
            const resp = await client.send('Network.getResponseBody', { requestId: params.requestId });
            body = resp && resp.body ? resp.body : null;
          } catch (err) { body = null; }
          client.removeListener('Network.responseReceived', handler);
          console.log('[CDP fallback] saw URL:', url);
          resolve({ url, status: params.response.status, headers: params.response.headers || {}, body });
        } catch (err) {
          if (!done) { done = true; clearTimeout(timer); client.removeListener('Network.responseReceived', handler); resolve(null); }
        }
      };

      client.on('Network.responseReceived', handler);
    });
  }

  app.get('/status', async (req, res) => {
    try {
      await clearSiteData();

      // guarded goto with retry
      try {
        if (!page || (typeof page.isClosed === 'function' && page.isClosed())) throw new Error('Page closed before navigation');
        await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 20000 });
      } catch (e) {
        if (e && typeof e.message === 'string' && e.message.toLowerCase().includes('detached frame')) {
          console.warn('page.goto hit detached frame — retrying once');
          await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 20000 });
        } else throw e;
      }

      await page.waitForSelector(TAB_SELECTOR, { visible: true, timeout: 10000 });

      // Temporarily remove interception so we don't stall/alter the click+network flow
      let hadInterception = interceptionEnabled;
      if (hadInterception) {
        await removeRequestInterception(); // removes handler and disables interception
      }

      // click
      try { await page.click(TAB_SELECTOR); } catch (clickErr) {
        try { await page.evaluate((sel)=>{ const el = document.querySelector(sel); if (el) el.click(); }, TAB_SELECTOR); } catch (e) {}
      }

      // wait for response
      const resp = await waitForImageDemoResponse(MAX_WAIT_MS);

      // restore interception if we had it before
      if (hadInterception) {
        await addRequestInterception();
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

  async function gracefulShutdown() {
    console.log('Shutting down...');
    clearInterval(keepAliveTimer);
    try { await browser.close(); } catch(e) {}
    process.exit(0);
  }
  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);

})();
