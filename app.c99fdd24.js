/* Serene Canvas — paint-by-number engine for adults 50+.
   Forked from Sparkle Pixels; architecture: SPEC.md §5 (layered canvas,
   mask-reveal artwork). Storage keys keep the sp_ prefix for continuity. */

'use strict';

// ---------------------------------------------------------------- constants
const APP_VERSION = '1.0.0';
let restoring = false;   // suppress pagehide saves while restoring a backup
const CP = 24;                 // art pixels per cell
const COIN_REWARD = 5;         // coins per completed picture
const UNLOCKS = { bomb: 3, brush: 5 };   // imagesCompleted gates
const STARTING_PROFILE = {
  coins: 30,
  imagesCompleted: 0,
  ftueDone: false,
  removeAds: false,   // $7.99 IAP: no banner + whole catalog forever
  boosters: { bucket: 3, bomb: 1, brush: 1, hint: 3 },
  opens: 0,               // app launches — gates the one-time reminder ask
  askedReminders: false,
  seenUnlockExplainer: false,   // explain the ad trade once, then get out of the way
  settings: { sparkle: true, sound: true, haptics: true, fillSound: 'bowl', bigNumbers: false,
              revealStyle: 'painting',   // 'painting' = true art | 'shimmer' = glitter pixels
              reminders: false, reminderTime: 'morning' },
};
const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)').matches;

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
};

// ---------------------------------------------------------------- shims
// Placeholder integration seams: swap internals for real SDKs at store time
// (Sentry / Firebase / PostHog) without touching call sites.
// Events buffer locally (sp_events) exactly as before; when a PostHog key
// is present they also flush upstream in batches. Empty key = pure no-op,
// so this ships dark and lights up the moment Terry pastes the key from
// posthog.com project settings. Distinct id is a random install id — no
// personal data, resettable by clearing app storage.
const POSTHOG_KEY = '';                       // e.g. 'phc_XXXX' — off until set
const POSTHOG_HOST = 'https://us.i.posthog.com';
const Analytics = {
  _installId: null,
  track(event, props = {}) {
    try {
      const q = loadJSON('sp_events', []);
      q.push({ e: event, p: props, t: Date.now() });
      localStorage.setItem('sp_events', JSON.stringify(q.slice(-200)));
    } catch { /* analytics must never break the game */ }
  },
  flush() {
    if (!POSTHOG_KEY || !navigator.onLine) return;
    let q;
    try { q = loadJSON('sp_events', []); } catch { return; }
    const pending = q.filter((ev) => !ev.s);
    if (!pending.length) return;
    if (!this._installId) {
      try {
        this._installId = localStorage.getItem('sp_install')
          || (Math.random().toString(36).slice(2) + Date.now().toString(36));
        localStorage.setItem('sp_install', this._installId);
      } catch { this._installId = 'anon'; }
    }
    const batch = pending.slice(0, 50).map((ev) => ({
      event: ev.e,
      properties: { ...ev.p, distinct_id: this._installId },
      timestamp: new Date(ev.t).toISOString(),
    }));
    // keepalive lets the hide-flush finish after the app is backgrounded
    fetch(POSTHOG_HOST + '/batch/', {
      method: 'POST', keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: POSTHOG_KEY, batch }),
    }).then((r) => {
      if (!r.ok) return;
      try {                         // mark sent instead of deleting — the
        const q2 = loadJSON('sp_events', []);   // buffer stays a local debug log
        let n = batch.length;
        for (const ev of q2) { if (!ev.s && n > 0) { ev.s = 1; n--; } }
        localStorage.setItem('sp_events', JSON.stringify(q2));
      } catch { /* ignore */ }
    }).catch(() => { /* offline or blocked — retry next flush */ });
  },
};
document.addEventListener('visibilitychange',
  () => { if (document.hidden) Analytics.flush(); });
// Ad integration: Google AdMob via the Capacitor community plugin on native
// builds; a placeholder bar on plain web. Call sites are final either way.
// TEST ad unit IDs (Google's public ones) — swap for real units + the real
// APPLICATION_ID in AndroidManifest before release (docs/PLAY_SUBMISSION.md).
// AdMob IDs. Two different kinds, easy to confuse:
//   "~" = APP id   → AndroidManifest meta-data (runbook §2), not used here
//   "/" = AD UNIT  → the ids below
const ADMOB = {
  appId: 'ca-app-pub-6843582433295495~6377380669',      // manifest, not code
  banner: {
    id: 'ca-app-pub-6843582433295495/6356099282',       // LIVE
    testing: false,
  },
  rewarded: {
    id: 'ca-app-pub-6843582433295495/2438135651',       // LIVE
    testing: false,
  },
};
const ADMOB_TEST_PREFIX = 'ca-app-pub-3940256099942544/';
const ADMOB_TEST_IDS = {                     // Google's public test units
  banner: 'ca-app-pub-3940256099942544/6300978111',
  rewarded: 'ca-app-pub-3940256099942544/5224354917',
};

// DEV SWITCH — set true while testing on an emulator or a debug build.
// Real ads usually will NOT appear during development: AdMob withholds
// live ads from emulators (they look like invalid traffic), and a newly
// created ad unit can take hours before it serves anything. A blank
// banner in those conditions means "no ad was returned", not "broken".
// Test ads always fill, so this is how you prove the wiring works.
// MUST be false for the release build.
const FORCE_TEST_ADS = false;
function adUnit(kind) {
  const u = ADMOB[kind];
  if (!FORCE_TEST_ADS) return { id: u.id, isTesting: u.testing };
  // swap in the matching TEST unit — never request a live unit with
  // isTesting set, which would log impressions against real inventory
  return { id: ADMOB_TEST_IDS[kind] || u.id, isTesting: true };
}
const CAP = window.Capacitor;
const IS_NATIVE = !!(CAP && CAP.isNativePlatform && CAP.isNativePlatform());
function admobPlugin() {
  try {
    return (CAP.Plugins && CAP.Plugins.AdMob) ||
      (CAP.registerPlugin && CAP.registerPlugin('AdMob')) || null;
  } catch { return null; }
}

const Ads = {
  bannerOn: false,
  rewardedReady: false,
  _plugin: null,

  async init() {
    if (profile.removeAds) return;      // paid: no banner, ever
    if (!IS_NATIVE) { this._webBanner(); return; }
    try {
      const AdMob = this._plugin = admobPlugin();
      if (!AdMob) { this._webBanner(); return; }
      // per-unit isTesting below is the right granularity; initializing
      // globally for testing would force test ads over the live banner
      await AdMob.initialize({ initializeForTesting: false });
      if (ADMOB.rewarded.id.startsWith(ADMOB_TEST_PREFIX)) {
        Analytics.track('admob_rewarded_is_test_unit', {});
      }
      // adaptive banner pinned to the OS bottom — visible on every screen;
      // the layout just reserves space via --ad-h / html.has-ad
      AdMob.addListener('bannerAdSizeChanged', (info) => {
        if (info && info.height) this._reserve(info.height);
      });
      const bu = adUnit('banner');
      await AdMob.showBanner({
        adId: bu.id, adSize: 'ADAPTIVE_BANNER',
        position: 'BOTTOM_CENTER', isTesting: bu.isTesting,
      });
      this._reserve(60);              // sensible default until the size event
      $('adBanner').style.display = 'none';   // native view replaces the slot
      this._prepareRewarded();
    } catch { this._webBanner(); }    // ad failure must never break the app
  },
  _reserve(h) {
    this.bannerOn = true;
    document.documentElement.style.setProperty('--ad-h', h + 'px');
    document.documentElement.classList.add('has-ad');
  },
  _webBanner() {
    // plain web (GitHub Pages / dev): keep the reserved placeholder bar
    this._reserve(54);
    $('adBanner').classList.add('on');
  },
  hideBanner() {
    // remove-ads purchase: drop the reserved space and any native banner
    this.bannerOn = false;
    document.documentElement.classList.remove('has-ad');
    $('adBanner').classList.remove('on');
    if (IS_NATIVE && this._plugin) {
      this._plugin.removeBanner().catch(() => {});
    }
  },
  async _prepareRewarded() {
    try {
      const ru = adUnit('rewarded');
      await this._plugin.prepareRewardVideoAd(
        { adId: ru.id, isTesting: ru.isTesting });
      this.rewardedReady = true;
    } catch { this.rewardedReady = false; }
  },
  async showRewarded(kind, onReward) {
    Analytics.track('rewarded_start', { kind });
    // Grant EXACTLY once. Both the showRewardVideoAd() promise and the
    // Dismissed listener can legitimately fire for one view, and leaked
    // listeners from earlier views used to fire too — so the guard is what
    // makes "one video, one reward" true rather than hoped for.
    let granted = false;
    const grant = () => {
      if (granted) return;
      granted = true;
      try { onReward(); } catch { /* grant must not crash */ }
      Analytics.track('rewarded_done', { kind });
    };
    // OFFLINE vs NO-FILL are different failures and must be handled
    // differently. Offline is the player's own network: refuse, or
    // airplane mode becomes a free-unlock cheat. No-fill is OUR supply
    // problem — see the catch below.
    if (!navigator.onLine) {
      Analytics.track('rewarded_offline', { kind });
      toast('You’re offline — reconnect to watch a video');
      return;
    }
    if (IS_NATIVE && this._plugin) {
      const AdMob = this._plugin;
      let earned = false;
      let handles = [];
      const cleanup = () => {
        for (const h of handles) { try { h.remove(); } catch { /* gone */ } }
        handles = [];
      };
      // addListener resolves a HANDLE in Capacitor 6 — it is not the handle
      // itself. The old code called .remove() on the returned Promise, which
      // threw into a swallowing catch, so no listener was ever removed. Every
      // view leaked two, and each leaked Dismissed listener re-ran an older
      // closure on the next dismissal — silently multiplying rewards.
      try {
        handles = await Promise.all([
          AdMob.addListener('onRewardedVideoAdReward', () => { earned = true; }),
          AdMob.addListener('onRewardedVideoAdDismissed', () => {
            // Fallback path: the player closed the ad. If the reward event
            // arrived first this still pays out; grant() dedupes.
            if (earned) grant();
            else toast('Watch to the end to earn the reward');
            cleanup();
            this._prepareRewarded();      // preload the next one
          }),
        ]);
      } catch { /* listeners unavailable; the promise below still pays */ }
      try {
        // v6 resolves this WITH the reward item once the reward is earned.
        // That is the authoritative signal and the one the old code ignored:
        // it waited only for Dismissed, so any flow where Dismissed did not
        // arrive paid nothing at all despite a fully watched video.
        await AdMob.showRewardVideoAd();
        earned = true;
        grant();
        // A rewarded ad is SINGLE USE — the loaded ad is consumed by showing
        // it, and the next show fails until another is prepared. The old code
        // only re-prepared inside the Dismissed handler, the very handler
        // that was not firing, so a player got exactly one video per launch
        // and every later attempt found an empty slot.
        this._prepareRewarded();
      } catch {
        cleanup();
        // We are online but AdMob has nothing to serve. An unfilled
        // impression earns exactly nothing, so refusing the player costs
        // goodwill and gains no revenue — FAIL OPEN and let them paint.
        Analytics.track('rewarded_nofill', { kind });
        toast('No video available right now — this one’s on us');
        grant();
        this._prepareRewarded();
      }
      return;
    }
    // web placeholder: simulate a short ad then grant
    toast('🎬 Ad playing… (placeholder)');
    setTimeout(grant, 1200);
  },
};

// In-app purchase seam: remove_ads_forever ($7.99) — no banner + the whole
// catalog unlocked permanently. Rewarded videos REMAIN available after
// purchase (bonus boosters are always ad-earned). On native this becomes
// Google Play Billing (docs/PLAY_SUBMISSION.md §IAP); the web/dev build
// grants directly as a placeholder.
// LAUNCH BUILD SHIPS WITHOUT IN-APP PURCHASE — ads only. Every purchase
// surface is removed from the DOM at boot (applyIapVisibility). Flip this
// to true and wire Play Billing (docs/PLAY_SUBMISSION.md §2b) to bring the
// $7.99 remove-ads back; the IAP object and profile.removeAds handling
// below stay intact so that is a one-line change.
const IAP_ENABLED = false;

const IAP = {
  PRICE: '$7.99',
  owned() { return !!profile.removeAds; },
  buy() {
    if (this.owned()) { toast('Already unlocked — thank you! 💚'); return; }
    Analytics.track('iap_start', {});
    if (IS_NATIVE) {
      // Google Play Billing flow lands here with the store build
      // (product id: remove_ads_forever); grant() runs on purchase success
      toast('Purchasing arrives with the store build');
      return;
    }
    this.grant();   // web/dev placeholder — the store build charges first
  },
  grant() {
    profile.removeAds = true;
    saveNow();
    Ads.hideBanner();
    syncOwnedUI();
    if ($('gallery').classList.contains('active')) buildGallery();
    Analytics.track('iap_done', {});
    toast('Everything unlocked, ads removed — thank you! 💚');
  },
};
function syncOwnedUI() {
  const owned = IAP.owned();
  for (const id of ['setBuyAll', 'shopBuyAll']) {
    const b = $(id);
    if (b) { b.textContent = owned ? '✓ Owned' : IAP.PRICE; b.disabled = owned; }
  }
}
// the web build (GitHub Pages, dev preview) has no notification plugin, so
// hide the controls rather than offer a switch that does nothing
function applyReminderVisibility() {
  if (Notify.available()) return;
  for (const id of ['rowReminders', 'rowReminderTime']) {
    const row = $(id);
    if (row) row.remove();
  }
}

// strip every purchase surface when IAP is off, so nothing advertises a
// product the store build cannot sell
function applyIapVisibility() {
  if (IAP_ENABLED) return;
  for (const id of ['setBuyAll', 'shopBuyAll', 'unlockBuyAll']) {
    const b = $(id);
    if (!b) continue;
    const row = b.closest('.row');
    (row || b).remove();
  }
}

// ---------------------------------------------------------------- reminders
// Local notifications via @capacitor/local-notifications. No server, no
// network, nothing collected — so unlike analytics this needs no privacy
// policy or Data Safety change.
//
// The design does the work here, not the plugin:
//  * ONE note a day, never more, and NEVER on a day you already opened the
//    app — every launch cancels the pending series and re-schedules from
//    TOMORROW, so the reminder only ever reaches someone who is away.
//  * Copy names the actual painting waiting that morning (the rotation is
//    deterministic, so future days are knowable today).
//  * No streaks, no loss framing, no urgency — the brief forbids it, and
//    this audience is the one most likely to uninstall over nagging.
//  * Inexact alarms only. Exact alarms need a restricted Android
//    permission and Play justification; a gentle reminder does not.
const REMINDER_DAYS = 14;          // rolling window, topped up each launch
const REMINDER_ID_BASE = 8100;
const REMINDER_COPY = [
  { t: "Today's painting is ready", b: '{name} — whenever you’d like to sit down.' },
  { t: 'A quiet moment?',           b: "Today's painting is {name}." },
  { t: "Today's painting: {name}",  b: 'A few unhurried minutes, whenever it suits you.' },
  { t: 'Your canvas is waiting',    b: '{name} is today’s picture. No rush at all.' },
  { t: 'Something new to paint',    b: 'Today it’s {name}. Take your time.' },
  { t: 'A painting for today',      b: '{name}. It’ll keep until you’re ready.' },
  { t: 'Ready when you are',        b: "Today's painting is {name}." },
  { t: "Today's picture: {name}",   b: 'A calm few minutes, whenever you like.' },
  { t: 'Your studio is open',       b: '{name} is waiting. No hurry.' },
  { t: 'A little color today?',     b: "Today's painting is {name}." },
  { t: "Today's painting: {name}",  b: 'Still here whenever you’d like to paint.' },
  { t: 'A quiet corner awaits',     b: '{name} is today’s picture.' },
  { t: 'Whenever you’re ready', b: "Today's painting is {name}. Take your time." },
  { t: 'A painting for today',      b: '{name} — no rush, it’ll keep.' },
];

const Notify = {
  plugin() {
    try {
      return (CAP.Plugins && CAP.Plugins.LocalNotifications) ||
        (CAP.registerPlugin && CAP.registerPlugin('LocalNotifications')) || null;
    } catch { return null; }
  },
  available() { return IS_NATIVE && !!this.plugin(); },

  // Soft-ask first: only raise the OS prompt after the player has said yes
  // in our own words. Android grants that prompt once — spending it on a
  // "no" is unrecoverable.
  async enable() {
    const LN = this.plugin();
    if (!LN) return false;
    try {
      let perm = await LN.checkPermissions();
      if (perm.display !== 'granted') perm = await LN.requestPermissions();
      if (perm.display !== 'granted') {
        toast('Reminders are off in your device settings');
        return false;
      }
      profile.settings.reminders = true;
      saveNow();
      await this.reschedule();
      Analytics.track('reminders_on', {});
      return true;
    } catch { return false; }
  },
  async disable() {
    profile.settings.reminders = false;
    saveNow();
    await this.clear();
    Analytics.track('reminders_off', {});
  },
  async clear() {
    const LN = this.plugin();
    if (!LN) return;
    try {
      const pending = await LN.getPending();
      const list = (pending && pending.notifications) || [];
      if (list.length) await LN.cancel({ notifications: list.map((n) => ({ id: n.id })) });
    } catch { /* never fatal */ }
  },
  copyFor(k, dayNumber) {
    const c = REMINDER_COPY[(k - 1) % REMINDER_COPY.length];
    const id = dailyLevelIdFor(dayNumber);
    const lvl = id && LEVELS.find((l) => l.id === id);
    const name = lvl ? lvl.name : 'a new painting';
    return { title: c.t.replace('{name}', name), body: c.b.replace('{name}', name) };
  },
  async reschedule() {
    if (!this.available() || !profile.settings.reminders) return;
    const LN = this.plugin();
    try {
      await this.clear();          // opening the app pushes the series back
      const hour = profile.settings.reminderTime === 'evening' ? 19 : 10;
      const today = Math.floor(Date.now() / 86400000);
      const notifications = [];
      for (let k = 1; k <= REMINDER_DAYS; k++) {
        const at = new Date();
        at.setDate(at.getDate() + k);
        at.setHours(hour, 0, 0, 0);
        const c = this.copyFor(k, today + k);
        notifications.push({
          id: REMINDER_ID_BASE + k, title: c.title, body: c.body,
          schedule: { at },        // inexact by design
        });
      }
      // a seasonal collection opening is worth its own note
      for (const ev of EVENTS) {
        const start = Date.parse(ev.start);
        const days = Math.round((start - Date.now()) / 86400000);
        if (days < 1 || days > REMINDER_DAYS) continue;
        if (!LEVELS.some((l) => l.cat === ev.cat)) continue;
        const at = new Date(start);
        at.setHours(hour, 0, 0, 0);
        notifications.push({
          id: REMINDER_ID_BASE + 100 + days,
          title: ev.label,
          body: `A limited collection of ${LEVELS.filter((l) => l.cat === ev.cat).length} paintings is here.`,
          schedule: { at },
        });
      }
      await LN.schedule({ notifications });
    } catch { /* reminders must never break the app */ }
  },
};

function bufferError(entry) {
  try {
    const errs = loadJSON('sp_errors', []);
    errs.push(Object.assign({ t: Date.now() }, entry));
    localStorage.setItem('sp_errors', JSON.stringify(errs.slice(-20)));
  } catch { /* ditto */ }
}
addEventListener('error', (e) =>
  bufferError({ m: String(e.message), s: `${e.filename || ''}:${e.lineno || 0}` }));
addEventListener('unhandledrejection', (e) =>
  bufferError({ m: 'unhandledrejection: ' + String(e.reason && e.reason.message || e.reason) }));

// ---------------------------------------------------------------- storage
function loadJSON(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch { return fallback; }
}
const profile = Object.assign({}, STARTING_PROFILE, loadJSON('sp_profile', {}));
profile.boosters = Object.assign({}, STARTING_PROFILE.boosters, profile.boosters);
profile.settings = Object.assign({}, STARTING_PROFILE.settings, profile.settings);
// retired themes (kawaii-era jackpot/slime) fall back to the calm default
if (!['music', 'bowl', 'pop', 'tap', 'drop', 'keys'].includes(profile.settings.fillSound)) {
  profile.settings.fillSound = 'bowl';
}
if (!['painting', 'shimmer'].includes(profile.settings.revealStyle)) {
  profile.settings.revealStyle = 'painting';
}
profile.removeAds = !!profile.removeAds;
profile.seenUnlockExplainer = !!profile.seenUnlockExplainer;
delete profile.unlocked;   // retired pre-release model (permanent ad unlocks)
// dark mode: first run follows the device preference, then the toggle rules
if (profile.settings.dark === undefined) {
  profile.settings.dark = matchMedia('(prefers-color-scheme: dark)').matches;
}
function applyTheme() {
  const dark = !!profile.settings.dark;
  document.documentElement.classList.toggle('dark', dark);
  const t = $('darkToggle');
  if (t) {
    t.classList.toggle('on', dark);
    t.querySelector('i').textContent = dark ? '🌙' : '☀️';
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = dark ? '#131418' : '#ffffff';
  if (typeof resizeBoard === 'function' && board) resizeBoard();   // rebuild canvas wash
}

let saveTimer = null;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 400);
}
function saveNow() {
  clearTimeout(saveTimer);
  if (restoring) return;
  try {   // storage can throw (quota, private mode) — never crash the game
    localStorage.setItem('sp_profile', JSON.stringify(profile));
    if (G.level) {
      let bin = '';
      for (let i = 0; i < G.filled.length; i++) bin += String.fromCharCode(G.filled[i]);
      localStorage.setItem('sp_prog_' + G.level.id, JSON.stringify({
        f: btoa(bin), fc: G.filledCount, pc: G.perColor, done: G.done,
        ts: Date.now(), sel: G.selected,
        cam: { z: G.zoom, x: G.panX, y: G.panY },
      }));
    }
  } catch (e) { bufferError({ m: 'saveNow: ' + e.message }); }
}
addEventListener('pagehide', saveNow);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    saveNow();
    if (Sound.ctx && Sound.ctx.state === 'running') Sound.ctx.suspend();
  } else if (Sound.ctx && Sound.ctx.state === 'suspended') {
    Sound.ctx.resume();
  }
});

function levelProgressSummary(level) {
  const p = loadJSON('sp_prog_' + level.id, null);
  const total = level.palette.reduce((s, c) => s + c.count, 0);
  return { pct: p ? p.fc / total : 0, done: !!(p && p.done), ts: (p && p.ts) || 0 };
}
function tierFor(level) {
  // Difficulty is cells AND colors: cells set how LONG a painting takes,
  // colors set how hard each decision is (more numbers = more hunting).
  // Scoring on cells alone labelled the whole catalog "Hard" once every
  // painting passed 4,200 cells — a 7,000-cell 3-color emblem is long but
  // genuinely easy, and the shelf should say so.
  const cells = level.palette.reduce((s, c) => s + c.count, 0);
  const score = cells * level.palette.length;
  return score < 35000 ? '🌱 Easy' : score < 80000 ? '⭐ Medium' : '💎 Hard';
}
// The daily rotation is a pure function of the day number, so FUTURE days
// are computable now — which is what lets a reminder scheduled a week out
// name the actual painting waiting that morning.
function dailyLevelIdFor(dayNumber) {
  const pool = LEVELS.filter((l) => l.cat !== 'myphotos');
  if (!pool.length) return null;
  return pool[((dayNumber % pool.length) + pool.length) % pool.length].id;
}
function dailyLevelId() {
  // PINNED per day. dailyLevelIdFor indexes into the level pool, so the
  // remote catalog growing mid-session would remap today's free painting
  // out from under whoever is painting it. First computation of a given
  // day wins and is stored; merges only affect FUTURE days.
  const day = Math.floor(Date.now() / 86400000);
  const key = 'sp_daily_' + day;
  try {
    const pinned = localStorage.getItem(key);
    if (pinned && LEVELS.some((l) => l.id === pinned)) return pinned;
    const id = dailyLevelIdFor(day);
    if (id) localStorage.setItem(key, id);
    localStorage.removeItem('sp_daily_' + (day - 1));   // yesterday's pin
    return id;
  } catch { return dailyLevelIdFor(day); }
}
const CATS = {
  myphotos:   { label: 'My Photos',   icon: '\uD83D\uDCF7', bg: '#f2ede4' },
  // Order here IS the shelf + circle order. Homes leads: it is the app
  // icon's subject and the listing's headline promise, so the first shelf
  // should pay that off before the player scrolls. Zodiac sets sit at the
  // bottom (niche taste vs. the universal homes/florals/animals), just
  // above the always-last My Photos.
  homes:      { label: 'Homes',       icon: '\uD83C\uDFE1', bg: '#f5f0e8' },
  interiors:  { label: 'Interiors',   icon: '\uD83D\uDECB', bg: '#f3eee8' },
  farmhouse:  { label: 'Farmhouse',   icon: '\uD83D\uDC04', bg: '#f2efe7' },
  flowers:    { label: 'Flowers',     icon: '\uD83C\uDF38', bg: '#f6eef0' },
  botanical:  { label: 'Botanical',   icon: '\uD83C\uDF3F', bg: '#edf2ec' },
  mandalas:   { label: 'Mandalas',    icon: '\uD83E\uDEB7', bg: '#efe9f2' },
  animals:    { label: 'Animals',     icon: '\uD83D\uDC3E', bg: '#f0ede6' },
  pets:       { label: 'Pets',        icon: '\uD83D\uDC31', bg: '#f4efe9' },
  birds:      { label: 'Birds',       icon: '\uD83D\uDC26', bg: '#edf1ea' },
  landscapes: { label: 'Landscapes',  icon: '\uD83C\uDFDE', bg: '#eef2ea' },
  stilllife:  { label: 'Still Life',  icon: '\uD83C\uDFFA', bg: '#f2eee9' },
  coastal:    { label: 'Coastal',     icon: '\uD83C\uDF0A', bg: '#eaf0f3' },
  // Seasonal shelves. Safe to declare with no paintings — buildGallery
  // filters to categories that have levels, so these stay invisible until
  // the remote catalog drops art into them, then appear WITHOUT an app
  // update. Their events below are dormant on the same rule.
  christmas:  { label: 'Christmas',   icon: '\uD83C\uDF84', bg: '#eef2ec' },
  easter:     { label: 'Easter',      icon: '\uD83D\uDC23', bg: '#f6f0e8' },
  mothersday: { label: "Mother's Day", icon: '\uD83D\uDC90', bg: '#f6eef2' },
  autumn:     { label: 'Autumn',      icon: '\uD83C\uDF41', bg: '#f5efe6' },
  zodiac:     { label: 'Zodiac',      icon: '\uD83C\uDF19', bg: '#eaeaf2' },
  cnyzodiac:  { label: 'Chinese Zodiac', icon: '\uD83D\uDC09', bg: '#f4ebe8' },
};
let galleryFilter = 'all';

// Limited-time events: add an entry + a themed pack (cat) and the lobby
// grows a countdown shelf + hero slide automatically while it's live.
// Lunar New Year: seeded several years ahead so this needs no code change
// each January. Windows open ~2 weeks before the new year and close after
// the Lantern Festival (15 days after). The label names that year's animal,
// so the shelf renames itself automatically.
const EVENTS = [
  { id: 'lny2027', label: '\uD83D\uDC10 Year of the Goat', cat: 'cnyzodiac',
    start: '2027-01-23', end: '2027-02-21' },   // new year Feb 6 2027
  { id: 'lny2028', label: '\uD83D\uDC12 Year of the Monkey', cat: 'cnyzodiac',
    start: '2028-01-12', end: '2028-02-10' },   // new year Jan 26 2028
  { id: 'lny2029', label: '\uD83D\uDC13 Year of the Rooster', cat: 'cnyzodiac',
    start: '2029-01-30', end: '2029-02-28' },   // new year Feb 13 2029
  { id: 'lny2030', label: '\uD83D\uDC15 Year of the Dog', cat: 'cnyzodiac',
    start: '2030-01-20', end: '2030-02-18' },   // new year Feb 3 2030
  // US-calendar holidays for the 50+ audience. Short, specific events are
  // listed before the long autumn season so they win when windows overlap.
  { id: 'xmas2026', label: '\uD83C\uDF84 Christmas Paintings', cat: 'christmas',
    start: '2026-12-01', end: '2026-12-26' },
  { id: 'xmas2027', label: '\uD83C\uDF84 Christmas Paintings', cat: 'christmas',
    start: '2027-12-01', end: '2027-12-26' },
  { id: 'xmas2028', label: '\uD83C\uDF84 Christmas Paintings', cat: 'christmas',
    start: '2028-12-01', end: '2028-12-26' },
  { id: 'easter2027', label: '\uD83D\uDC23 Easter Paintings', cat: 'easter',
    start: '2027-03-14', end: '2027-04-04' },   // Easter Mar 28 2027
  { id: 'easter2028', label: '\uD83D\uDC23 Easter Paintings', cat: 'easter',
    start: '2028-04-02', end: '2028-04-16' },   // Easter Apr 16 2028
  { id: 'easter2029', label: '\uD83D\uDC23 Easter Paintings', cat: 'easter',
    start: '2029-03-18', end: '2029-04-01' },   // Easter Apr 1 2029
  { id: 'mday2027', label: "\uD83D\uDC90 For Mother's Day", cat: 'mothersday',
    start: '2027-04-26', end: '2027-05-10' },   // 2nd Sunday May 9 2027
  { id: 'mday2028', label: "\uD83D\uDC90 For Mother's Day", cat: 'mothersday',
    start: '2028-05-01', end: '2028-05-15' },   // May 14 2028
  { id: 'fall2026', label: '\uD83C\uDF41 Autumn Colors', cat: 'autumn',
    start: '2026-09-22', end: '2026-11-30' },
  { id: 'fall2027', label: '\uD83C\uDF41 Autumn Colors', cat: 'autumn',
    start: '2027-09-22', end: '2027-11-30' },
];
// player-created levels (photo import) — same shape as shipped levels
const MAX_USER_LEVELS = 20;
function loadUserLevels() {
  const ul = loadJSON('sp_user_levels', []);
  if (!Array.isArray(ul)) return;
  for (const lv of ul) {
    try {
      if (lv && lv.id && lv.id.startsWith('user_') && lv.width > 0 && lv.height > 0 &&
          Array.isArray(lv.palette) && typeof lv.cells === 'string' &&
          decodeCells(lv.cells).length === lv.width * lv.height) {
        lv.cat = 'myphotos';
        LEVELS.push(lv);
      }
    } catch { /* skip corrupt entries */ }
  }
}
function userLevelCount() { return LEVELS.filter((l) => l.cat === 'myphotos').length; }
function deleteUserLevel(id) {
  if (!confirm('Delete this picture and its progress?')) return;
  const ul = loadJSON('sp_user_levels', []).filter((l) => l && l.id !== id);
  try { localStorage.setItem('sp_user_levels', JSON.stringify(ul)); } catch { /* ignore */ }
  localStorage.removeItem('sp_prog_' + id);
  const i = LEVELS.findIndex((l) => l.id === id);
  if (i >= 0) LEVELS.splice(i, 1);
  thumbCache.clear();
  Analytics.track('photo_delete', {});
  buildGallery();
}

function activeEvent() {
  const now = Date.now();
  return EVENTS.find((e) =>
    now >= Date.parse(e.start) && now < Date.parse(e.end) &&
    LEVELS.some((l) => l.cat === e.cat)) || null;
}
function eventDaysLeft(e) {
  return Math.max(1, Math.ceil((Date.parse(e.end) - Date.now()) / 86400000));
}

// ---------------------------------------------------------------- helpers
function decodeCells(b64) {
  try {
    const bin = atob(b64);
    const a = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    return a;
  } catch { return new Uint8Array(0); }   // corrupt data → caller falls back
}
function hexRGB(hex) {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}
function luminance(hex) {
  const [r, g, b] = hexRGB(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}
// Ghost-grey mapping for UNFILLED cells at working zoom. Widened from
// 244-t*60 (spread 54): at that range the board's structure was invisible
// while zoomed in — sky, hills and walls all read as the same pale wash.
// The floor stays at 148 ON PURPOSE: number ink must clear contrast on
// every unfilled cell, and mid-greys are where no single ink works. At a
// 148 floor, a dark ink still reads everywhere (verified ≥3:1 across all
// 76 palettes); numberInkFor() picks the darker ink for the darker cells.
// The zoomed-OUT view is a different layer (previewCanvas, spread 152)
// and was never washed out — do not "fix" it.
function ghostGray(hex) {
  return Math.round(242 - (1 - luminance(hex)) * 94);
}
function numberInkFor(v) {
  // Two inks because one cannot span the widened ghost range. Thresholds
  // and values are VERIFIED, not chosen: worst-case contrast across every
  // palette entry in the shipped catalog is 3.23:1 (>=3:1 large-text AA).
  // The old single ink #7a7a82 measured 2.57:1 at the boundary cells.
  return v < 200 ? '#2e2e33' : '#6a6a72';
}
function grayFor(hex) {
  const v = ghostGray(hex);
  return `rgb(${v},${v},${v})`;
}
function textColorOn(hex) { return luminance(hex) > 0.62 ? '#3a3a3f' : '#fff'; }
function shade(hex, f) {
  const [r, g, b] = hexRGB(hex);
  return `rgb(${(r * f) | 0},${(g * f) | 0},${(b * f) | 0})`;
}
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const ease = (k) => 1 - Math.pow(1 - k, 3);
// cell-number size as a fraction of cell width; "Larger numbers" is the
// 50+ accessibility setting (Settings sheet)
const numberScale = () => (profile.settings.bigNumbers ? 0.58 : 0.44);

// ---------------------------------------------------------------- sound
// ASMR-style fill sound: a soft water-droplet tone layered with a whisper of
// filtered noise, subtle stereo drift, and a generated reverb tail. Chained
// fills climb a major-pentatonic ladder so drag-painting plays a tiny melody.
// Fill-sound themes (profile.settings.fillSound), ranked by ASMR popularity
// research: 'pop' = real bubble-pop recordings (Mixkit, free license) — the
// dominant satisfying-game sound; 'tap' = synthesized soft wood tap (the #2
// ASMR trigger); 'drop' = the synthesized water droplet.
const POP_FILES = ['sounds/pop_1.mp3', 'sounds/pop_2.mp3', 'sounds/pop_3.mp3', 'sounds/pop_4.mp3'];
const PENTATONIC = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];
const Sound = {
  ctx: null, master: null, wet: null, noiseBuf: null,
  popBufs: [], popLoading: false,
  combo: 0, lastTick: 0,
  ac() {
    if (!this.ctx) {
      const ac = this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      const comp = ac.createDynamicsCompressor();
      comp.threshold.value = -22; comp.knee.value = 18;
      comp.ratio.value = 8; comp.attack.value = 0.002; comp.release.value = 0.12;
      comp.connect(ac.destination);
      this.master = ac.createGain();
      this.master.gain.value = 0.9;
      this.master.connect(comp);
      // lush reverb: convolver fed a generated exponential-decay noise impulse
      // (long tail — the music direction wants taps "drenched in reverb")
      const dur = 2.4, len = (ac.sampleRate * dur) | 0;
      const ir = ac.createBuffer(2, len, ac.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const d = ir.getChannelData(ch);
        for (let i = 0; i < len; i++)
          d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.2);
      }
      const conv = ac.createConvolver();
      conv.buffer = ir;
      this.wet = ac.createGain();
      this.wet.gain.value = 0.35;
      // highpass after the convolver: the noise-based IR has low-frequency
      // energy that reads as buzz/rumble — keep only the airy top of the tail
      const wetHP = ac.createBiquadFilter();
      wetHP.type = 'highpass'; wetHP.frequency.value = 280; wetHP.Q.value = 0.6;
      this.wet.connect(conv);
      conv.connect(wetHP);
      wetHP.connect(this.master);
      // cached noise source material for the tactile "paper" layer
      const nb = ac.createBuffer(1, ac.sampleRate * 0.15, ac.sampleRate);
      const nd = nb.getChannelData(0);
      for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
      this.noiseBuf = nb;
      this.loadPops();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  },
  loadPops() {
    if (this.popLoading || this.popBufs.length) return;
    this.popLoading = true;
    POP_FILES.forEach((url, i) =>
      fetch(url)
        .then((r) => r.arrayBuffer())
        .then((ab) => this.ctx.decodeAudioData(ab))
        .then((buf) => { this.popBufs[i] = buf; })
        .catch(() => {}));   // fetch failure → droplet fallback keeps playing
  },
  // real bubble-pop sample: random variation, combo raises pitch slightly
  pop(combo) {
    const ac = this.ac();
    const bufs = this.popBufs.filter(Boolean);
    if (!bufs.length) {      // samples not ready yet — droplet fallback
      this.drop(392 * Math.pow(2, PENTATONIC[combo] / 12), { pan: (Math.random() - 0.5) * 0.5 });
      return;
    }
    const t = ac.currentTime;
    const src = ac.createBufferSource();
    // variation 4 (soap-bubble "blub-pop") is a rare treat, not the staple
    src.buffer = Math.random() < 0.12 && bufs.length > 3
      ? bufs[3] : bufs[(Math.random() * Math.min(3, bufs.length)) | 0];
    src.playbackRate.value = (1 + combo * 0.03) * (0.94 + Math.random() * 0.12);
    const g = ac.createGain();
    g.gain.value = 0.5;
    let tail = g;
    if (ac.createStereoPanner) {
      const p = ac.createStereoPanner();
      p.pan.value = (Math.random() - 0.5) * 0.5;
      g.connect(p); tail = p;
    }
    tail.connect(this.master);
    const send = ac.createGain();   // pops sound best fairly dry — light reverb
    send.gain.value = 0.12;
    g.connect(send).connect(this.wet);
    src.connect(g);
    src.start(t);
  },
  // singing-bowl: one pentatonic note with warm harmonic partials, long
  // sung decay, drenched in reverb — the "harmonious ASMR" theme
  bowl(n) {
    if (!profile.settings.sound) return;
    const now = performance.now();
    if (now - (this._lastBowl || 0) < 70) return;
    this._lastBowl = now;
    const ac = this.ac(), t = ac.currentTime;
    const PENT = [0, 2, 4, 7, 9];
    const idx = ((n || 1) - 1) % 15;
    const f = 261.63 * Math.pow(2, (PENT[idx % 5] + 12 * Math.floor(idx / 5)) / 12);
    const out = ac.createGain();
    let tail = out;
    if (ac.createStereoPanner) {
      const p = ac.createStereoPanner();
      p.pan.value = (Math.random() - 0.5) * 0.6;
      out.connect(p); tail = p;
    }
    tail.connect(this.master);
    const wetS = ac.createGain();
    wetS.gain.value = 0.9;
    out.connect(wetS);
    wetS.connect(this.wet);
    // bowl partials: slightly sharp octave + twelfth give the metallic "sing"
    const partials = [[1, 0.09, 2.4], [2.004, 0.028, 1.6], [3.011, 0.012, 0.9]];
    for (const [ratio, gain, dur] of partials) {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = 'sine';
      o.frequency.value = f * ratio;
      o.detune.value = (Math.random() - 0.5) * 5;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(out);
      o.start(t); o.stop(t + dur + 0.1);
    }
  },

  // slot-machine payout: bright metallic ding climbing a major arpeggio,
  // with a little coin-cascade flourish every 5th chained fill
  jackpot(combo) {
    if (!profile.settings.sound) return;
    const ac = this.ac(), t = ac.currentTime;
    const ARP = [0, 4, 7, 12, 16, 19, 24, 28, 31, 36, 40, 43, 48, 52, 55];
    const ding = (semis, when, gain) => {
      const f = 1046.5 * Math.pow(2, semis / 12);   // C6 base — casino bright
      const out = ac.createGain();
      let tail = out;
      if (ac.createStereoPanner) {
        const p = ac.createStereoPanner();
        p.pan.value = (Math.random() - 0.5) * 0.5;
        out.connect(p); tail = p;
      }
      tail.connect(this.master);
      const wetS = ac.createGain();
      wetS.gain.value = 0.25;                        // dings stay crisp
      out.connect(wetS);
      wetS.connect(this.wet);
      const o1 = ac.createOscillator(), g1 = ac.createGain();
      o1.type = 'triangle'; o1.frequency.value = f;
      g1.gain.setValueAtTime(0.0001, t + when);
      g1.gain.exponentialRampToValueAtTime(gain, t + when + 0.004);
      g1.gain.exponentialRampToValueAtTime(0.0001, t + when + 0.34);
      o1.connect(g1).connect(out);
      o1.start(t + when); o1.stop(t + when + 0.4);
      const o2 = ac.createOscillator(), g2 = ac.createGain();
      o2.type = 'square'; o2.frequency.value = f * 2;
      g2.gain.setValueAtTime(0.0001, t + when);
      g2.gain.exponentialRampToValueAtTime(gain * 0.18, t + when + 0.003);
      g2.gain.exponentialRampToValueAtTime(0.0001, t + when + 0.09);
      o2.connect(g2).connect(out);
      o2.start(t + when); o2.stop(t + when + 0.12);
    };
    ding(ARP[Math.min(combo, ARP.length - 1)], 0, 0.075);
    if (combo > 0 && combo % 5 === 0) {              // payout flourish
      ding(ARP[(combo + 2) % ARP.length], 0.05, 0.05);
      ding(ARP[(combo + 4) % ARP.length], 0.1, 0.045);
      ding(ARP[(combo + 7) % ARP.length], 0.15, 0.04);
    }
  },

  // mechanical-keyboard "thock": felt-damped thump + lowpassed key noise
  keys(combo) {
    if (!profile.settings.sound) return;
    const ac = this.ac(), t = ac.currentTime;
    const out = ac.createGain();
    let tail = out;
    if (ac.createStereoPanner) {
      const p = ac.createStereoPanner();
      p.pan.value = (Math.random() - 0.5) * 0.7;
      out.connect(p); tail = p;
    }
    tail.connect(this.master);
    const f = (95 + combo * 4) * (0.92 + Math.random() * 0.16);
    const o = ac.createOscillator(), og = ac.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(f * 1.8, t);
    o.frequency.exponentialRampToValueAtTime(f, t + 0.015);
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(0.14, t + 0.003);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
    o.connect(og).connect(out);
    o.start(t); o.stop(t + 0.09);
    const n = ac.createBufferSource(), nf = ac.createBiquadFilter(), ng = ac.createGain();
    n.buffer = this.noiseBuf;
    nf.type = 'lowpass';
    nf.frequency.value = 1100 + Math.random() * 500;
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(0.055, t + 0.002);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
    n.connect(nf).connect(ng).connect(out);
    n.start(t); n.stop(t + 0.07);
  },

  // slime squelch: bandpass noise sweeping down + wobbly low blip
  slime(combo) {
    if (!profile.settings.sound) return;
    const ac = this.ac(), t = ac.currentTime;
    const out = ac.createGain();
    let tail = out;
    if (ac.createStereoPanner) {
      const p = ac.createStereoPanner();
      p.pan.value = (Math.random() - 0.5) * 0.6;
      out.connect(p); tail = p;
    }
    tail.connect(this.master);
    const wetS = ac.createGain();
    wetS.gain.value = 0.2;
    out.connect(wetS);
    wetS.connect(this.wet);
    const n = ac.createBufferSource(), nf = ac.createBiquadFilter(), ng = ac.createGain();
    n.buffer = this.noiseBuf;
    nf.type = 'bandpass'; nf.Q.value = 2.2;
    const startF = 1200 + Math.random() * 600 + combo * 40;
    nf.frequency.setValueAtTime(startF, t);
    nf.frequency.exponentialRampToValueAtTime(280, t + 0.11);
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(0.10, t + 0.008);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
    n.connect(nf).connect(ng).connect(out);
    n.start(t); n.stop(t + 0.16);
    const o = ac.createOscillator(), og = ac.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(230 * (0.9 + Math.random() * 0.2), t);
    o.frequency.exponentialRampToValueAtTime(130, t + 0.09);
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(0.06, t + 0.01);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
    o.connect(og).connect(out);
    o.start(t); o.stop(t + 0.13);
  },

  // synthesized soft wood tap: low thump + tiny filtered click
  tap(combo) {
    if (!profile.settings.sound) return;
    const ac = this.ac(), t = ac.currentTime;
    const out = ac.createGain();
    let tail = out;
    if (ac.createStereoPanner) {
      const p = ac.createStereoPanner();
      p.pan.value = (Math.random() - 0.5) * 0.6;
      out.connect(p); tail = p;
    }
    tail.connect(this.master);
    const o = ac.createOscillator(), og = ac.createGain();
    o.type = 'sine';
    const f = (170 + combo * 9) * (0.95 + Math.random() * 0.1);
    o.frequency.setValueAtTime(f * 1.6, t);
    o.frequency.exponentialRampToValueAtTime(f, t + 0.02);
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(0.16, t + 0.004);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    o.connect(og).connect(out);
    o.start(t); o.stop(t + 0.12);
    const n = ac.createBufferSource(), nf = ac.createBiquadFilter(), ng = ac.createGain();
    n.buffer = this.noiseBuf;
    nf.type = 'bandpass';
    nf.frequency.value = 1700 + Math.random() * 900;
    nf.Q.value = 1.4;
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(0.05, t + 0.003);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.035);
    n.connect(nf).connect(ng).connect(out);
    n.start(t); n.stop(t + 0.06);
  },
  // voice: soft sine droplet with a gentle downward glide + noise whisper
  drop(freq, { gain = 0.09, dur = 0.22, pan = 0, when = 0, noise = 0.018 } = {}) {
    if (!profile.settings.sound) return;
    const ac = this.ac(), t = ac.currentTime + when;
    const out = ac.createGain();
    let tail = out;
    if (ac.createStereoPanner) {
      const p = ac.createStereoPanner();
      p.pan.value = pan;
      out.connect(p); tail = p;
    }
    tail.connect(this.master);
    out.connect(this.wet);

    const o = ac.createOscillator(), og = ac.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(freq * 1.10, t);                 // tiny glide down = "bloop"
    o.frequency.exponentialRampToValueAtTime(freq, t + 0.05);
    o.detune.value = (Math.random() - 0.5) * 14;                // organic, never identical
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(gain, t + 0.008);      // soft attack, no click
    og.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(og).connect(out);
    o.start(t); o.stop(t + dur + 0.05);

    if (noise > 0) {                                            // paper-touch whisper
      const n = ac.createBufferSource(), nf = ac.createBiquadFilter(), ng = ac.createGain();
      n.buffer = this.noiseBuf;
      nf.type = 'bandpass';
      nf.frequency.value = 2800 + Math.random() * 1800;
      nf.Q.value = 0.8;
      ng.gain.setValueAtTime(0.0001, t);
      ng.gain.exponentialRampToValueAtTime(noise, t + 0.005);
      ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
      n.connect(nf).connect(ng).connect(out);
      n.start(t); n.stop(t + 0.1);
    }
  },
  preview(n) {
    // selecting a swatch plays its note — color-switching joins the song
    try {
      if (!profile.settings.sound) return;
      const th = profile.settings.fillSound;
      if (th === 'music') Music.note(n);
      else if (th === 'bowl') { this._lastBowl = 0; this.bowl(n); }
      else {
        const PENT = [0, 2, 4, 7, 9];
        const idx = ((n || 1) - 1) % 15;
        this.drop(261.63 * Math.pow(2, (PENT[idx % 5] + 12 * ((idx / 5) | 0)) / 12),
          { gain: 0.05, dur: 0.18 });
      }
    } catch { /* preview must never throw */ }
  },
  tick(n) {
    const now = performance.now();
    this.combo = now - this.lastTick < 350 ? Math.min(this.combo + 1, PENTATONIC.length - 1) : 0;
    this.lastTick = now;
    try {   // audio failure (unsupported ctx, decode issues) must never crash play
      if (profile.settings.sound) {
        const theme = profile.settings.fillSound;
        if (theme === 'music') Music.note(n || G.selected);
        else if (theme === 'bowl') this.bowl(n || G.selected);
        else if (theme === 'jackpot') this.jackpot(this.combo);
        else if (theme === 'keys') this.keys(this.combo);
        else if (theme === 'slime') this.slime(this.combo);
        else if (theme === 'tap') this.tap(this.combo);
        else if (theme === 'drop')
          this.drop(392 * Math.pow(2, PENTATONIC[this.combo] / 12), { pan: (Math.random() - 0.5) * 0.5 });
        else this.pop(this.combo);
      }
    } catch (e) { bufferError({ m: 'Sound.tick: ' + e.message }); }
    try { if (profile.settings.haptics && navigator.vibrate) navigator.vibrate(6); } catch { /* optional */ }
  },
  error() { this.drop(147, { gain: 0.07, dur: 0.16, noise: 0.01 }); },
  colorDone() {
    this.drop(587, { gain: 0.08 });
    this.drop(784, { gain: 0.08, when: 0.09 });
    this.drop(1175, { gain: 0.06, when: 0.18, dur: 0.4 });
  },
  resolve() {
    // ceremony finale in the player's own sound language
    try {
      const th = profile.settings.fillSound;
      if (th === 'music' || th === 'drop') {
        [0, 4, 7, 12].forEach((st, i) =>
          this.drop(261.63 * Math.pow(2, st / 12), { gain: 0.1, dur: 0.9, when: i * 0.13 }));
      } else if (th === 'bowl') {
        [0, 4, 7].forEach((st, i) => setTimeout(() => {
          this._lastBowl = 0;   // bypass throttle for the chord
          this.bowl(1 + [0, 2, 3][i]);
        }, i * 160));
      } else {
        this.win();
      }
    } catch { /* never crash the ceremony */ }
  },
  win() {
    [392, 494, 587, 784, 988].forEach((f, i) =>
      this.drop(f, { gain: 0.09, dur: 0.5, when: i * 0.12, pan: (i % 2) * 0.5 - 0.25 }));
  },
  whoosh() {
    for (let i = 0; i < 6; i++)
      this.drop(440 + i * 110, { gain: 0.035, dur: 0.3, when: i * 0.045, noise: 0.012, pan: i / 6 - 0.5 });
  },
};

// ---------------------------------------------------------------- music
// Ambient-synthesizer sound direction: a soft evolving background pad drifts
// between root and fifth; every palette number is a note of the C-major
// pentatonic scale, triggered as the player paints — the player co-creates
// the melody. Mallet-soft voices, drenched in the shared reverb.
const Music = {
  pad: null, chordTimer: null, chordIdx: 0, lastNote: 0,
  // root–fifth drones inside C major: C(1)+G(5), then G+D — "intervals 1 and 5".
  // Voiced from C4 up: anything droning below ~G3 reads as electrical hum.
  CHORDS: [
    [261.63, 392.00, 523.25],   // C4 · G4 · C5
    [196.00, 293.66, 392.00],   // G3 · D4 · G4
  ],
  active() { return profile.settings.sound && profile.settings.fillSound === 'music'; },

  start() {
    if (this.pad || !this.active()) return;
    try { this._start(); } catch (e) { this.pad = null; bufferError({ m: 'Music.start: ' + e.message }); }
  },
  _start() {
    const ac = Sound.ac();
    const out = ac.createGain();
    out.gain.value = 0.0001;
    // highpass kills any sub-rumble; lowpass keeps the top soft
    const hp = ac.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 150; hp.Q.value = 0.5;
    const filt = ac.createBiquadFilter();
    filt.type = 'lowpass'; filt.frequency.value = 900; filt.Q.value = 0.3;
    out.connect(hp);
    hp.connect(filt);
    filt.connect(Sound.master);
    // NO reverb send for the pad: convolving a sustained drone with the
    // noise-based IR produces constant broadband buzz. The pad is dry —
    // it IS the ambience; only the percussive notes get the reverb tail.

    // slow undulation: LFO breathes the filter cutoff over ~20s cycles
    const lfo = ac.createOscillator(), lfoGain = ac.createGain();
    lfo.frequency.value = 0.05;
    lfoGain.gain.value = 260;
    lfo.connect(lfoGain).connect(filt.frequency);
    lfo.start();

    const gains = [0.22, 0.18, 0.06];
    const types = ['sine', 'sine', 'triangle'];
    const oscs = this.CHORDS[0].map((f, i) => {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = types[i]; o.frequency.value = f;
      o.detune.value = (Math.random() - 0.5) * 4;   // gentle; wide detune throbs
      g.gain.value = gains[i];
      o.connect(g).connect(out);
      o.start();
      return o;
    });
    out.gain.setTargetAtTime(0.04, ac.currentTime, 2.5);   // slow fade-in

    this.pad = { out, oscs, lfo };
    this.chordIdx = 0;
    this.chordTimer = setInterval(() => {                   // drift I ↔ V
      if (!this.pad) return;
      this.chordIdx = 1 - this.chordIdx;
      const t = Sound.ctx.currentTime;
      this.CHORDS[this.chordIdx].forEach((f, i) =>
        this.pad.oscs[i].frequency.setTargetAtTime(f, t, 4.5));
    }, 19000);
  },

  stop() {
    if (!this.pad) return;
    clearInterval(this.chordTimer);
    const { out, oscs, lfo } = this.pad;
    this.pad = null;
    out.gain.setTargetAtTime(0.0001, Sound.ctx.currentTime, 0.6);
    setTimeout(() => {
      oscs.forEach((o) => { try { o.stop(); } catch { /* already stopped */ } });
      try { lfo.stop(); } catch { /* already stopped */ }
    }, 3000);
  },

  // soft mallet/bell note for palette number n (1-based), C-major pentatonic
  note(n) {
    if (!this.active()) return;
    const now = performance.now();
    if (now - this.lastNote < 45) return;   // fast drags → gentle glissando, not machine-gun
    this.lastNote = now;
    const ac = Sound.ac();
    const PENT = [0, 2, 4, 7, 9];
    const idx = ((n || 1) - 1) % 15;
    const semis = PENT[idx % 5] + 12 * Math.floor(idx / 5);
    const f = 261.63 * Math.pow(2, semis / 12);   // C4 upward, region-stable

    const t = ac.currentTime;
    const out = ac.createGain();
    let tail = out;
    if (ac.createStereoPanner) {
      const p = ac.createStereoPanner();
      p.pan.value = (Math.random() - 0.5) * 0.7;
      out.connect(p); tail = p;
    }
    tail.connect(Sound.master);
    const wetS = ac.createGain();
    wetS.gain.value = 0.95;                        // drenched
    out.connect(wetS);
    wetS.connect(Sound.wet);

    // fundamental: soft mallet — fast attack, long singing decay
    const o1 = ac.createOscillator(), g1 = ac.createGain();
    o1.type = 'sine'; o1.frequency.value = f;
    o1.detune.value = (Math.random() - 0.5) * 6;
    g1.gain.setValueAtTime(0.0001, t);
    g1.gain.exponentialRampToValueAtTime(0.11, t + 0.006);
    g1.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);
    o1.connect(g1).connect(out);
    o1.start(t); o1.stop(t + 1.7);

    // strike partial: brief inharmonic shimmer that says "mallet on bell"
    const o2 = ac.createOscillator(), g2 = ac.createGain();
    o2.type = 'sine'; o2.frequency.value = f * 2.99;
    g2.gain.setValueAtTime(0.0001, t);
    g2.gain.exponentialRampToValueAtTime(0.022, t + 0.004);
    g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    o2.connect(g2).connect(out);
    o2.start(t); o2.stop(t + 0.35);
  },
};

// ---------------------------------------------------------------- game state
const G = {
  level: null, cells: null, filled: null,
  filledList: [],            // indices of filled cells (twinkle sampling)
  perColor: [], filledCount: 0, totalCells: 0, done: false,
  selected: 1,
  zoom: 1, panX: 0, panY: 0, minZoom: 0.2, maxZoom: 4,
  fx: [], twinkles: [], confetti: [],
  armed: null,               // 'bucket' | 'bomb' | 'eraser' | 'brush'
  brushStroke: false,
  camAnim: null, shine: null, inputLocked: false,
  replay: null, wayfind: null,
  lastPointer: null,
  colorCanvas: null, grayCanvas: null, artCanvas: null, revealCanvas: null,
  previewCanvas: null,
};

const board = $('board');
const ctx = board.getContext('2d', { alpha: false });   // opaque = faster compositing
let dpr = 1, vw = 0, vh = 0;
let needRender = true;   // idle-skip: draw only when something changed/animates
let bgGrad = null;       // soft pastel wash behind the grid (frosted UI blurs it)

function resizeBoard() {
  // cap at 2x: 3x devices push ~2.25x more pixels for imperceptible gain
  dpr = Math.min(devicePixelRatio || 1, 2);
  needRender = true;
  vw = innerWidth; vh = innerHeight;
  board.width = vw * dpr; board.height = vh * dpr;
  board.style.width = vw + 'px'; board.style.height = vh + 'px';
  bgGrad = ctx.createLinearGradient(0, 0, vw * 0.3, vh);
  if (profile.settings.dark) {
    bgGrad.addColorStop(0, '#191a20');
    bgGrad.addColorStop(0.5, '#141519');
    bgGrad.addColorStop(1, '#14171c');
  } else {
    bgGrad.addColorStop(0, '#f8f7f1');
    bgGrad.addColorStop(0.5, '#ffffff');
    bgGrad.addColorStop(1, '#f1f4ec');
  }
}
addEventListener('resize', () => { resizeBoard(); if (G.level) clampCamera(); });

// ---------------------------------------------------------------- level setup
// ---- rewarded catalog gate: the newest half of each shelf is ad-locked.
// One rewarded video opens one painting FOR THIS SESSION (relocks on next
// launch — or buy remove-ads once to open everything forever). The daily
// picture and the player's own photos are always free.
const sessionUnlocks = new Set();   // level ids — deliberately not persisted

// Share of the catalog behind a rewarded video. Tune this one number.
const LOCKED_SHARE = 0.8;

// Which paintings are free is decided once, deterministically, from the
// level ids — so it is scattered rather than "the back half of each shelf",
// but STABLE: a painting that was free yesterday is free today. (True
// per-launch randomness would relock things people had just played.)
// The first painting on every shelf is always free, so no shelf greets you
// with a wall, and the remaining free slots are drawn with a bias toward
// the front — browsing starts easy and ad-walled pieces appear deeper in.
let freeSet = null;
function hashId(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
function buildFreeSet() {
  const pool = LEVELS.filter((l) => l.cat !== 'myphotos');
  const byCat = {};
  for (const l of pool) (byCat[l.cat] = byCat[l.cat] || []).push(l);
  const free = new Set();
  // The guaranteed-free opener of each shelf is its EASIEST painting, not
  // its first. A brand-new player's first tap should be a quick win — the
  // on-ramp — and picking by score (cells x colours, same math as
  // tierFor) works on every client: remote-merged levels compete on score
  // no matter where the merge appended them.
  const scoreOf = (l) => l.palette.reduce((s, c) => s + c.count, 0) * l.palette.length;
  for (const cat in byCat) {
    let best = byCat[cat][0];
    for (const l of byCat[cat]) if (scoreOf(l) < scoreOf(best)) best = l;
    free.add(best.id);
  }
  const target = Math.max(free.size, Math.round(pool.length * (1 - LOCKED_SHARE)));
  // Spend the remaining slots where they are actually SEEN. Weighting by
  // depth alone (i * k) fills index-1 of every shelf before index-2 of any,
  // which spreads the free paintings so thin that the top shelf gets its
  // opener and nothing else — the first thing a new player sees is one
  // painting and a row of Watch badges. Multiplying depth by shelf rank
  // makes depth cheap at the top and expensive at the bottom, so the
  // shelves above the fold get a real free run and the niche shelves at
  // the bottom keep just their opener. Same global 80%, better front door.
  const order = Object.keys(CATS).filter((c) => c !== 'myphotos');
  const rankOf = (c) => (order.indexOf(c) < 0 ? order.length : order.indexOf(c));
  const rest = [];
  for (const cat in byCat) {
    byCat[cat].forEach((l, i) => {
      if (!free.has(l.id)) {
        rest.push({ id: l.id, k: i * (1 + rankOf(cat)) * 1000 + hashId(l.id) % 1000 });
      }
    });
  }
  rest.sort((a, b) => a.k - b.k);        // shallow + high on the page wins
  for (const r of rest) {
    if (free.size >= target) break;
    free.add(r.id);
  }
  freeSet = free;
}
function isLocked(level) {
  if (profile.removeAds) return false;
  if (level.cat === 'myphotos') return false;              // your own photos
  if (sessionUnlocks.has(level.id)) return false;
  if (level.id === dailyLevelId()) return false;           // daily always free
  if (!freeSet) buildFreeSet();
  return !freeSet.has(level.id);
}

// Badge for an ad-gated painting: green play button + "Watch". Says what
// you CAN do (watch a short video and paint it), not what you can't.
const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  return n;
}
function watchPill() {
  const pill = el('span', 'watch-pill');
  const svg = svgEl('svg',
    { viewBox: '0 0 24 24', width: 15, height: 15, 'aria-hidden': 'true' });
  svg.appendChild(svgEl('circle', { cx: 12, cy: 12, r: 11, fill: '#4f9d63' }));
  svg.appendChild(svgEl('path', { d: 'M9.7 7.3 17 12l-7.3 4.7Z', fill: '#fff' }));
  pill.appendChild(svg);
  pill.appendChild(document.createTextNode('Watch'));
  return pill;
}

let pendingUnlock = null;

// The unlock sheet is the one place the app genuinely needs a connection.
// Everything else — painting, the gallery, imported photos — works offline
// off the service-worker cache, so say that rather than implying the whole
// app is down.
function applyUnlockConnectivity() {
  const offline = !navigator.onLine;
  $('unlockCopy').textContent = offline
    ? 'You’re offline right now. Reconnect to watch a short video and open this one — everything already open still paints just fine.'
    : 'Watch a short video to paint it during this visit.';
  const btn = $('unlockWatch');
  btn.textContent = offline ? 'No connection' : '🎬 Watch & Paint Now';
  btn.disabled = offline;
}
for (const evt of ['online', 'offline']) {
  addEventListener(evt, () => {
    if ($('unlockSheet').classList.contains('open')) applyUnlockConnectivity();
  });
}

// The rewarded flow, once the player has agreed to the trade.
function startUnlock(level) {
  if (!level) return;
  toast('Loading your video…');
  Ads.showRewarded('unlock', () => {
    sessionUnlocks.add(level.id);       // this visit only — relocks next launch
    Analytics.track('unlock_done', { id: level.id });
    toast(`${level.name} is open — enjoy your visit 🖼️`);
    openLevel(level);
  });
}

function offerUnlock(level) {
  // Explain the trade ONCE. After that the green ▶ Watch badge on the card
  // is the affordance — re-showing this sheet on every unlock would be
  // friction on 80% of the catalog. Offline still gets the sheet, because
  // there the player needs telling why nothing will happen.
  if (profile.seenUnlockExplainer && navigator.onLine) {
    pendingUnlock = level;
    startUnlock(level);
    return;
  }
  pendingUnlock = level;
  const cv = $('unlockThumb');
  cv.width = level.width; cv.height = level.height;
  drawThumb(cv, level, false);                 // B&W tease of the painting
  $('unlockTitle').textContent = level.name;
  applyUnlockConnectivity();
  $('unlockSheet').classList.add('open');
  Analytics.track('unlock_offer', { id: level.id, offline: !navigator.onLine });
}

function openLevel(level) {
  if (isLocked(level)) { offerUnlock(level); return; }
  G.level = level;
  G.cells = decodeCells(level.cells);
  const W = level.width, H = level.height;
  G.totalCells = level.palette.reduce((s, c) => s + c.count, 0);

  // restore progress — treat saved data as untrusted: any corruption falls
  // back to a fresh grid, and counts are ALWAYS recomputed from the cells
  const saved = loadJSON('sp_prog_' + level.id, null);
  G.filled = saved ? decodeCells(saved.f) : new Uint8Array(W * H);
  if (G.filled.length !== W * H) G.filled = new Uint8Array(W * H);
  G.done = !!(saved && saved.done);
  G.filledList = [];
  G.perColor = new Array(level.palette.length + 1).fill(0);
  G.filledCount = 0;
  for (let i = 0; i < G.filled.length; i++) {
    if (!G.filled[i]) continue;
    if (!G.cells[i]) { G.filled[i] = 0; continue; }   // heal orphan fills
    G.filledList.push(i);
    G.filledCount++;
    G.perColor[G.cells[i]]++;
  }

  buildLayers();
  buildPalette();

  // camera: fit whole picture, biased above the palette bar
  const fitZ = Math.min(vw / (W * CP), (vh * 0.68) / (H * CP)) * 0.94;
  G.minZoom = fitZ * 0.85;
  G.maxZoom = Math.max(48 / CP, fitZ * 3);
  G.zoom = fitZ;
  G.panX = (vw - W * CP * fitZ) / 2;
  G.panY = (vh * 0.78 - H * CP * fitZ) / 2 + vh * 0.04;

  // resume where the player left off (camera + selected color)
  if (saved && !G.done && saved.sel && G.perColor[saved.sel] < level.palette[saved.sel - 1].count) {
    selectColor(saved.sel);
  } else {
    autoSelectColor(true);
  }
  if (saved && !G.done && saved.cam && G.filledCount > 0) {
    G.zoom = saved.cam.z; G.panX = saved.cam.x; G.panY = saved.cam.y;
    clampCamera();
  }

  G.fx = []; G.twinkles = []; G.confetti = [];
  G.armed = null; G.brushStroke = false; G.camAnim = null; G.shine = null;
  G.inputLocked = false;
  updateToolButtons(); updateCoinUI(); updateProgressBar();
  needRender = true;
  Analytics.track('level_start', { id: level.id, pct: G.filledCount / G.totalCells });
  showScreen('game');
  FTUE.start();
}

function updateProgressBar() {
  $('lvlProgress').firstElementChild.style.width =
    G.totalCells ? `${(G.filledCount / G.totalCells) * 100}%` : '0%';
}

function buildLayers() {
  const { width: W, height: H, palette } = G.level;

  // 1px-per-cell flat color + ghost gray canvases — written as raw pixel
  // buffers: one putImageData instead of ~7k fillRect calls each
  G.colorCanvas = makeCanvas(W, H);
  G.grayCanvas = makeCanvas(W, H);
  const cc = G.colorCanvas.getContext('2d'), gc = G.grayCanvas.getContext('2d');
  const rgb = palette.map((p) => hexRGB(p.hex));
  const gray = palette.map((p) => ghostGray(p.hex));   // same math as grayFor()
  // number ink per palette entry — the darker ghost cells need darker ink
  G.numberInk = gray.map((v) => numberInkFor(v));
  const cimg = cc.createImageData(W, H), gimg = gc.createImageData(W, H);
  const cd = cimg.data, gd = gimg.data;
  for (let i = 0; i < G.cells.length; i++) {
    const n = G.cells[i];
    if (!n) continue;
    const o = i * 4, [r, g, b] = rgb[n - 1], v = gray[n - 1];
    cd[o] = r; cd[o + 1] = g; cd[o + 2] = b; cd[o + 3] = 255;
    gd[o] = v; gd[o + 1] = v; gd[o + 2] = v; gd[o + 3] = 255;
  }
  cc.putImageData(cimg, 0, 0);
  gc.putImageData(gimg, 0, 0);

  // full-res artwork layer — painted by applyRevealStyle() per the player's
  // reveal style: 'painting' (true source art) or 'shimmer' (glitter pixels)
  const AW = W * CP, AH = H * CP;
  G.artCanvas = makeCanvas(AW, AH);

  // candy-tile preview: full-res crisp rounded pixels — the zoomed-out view.
  // GRAYSCALE by design: the far view is a black-and-white image of the
  // artwork; color exists only where the player has painted (the reveal
  // layer draws on top), so progress literally colorizes the photo.
  // Built in three strokes instead of ~7k rounded-rect paths: a 1px-per-cell
  // grayscale buffer upscaled crisp, then ONE tiled "tile chrome" pattern
  // (seam corners + bevel catchlight — identical for every tile) composited
  // source-atop so empty cells stay transparent. Visually equivalent: the
  // pattern's 16% black seam over gray v equals the old v*0.84 seam tone.
  G.previewCanvas = makeCanvas(AW, AH);
  const pv = G.previewCanvas.getContext('2d');
  const gs = makeCanvas(W, H);
  const gsc = gs.getContext('2d');
  const gsimg = gsc.createImageData(W, H);
  const gsd = gsimg.data;
  const tone = palette.map((p) => Math.round(88 + luminance(p.hex) * 152));
  for (let i = 0; i < G.cells.length; i++) {
    const n = G.cells[i];
    if (!n) continue;
    const o = i * 4, v = tone[n - 1];
    gsd[o] = v; gsd[o + 1] = v; gsd[o + 2] = v; gsd[o + 3] = 255;
  }
  gsc.putImageData(gsimg, 0, 0);
  pv.imageSmoothingEnabled = false;
  pv.drawImage(gs, 0, 0, AW, AH);
  pv.imageSmoothingEnabled = true;
  pv.globalCompositeOperation = 'source-atop';   // never paint empty cells
  pv.fillStyle = pv.createPattern(makeTileChrome(), 'repeat');
  pv.fillRect(0, 0, AW, AH);
  pv.globalCompositeOperation = 'source-over';

  // revealed layer: art shows only where cells are filled (painted by
  // applyRevealStyle, which also picks the artwork style)
  G.revealCanvas = makeCanvas(AW, AH);
  if (G.level.art) loadLevelArt(G.level);
  applyRevealStyle();
}

// ---- reveal styles: 'painting' uncovers the true source artwork;
// ---- 'shimmer' uncovers flat quantized color dressed in glitter
const artImages = new Map();   // level.id → Image (or null after load error)
function loadLevelArt(level) {
  if (!level.art || artImages.has(level.id)) return;
  const img = new Image();
  if (level.remote) img.crossOrigin = 'anonymous';
  img.onload = () => {
    if (G.level && G.level.id === level.id) applyRevealStyle();
    // upgrade any waiting promo thumbs IN PLACE — no gallery rebuild, so
    // the hero carousel never resets mid-animation
    document.querySelectorAll(`canvas[data-art-pending="${level.id}"]`)
      .forEach((cv) => drawPromoThumb(cv, level));
  };
  img.onerror = () => artImages.set(level.id, null);   // shimmer fallback
  img.src = level.art;
  artImages.set(level.id, img);
}

// Promo surfaces (hero carousel, category circles, finished cards, win
// panel) show the REAL painting when the reveal style is 'painting' — the
// artwork is the product for this audience. Unfinished shelf cards keep the
// quantized B&W progress-map mechanic ("my color spreads over the photo").
function drawPromoThumb(cv, level) {
  if (profile.settings.revealStyle === 'painting' && level.art) {
    const img = artImages.get(level.id);
    if (img && img.complete && img.naturalWidth) {
      const S = 360;                    // crisp at hero size on 2-3x screens
      cv.width = S;
      cv.height = Math.max(1, Math.round(S * level.height / level.width));
      const c = cv.getContext('2d');
      c.imageSmoothingEnabled = true;
      c.imageSmoothingQuality = 'high';
      c.drawImage(img, 0, 0, cv.width, cv.height);
      cv.style.imageRendering = 'auto'; // override the pixelated thumb CSS
      delete cv.dataset.artPending;
      return;
    }
    cv.dataset.artPending = level.id;   // loadLevelArt upgrades it in place
    loadLevelArt(level);
  }
  drawThumb(cv, level, true);           // quantized fallback / shimmer style
}
function artReady() {
  const img = G.level && artImages.get(G.level.id);
  return (img && img.complete && img.naturalWidth) ? img : null;
}
function artStyle() {
  return profile.settings.revealStyle === 'painting' && artReady()
    ? 'painting' : 'shimmer';
}

function paintShimmerArt(a, W, H, AW, AH) {
  a.imageSmoothingEnabled = false;
  a.drawImage(G.colorCanvas, 0, 0, AW, AH);
  // soft light/dark flow (continuous across color regions = the glitter tell)
  a.globalCompositeOperation = 'overlay';
  for (let k = 0; k < 10; k++) {
    const gx = Math.random() * AW, gy = Math.random() * AH;
    const r = (0.25 + Math.random() * 0.45) * Math.max(AW, AH);
    const grad = a.createRadialGradient(gx, gy, 0, gx, gy, r);
    const light = Math.random() < 0.55;
    grad.addColorStop(0, light ? 'rgba(255,255,255,.38)' : 'rgba(40,40,70,.30)');
    grad.addColorStop(1, 'rgba(128,128,128,0)');
    a.fillStyle = grad; a.fillRect(0, 0, AW, AH);
  }
  for (let k = 0; k < 4; k++) {                       // diagonal shine streaks
    const grad = a.createLinearGradient(0, 0, AW, AH);
    const c = Math.random() * 0.7 + 0.15;
    grad.addColorStop(Math.max(0, c - 0.12), 'rgba(255,255,255,0)');
    grad.addColorStop(c, 'rgba(255,255,255,.30)');
    grad.addColorStop(Math.min(1, c + 0.12), 'rgba(255,255,255,0)');
    a.fillStyle = grad; a.fillRect(0, 0, AW, AH);
  }
  a.globalCompositeOperation = 'lighter';             // sparkle specks
  const specks = W * H * 2.2;
  for (let k = 0; k < specks; k++) {
    const x = Math.random() * AW, y = Math.random() * AH;
    const r = 0.6 + Math.random() * 1.8;
    a.globalAlpha = 0.15 + Math.random() * 0.6;
    a.fillStyle = '#fff';
    a.beginPath(); a.arc(x, y, r, 0, 7); a.fill();
  }
  a.globalAlpha = 1;
}

function applyRevealStyle() {
  if (!G.level || !G.artCanvas) return;
  const { width: W, height: H } = G.level;
  const AW = W * CP, AH = H * CP;
  const a = G.artCanvas.getContext('2d');
  a.clearRect(0, 0, AW, AH);
  const img = artStyle() === 'painting' && artReady();
  if (img) {
    a.imageSmoothingEnabled = true;
    a.imageSmoothingQuality = 'high';
    a.drawImage(img, 0, 0, AW, AH);
  } else if (profile.settings.revealStyle === 'painting' &&
             G.level.art && artImages.get(G.level.id) !== null) {
    // art still decoding: cheap flat placeholder (one drawImage) — the
    // glitter paint would be thrown away when the image lands anyway
    a.imageSmoothingEnabled = false;
    a.drawImage(G.colorCanvas, 0, 0, AW, AH);
  } else {
    paintShimmerArt(a, W, H, AW, AH);
  }
  a.globalCompositeOperation = 'destination-in';      // clip to the art shape
  a.imageSmoothingEnabled = false;
  a.drawImage(G.colorCanvas, 0, 0, AW, AH);
  a.globalCompositeOperation = 'source-over';

  // re-reveal everything already painted in the new style
  const r = G.revealCanvas.getContext('2d');
  r.clearRect(0, 0, AW, AH);
  for (const i of G.filledList) {
    const x = (i % W) * CP, y = ((i / W) | 0) * CP;
    r.drawImage(G.artCanvas, x, y, CP, CP, x, y, CP, CP);
  }
  needRender = true;
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

// One CP×CP candy-tile overlay cell: dark seam with rounded-corner cutout +
// top bevel catchlight. Tiled as a pattern over the whole preview.
let tileChrome = null;
function makeTileChrome() {
  if (tileChrome) return tileChrome;
  const c = makeCanvas(CP, CP);
  const t = c.getContext('2d');
  const rad = CP * 0.22;
  t.fillStyle = 'rgba(0,0,0,.16)';               // seam tone (v → v*0.84)
  t.fillRect(0, 0, CP, CP);
  if (typeof t.roundRect === 'function') {
    t.globalCompositeOperation = 'destination-out';   // punch the tile face
    t.beginPath();
    t.roundRect(0.8, 0.8, CP - 1.6, CP - 1.6, rad);
    t.fill();
    t.globalCompositeOperation = 'source-over';
    t.fillStyle = 'rgba(255,255,255,.10)';       // top bevel catchlight
    t.beginPath();
    t.roundRect(2.4, 2.2, CP - 4.8, CP * 0.32, rad * 0.7);
    t.fill();
  } else {
    t.clearRect(0.8, 0.8, CP - 1.6, CP - 1.6);
  }
  tileChrome = c;
  return c;
}

// ---------------------------------------------------------------- palette UI
function buildPalette() {
  const pal = $('palette');
  pal.replaceChildren();
  // incomplete colors first; finished ones rest at the end of the bar
  const ordered = [...G.level.palette].sort((a, b) =>
    ((G.perColor[a.n] >= a.count) - (G.perColor[b.n] >= b.count)) || (a.n - b.n));
  for (const p of ordered) {
    const b = el('button', 'swatch');
    b.dataset.n = p.n;
    b.appendChild(el('div', 'ring'));
    const core = el('div', 'core', String(p.n));
    core.style.background = p.hex;
    core.style.color = textColorOn(p.hex);
    b.appendChild(core);
    b.appendChild(el('span', 'left'));
    b.addEventListener('click', () => { Sound.ac(); selectColor(p.n); Sound.preview(p.n); });
    pal.appendChild(b);
  }
  for (const p of G.level.palette) updateSwatch(p.n);
}
function updateSwatch(n) {
  const b = document.querySelector(`.swatch[data-n="${n}"]`);
  if (!b || !G.level) return;
  const p = G.level.palette[n - 1];
  if (!p || !p.count) return;
  const pct = Math.round((G.perColor[n] / p.count) * 100);
  b.querySelector('.ring').style.background =
    `conic-gradient(var(--accent) ${pct}%, var(--ring-track) ${pct}%)`;
  const wasDone = b.classList.contains('done');
  const done = G.perColor[n] >= p.count;
  b.classList.toggle('done', done);
  b.querySelector('.core').textContent = done ? '✓' : p.n;
  const lb = b.querySelector('.left');
  if (lb) lb.textContent = `${p.count - G.perColor[n]} left`;
  if (done && !wasDone) {
    b.classList.add('justDone');
    setTimeout(() => {
      b.classList.remove('justDone');
      if (b.parentElement) b.parentElement.appendChild(b);   // rest at the end
    }, 620);
  }
}
function selectColor(n) {
  G.selected = n;
  needRender = true;
  document.querySelectorAll('.swatch').forEach((s) =>
    s.classList.toggle('sel', +s.dataset.n === n));
  const b = document.querySelector(`.swatch[data-n="${n}"]`);
  if (b) b.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
}
function autoSelectColor(initial) {
  const pal = G.level.palette;
  const start = initial ? 0 : G.selected % pal.length;
  for (let k = 0; k < pal.length; k++) {
    const n = ((start + k) % pal.length) + 1;
    if (G.perColor[n] < pal[n - 1].count) { selectColor(n); return true; }
  }
  return false;
}

// ---------------------------------------------------------------- fill / erase
function fillCell(i, opts = {}) {
  if (i < 0 || i >= G.cells.length || G.filled[i] || !G.cells[i]) return false;
  G.filled[i] = 1;
  G.filledList.push(i);
  G.filledCount++;
  const n = G.cells[i];
  G.perColor[n]++;
  const W = G.level.width, x = (i % W) * CP, y = ((i / W) | 0) * CP;
  G.revealCanvas.getContext('2d').drawImage(G.artCanvas, x, y, CP, CP, x, y, CP, CP);
  G.fx.push({ kind: 'pop', i, t0: performance.now() + (opts.delay || 0) });
  needRender = true;
  if (!opts.quiet) Sound.tick(n);
  if (!opts.batch) {   // flood fills batch the UI refresh (rippleFill)
    updateSwatch(n);
    updateProgressBar();
    FTUE.onFill();
  }
  if (G.perColor[n] >= G.level.palette[n - 1].count && !opts.suppressAdvance) {
    Sound.colorDone();
    if (!autoSelectColor(false)) onLevelComplete();
  } else if (G.filledCount >= G.totalCells) {
    onLevelComplete();
  }
  saveSoon();
  return true;
}
function eraseCell(i) {
  if (i < 0 || i >= G.cells.length || !G.filled[i]) return false;
  G.filled[i] = 0;
  G.filledList.splice(G.filledList.indexOf(i), 1);
  G.filledCount--;
  const n = G.cells[i];
  G.perColor[n]--;
  const W = G.level.width, x = (i % W) * CP, y = ((i / W) | 0) * CP;
  G.revealCanvas.getContext('2d').clearRect(x, y, CP, CP);
  needRender = true;
  updateSwatch(n);
  updateProgressBar();
  saveSoon();
  return true;
}

// ---------------------------------------------------------------- FTUE
// First-time tutorial: hand points at a real paintable cell, hints advance
// on fill milestones (tap → drag → pinch), then never shows again.
const FTUE = {
  active: false, step: 0, fills: 0, frame: 0,
  start() {
    if (profile.ftueDone || G.done || G.filledCount > 0) return;
    this.active = true; this.step = 1; this.fills = 0;
    $('ftue').classList.add('on');
    $('ftueHand').style.display = '';
    this.say(`Tap the dark cells numbered ${G.selected} to paint them 🖌️`);
    Analytics.track('ftue_start', {});
  },
  say(msg) { $('ftueMsg').textContent = msg; },
  onFill() {
    if (!this.active) return;
    this.fills++;
    if (this.step === 1 && this.fills >= 3) {
      this.step = 2;
      this.say('Nice! Now drag your finger across cells to paint fast 🖌️');
    } else if (this.step === 2 && this.fills >= 12) {
      this.step = 3;
      $('ftueHand').style.display = 'none';
      this.say('Pinch to zoom in · drag to move around 🔍');
      setTimeout(() => this.end(), 4000);
    }
  },
  end() {
    if (!this.active) return;
    this.active = false;
    $('ftue').classList.remove('on');
    profile.ftueDone = true;
    saveSoon();
    Analytics.track('ftue_done', { fills: this.fills });
  },
  // called from the render loop: keep the hand over a real target cell
  positionHand() {
    if (!this.active || this.step >= 3 || (++this.frame % 20)) return;
    const W = G.level.width;
    const cx = (vw / 2 - G.panX) / G.zoom / CP, cy = (vh / 2 - G.panY) / G.zoom / CP;
    let best = -1, bestD = Infinity;
    for (let i = 0; i < G.cells.length; i++) {
      if (G.cells[i] !== G.selected || G.filled[i]) continue;
      const d = Math.hypot(i % W - cx, ((i / W) | 0) - cy);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best < 0) return;
    const sx = ((best % W) + 0.5) * CP * G.zoom + G.panX;
    const sy = (((best / W) | 0) + 0.5) * CP * G.zoom + G.panY;
    const hand = $('ftueHand');
    hand.style.left = clamp(sx, 20, vw - 40) + 'px';
    hand.style.top = clamp(sy, vh * 0.2, vh * 0.72) + 'px';
  },
};

function floodFill(start) {
  const { width: W, height: H } = G.level;
  const n = G.cells[start];
  if (!n || G.filled[start]) return 0;
  const seen = new Uint8Array(G.cells.length);
  const stack = [start];
  const hits = [];
  while (stack.length) {
    const i = stack.pop();
    if (seen[i] || G.cells[i] !== n || G.filled[i]) continue;
    seen[i] = 1; hits.push(i);
    const x = i % W, y = (i / W) | 0;
    if (x > 0) stack.push(i - 1);
    if (x < W - 1) stack.push(i + 1);
    if (y > 0) stack.push(i - W);
    if (y < H - 1) stack.push(i + W);
  }
  rippleFill(hits, start);
  return hits.length;
}
function rippleFill(indices, origin) {
  const W = G.level.width;
  const ox = origin % W, oy = (origin / W) | 0;
  indices.sort((a, b) =>
    (Math.hypot(a % W - ox, ((a / W) | 0) - oy)) - (Math.hypot(b % W - ox, ((b / W) | 0) - oy)));
  Sound.whoosh();
  indices.forEach((i, k) => fillCell(i, {
    quiet: true, batch: true, delay: Math.min(k * 9, 600),
    suppressAdvance: k < indices.length - 1,
  }));
  // one UI refresh for the whole flood instead of N
  for (const p of G.level.palette) updateSwatch(p.n);
  updateProgressBar();
  FTUE.onFill();
}

// ---------------------------------------------------------------- tools
function updateToolButtons() {
  const b = profile.boosters, ic = profile.imagesCompleted;
  // owning one (e.g. from a rewarded video) unlocks the tool early
  const cfg = [
    ['btnBucket', 'bucket', true],
    ['btnHint', 'hint', true],
    ['btnBomb', 'bomb', ic >= UNLOCKS.bomb || b.bomb > 0],
    ['btnBrush', 'brush', ic >= UNLOCKS.brush || b.brush > 0],
  ];
  for (const [id, key, unlocked] of cfg) {
    const btn = $(id);
    const badge = btn.querySelector('.badge, .lock');
    if (!unlocked) {
      badge.className = 'lock'; badge.textContent = '🔒';
      btn.classList.add('dim');
    } else {
      badge.className = 'badge'; badge.textContent = b[key];
      btn.classList.toggle('dim', b[key] === 0);
    }
    btn.classList.toggle('armed', G.armed === key);
  }
  $('btnEraser').classList.toggle('armed', G.armed === 'eraser');
}
function armTool(key) {
  const ic = profile.imagesCompleted;
  if (key === 'bomb' && ic < UNLOCKS.bomb && profile.boosters.bomb === 0) {
    toast(`Paint ${UNLOCKS.bomb - ic} more picture(s) to unlock THE BOMB 💣 — or grab one with a video 🎬`);
    openStore(); return;
  }
  if (key === 'brush' && ic < UNLOCKS.brush && profile.boosters.brush === 0) {
    toast(`Paint ${UNLOCKS.brush - ic} more picture(s) to unlock the Brush 🖌️ — or grab one with a video 🎬`);
    openStore(); return;
  }
  if (key !== 'eraser' && profile.boosters[key] === 0) { openStore(); return; }
  G.armed = G.armed === key ? null : key;
  if (G.armed === 'hint') { useHint(); G.armed = null; }
  updateToolButtons();
}
function useHint() {
  if (profile.boosters.hint <= 0) { openStore(); return; }
  const { width: W } = G.level;
  // nearest unfilled cell of the selected color to the viewport center
  const cx = (vw / 2 - G.panX) / G.zoom / CP, cy = (vh / 2 - G.panY) / G.zoom / CP;
  let best = -1, bestD = Infinity;
  for (let i = 0; i < G.cells.length; i++) {
    if (G.cells[i] !== G.selected || G.filled[i]) continue;
    const d = Math.hypot(i % W - cx, ((i / W) | 0) - cy);
    if (d < bestD) { bestD = d; best = i; }
  }
  if (best < 0) return;
  profile.boosters.hint--;
  Analytics.track('booster_used', { kind: 'hint' });
  updateToolButtons(); saveSoon();
  const bx = (best % W + 0.5) * CP, by = (((best / W) | 0) + 0.5) * CP;
  const z = Math.max(G.zoom, 26 / CP);
  flyCamera(z, vw / 2 - bx * z, vh * 0.42 - by * z, 500, () => {
    G.fx.push({ kind: 'pulse', i: best, t0: performance.now() });
    setTimeout(() => fillCell(best), 250);
  });
}
function useBucketAt(i) {
  if (!G.cells[i] || G.filled[i]) { toast('Tap a numbered cell to fill its region 🪣'); return; }
  profile.boosters.bucket--;
  Analytics.track('booster_used', { kind: 'bucket' });
  G.armed = null;
  floodFill(i);
  updateToolButtons(); saveSoon();
}
function useBombAt(i) {
  const { width: W, height: H } = G.level;
  const bx = i % W, by = (i / W) | 0, R = 4;
  const hits = [];
  for (let y = Math.max(0, by - R); y <= Math.min(H - 1, by + R); y++)
    for (let x = Math.max(0, bx - R); x <= Math.min(W - 1, bx + R); x++) {
      const j = y * W + x;
      if (G.cells[j] && !G.filled[j] && Math.hypot(x - bx, y - by) <= R + 0.4) hits.push(j);
    }
  if (!hits.length) return;
  profile.boosters.bomb--;
  Analytics.track('booster_used', { kind: 'bomb' });
  G.armed = null;
  Sound.drop(90, { gain: 0.2, dur: 0.4 });
  rippleFill(hits, i);
  updateToolButtons(); saveSoon();
}

// ---------------------------------------------------------------- camera
function clampCamera() {
  const { width: W, height: H } = G.level;
  G.zoom = clamp(G.zoom, G.minZoom, G.maxZoom);
  const aw = W * CP * G.zoom, ah = H * CP * G.zoom;
  const mx = vw * 0.5, my = vh * 0.5;   // let the art roam but keep it on screen
  G.panX = clamp(G.panX, mx - aw, vw - mx);
  G.panY = clamp(G.panY, my - ah, vh - my);
}
function flyCamera(z, px, py, dur, cb) {
  G.camAnim = {
    t0: performance.now(), dur,
    from: { z: G.zoom, x: G.panX, y: G.panY },
    to: { z, x: px, y: py }, cb,
  };
}
function stepCamera(now) {
  const a = G.camAnim;
  if (!a) return;
  const k = ease(clamp((now - a.t0) / a.dur, 0, 1));
  G.zoom = a.from.z + (a.to.z - a.from.z) * k;
  G.panX = a.from.x + (a.to.x - a.from.x) * k;
  G.panY = a.from.y + (a.to.y - a.from.y) * k;
  if (k >= 1) { G.camAnim = null; a.cb && a.cb(); }
}

// ---------------------------------------------------------------- input
const pointers = new Map();
let gesture = null;   // {mode:'pending'|'pan'|'paint'|'pinch'|'erase'|'brush', ...}

function cellAt(sx, sy) {
  const wx = (sx - G.panX) / G.zoom / CP, wy = (sy - G.panY) / G.zoom / CP;
  const { width: W, height: H } = G.level;
  const x = Math.floor(wx), y = Math.floor(wy);
  if (x < 0 || y < 0 || x >= W || y >= H) return -1;
  return y * W + x;
}

board.addEventListener('pointerdown', (e) => {
  if (G.inputLocked) return;
  board.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  Sound.ac();
  if (pointers.size === 2) {
    const [p1, p2] = [...pointers.values()];
    gesture = {
      mode: 'pinch',
      baseDist: Math.hypot(p1.x - p2.x, p1.y - p2.y),
      baseZoom: G.zoom,
      baseMid: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 },
      basePan: { x: G.panX, y: G.panY },
    };
  } else if (pointers.size === 1) {
    gesture = {
      mode: 'pending', id: e.pointerId,
      sx: e.clientX, sy: e.clientY, t0: performance.now(),
      lastCell: cellAt(e.clientX, e.clientY),
    };
    G.lastPointer = { x: e.clientX, y: e.clientY };
  }
});

board.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId) || G.inputLocked) return;
  needRender = true;
  const p = pointers.get(e.pointerId);
  p.x = e.clientX; p.y = e.clientY;
  G.lastPointer = { x: e.clientX, y: e.clientY };
  if (!gesture) return;

  if (gesture.mode === 'pinch' && pointers.size === 2) {
    const [p1, p2] = [...pointers.values()];
    const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
    const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    const z = clamp(gesture.baseZoom * (dist / gesture.baseDist), G.minZoom, G.maxZoom);
    const wx = (gesture.baseMid.x - gesture.basePan.x) / gesture.baseZoom;
    const wy = (gesture.baseMid.y - gesture.basePan.y) / gesture.baseZoom;
    G.zoom = z;
    G.panX = mid.x - wx * z;
    G.panY = mid.y - wy * z;
    clampCamera();
    return;
  }

  if (gesture.mode === 'pending') {
    const moved = Math.hypot(e.clientX - gesture.sx, e.clientY - gesture.sy);
    if (moved > 6) {
      const i = gesture.lastCell;
      if (G.armed === 'eraser') gesture.mode = 'erase';
      else if (G.armed === 'brush' && profile.boosters.brush > 0) {
        profile.boosters.brush--; G.brushStroke = true; gesture.mode = 'brush';
        updateToolButtons(); saveSoon();
      } else if (G.armed === null && i >= 0 && !G.filled[i] && G.cells[i] === G.selected) {
        gesture.mode = 'paint';
      } else {
        gesture.mode = 'pan';
      }
      gesture.px = gesture.sx; gesture.py = gesture.sy;
    } else return;
  }

  if (gesture.mode === 'pan') {
    G.panX += e.clientX - gesture.px;
    G.panY += e.clientY - gesture.py;
    gesture.px = e.clientX; gesture.py = e.clientY;
    clampCamera();
  } else if (gesture.mode === 'paint' || gesture.mode === 'erase' || gesture.mode === 'brush') {
    const cur = cellAt(e.clientX, e.clientY);
    strokeCells(gesture.lastCell, cur, gesture.mode);
    gesture.lastCell = cur;
  }
});

function strokeCells(from, to, mode) {
  const { width: W } = G.level;
  const cellsOnLine = [];
  if (from < 0 && to < 0) return;
  if (from < 0) cellsOnLine.push(to);
  else if (to < 0 || from === to) cellsOnLine.push(from);
  else {
    let x0 = from % W, y0 = (from / W) | 0;
    const x1 = to % W, y1 = (to / W) | 0;
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      cellsOnLine.push(y0 * W + x0);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }
  for (const i of cellsOnLine) {
    if (i < 0) continue;
    if (mode === 'erase') eraseCell(i);
    else if (mode === 'brush') { if (G.cells[i] && !G.filled[i]) fillCell(i); }
    else if (G.cells[i] === G.selected && !G.filled[i]) fillCell(i);
  }
}

function endPointer(e) {
  const wasPinch = gesture && gesture.mode === 'pinch';
  pointers.delete(e.pointerId);
  if (wasPinch && pointers.size === 1) {
    const [rem] = [...pointers.values()];
    gesture = { mode: 'pan', px: rem.x, py: rem.y, lastCell: -1 };
    return;
  }
  if (pointers.size > 0) return;

  if (gesture && gesture.mode === 'pending' && !G.inputLocked) {
    handleTap(gesture.lastCell);
  }
  if (gesture && gesture.mode === 'brush') G.brushStroke = false;
  gesture = null;
}
board.addEventListener('pointerup', endPointer);
board.addEventListener('pointercancel', endPointer);

board.addEventListener('wheel', (e) => {   // desktop testing convenience
  e.preventDefault();
  needRender = true;
  const z = clamp(G.zoom * (e.deltaY < 0 ? 1.12 : 0.89), G.minZoom, G.maxZoom);
  const wx = (e.clientX - G.panX) / G.zoom, wy = (e.clientY - G.panY) / G.zoom;
  G.zoom = z;
  G.panX = e.clientX - wx * z; G.panY = e.clientY - wy * z;
  clampCamera();
}, { passive: false });
document.addEventListener('gesturestart', (e) => e.preventDefault());

function handleTap(i) {
  if (G.wayfindHit && G.lastPointer &&
      Math.hypot(G.lastPointer.x - G.wayfindHit.x, G.lastPointer.y - G.wayfindHit.y) < 34) {
    const W = G.level.width, ti = G.wayfindHit.i;
    const z = Math.max(G.zoom, 22 / CP);
    flyCamera(z, vw / 2 - ((ti % W) + 0.5) * CP * z, vh * 0.42 - (((ti / W) | 0) + 0.5) * CP * z, 450);
    return;
  }
  if (i < 0) return;
  if (G.armed === 'bucket') { useBucketAt(i); return; }
  if (G.armed === 'bomb') { useBombAt(i); return; }
  if (G.armed === 'eraser') { eraseCell(i); return; }
  if (G.armed === 'brush') {
    if (G.cells[i] && !G.filled[i] && profile.boosters.brush > 0) {
      profile.boosters.brush--; fillCell(i); updateToolButtons(); saveSoon();
    }
    return;
  }
  if (!G.cells[i] || G.filled[i]) return;
  if (G.cells[i] === G.selected) fillCell(i);
  else {
    G.fx.push({ kind: 'wrong', i, t0: performance.now() });
    Sound.error();
    if (profile.settings.haptics && navigator.vibrate) navigator.vibrate([20, 30, 20]);
  }
}

// ---------------------------------------------------------------- completion
function onLevelComplete() {
  if (G.done) return;
  G.done = true;
  G.inputLocked = true;
  G.armed = null;
  FTUE.end();
  Analytics.track('level_complete', { id: G.level.id, cells: G.totalCells });
  profile.imagesCompleted++;
  // Did this painting COMPLETE its shelf? Computed now (while this level's
  // progress record is being written) and shown after the win panel closes,
  // so the trophy never fights the confetti for attention.
  _pendingSetAward = checkSetComplete(G.level);
  profile.coins += COIN_REWARD;
  let msg = `+${COIN_REWARD} 🪙 earned`;
  if (profile.imagesCompleted === UNLOCKS.bomb) { profile.boosters.bomb += 2; msg += ' · 💣 Bomb unlocked!'; }
  if (profile.imagesCompleted === UNLOCKS.brush) { profile.boosters.brush += 2; msg += ' · 🖌️ Brush unlocked!'; }
  $('winReward').textContent = msg;
  updateCoinUI(); saveNow();

  const { width: W, height: H } = G.level;
  const fitZ = Math.min(vw / (W * CP), (vh * 0.6) / (H * CP)) * 0.9;
  flyCamera(fitZ, (vw - W * CP * fitZ) / 2, vh * 0.06 + (vh * 0.55 - H * CP * fitZ) / 2, 700, () => {
    startReplay();
  });
  // end-to-end watchdog: camera fly + replay both ride rAF, which throttled
  // tabs suspend — whatever stalls, the panel must appear
  setTimeout(() => {
    if ($('winOverlay').classList.contains('open')) return;
    if (G.camAnim) { G.camAnim.cb = null; G.camAnim = null; }
    if (G.replay) { stepReplay(Infinity); return; }   // finishes → panel
    // replay never started: restore the full reveal and close out
    G.revealCanvas.getContext('2d').drawImage(G.artCanvas, 0, 0);
    finishCeremony();
  }, 6000);
}

// Ceremony act I: wipe the color and repaint it as a fast timelapse — the
// picture wakes from B&W to full sparkle in ~3 seconds, color by color.
function startReplay() {
  const order = [...G.filledList].sort((a, b) =>
    (G.cells[a] - G.cells[b]) || (a - b));
  G.revealCanvas.getContext('2d').clearRect(0, 0, G.revealCanvas.width, G.revealCanvas.height);
  G.replay = { queue: order, k: 0, perFrame: Math.max(4, Math.ceil(order.length / 170)) };
  needRender = true;
}
function stepReplay(count) {
  const r = G.replay;
  if (!r) return;
  const W = G.level.width;
  const rc = G.revealCanvas.getContext('2d');
  const end = Math.min(r.queue.length, r.k + count);
  for (; r.k < end; r.k++) {
    const i = r.queue[r.k];
    const x = (i % W) * CP, y = ((i / W) | 0) * CP;
    rc.drawImage(G.artCanvas, x, y, CP, CP, x, y, CP, CP);
  }
  if (r.k >= r.queue.length) {
    G.replay = null;
    finishCeremony();
  }
}
function finishCeremony() {
  G.shine = { t0: performance.now(), dur: 1200 };
  Sound.resolve();
  spawnConfetti();
  // win panel thumb: the character takes a bow (sprite frames if it has them)
  const cv = $('winThumb');
  if (cv) {
    cv.width = G.level.width; cv.height = G.level.height;
    drawPromoThumb(cv, G.level);
    if (G.level.anim && G.level.anim.length) {
      if (!G.level._animCells) G.level._animCells = G.level.anim.map(decodeCells);
      const f1 = G.level._animCells[0];
      if (f1 && f1.length === G.level.width * G.level.height) {
        [f1, null, f1, null, f1, null].forEach((frame, k) =>
          setTimeout(() => {
            try { drawThumb(cv, G.level, true, frame || undefined); } catch { /* cosmetic */ }
          }, 700 + k * 420));
      }
    }
  }
  setTimeout(() => $('winOverlay').classList.add('open'), 600);
}
function spawnConfetti() {
  if (REDUCED_MOTION) return;
  const colors = G.level.palette.map((p) => p.hex).concat(['#c9a86a', '#c1663f']);
  for (let k = 0; k < 140; k++) {
    G.confetti.push({
      x: vw / 2 + (Math.random() - 0.5) * vw * 0.5,
      y: -20 - Math.random() * vh * 0.3,
      vx: (Math.random() - 0.5) * 3,
      vy: 2 + Math.random() * 3.5,
      rot: Math.random() * 7, vr: (Math.random() - 0.5) * 0.25,
      w: 6 + Math.random() * 7, h: 4 + Math.random() * 5,
      c: colors[(Math.random() * colors.length) | 0],
    });
  }
}

// ---------------------------------------------------------------- render loop
function render(now) {
  requestAnimationFrame(render);
  if (document.hidden) return;   // battery: no drawing in background
  if (!$('game').classList.contains('active') || !G.level) return;
  stepCamera(now);
  FTUE.positionHand();

  // idle skip: keep the last frame unless something moved or animates
  const animating = G.camAnim || G.fx.length || G.confetti.length || G.shine ||
    G.replay || FTUE.active || G.armed === 'bucket' || G.armed === 'bomb' ||
    (profile.settings.sparkle && !REDUCED_MOTION && G.filledList.length > 0 &&
     artStyle() === 'shimmer');
  if (!needRender && !animating) return;
  needRender = false;
  if (G.replay) stepReplay(G.replay.perFrame);

  const { width: W, height: H } = G.level;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = bgGrad || '#fff';
  ctx.fillRect(0, 0, vw, vh);
  ctx.setTransform(G.zoom * dpr, 0, 0, G.zoom * dpr, G.panX * dpr, G.panY * dpr);

  const px = CP * G.zoom;   // on-screen cell size
  // Zoom-out preview: below ~14px cells the working grid crossfades into a
  // soft full-color image (smoothed upscale = gentle "plush pixel" look).
  // Numbers and grid exist only when zoomed in enough to actually use them.
  const previewAlpha = clamp((14 - px) / 4, 0, 1);

  // layer 1: ghost grays
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(G.grayCanvas, 0, 0, W * CP, H * CP);

  // layer 1.5: candy-tile preview fading in as you zoom out (full-res
  // source being minified = crisp edges, soft rounded tiles)
  if (previewAlpha > 0 && G.previewCanvas) {
    ctx.globalAlpha = previewAlpha;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(G.previewCanvas, 0, 0, W * CP, H * CP);
    ctx.globalAlpha = 1;
    ctx.imageSmoothingEnabled = false;
  }

  // layer 2: revealed glitter art
  ctx.drawImage(G.revealCanvas, 0, 0, W * CP, H * CP);

  // layer 3: grid + numbers + selection highlight (viewport-culled)
  const x0 = clamp(Math.floor(-G.panX / G.zoom / CP), 0, W - 1);
  const y0 = clamp(Math.floor(-G.panY / G.zoom / CP), 0, H - 1);
  const x1 = clamp(Math.ceil((vw - G.panX) / G.zoom / CP), 0, W - 1);
  const y1 = clamp(Math.ceil((vh - G.panY) / G.zoom / CP), 0, H - 1);

  if (px >= 5 && previewAlpha === 0) {
    ctx.strokeStyle = 'rgba(0,0,0,.07)';
    ctx.lineWidth = 1 / G.zoom;
    ctx.beginPath();
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const i = y * W + x;
      if (!G.cells[i] || G.filled[i]) continue;
      ctx.rect(x * CP, y * CP, CP, CP);
    }
    ctx.stroke();
  }
  // selection highlight fades out as the preview fades in
  let anySelectedVisible = false;
  if (previewAlpha < 1) {
    ctx.globalAlpha = 1 - previewAlpha;
    ctx.fillStyle = '#8f8f96';
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const i = y * W + x;
      if (G.cells[i] === G.selected && !G.filled[i]) {
        ctx.fillRect(x * CP, y * CP, CP, CP);
        anySelectedVisible = true;
      }
    }
    ctx.globalAlpha = 1;
  }
  // numbers: zoom in to see them (the preview owns the far view)
  if (px >= 14) {
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `600 ${CP * numberScale()}px -apple-system, sans-serif`;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const i = y * W + x;
      const n = G.cells[i];
      if (!n || G.filled[i]) continue;
      ctx.fillStyle = n === G.selected ? '#fff'
        : (G.numberInk ? G.numberInk[n - 1] : '#7a7a82');
      ctx.fillText(n, (x + 0.5) * CP, (y + 0.54) * CP);
    }
  }

  drawWayfinder(now, anySelectedVisible, previewAlpha, W);
  drawFx(now, W);
  drawTwinkles(now, W, H, x0, y0, x1, y1);
  drawShine(now, W, H);
  if (G.armed === 'bucket' || G.armed === 'bomb') drawToolCursor();
  drawLoupe(now);
  drawConfetti();
}

// Magnifier loupe: while painting (or press-holding) in dense zoom levels,
// a magnified bubble above the finger shows cells + numbers at readable size
function drawLoupe(now) {
  if (!gesture || !G.lastPointer) return;
  const holding = gesture.mode === 'paint' ||
    (gesture.mode === 'pending' && now - gesture.t0 > 380);
  const cellPx = CP * G.zoom;
  if (!holding || cellPx >= 20) return;
  const px = G.lastPointer.x, py = G.lastPointer.y;
  const wx = (px - G.panX) / G.zoom, wy = (py - G.panY) / G.zoom;   // art px
  const LZ = 26 / CP;              // loupe zoom: 26px cells = readable
  const R = 60;
  const lx = clamp(px, R + 8, vw - R - 8);
  const ly = Math.max(R + 12, py - 105);

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.save();
  ctx.beginPath();
  ctx.arc(lx, ly, R, 0, 7);
  ctx.clip();
  ctx.fillStyle = bgGrad || '#fff';
  ctx.fillRect(lx - R, ly - R, R * 2, R * 2);
  ctx.setTransform(LZ * dpr, 0, 0, LZ * dpr, (lx - wx * LZ) * dpr, (ly - wy * LZ) * dpr);
  const W = G.level.width, H = G.level.height;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(G.grayCanvas, 0, 0, W * CP, H * CP);
  ctx.drawImage(G.revealCanvas, 0, 0, W * CP, H * CP);
  const cx0 = clamp(Math.floor((wx - R / LZ) / CP), 0, W - 1);
  const cy0 = clamp(Math.floor((wy - R / LZ) / CP), 0, H - 1);
  const cx1 = clamp(Math.ceil((wx + R / LZ) / CP), 0, W - 1);
  const cy1 = clamp(Math.ceil((wy + R / LZ) / CP), 0, H - 1);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = `600 ${CP * numberScale()}px -apple-system, sans-serif`;
  for (let y = cy0; y <= cy1; y++) for (let x = cx0; x <= cx1; x++) {
    const i = y * W + x;
    const n = G.cells[i];
    if (!n || G.filled[i]) continue;
    if (n === G.selected) {
      ctx.fillStyle = '#8f8f96';
      ctx.fillRect(x * CP, y * CP, CP, CP);
      ctx.fillStyle = '#fff';
    } else {
      ctx.fillStyle = G.numberInk ? G.numberInk[n - 1] : '#7a7a82';
    }
    ctx.fillText(n, (x + 0.5) * CP, (y + 0.54) * CP);
  }
  ctx.restore();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.beginPath();
  ctx.arc(lx, ly, R, 0, 7);
  ctx.lineWidth = 3.5;
  ctx.strokeStyle = 'rgba(107,143,113,.95)';
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(lx, ly, 3, 0, 7);
  ctx.fillStyle = 'rgba(107,143,113,.9)';
  ctx.fill();
  ctx.setTransform(G.zoom * dpr, 0, 0, G.zoom * dpr, G.panX * dpr, G.panY * dpr);
}

// Wayfinding: when every remaining cell of the selected color is off-screen,
// an edge arrow points to the nearest one; tapping it flies the camera there.
function drawWayfinder(now, anySelectedVisible, previewAlpha, W) {
  G.wayfindHit = null;
  if (anySelectedVisible || previewAlpha >= 1 || G.inputLocked || G.replay) { G.wayfind = null; return; }
  const p = G.level.palette[G.selected - 1];
  if (!p || G.perColor[G.selected] >= p.count) { G.wayfind = null; return; }
  // refresh the target occasionally (camera moves invalidate it cheaply)
  if (!G.wayfind || now - G.wayfind.t > 350) {
    const cx = (vw / 2 - G.panX) / G.zoom / CP, cy = (vh / 2 - G.panY) / G.zoom / CP;
    let best = -1, bd = Infinity;
    for (let i = 0; i < G.cells.length; i++) {
      if (G.cells[i] !== G.selected || G.filled[i]) continue;
      const d = Math.hypot(i % W - cx, ((i / W) | 0) - cy);
      if (d < bd) { bd = d; best = i; }
    }
    if (best < 0) { G.wayfind = null; return; }
    G.wayfind = { i: best, t: now };
  }
  const ti = G.wayfind.i;
  const tx = ((ti % W) + 0.5) * CP * G.zoom + G.panX;
  const ty = (((ti / W) | 0) + 0.5) * CP * G.zoom + G.panY;
  const ccx = vw / 2, ccy = vh * 0.45;
  const dx = tx - ccx, dy = ty - ccy;
  const len = Math.hypot(dx, dy) || 1;
  // pin to a safe on-screen ring
  const m = { l: 46, r: 46, t: 110, b: 200 };
  const k = Math.min(
    dx > 0 ? (vw - m.r - ccx) / dx : dx < 0 ? (m.l - ccx) / dx : 1e9,
    dy > 0 ? (vh - m.b - ccy) / dy : dy < 0 ? (m.t - ccy) / dy : 1e9);
  const ax = ccx + dx * k, ay = ccy + dy * k;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const pulse = 1 + Math.sin(now / 260) * 0.07;
  ctx.beginPath();
  ctx.arc(ax, ay, 21 * pulse, 0, 7);
  ctx.fillStyle = 'rgba(107,143,113,.94)';
  ctx.fill();
  ctx.save();
  ctx.translate(ax, ay);
  ctx.rotate(Math.atan2(dy, dx));
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.moveTo(10, 0); ctx.lineTo(-4, -7); ctx.lineTo(-4, 7);
  ctx.closePath(); ctx.fill();
  ctx.restore();
  G.wayfindHit = { x: ax, y: ay, i: ti };
  ctx.setTransform(G.zoom * dpr, 0, 0, G.zoom * dpr, G.panX * dpr, G.panY * dpr);
}

function drawFx(now, W) {
  for (let k = G.fx.length - 1; k >= 0; k--) {
    const f = G.fx[k];
    const t = now - f.t0;
    if (t < 0) continue;
    const x = (f.i % W) * CP, y = ((f.i / W) | 0) * CP;
    if (f.kind === 'pop') {
      const k1 = t / 240;
      if (k1 >= 1) { G.fx.splice(k, 1); continue; }
      const s = 1 + 0.45 * (1 - ease(k1));
      const off = (CP * (s - 1)) / 2;
      ctx.drawImage(G.artCanvas, x, y, CP, CP, x - off, y - off, CP * s, CP * s);
      ctx.globalAlpha = 0.5 * (1 - k1);
      ctx.fillStyle = '#fff';
      ctx.fillRect(x - off, y - off, CP * s, CP * s);
      ctx.globalAlpha = 1;
    } else if (f.kind === 'wrong') {
      const k1 = t / 380;
      if (k1 >= 1) { G.fx.splice(k, 1); continue; }
      const jx = Math.sin(t / 18) * CP * 0.08 * (1 - k1);
      ctx.globalAlpha = 0.4 * (1 - k1);
      ctx.fillStyle = '#ff5a4e';
      ctx.fillRect(x + jx, y, CP, CP);
      ctx.globalAlpha = 1;
    } else if (f.kind === 'pulse') {
      const k1 = t / 600;
      if (k1 >= 1) { G.fx.splice(k, 1); continue; }
      ctx.strokeStyle = `rgba(107,143,113,${1 - k1})`;
      ctx.lineWidth = 3 / G.zoom;
      const r = CP * (0.5 + k1 * 1.6);
      ctx.beginPath();
      ctx.arc(x + CP / 2, y + CP / 2, r, 0, 7);
      ctx.stroke();
    }
  }
}

function drawTwinkles(now, W, H, x0, y0, x1, y1) {
  // painting mode reveals real art — ambient glitter would sit on top of it
  if (!profile.settings.sparkle || REDUCED_MOTION || artStyle() === 'painting') {
    G.twinkles.length = 0; return;
  }
  // keep ~35 alive, spawned over visible *filled* cells
  if (G.twinkles.length < 35 && G.filledList.length > 0) {
    for (let s = 0; s < 3; s++) {
      const i = G.filledList[(Math.random() * G.filledList.length) | 0];
      const cx = i % W, cy = (i / W) | 0;
      if (cx < x0 || cx > x1 || cy < y0 || cy > y1) continue;
      G.twinkles.push({
        x: (cx + Math.random()) * CP, y: (cy + Math.random()) * CP,
        t0: now, dur: 500 + Math.random() * 900,
        r: (0.1 + Math.random() * 0.22) * CP,
      });
    }
  }
  for (let k = G.twinkles.length - 1; k >= 0; k--) {
    const tw = G.twinkles[k];
    const k1 = (now - tw.t0) / tw.dur;
    if (k1 >= 1) { G.twinkles.splice(k, 1); continue; }
    const a = Math.sin(k1 * Math.PI);
    const r = tw.r * (0.5 + a * 0.5);
    ctx.globalAlpha = a * 0.9;
    ctx.fillStyle = '#fff';
    ctx.beginPath();                                  // 4-point star
    ctx.moveTo(tw.x, tw.y - r); ctx.quadraticCurveTo(tw.x, tw.y, tw.x + r, tw.y);
    ctx.quadraticCurveTo(tw.x, tw.y, tw.x, tw.y + r);
    ctx.quadraticCurveTo(tw.x, tw.y, tw.x - r, tw.y);
    ctx.quadraticCurveTo(tw.x, tw.y, tw.x, tw.y - r);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}

function drawShine(now, W, H) {
  if (!G.shine) return;
  const k = (now - G.shine.t0) / G.shine.dur;
  if (k >= 1) { G.shine = null; return; }
  const aw = W * CP, ah = H * CP;
  const pos = -0.4 + k * 1.8;
  const g = ctx.createLinearGradient(aw * (pos - 0.25), 0, aw * (pos + 0.25), ah * 0.35);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.5, 'rgba(255,255,255,.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, aw, ah); ctx.clip();
  ctx.fillStyle = g; ctx.fillRect(0, 0, aw, ah);
  ctx.restore();
}

function drawToolCursor() {
  if (!G.lastPointer) return;
  const i = cellAt(G.lastPointer.x, G.lastPointer.y);
  if (i < 0) return;
  const W = G.level.width;
  const x = (i % W) * CP, y = ((i / W) | 0) * CP;
  ctx.strokeStyle = '#6b8f71';
  ctx.lineWidth = 3.5 / G.zoom;
  const pad = CP * 0.18;
  ctx.strokeRect(x - pad, y - pad, CP + pad * 2, CP + pad * 2);
}

function drawConfetti() {
  if (!G.confetti.length) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);   // screen space
  for (let k = G.confetti.length - 1; k >= 0; k--) {
    const c = G.confetti[k];
    c.x += c.vx; c.y += c.vy; c.vy += 0.06; c.rot += c.vr;
    if (c.y > vh + 30) { G.confetti.splice(k, 1); continue; }
    ctx.save();
    ctx.translate(c.x, c.y); ctx.rotate(c.rot);
    ctx.fillStyle = c.c;
    ctx.fillRect(-c.w / 2, -c.h / 2, c.w, c.h);
    ctx.restore();
  }
}

// ---------------------------------------------------------------- gallery
// Set while navigating in RESPONSE to a back press, so we adjust the UI
// without touching the history we are already being popped out of.
let _navFromPop = false;
function showScreen(name) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  $(name).classList.add('active');
  // Android's back button must leave a painting, not the app. The lobby is
  // home; every other screen keeps exactly ONE history entry so back lands
  // there. Without an entry to pop, Android does not fire popstate at all —
  // it just closes the app, which is what happened from inside a painting.
  if (!_navFromPop) {
    if (name === 'gallery') {
      if (history.state && history.state.screen) {   // leaving via the UI:
        _sheetPopSuppress++;                          // consume our entry so
        history.back();                               // back is not a no-op
      }
    } else if (!(history.state && history.state.screen)) {
      history.pushState({ screen: name }, '');        // one entry, not one per hop
    }
  }
  if (name === 'gallery') { buildGallery(); Music.stop(); }
  else if (name === 'wall') { buildWall(); Music.stop(); }
  else if (name === 'search') {
    Music.stop();
    $('searchInput').value = '';
    runSearch('');
    setTimeout(() => $('searchInput').focus(), 80);
  }
  else if (name === 'game') Music.start();
}
function buildGallery() {
  $('galleryCoinCount').textContent = profile.coins;
  buildHero();
  buildGiftStrip();
  buildCatCircles();

  const shelves = $('shelves');
  shelves.replaceChildren();
  const ev = activeEvent();
  const cats = Object.keys(CATS).filter((c) =>
    c === 'myphotos' || LEVELS.some((l) => l.cat === c));
  // My Photos lives at the BOTTOM of the page — the shipped catalog leads,
  // and the circles row ends with a nav icon that jumps down to it
  const mp = cats.indexOf('myphotos');
  if (mp >= 0) { cats.splice(mp, 1); cats.push('myphotos'); }
  if (ev && !cats.includes(ev.cat)) cats.unshift(ev.cat);
  else if (ev) { cats.splice(cats.indexOf(ev.cat), 1); cats.unshift(ev.cat); }
  for (const cat of cats) {
    const entries = LEVELS
      .filter((l) => l.cat === cat)
      .map((l) => ({ l, s: levelProgressSummary(l) }));
    entries.sort((a, b) => {
      const rank = (e) => (e.s.done ? 2 : e.s.pct > 0 ? 0 : 1);
      // among untouched paintings, free ones lead the shelf — the player
      // meets paintable art before the Watch badges
      return rank(a) - rank(b) || b.s.ts - a.s.ts
        || (isLocked(a.l) ? 1 : 0) - (isLocked(b.l) ? 1 : 0);
    });
    const isEvent = ev && cat === ev.cat;
    const meta = CATS[cat] || { icon: '\uD83C\uDF89', label: ev ? ev.label : cat, bg: '#fff3e2' };
    const sec = el('section', 'shelf' + (isEvent ? ' event' : ''));
    sec.id = 'shelf-' + cat;
    const head = el('div', 'shelf-head');
    // Icon in its own fixed-width box rather than inline in the text. Emoji
    // advance widths differ per glyph, so "🏡 Homes" and "🛋 Interiors" as
    // flowing strings start their LABELS at different x — visible as ragged
    // headings all the way down the lobby. Two boxes, two clean columns.
    if (isEvent) {
      head.appendChild(el('span', '', ev.label));
    } else {
      const h = el('span', 'shelf-title');
      h.appendChild(el('i', 'ri', meta.icon));
      h.appendChild(el('span', '', meta.label));
      head.appendChild(h);
    }
    // no count here on purpose — a number caps the sense of how much there
    // is and discourages scrolling; let the shelf just keep going
    if (isEvent) head.appendChild(el('span', 'event-count', `Ends in ${eventDaysLeft(ev)}d`));
    sec.appendChild(head);
    const row = el('div', 'shelf-row');
    const populate = () => {
      if (row.dataset.built) return;
      row.dataset.built = '1';
      if (cat === 'myphotos') {
        const cc = el('button', 'scard create-card');
        cc.appendChild(el('div', 'big', '\uD83D\uDCF8'));
        cc.appendChild(el('div', 'nm', 'New from photo'));
        cc.addEventListener('click', () => {
          if (userLevelCount() >= MAX_USER_LEVELS) {
            toast(`Photo shelf is full (${MAX_USER_LEVELS}) \u2014 delete one to make room`);
            return;
          }
          $('photoFile').click();
        });
        row.appendChild(cc);
      }
      for (const { l: level, s: ps } of entries) {
        const { pct, done } = ps;
        const card = el('button', 'scard' + (done ? ' done-card' : ''));
        card.dataset.lid = level.id;
        card.appendChild(el('span', 'tier', tierFor(level)));
        if (isLocked(level)) card.appendChild(watchPill());
        const cv = makeCanvas(level.width, level.height);
        if (done) drawPromoThumb(cv, level);
        else drawThumb(cv, level, false);
        const wrap2 = el('div', 'thumbwrap');
        wrap2.style.background = (CATS[cat] || meta).bg;
        wrap2.appendChild(cv);
        card.appendChild(wrap2);
        card.appendChild(el('div', 'nm', done ? '\u2713 ' + level.name : level.name));
        if (!done && pct > 0) {
          const bar = el('div', 'bar');
          const fill = el('i');
          fill.style.width = `${Math.max(2, pct * 100)}%`;
          bar.appendChild(fill);
          card.appendChild(bar);
        }
        if (cat === 'myphotos') {
          const db = el('button', 'del', '\u00D7');
          db.addEventListener('click', (ev) => { ev.stopPropagation(); deleteUserLevel(level.id); });
          card.appendChild(db);
        }
        card.addEventListener('click', () => openWithTransition(level, card));
        row.appendChild(card);
      }
    };
    row.style.minHeight = '168px';
    if (shelves.children.length < 2 || !shelfObserver) {
      populate();                       // above the fold (or no IO support)
    } else {
      row._populate = populate;
      shelfObserver.observe(row);
    }
    sec.appendChild(row);
    shelves.appendChild(sec);
  }
}

let shelfObserver = null;
if ('IntersectionObserver' in window) {
  shelfObserver = new IntersectionObserver((ents) => {
    for (const e of ents) {
      if (e.isIntersecting && e.target._populate) {
        e.target._populate();
        shelfObserver.unobserve(e.target);
      }
    }
  }, { rootMargin: '400px 0px' });
}

// ---- shared-element transition: the card art grows into the painting
function openWithTransition(level, cardEl) {
  const cv = cardEl && cardEl.querySelector('canvas');
  if (REDUCED_MOTION || !cv) { openLevel(level); return; }
  try {
    const r = cv.getBoundingClientRect();
    const ghost = makeCanvas(cv.width, cv.height);
    ghost.getContext('2d').drawImage(cv, 0, 0);
    const dark = !!profile.settings.dark;
    ghost.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;` +
      `width:${r.width}px;height:${r.height}px;z-index:99;pointer-events:none;` +
      'image-rendering:pixelated;object-fit:contain;' +
      'transition:all .38s cubic-bezier(.3,.8,.3,1);';
    const veil = el('div');
    veil.style.cssText = 'position:fixed;inset:0;z-index:98;opacity:0;' +
      `pointer-events:none;transition:opacity .34s;background:${dark ? '#141519' : '#fff'};`;
    document.body.append(veil, ghost);
    requestAnimationFrame(() => {
      const tw = Math.min(vw * 0.78, 330);
      const th = tw * (cv.height / cv.width);
      ghost.style.left = `${(vw - tw) / 2}px`;
      ghost.style.top = `${vh * 0.4 - th / 2}px`;
      ghost.style.width = `${tw}px`;
      ghost.style.height = `${th}px`;
      veil.style.opacity = '1';
    });
    setTimeout(() => openLevel(level), 300);
    setTimeout(() => {
      ghost.style.transition = 'opacity .26s';
      veil.style.transition = 'opacity .3s';
      ghost.style.opacity = '0';
      veil.style.opacity = '0';
    }, 430);
    setTimeout(() => { ghost.remove(); veil.remove(); }, 800);
  } catch { openLevel(level); }
}

function jumpToShelf(cat) {
  const sec = document.getElementById('shelf-' + cat);
  const sh = $('shelves');
  if (!sec || !sh) return;
  const top = sh.scrollTop + sec.getBoundingClientRect().top - sh.getBoundingClientRect().top - 4;
  animateScroll(sh, top);
}

// own rAF scroll animation: scrollTo({behavior:'smooth'}) is unreliable
// across engines (silently no-ops in some), so we ease it ourselves
function animateScroll(elm, to, dur = 450) {
  if (REDUCED_MOTION) { elm.scrollTop = to; return; }
  const from = elm.scrollTop, t0 = performance.now();
  let finished = false;
  const step = (now) => {
    const k = clamp((now - t0) / dur, 0, 1);
    elm.scrollTop = from + (to - from) * ease(k);
    if (k < 1) requestAnimationFrame(step);
    else finished = true;
  };
  requestAnimationFrame(step);
  // rAF is suspended in hidden/throttled tabs — guarantee arrival regardless
  setTimeout(() => { if (!finished) elm.scrollTop = to; }, dur + 120);
}

// daily gift: the SHEIN-style promo strip, wired to real coins (+5/day)
const STREAK_REWARDS = [5, 6, 7, 8, 9, 10, 12];   // day 1..7+, capped
function streakRewardFor(count) {
  return STREAK_REWARDS[Math.min(Math.max(count, 1) - 1, STREAK_REWARDS.length - 1)];
}
function buildGiftStrip() {
  let strip = $('giftStrip');
  if (!strip) {
    strip = el('div'); strip.id = 'giftStrip';
    $('heroWrap').after(strip);
  }
  strip.replaceChildren();
  const today = Math.floor(Date.now() / 86400000);
  const claimed = profile.lastGiftDay === today;
  const alive = profile.lastGiftDay === today || profile.lastGiftDay === today - 1;
  const streak = alive ? (profile.streakCount || 0) : 0;
  const nextReward = streakRewardFor(claimed ? streak + 1 : streak + 1);

  strip.appendChild(el('span', '', '\uD83C\uDF81'));
  const grow = el('span', 'grow');
  grow.appendChild(el('span', '',
    claimed ? 'Back tomorrow to keep it! ' : 'Daily gift ready '));
  if (streak > 1) grow.appendChild(el('span', 'fire', `\uD83D\uDD25 ${streak}-day streak`));
  strip.appendChild(grow);

  // trailing-7-days calendar dots, streak-filled up to the last claim
  const dots = el('span', 'dots');
  const anchor = claimed ? today : profile.lastGiftDay;
  for (let d = 6; d >= 0; d--) {
    const day = today - d;
    const on = alive && day <= anchor && day > anchor - Math.min(streak, 7);
    dots.appendChild(el('i', on ? 'on' : ''));
  }
  strip.appendChild(dots);

  const btn = el('button', '', claimed ? '\u2713' : `+${nextReward} \uD83E\uDE99`);
  btn.disabled = claimed;
  btn.addEventListener('click', () => {
    if (profile.lastGiftDay === today) return;
    profile.streakCount = profile.lastGiftDay === today - 1 ? (profile.streakCount || 0) + 1 : 1;
    profile.lastGiftDay = today;
    const reward = streakRewardFor(profile.streakCount);
    profile.coins += reward;
    updateCoinUI(); saveSoon();
    Analytics.track('gift_claim', { streak: profile.streakCount, reward });
    Sound.colorDone();
    toast(`+${reward} \uD83E\uDE99 ${profile.streakCount > 1 ? `\uD83D\uDD25 ${profile.streakCount}-day streak!` : 'See you tomorrow!'}`);
    buildGiftStrip();
  });
  strip.appendChild(btn);
}

// circular category quick-nav (image-first, jumps to the shelf)
function buildCatCircles() {
  let rowEl = $('catCircles');
  if (!rowEl) {
    rowEl = el('div'); rowEl.id = 'catCircles';
    $('giftStrip').after(rowEl);
  }
  rowEl.replaceChildren();
  for (const cat of Object.keys(CATS).filter((c) =>
      c !== 'myphotos' && LEVELS.some((l) => l.cat === c))) {
    const sample = LEVELS.find((l) => l.cat === cat);
    const btn = el('button', 'ccirc');
    const cir = el('div', 'cir');
    cir.style.background = CATS[cat].bg;
    const cv = makeCanvas(sample.width, sample.height);
    drawPromoThumb(cv, sample);
    cir.appendChild(cv);
    btn.appendChild(cir);
    btn.appendChild(el('div', 'lbl', CATS[cat].label));
    btn.addEventListener('click', () => jumpToShelf(cat));
    rowEl.appendChild(btn);
  }
  // trailing nav circle: jumps down to the My Photos shelf at the bottom
  const pbtn = el('button', 'ccirc');
  const pcir = el('div', 'cir');
  pcir.style.background = 'var(--chipbg)';
  const glyph = el('span', '', '📸');
  glyph.style.fontSize = '26px';
  pcir.appendChild(glyph);
  pbtn.appendChild(pcir);
  pbtn.appendChild(el('div', 'lbl', 'My Photos'));
  pbtn.addEventListener('click', () => jumpToShelf('myphotos'));
  rowEl.appendChild(pbtn);
}

// hero carousel: auto-rotating promo slides (continue / daily / featured pack)
let heroTimer = null, heroIdx = 0;
function buildHero() {
  const wrap = $('heroWrap');
  wrap.replaceChildren();
  clearInterval(heroTimer);
  heroIdx = 0;

  const slides = [];
  const summaries = LEVELS.map((l) => ({ l, s: levelProgressSummary(l) }));

  // 0. limited event: always first while live
  const ev0 = activeEvent();
  if (ev0) {
    const evLvls = LEVELS.filter((l) => l.cat === ev0.cat);
    slides.push({
      cls: 'hero-pack', label: '\u23F3 LIMITED EVENT', name: ev0.label,
      sub: `A limited collection \u2014 ends in ${eventDaysLeft(ev0)} days`,
      go: 'Play now', arts: evLvls.slice(0, 3).length >= 2 ? evLvls.slice(0, 3) : [evLvls[0]],
      onTap: () => jumpToShelf(ev0.cat),
    });
  }

  // 1. Continue: most recently painted, unfinished
  const started = summaries.filter((e) => !e.s.done && e.s.pct > 0);
  started.sort((a, b) => b.s.ts - a.s.ts);
  const resume = started[0];
  if (resume) {
    slides.push({
      cls: 'hero-continue', label: 'CONTINUE PAINTING', name: resume.l.name,
      sub: `${Math.max(1, Math.round(resume.s.pct * 100))}% painted`,
      go: 'Resume', arts: [resume.l],
      onTap: () => openLevel(resume.l),
    });
  }

  // 2. Today's picture
  const daily = LEVELS.find((l) => l.id === dailyLevelId());
  if (daily) {
    const ds = levelProgressSummary(daily);
    slides.push({
      cls: 'hero-daily', label: "\u2B50 TODAY'S PICTURE", name: daily.name,
      sub: 'A new picture every day',
      go: ds.done ? '\u2713 Done' : ds.pct > 0 ? 'Resume' : 'Play',
      arts: [daily], onTap: () => openLevel(daily),
    });
  }

  // 3. Almost done: highest-progress unfinished (skip if it IS the resume)
  const almost = [...started].sort((a, b) => b.s.pct - a.s.pct)[0];
  if (almost && (!resume || almost.l.id !== resume.l.id) && almost.s.pct >= 0.3) {
    slides.push({
      cls: 'hero-continue', label: '\uD83C\uDFC1 SO CLOSE!', name: almost.l.name,
      sub: `${Math.round(almost.s.pct * 100)}% \u2014 nearly finished`,
      go: 'Finish it', arts: [almost.l],
      onTap: () => openLevel(almost.l),
    });
  }

  // 4. Featured collection: rotates daily through the well-stocked shelves
  // (was hardcoded to Flowers back when that was the only full shelf)
  let featuredCat = null;
  const featurable = Object.keys(CATS).filter((c) =>
    c !== 'myphotos' && LEVELS.filter((l) => l.cat === c).length >= 3);
  if (featurable.length) {
    featuredCat = featurable[Math.floor(Date.now() / 86400000) % featurable.length];
    const fl = LEVELS.filter((l) => l.cat === featuredCat);
    slides.push({
      cls: 'hero-pack',
      label: `${CATS[featuredCat].icon} FEATURED COLLECTION`,
      name: CATS[featuredCat].label,
      sub: 'A collection to lose yourself in', go: 'Explore',
      arts: [fl[1], fl[0], fl[2]].filter(Boolean),
      onTap: () => jumpToShelf(featuredCat),
    });
  }

  // 5. Category spotlight, rotating daily through the OTHER categories
  const others = Object.keys(CATS).filter((c) =>
    c !== featuredCat && c !== 'myphotos' && LEVELS.some((l) => l.cat === c));
  if (others.length) {
    const cat = others[Math.floor(Date.now() / 86400000) % others.length];
    const catLvls = LEVELS.filter((l) => l.cat === cat);
    slides.push({
      cls: 'hero-daily', label: `${CATS[cat].icon} ${CATS[cat].label.toUpperCase()} SHELF`,
      name: CATS[cat].label,
      sub: 'Something quiet to paint',
      go: 'Browse', arts: catLvls.slice(0, 3), onTap: () => jumpToShelf(cat),
    });
  }

  // 6. Start something new: a fresh untouched picture
  const fresh = summaries.filter((e) => !e.s.done && e.s.pct === 0 && e.l.cat !== 'myphotos');
  if (fresh.length) {
    const pick = fresh[Math.floor(Date.now() / 86400000 * 7) % fresh.length];
    slides.push({
      cls: 'hero-pack', label: '\ud83c\udfa8 START SOMETHING NEW', name: pick.l.name,
      sub: 'Untouched and waiting for color', go: 'Start',
      arts: [pick.l], onTap: () => openLevel(pick.l),
    });
  }

  if (!slides.length) return;

  const car = el('div'); car.id = 'heroCar';
  const track = el('div'); track.id = 'heroTrack';
  for (const sl of slides) {
    const sbtn = el('button', 'hero-slide ' + sl.cls);
    // full-bleed art: 1\u20133 paintings split the banner width and cover their
    // share, so the slide is filled edge to edge at any viewport size
    const bg = el('div', 'hero-bg');
    for (const lv of sl.arts.slice(0, 3)) {
      const c = makeCanvas(lv.width, lv.height);
      drawPromoThumb(c, lv);
      bg.appendChild(c);
    }
    sbtn.appendChild(bg);
    const info = el('div', 'hero-info');
    info.appendChild(el('div', 'hero-label', sl.label));
    info.appendChild(el('div', 'hero-name', sl.name));
    info.appendChild(el('div', 'hero-sub', sl.sub));
    info.appendChild(el('div', 'hero-go', sl.go));
    sbtn.appendChild(info);
    sbtn.addEventListener('click', sl.onTap);
    track.appendChild(sbtn);
  }
  car.appendChild(track);
  const dots = el('div'); dots.id = 'heroDots';
  slides.forEach(() => dots.appendChild(el('i')));
  car.appendChild(dots);
  wrap.appendChild(car);

  const setIdx = (i) => {
    heroIdx = i % slides.length;
    track.style.transform = `translateX(-${heroIdx * 100}%)`;
    [...dots.children].forEach((d, k) => d.classList.toggle('on', k === heroIdx));
  };
  setIdx(0);
  if (slides.length > 1 && !REDUCED_MOTION) {
    heroTimer = setInterval(() => {
      if (document.hidden || !$('gallery').classList.contains('active')) return;
      setIdx(heroIdx + 1);
    }, 4600);
  }
}

const thumbCache = new Map();
function drawThumb(cv, level, colored, cellsOverride) {
  if (!cellsOverride) {
    // cache full renders (per-cell loops are the gallery's hot path);
    // key includes fill count so progress patches invalidate naturally
    const saved = loadJSON('sp_prog_' + level.id, null);
    const key = `${level.id}|${colored ? 'c' : 'p'}|${saved ? saved.fc || 0 : 0}`;
    let src = thumbCache.get(key);
    if (!src) {
      src = makeCanvas(level.width, level.height);
      drawThumbRaw(src, level, colored);
      if (thumbCache.size > 220) thumbCache.clear();
      thumbCache.set(key, src);
    }
    const c = cv.getContext('2d');
    c.clearRect(0, 0, cv.width, cv.height);
    c.drawImage(src, 0, 0);
    return;
  }
  drawThumbRaw(cv, level, colored, cellsOverride);
}
function drawThumbRaw(cv, level, colored, cellsOverride) {
  // colored=true → full color (done pictures, promo cards).
  // otherwise: B&W image, with the player's actual painted cells in color —
  // the lobby doubles as a progress map ("my color spreads over the photo").
  // cellsOverride: an animation frame's cells (same grid + palette).
  const c = cv.getContext('2d');
  const cells = cellsOverride || decodeCells(level.cells);
  let filled = null;
  if (!colored) {
    const saved = loadJSON('sp_prog_' + level.id, null);
    if (saved && saved.f) {
      const f = decodeCells(saved.f);
      if (f.length === cells.length) filled = f;
    }
  }
  // raw pixel buffer: one putImageData instead of a fillRect per cell
  if (!cells.length) return;   // corrupt data → keep the canvas blank
  const W = level.width;
  const rgb = level.palette.map((p) => hexRGB(p.hex));
  const bw = level.palette.map((p) =>
    Math.round(96 + luminance(p.hex) * 140));   // wide-range B&W
  const img = c.createImageData(W, cells.length / W);
  const d = img.data;
  for (let i = 0; i < cells.length; i++) {
    const n = cells[i];
    if (!n) continue;
    const o = i * 4;
    if (colored || (filled && filled[i])) {
      const p = rgb[n - 1];
      d[o] = p[0]; d[o + 1] = p[1]; d[o + 2] = p[2];
    } else {
      d[o] = d[o + 1] = d[o + 2] = bw[n - 1];
    }
    d[o + 3] = 255;
  }
  c.putImageData(img, 0, 0);
}

// ---------------------------------------------------------------- search
// Searches are logged to the local Analytics buffer. The valuable signal
// is the EMPTY ones: "nine people searched 'butterfly' and found nothing"
// is a direct instruction to the art pipeline. Logging is debounced so a
// query is recorded once the player stops typing, not per keystroke, and
// nothing leaves the device today.
let searchTimer = null;

// "butterfly" must find a painting keyworded "butterflies" — a plain
// substring test cannot bridge singular and plural, so try both forms.
function queryForms(s) {
  const v = new Set([s]);
  if (s.endsWith('y')) v.add(s.slice(0, -1) + 'ies');
  if (s.endsWith('ies')) v.add(s.slice(0, -3) + 'y');
  if (s.endsWith('es')) v.add(s.slice(0, -2));
  if (s.endsWith('s')) v.add(s.slice(0, -1)); else v.add(s + 's');
  return [...v];
}

function matchLevels(q) {
  const s = q.trim().toLowerCase();
  if (!s) return [];
  const forms = queryForms(s);
  const hit = (hay) => forms.some((f) => hay.includes(f));
  return LEVELS.filter((l) => {
    const cat = (CATS[l.cat] && CATS[l.cat].label) || '';
    // l.kw holds subject terms from the generation prompt, so "butterfly"
    // finds Lavender Dance even though neither its title nor its shelf
    // says so. Titles alone describe what a painting is CALLED, not what
    // it is OF.
    return hit(l.name.toLowerCase()) || hit(cat.toLowerCase()) || hit(l.kw || '');
  });
}

function runSearch(q) {
  const body = $('searchBody');
  body.replaceChildren();
  $('searchBox').classList.toggle('has-text', !!q.trim());

  if (!q.trim()) {                       // resting state: browse by shelf
    body.appendChild(el('div', 'hint', 'Browse by collection'));
    const chips = el('div', 'scat-chips');
    for (const cat of Object.keys(CATS)) {
      const n = LEVELS.filter((l) => l.cat === cat).length;
      if (!n) continue;
      const c = el('button', 'scat-chip', `${CATS[cat].icon} ${CATS[cat].label}`);
      c.addEventListener('click', () => {
        showScreen('gallery');
        setTimeout(() => jumpToShelf(cat), 60);
      });
      chips.appendChild(c);
    }
    body.appendChild(chips);
    return;
  }

  const hits = matchLevels(q);
  if (!hits.length) {
    const empty = el('div');
    empty.id = 'searchEmpty';
    empty.appendChild(el('div', 'big', '🔍'));
    empty.appendChild(el('p', 'about-p', `No paintings match “${q.trim()}”.`));
    empty.appendChild(el('p', 'about-p', 'Try a colour, a place, or a season.'));
    body.appendChild(empty);
  } else {
    body.appendChild(el('div', 'hint',
      `${hits.length} ${hits.length === 1 ? 'painting' : 'paintings'}`));
    const grid = el('div', 'sresults');
    for (const level of hits) {
      const s = levelProgressSummary(level);
      const card = el('button', 'scard' + (s.done ? ' done-card' : ''));
      card.appendChild(el('span', 'tier', tierFor(level)));
      if (isLocked(level)) card.appendChild(watchPill());
      const cv = makeCanvas(level.width, level.height);
      if (s.done) drawPromoThumb(cv, level); else drawThumb(cv, level, false);
      const wrap = el('div', 'thumbwrap');
      wrap.style.background = (CATS[level.cat] || {}).bg || 'transparent';
      wrap.appendChild(cv);
      card.appendChild(wrap);
      card.appendChild(el('div', 'nm', s.done ? '✓ ' + level.name : level.name));
      card.addEventListener('click', () => openLevel(level));
      grid.appendChild(card);
    }
    body.appendChild(grid);
  }

  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    Analytics.track('search', { q: q.trim().slice(0, 40), hits: hits.length });
    if (!hits.length) Analytics.track('search_empty', { q: q.trim().slice(0, 40) });
  }, 700);
}

$('btnSearch').addEventListener('click', () => showScreen('search'));
$('btnSearchBack').addEventListener('click', () => showScreen('gallery'));
$('searchInput').addEventListener('input', (e) => runSearch(e.target.value));
$('searchClear').addEventListener('click', () => {
  $('searchInput').value = '';
  runSearch('');
  $('searchInput').focus();
});

// ---------------------------------------------------------------- my gallery
// Finished paintings hung on a wall — the "I'd hang this" promise made
// literal. Promo art (the real painting) in a gilded frame and cream mat,
// newest first, with a museum placard underneath.
function prettyDate(ts) {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleDateString(undefined,
      { year: 'numeric', month: 'long', day: 'numeric' });
  } catch { return ''; }
}

function buildWall() {
  const grid = $('wallGrid');
  grid.replaceChildren();
  const done = LEVELS
    .map((l) => ({ l, s: levelProgressSummary(l) }))
    .filter((e) => e.s.done)
    .sort((a, b) => b.s.ts - a.s.ts);

  $('wallCount').textContent = done.length
    ? `${done.length} ${done.length === 1 ? 'painting' : 'paintings'}`
    : 'Nothing hung yet';

  // earned collection badges — permanent trophies above the wall
  let sets = $('wallSets');
  if (!sets) {
    sets = el('div'); sets.id = 'wallSets';
    grid.parentNode.insertBefore(sets, grid);
  }
  sets.replaceChildren();
  const earned = Object.keys(profile.setsEarned || {})
    .filter((c) => CATS[c]).sort((a, b) => profile.setsEarned[a] - profile.setsEarned[b]);
  for (const c of earned) {
    const chip = el('span', 'setbadge');
    chip.appendChild(el('i', '', CATS[c].icon));
    chip.appendChild(el('b', '', CATS[c].label));
    sets.appendChild(chip);
  }
  sets.style.display = earned.length ? '' : 'none';

  if (!done.length) {
    const empty = el('div');
    empty.id = 'wallEmpty';
    empty.appendChild(el('div', 'ghost-frame'));
    empty.appendChild(el('p', 'about-p', 'Your finished paintings will hang here.'));
    empty.appendChild(el('p', 'about-p', 'Complete one to begin your collection.'));
    grid.appendChild(empty);
    return;
  }

  for (const { l, s } of done) {
    const piece = el('button', 'artpiece');
    const frame = el('div', 'artframe');
    const mat = el('div', 'artmat');
    const cv = makeCanvas(l.width, l.height);
    drawPromoThumb(cv, l);              // the real artwork, not the grid
    mat.appendChild(cv);
    frame.appendChild(mat);
    piece.appendChild(frame);
    const placard = el('div', 'artplacard');
    placard.appendChild(el('div', 'nm', l.name));
    placard.appendChild(el('div', 'dt', prettyDate(s.ts)));
    piece.appendChild(placard);
    piece.addEventListener('click', () => openArtView(l, s.ts));
    grid.appendChild(piece);
  }
}

let artViewLevel = null;
function openArtView(level, ts) {
  artViewLevel = level;
  const cv = $('artViewCanvas');
  cv.width = level.width; cv.height = level.height;   // sized before fallback
  drawPromoThumb(cv, level);
  $('artViewName').textContent = level.name;
  $('artViewDate').textContent = ts ? 'Finished ' + prettyDate(ts) : '';
  $('artView').classList.add('open');
  Analytics.track('wall_view', { id: level.id });
}

// Share any finished painting (the win panel shares the live board instead)
function shareArtwork(level) {
  if (!level) return;
  const S = 1200;
  const h = Math.max(1, Math.round(S * level.height / level.width));
  const out = makeCanvas(S, h + 100);
  const o = out.getContext('2d');
  o.fillStyle = '#fbfaf6';
  o.fillRect(0, 0, out.width, out.height);
  const src = makeCanvas(level.width, level.height);
  drawPromoThumb(src, level);
  o.imageSmoothingEnabled = true;
  o.imageSmoothingQuality = 'high';
  o.drawImage(src, 0, 0, S, h);
  o.fillStyle = '#6b8f71';
  o.font = '700 40px Georgia, serif';
  o.textAlign = 'center';
  o.fillText('Serene Canvas', S / 2, h + 64);
  out.toBlob(async (blob) => {
    if (!blob) return;
    const file = new File([blob], 'serene-canvas.png', { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: level.name }); } catch {}
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'serene-canvas.png';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }
    Analytics.track('wall_share', { id: level.id });
  });
}

$('btnWall').addEventListener('click', () => showScreen('wall'));
$('btnWallBack').addEventListener('click', () => showScreen('gallery'));
$('artViewClose').addEventListener('click', () => $('artView').classList.remove('open'));
$('artViewShare').addEventListener('click', () => shareArtwork(artViewLevel));

// ---------------------------------------------------------------- photo import
// Turns any photo into a playable level ENTIRELY on-device: median-cut
// quantization + 4x majority pooling + despeckle — the Python pipeline
// (pipeline/make_levels.py) ported to canvas. The photo never leaves the phone.
const PhotoImport = {
  SIZES: { easy: { dim: 44, k: 12 }, classic: { dim: 64, k: 14 }, epic: { dim: 84, k: 16 } },
  draft: null,   // { img, size, level }

  async fromFile(file) {
    try {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.src = url;                       // <img> decode auto-applies EXIF orientation
      await img.decode();
      URL.revokeObjectURL(url);
      this.draft = { img, size: 'classic' };
      this.process();
      document.querySelectorAll('#photoSizes .chip').forEach((c) =>
        c.classList.toggle('on', c.dataset.ps === 'classic'));
      $('photoSheet').classList.add('open');
      Analytics.track('photo_pick', {});
    } catch (e) {
      bufferError({ m: 'photo load: ' + e.message });
      toast("Couldn't read that photo \u2014 try another?");
    }
  },

  process() {
    const { img, size } = this.draft;
    const { dim, k } = this.SIZES[size];
    const t = performance.now();
    this.draft.level = this.quantize(img, dim, k);
    if (performance.now() - t > 250) Analytics.track('photo_slow', { ms: Math.round(performance.now() - t) });
    // preview at native cell resolution, CSS-upscaled pixelated
    const lv = this.draft.level;
    const pv = $('photoPreview');
    pv.width = lv.width; pv.height = lv.height;
    drawThumbRaw(pv, lv, true);
    pv.style.aspectRatio = `${lv.width} / ${lv.height}`;
    $('photoStats').textContent =
      `${lv.width}\u00D7${lv.height} \u2014 ${lv.palette.length} colors, ` +
      `${lv.palette.reduce((a, b) => a + b.count, 0).toLocaleString()} cells`;
  },

  quantize(img, maxDim, k) {
    const OS = 4;
    const scale = maxDim / Math.max(img.naturalWidth, img.naturalHeight);
    const gw = Math.max(8, Math.round(img.naturalWidth * scale));
    const gh = Math.max(8, Math.round(img.naturalHeight * scale));
    const hw = gw * OS, hh = gh * OS;

    // progressive downscale: halve repeatedly (single giant drawImage steps
    // box-filter with directional artifacts = the "smearing")
    let src = img, sw = img.naturalWidth, sh = img.naturalHeight;
    while (sw / 2 > hw && sh / 2 > hh) {
      const step = makeCanvas(Math.round(sw / 2), Math.round(sh / 2));
      const sx2 = step.getContext('2d');
      sx2.imageSmoothingEnabled = true;
      sx2.imageSmoothingQuality = 'high';
      sx2.drawImage(src, 0, 0, step.width, step.height);
      src = step; sw = step.width; sh = step.height;
    }
    const c = makeCanvas(hw, hh);
    const cx = c.getContext('2d', { willReadFrequently: true });
    cx.imageSmoothingEnabled = true;
    cx.imageSmoothingQuality = 'high';
    cx.filter = 'blur(0.6px) saturate(1.12) contrast(1.04)';   // fuse JPEG noise, gentle pop
    cx.drawImage(src, 0, 0, hw, hh);
    const px = cx.getImageData(0, 0, hw, hh).data;
    const nPx = hw * hh;

    // 1. median cut for the initial palette
    let box = new Array(nPx);
    for (let i = 0, j = 0; i < px.length; i += 4, j++)
      box[j] = (px[i] << 16) | (px[i + 1] << 8) | px[i + 2];
    let boxes = [box], _mc = 0;
    while (boxes.length < k) {
      if (++_mc > 100) break;   // safety: median cut is bounded by k anyway
      boxes.sort((a, b) => b.length - a.length);
      const big = boxes[0];
      if (big.length < 8) break;
      const mins = [255, 255, 255], maxs = [0, 0, 0];
      for (const v of big) {
        const r = v >> 16, g = (v >> 8) & 255, b2 = v & 255;
        if (r < mins[0]) mins[0] = r; if (r > maxs[0]) maxs[0] = r;
        if (g < mins[1]) mins[1] = g; if (g > maxs[1]) maxs[1] = g;
        if (b2 < mins[2]) mins[2] = b2; if (b2 > maxs[2]) maxs[2] = b2;
      }
      const ranges = [maxs[0] - mins[0], maxs[1] - mins[1], maxs[2] - mins[2]];
      const ch = ranges.indexOf(Math.max(...ranges));
      const shift = ch === 0 ? 16 : ch === 1 ? 8 : 0;
      big.sort((a, b) => ((a >> shift) & 255) - ((b >> shift) & 255));
      const mid = big.length >> 1;
      boxes = boxes.slice(1);
      boxes.push(big.slice(0, mid), big.slice(mid));
    }
    let palette = boxes.filter((b) => b.length).map((b) => {
      let r = 0, g = 0, b2 = 0;
      for (const v of b) { r += v >> 16; g += (v >> 8) & 255; b2 += v & 255; }
      return [r / b.length, g / b.length, b2 / b.length];
    });

    // 2. k-means refinement (2 rounds) — median-cut centroids drift muddy on
    // photos; Lloyd steps sharpen them noticeably
    const assign = new Uint8Array(nPx);
    const nearest = (r, g, b2) => {
      let best = 0, bd = Infinity;
      for (let pi = 0; pi < palette.length; pi++) {
        const d = (r - palette[pi][0]) ** 2 + (g - palette[pi][1]) ** 2 + (b2 - palette[pi][2]) ** 2;
        if (d < bd) { bd = d; best = pi; }
      }
      return best;
    };
    // k-means centroids: 2 refine rounds on a sampled subset (fast + stable)
    const STRIDE = nPx > 40000 ? 3 : 1;
    for (let round = 0; round < 2; round++) {
      const sums = palette.map(() => [0, 0, 0, 0]);
      for (let j = 0; j < nPx; j += STRIDE) {
        const o = j * 4;
        const best = nearest(px[o], px[o + 1], px[o + 2]);
        const su = sums[best];
        su[0] += px[o]; su[1] += px[o + 1]; su[2] += px[o + 2]; su[3]++;
      }
      palette = palette.map((old, pi) => {
        const su = sums[pi];
        return su[3] ? [su[0] / su[3], su[1] / su[3], su[2] / su[3]] : old;
      });
    }
    palette = palette.map((p2) => p2.map(Math.round));
    // final full-resolution assignment (every subpixel) for the majority vote
    for (let j = 0; j < nPx; j++) {
      const o = j * 4;
      assign[j] = nearest(px[o], px[o + 1], px[o + 2]);
    }

    // 3. per-cell MAJORITY VOTE of subpixel assignments — averaging RGB then
    // snapping created edge halos + gradient salt-and-pepper (the "grain")
    let cells = new Uint8Array(gw * gh);
    const votes = new Uint16Array(palette.length);
    for (let cy = 0; cy < gh; cy++) for (let cx2 = 0; cx2 < gw; cx2++) {
      votes.fill(0);
      for (let sy = 0; sy < OS; sy++) for (let sx = 0; sx < OS; sx++)
        votes[assign[(cy * OS + sy) * hw + cx2 * OS + sx]]++;
      let best = 0;
      for (let pi = 1; pi < votes.length; pi++) if (votes[pi] > votes[best]) best = pi;
      cells[cy * gw + cx2] = best + 1;
    }

    // 4. merge near-identical palette entries
    const remap = new Array(palette.length + 1).fill(0).map((_, i) => i);
    for (let i = 0; i < palette.length; i++) for (let j = i + 1; j < palette.length; j++) {
      if (remap[j + 1] !== j + 1) continue;
      const d = Math.hypot(palette[i][0] - palette[j][0], palette[i][1] - palette[j][1], palette[i][2] - palette[j][2]);
      if (d < 16) remap[j + 1] = remap[i + 1];
    }
    cells = cells.map((v) => remap[v]);

    // 5. one 3x3 mode-smoothing pass: kills residual speckle, preserves edges
    const smoothed = new Uint8Array(cells);
    const counts9 = {};
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      const i = y * gw + x;
      const me = cells[i];
      let meCount = 0;
      for (const key in counts9) delete counts9[key];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
        const v = cells[ny * gw + nx];
        counts9[v] = (counts9[v] || 0) + 1;
        if (v === me) meCount++;
      }
      if (meCount <= 2) {   // isolated: adopt the neighborhood's majority
        let top = me, tc = 0;
        for (const key in counts9) if (counts9[key] > tc) { tc = counts9[key]; top = +key; }
        smoothed[i] = top;
      }
    }
    cells = smoothed;

    // 6. despeckle: absorb regions under 4 cells into their dominant neighbor
    const seen = new Uint8Array(cells.length);
    for (let start2 = 0; start2 < cells.length; start2++) {
      if (seen[start2]) continue;
      const color = cells[start2];
      const region = [start2], queue = [start2];
      seen[start2] = 1;
      while (queue.length) {
        const i = queue.pop();
        const x = i % gw, y = (i / gw) | 0;
        for (const nb of [x > 0 ? i - 1 : -1, x < gw - 1 ? i + 1 : -1, y > 0 ? i - gw : -1, y < gh - 1 ? i + gw : -1]) {
          if (nb >= 0 && !seen[nb] && cells[nb] === color) { seen[nb] = 1; region.push(nb); queue.push(nb); }
        }
      }
      if (region.length < 4) {
        const border = {};
        for (const i of region) {
          const x = i % gw, y = (i / gw) | 0;
          for (const nb of [x > 0 ? i - 1 : -1, x < gw - 1 ? i + 1 : -1, y > 0 ? i - gw : -1, y < gh - 1 ? i + gw : -1]) {
            if (nb >= 0 && cells[nb] !== color) border[cells[nb]] = (border[cells[nb]] || 0) + 1;
          }
        }
        const top = Object.entries(border).sort((a, b) => b[1] - a[1])[0];
        if (top) for (const i of region) cells[i] = +top[0];
      }
    }

    // 7. renumber by count desc, drop unused
    const counts = {};
    for (const v of cells) counts[v] = (counts[v] || 0) + 1;
    const order = Object.keys(counts).map(Number).sort((a, b) => counts[b] - counts[a]);
    const newN = {};
    order.forEach((old, i) => { newN[old] = i + 1; });
    cells = cells.map((v) => newN[v]);
    const palOut = order.map((old, i) => ({
      n: i + 1,
      hex: '#' + palette[old - 1].map((v) => v.toString(16).padStart(2, '0')).join(''),
      count: counts[old],
    }));

    let bin = '';
    for (let i = 0; i < cells.length; i += 8192) bin += String.fromCharCode(...cells.slice(i, i + 8192));
    return { id: 'draft', name: 'My Photo', cat: 'myphotos', width: gw, height: gh, palette: palOut, cells: btoa(bin) };
  },

  create() {
    const lv = this.draft && this.draft.level;
    if (!lv) return;
    const n = userLevelCount() + 1;
    lv.id = 'user_' + Date.now().toString(36);
    lv.name = 'My Photo ' + n;
    const ul = loadJSON('sp_user_levels', []);
    ul.push(lv);
    try {
      localStorage.setItem('sp_user_levels', JSON.stringify(ul));
    } catch (e) {
      bufferError({ m: 'photo save: ' + e.message });
      toast('Not enough space to save \u2014 delete an old photo picture?');
      return;
    }
    LEVELS.push(lv);
    $('photoSheet').classList.remove('open');
    this.draft = null;
    Analytics.track('photo_create', { cells: lv.palette.reduce((a, b) => a + b.count, 0) });
    toast('Added to My Photos \uD83D\uDCF8');
    openLevel(lv);
  },
};

$('photoFile').addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (f) PhotoImport.fromFile(f);
});
document.querySelectorAll('#photoSizes .chip').forEach((c) =>
  c.addEventListener('click', () => {
    if (!PhotoImport.draft) return;
    PhotoImport.draft.size = c.dataset.ps;
    document.querySelectorAll('#photoSizes .chip').forEach((x) =>
      x.classList.toggle('on', x === c));
    PhotoImport.process();
    Sound.ac();
  }));
$('photoCreate').addEventListener('click', () => PhotoImport.create());

// ---------------------------------------------------------------- lobby life
// Attention wiggles: every few seconds ONE random on-screen unfinished card
// does a little jiggle — an invitation, never a chorus.
let lastWiggled = null;
function scheduleWiggle() {
  setTimeout(() => {
    scheduleWiggle();
    if (document.hidden || REDUCED_MOTION) return;
    if (!$('gallery').classList.contains('active')) return;
    const candidates = [...document.querySelectorAll('#shelves .scard:not(.done-card)')]
      .filter((c) => {
        const r = c.getBoundingClientRect();
        return r.bottom > 90 && r.top < innerHeight - 30;
      })
      .filter((c) => c !== lastWiggled);
    if (!candidates.length) return;
    const pick = candidates[(Math.random() * candidates.length) | 0];
    lastWiggled = pick;
    pick.classList.add('wiggle');
    setTimeout(() => pick.classList.remove('wiggle'), 1600);
    // characters with generated sprite frames really move (tongue/wink/wave)
    const lv = LEVELS.find((l) => l.id === pick.dataset.lid);
    if (lv && lv.anim && lv.anim.length) {
      playThumbAnim(pick, lv, pick.classList.contains('done-card'));
    }
  }, 2200 + Math.random() * 2200);   // organic, not metronomic
}
scheduleWiggle();

function playThumbAnim(card, lv, done) {
  const cv = card.querySelector('canvas');
  if (!cv) return;
  if (!lv._animCells) lv._animCells = lv.anim.map(decodeCells);
  const f1 = lv._animCells[0];
  if (!f1 || f1.length !== lv.width * lv.height) return;
  // two-beat loop: frame → base → frame → base (wag-wag / wink-wink)
  [f1, null, f1, null].forEach((frame, k) =>
    setTimeout(() => {
      try { drawThumb(cv, lv, done, frame || undefined); } catch { /* cosmetic */ }
    }, 160 + k * 470));
}

// ---------------------------------------------------------------- UI wiring
function toast(msg, ms = 2200) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), ms);
}
function updateCoinUI() {
  $('coinCount').textContent = profile.coins;
  $('galleryCoinCount').textContent = profile.coins;
}
// ---- inventory + reward feedback -----------------------------------------
// The shop used to print a hardcoded "×1" beside every item. It read as an
// inventory count but was static markup, so watching a video changed nothing
// visible anywhere in the lobby — the reward WAS granted, it just had no way
// of showing. updateToolButtons() only writes the in-level toolbar badges,
// which you cannot see from the shop.
const BOOSTER_META = {
  bucket: { icon: '🪣', label: 'Bucket' },
  hint:   { icon: '💡', label: 'Hint' },
  bomb:   { icon: '💣', label: 'Bomb' },
  brush:  { icon: '🖌️', label: 'Brush' },
  coins:  { icon: '🪙', label: 'Coins' },
};

function updateShopUI() {
  document.querySelectorAll('[data-own]').forEach((el) => {
    const n = profile.boosters[el.dataset.own] || 0;
    el.textContent = n ? `${n} in your kit` : 'none yet';
    el.classList.toggle('zero', n === 0);
  });
}

// One place that grants, updates every surface, persists, and confirms.
function grantReward(kind, amount = 1) {
  const meta = BOOSTER_META[kind] || { icon: '🎁', label: kind };
  let total;
  if (kind === 'coins') {
    profile.coins += amount;
    total = `${profile.coins} coins total`;
  } else {
    profile.boosters[kind] = (profile.boosters[kind] || 0) + amount;
    total = `${profile.boosters[kind]} in your kit`;
  }
  updateCoinUI(); updateToolButtons(); updateShopUI();
  saveNow();          // persist immediately — not saveSoon(); a reward must
                      // survive the player closing the app straight after
  $('rewardIcon').textContent = meta.icon;
  $('rewardTitle').textContent = `+${amount} ${meta.label}`;
  $('rewardSub').textContent = kind === 'coins'
    ? 'Added to your balance' : 'Added to your painting kit';
  $('rewardTotal').textContent = total;
  $('rewardSheet').classList.add('open');
}

if ($('rewardOk')) {
  $('rewardOk').addEventListener('click',
    () => $('rewardSheet').classList.remove('open'));
}

function openStore() { updateShopUI(); $('storeSheet').classList.add('open'); }

$('btnBack').addEventListener('click', () => { saveNow(); showScreen('gallery'); });
$('btnSettings').addEventListener('click', () => {
  syncSettingToggles();
  $('settingsSheet').classList.add('open');
});
$('coinPill').addEventListener('click', openStore);
$('btnBucket').addEventListener('click', () => armTool('bucket'));
$('btnHint').addEventListener('click', () => armTool('hint'));
$('btnBomb').addEventListener('click', () => armTool('bomb'));
$('btnBrush').addEventListener('click', () => armTool('brush'));
$('btnEraser').addEventListener('click', () => armTool('eraser'));
$('darkToggle').addEventListener('click', () => {
  profile.settings.dark = !profile.settings.dark;
  applyTheme();
  saveSoon();
});

// Backdrop tap goes through closeSheet() like every other close path. Doing
// classList.remove() directly left the sheet's history entry behind, so the
// next back press was silently eaten popping a dead entry.
document.querySelectorAll('.sheet-wrap').forEach((w) =>
  w.addEventListener('click', (e) => { if (e.target === w) closeSheet(w); }));

// ---- sheets must always be escapable ------------------------------------
// Backdrop-tap used to be the ONLY way out of a sheet. That fails whenever
// the sheet is tall enough to cover the backdrop (Settings, 855px on a
// 412x915 Pixel 7) and it is an invisible affordance even when it works.
// Two additions: a real close button on every sheet, and Android's back
// gesture closing the top sheet rather than leaving the app.
document.querySelectorAll('.sheet-wrap').forEach((w) => {
  const panel = w.querySelector('.sheet');
  if (!panel || panel.querySelector('.sheet-close')) return;
  const btn = el('button', 'sheet-close', '✕');
  btn.setAttribute('aria-label', 'Close');
  btn.addEventListener('click', () => closeSheet(w));
  panel.insertBefore(btn, panel.firstChild);
});

// One history entry per open sheet, so the hardware/gesture back button
// pops the sheet. The app declares enableOnBackInvokedCallback="false", so
// back arrives here as a normal popstate.
let _sheetPopSuppress = 0;
// Open ORDER, which is not DOM order. Querying `.sheet-wrap.open` and taking
// the last match returns the last in the document — so with the reward card
// (declared early) stacked over the shop (declared later), back closed the
// shop and left the card floating. Track the order things actually opened.
const _sheetStack = [];
function topOpenSheet() {
  for (let i = _sheetStack.length - 1; i >= 0; i--) {
    const w = document.getElementById(_sheetStack[i]);
    if (w && w.classList.contains('open')) return w;
  }
  return null;
}
// Closing is just removing the class. History is reconciled centrally by the
// observer below, because there are a dozen places that close a sheet
// directly and any new one would otherwise silently desync history again.
function closeSheet(w) { w.classList.remove('open'); }
(function trackSheetHistory() {
  const obs = new MutationObserver((muts) => {
    for (const m of muts) {
      const w = m.target;
      const open = w.classList.contains('open');
      if (open === (w.dataset.wasOpen === '1')) continue;   // class churn
      w.dataset.wasOpen = open ? '1' : '0';
      if (open) {
        _sheetStack.push(w.id);
        history.pushState({ sheet: w.id }, '');
      } else {
        const i = _sheetStack.lastIndexOf(w.id);
        if (i >= 0) _sheetStack.splice(i, 1);
        // Consume this sheet's history entry however it was closed — ✕,
        // backdrop, "Got it", or any of the direct classList.remove call
        // sites. Skipped when the close came FROM a back press, where the
        // browser has already popped the entry for us.
        const fromPop = w.dataset.fromPop === '1';
        delete w.dataset.fromPop;
        if (!fromPop && history.state && history.state.sheet === w.id) {
          _sheetPopSuppress++;
          history.back();
        }
      }
    }
  });
  document.querySelectorAll('.sheet-wrap').forEach((w) => {
    w.dataset.wasOpen = w.classList.contains('open') ? '1' : '0';
    obs.observe(w, { attributes: true, attributeFilter: ['class'] });
  });
  // Back order: top sheet first, then out of any screen to the lobby, and
  // only then let Android close the app.
  addEventListener('popstate', () => {
    if (_sheetPopSuppress > 0) { _sheetPopSuppress--; return; }
    const w = topOpenSheet();
    if (w) {
      // Marked on the ELEMENT, not a plain flag: MutationObserver callbacks
      // are microtasks, so a flag set and cleared around this line would
      // already read false by the time the observer runs.
      w.dataset.fromPop = '1';
      w.classList.remove('open');
      return;
    }
    const active = document.querySelector('.screen.active');
    if (active && active.id !== 'gallery') {
      if (active.id === 'game') saveNow();      // never lose a painting to a back press
      _navFromPop = true;
      showScreen('gallery');
      _navFromPop = false;
    }
  });
})();

document.querySelectorAll('[data-buy]').forEach((b) =>
  b.addEventListener('click', () => {
    const what = b.dataset.buy;
    Analytics.track('shop_buy', { what });
    const cost = +b.dataset.cost;
    if (profile.coins < cost) { toast("A few more coins and it's yours"); return; }
    profile.coins -= cost;
    grantReward(what);          // handles inventory, every UI, save, confirm
  }));

// Watch-a-video buttons in the shop. "Free coins" used to sit on the
// data-buy path with a `what === 'ad'` branch that granted 15 coins WITHOUT
// showing an ad, and toasted "(ad placeholder)" in production — giving away
// the reward and earning nothing. It now goes through the same rewarded flow
// as everything else.
document.querySelectorAll('[data-adget]').forEach((b) =>
  b.addEventListener('click', () => {
    const kind = b.dataset.adget;
    Ads.showRewarded(kind, () => grantReward(kind, kind === 'coins' ? 15 : 1));
  }));

function syncSettingToggles() {
  $('setSound').classList.toggle('on', profile.settings.sound);
  $('setHaptics').classList.toggle('on', profile.settings.haptics);
  $('setSparkle').classList.toggle('on', profile.settings.sparkle);
  $('setBigNums').classList.toggle('on', profile.settings.bigNumbers);
  document.querySelectorAll('.chip[data-fs]').forEach((c) =>
    c.classList.toggle('on', c.dataset.fs === profile.settings.fillSound));
  document.querySelectorAll('.chip[data-rs]').forEach((c) =>
    c.classList.toggle('on', c.dataset.rs === profile.settings.revealStyle));
  const rem = $('setReminders');
  if (rem) rem.classList.toggle('on', profile.settings.reminders);
  document.querySelectorAll('.chip[data-rt]').forEach((c) =>
    c.classList.toggle('on', c.dataset.rt === profile.settings.reminderTime));
  // the time choice only means something once reminders are on
  const timeRow = $('rowReminderTime');
  if (timeRow) timeRow.style.display = profile.settings.reminders ? '' : 'none';
}
if ($('setReminders')) {
  $('setReminders').addEventListener('click', async () => {
    if (profile.settings.reminders) await Notify.disable();
    else await Notify.enable();
    syncSettingToggles();
  });
}
document.querySelectorAll('.chip[data-rt]').forEach((c) =>
  c.addEventListener('click', () => {
    profile.settings.reminderTime = c.dataset.rt;
    saveNow();
    syncSettingToggles();
    Notify.reschedule();
  }));

// One-time soft ask, on the third launch — by then someone has chosen to
// come back, which is when the offer is welcome rather than noise.
function maybeAskReminders() {
  if (profile.askedReminders || profile.settings.reminders) return;
  if (profile.opens < 3 || !Notify.available()) return;
  profile.askedReminders = true;
  saveNow();
  setTimeout(() => $('remindAsk').classList.add('open'), 900);
}
$('remindYes').addEventListener('click', async () => {
  $('remindAsk').classList.remove('open');
  await Notify.enable();
  syncSettingToggles();
});
$('remindNo').addEventListener('click', () => {
  $('remindAsk').classList.remove('open');
  Analytics.track('reminders_declined', {});
});
document.querySelectorAll('.chip[data-rs]').forEach((c) =>
  c.addEventListener('click', () => {
    profile.settings.revealStyle = c.dataset.rs;
    syncSettingToggles(); saveSoon();
    if (G.level) {
      if (G.level.art) loadLevelArt(G.level);   // may still be in flight
      applyRevealStyle();                        // falls back until it lands
    }
  }));
document.querySelectorAll('.chip[data-fs]').forEach((c) =>
  c.addEventListener('click', () => {
    profile.settings.fillSound = c.dataset.fs;
    syncSettingToggles(); saveSoon();
    if (c.dataset.fs === 'music' && $('game').classList.contains('active')) Music.start();
    else if (c.dataset.fs !== 'music') Music.stop();
    Sound.combo = 0; Sound.lastTick = 0;   // clean single-note preview
    Sound.tick(G.selected || 1);
  }));
for (const [id, key] of [['setSound', 'sound'], ['setHaptics', 'haptics'],
                         ['setSparkle', 'sparkle'], ['setBigNums', 'bigNumbers']]) {
  $(id).addEventListener('click', () => {
    profile.settings[key] = !profile.settings[key];
    syncSettingToggles(); saveSoon();
    needRender = true;   // bigNumbers changes the canvas number font
  });
}
$('setReset').addEventListener('click', () => {
  if (!G.level || !confirm('Reset this picture? All progress on it will be lost.')) return;
  localStorage.removeItem('sp_prog_' + G.level.id);
  $('settingsSheet').classList.remove('open');
  openLevel(G.level);
});

$('btnHome').addEventListener('click', () => {
  $('winOverlay').classList.remove('open');
  G.confetti.length = 0;
  if (_pendingSetAward) { showSetAward(_pendingSetAward); _pendingSetAward = null; }
  else Review.maybeAsk();
  showScreen('gallery');
});
$('btnNext').addEventListener('click', () => {
  $('winOverlay').classList.remove('open');
  G.confetti.length = 0;
  if (_pendingSetAward) { showSetAward(_pendingSetAward); _pendingSetAward = null; }
  else Review.maybeAsk();
  const next = LEVELS.find((l) => !levelProgressSummary(l).done);
  if (next) openLevel(next);
  else { toast('Every painting finished — beautifully done. New collections soon.'); showScreen('gallery'); }
});
$('btnShare').addEventListener('click', async () => {
  const { width: W, height: H } = G.level;
  const out = makeCanvas(W * CP, H * CP + 80);
  const o = out.getContext('2d');
  o.fillStyle = '#fff'; o.fillRect(0, 0, out.width, out.height);
  o.drawImage(G.artCanvas, 0, 0);
  o.fillStyle = '#6b8f71';
  o.font = `700 ${CP * 1.6}px Georgia, serif`;
  o.textAlign = 'center';
  o.fillText('Serene Canvas', out.width / 2, out.height - CP);
  out.toBlob(async (blob) => {
    const file = new File([blob], 'serene-canvas.png', { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'Serene Canvas' }); } catch {}
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'serene-canvas.png';
      a.click();
    }
  });
});

// ---------------------------------------------------------------- boot
if (typeof LEVELS === 'undefined' || !LEVELS.length) {
  document.body.replaceChildren(
    el('div', '', 'Could not load the picture catalog — please reload.'));
  throw new Error('levels.js missing or empty');
}
applyTheme();

// ---- collection sets: finish every painting on a shelf --------------------
// The 50+ audience skews completionist; a set award turns "I painted one"
// into "I am working through the Birds". Earned sets persist so the trophy
// shows exactly once, and My Gallery wears the badges permanently.
let _pendingSetAward = null;
function checkSetComplete(level) {
  const cat = level.cat;
  if (!cat || cat === 'myphotos') return null;
  if ((profile.setsEarned || {})[cat]) return null;
  const shelf = LEVELS.filter((l) => l.cat === cat);
  // the level being completed right now counts — its record just saved
  if (!shelf.length || !shelf.every((l) =>
    l.id === level.id || levelProgressSummary(l).done)) return null;
  profile.setsEarned = profile.setsEarned || {};
  profile.setsEarned[cat] = Date.now();
  Analytics.track('set_complete', { cat, size: shelf.length });
  saveNow();
  return cat;
}
function showSetAward(cat) {
  const meta = CATS[cat];
  if (!meta) return;
  $('rewardIcon').textContent = '\uD83C\uDFC6';
  $('rewardTitle').textContent = `${meta.label} Collection`;
  $('rewardSub').textContent = 'Every painting on this shelf, finished';
  $('rewardTotal').textContent = `\u2728 Set complete \u2014 ${meta.icon} badge earned`;
  $('rewardSheet').classList.add('open');
}

// ---- store review ask -----------------------------------------------------
// Native Play in-app review, asked at the moment of highest goodwill: the
// player has just finished a painting and closed the win panel. Play's API
// decides whether a dialog actually appears and self-throttles, so the
// ladder here only bounds how often we ASK. Never on the web build.
const Review = {
  LADDER: [2, 7, 20],                      // completions that trigger an ask
  _plugin: null,
  init() {
    if (!IS_NATIVE) return;
    try {
      const reg = CAP && CAP.Plugins;
      this._plugin = (reg && (reg.InAppReview || reg.RateApp)) || null;
    } catch { this._plugin = null; }
  },
  maybeAsk() {
    if (!this._plugin) return;
    const asked = profile.reviewAsks || 0;
    const due = this.LADDER[asked];
    if (due === undefined || profile.imagesCompleted < due) return;
    profile.reviewAsks = asked + 1;
    saveNow();
    Analytics.track('review_asked', { at: profile.imagesCompleted });
    try { this._plugin.requestReview(); } catch { /* silently skip */ }
  },
};

// ---- remote catalog: the daily-drop engine --------------------------------
// The APK ships a bundled levels.js; this fetches catalog.json from the
// Pages deploy and merges levels the bundle has never heard of. Rules that
// keep it safe:
//   * ADD only, never replace — replacing a level changes its cells and
//     silently invalidates saved progress (sp_prog_<id> has no version).
//   * unknown categories are skipped (no shelf to render them on) — the
//     holiday cats above exist precisely so their drops are known.
//   * cached catalog applies SYNCHRONOUSLY at boot, before the first
//     buildGallery, so a session never changes shape midway; a live fetch
//     may merge later but only ever adds, and the daily is pinned.
//   * remote art needs crossOrigin: shareArtwork exports the canvas, and
//     a tainted canvas would break sharing for every remote painting.
const RemoteCatalog = {
  URL: 'https://classic888ai.github.io/serene-canvas/catalog.json',
  applied: new Set(),
  merge(cat, live) {
    if (!cat || !Array.isArray(cat.levels)) return 0;
    const have = new Set(LEVELS.map((l) => l.id));
    let added = 0;
    for (const lv of cat.levels) {
      try {
        if (!lv || !lv.id || have.has(lv.id) || this.applied.has(lv.id)) continue;
        if (!CATS[lv.cat]) continue;                     // no shelf for it
        if (!(lv.width > 0) || !(lv.height > 0)) continue;
        if (typeof lv.cells !== 'string' ||
            decodeCells(lv.cells).length !== lv.width * lv.height) continue;
        if (lv.art && cat.artBase) { lv.art = cat.artBase + lv.id + '.jpg'; lv.remote = 1; }
        LEVELS.push(lv);
        this.applied.add(lv.id);
        added++;
      } catch { /* one bad record must not sink the drop */ }
    }
    if (added) {
      freeSet = null;                                    // re-deal the free slots
      if (live) {
        const active = document.querySelector('.screen.active');
        if (active && active.id === 'gallery') buildGallery();
        toast(`\uD83C\uDFA8 ${added} new painting${added === 1 ? '' : 's'} arrived`);
      }
      Analytics.track('catalog_merged', { n: added, live: !!live });
    }
    return added;
  },
  boot() {
    try {                                     // cached copy, synchronous
      const c = localStorage.getItem('sp_catalog');
      if (c) this.merge(JSON.parse(c), false);
    } catch { /* corrupt cache = ignore */ }
    this.refresh();
  },
  async refresh() {
    if (!navigator.onLine) return;
    try {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 6000);
      const r = await fetch(this.URL, { signal: ctrl.signal, cache: 'no-store' });
      if (!r.ok) return;
      const text = await r.text();
      const cat = JSON.parse(text);
      try {
        const prev = localStorage.getItem('sp_catalog_v');
        if (text.length < 3000000) {          // stay far from the quota
          localStorage.setItem('sp_catalog', text);
          localStorage.setItem('sp_catalog_v', String(cat.version || ''));
        }
        if (prev === String(cat.version || '')) return;   // nothing new
      } catch { /* quota — still merge this session */ }
      this.merge(cat, true);
    } catch { Analytics.track('catalog_fetch_fail', {}); }
  },
};

loadUserLevels();
RemoteCatalog.boot();
resizeBoard();
buildGallery();
// warm the painting-reveal art in idle time: promo thumbs upgrade once and
// level opens skip the flat placeholder flash
setTimeout(() => {
  if (profile.settings.revealStyle === 'painting') {
    for (const l of LEVELS) if (l.art) loadLevelArt(l);
  }
}, 900);
updateCoinUI();
Ads.init();   // AdMob on native builds, placeholder bar on plain web
Review.init();
syncOwnedUI();
applyIapVisibility();
applyReminderVisibility();
// launching pushes the reminder series back to tomorrow, so a reminder
// only ever reaches someone who has been away
profile.opens = (profile.opens || 0) + 1;
saveNow();
Notify.reschedule();
maybeAskReminders();
requestAnimationFrame(render);
if ('serviceWorker' in navigator) {
  addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
    let hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController) $('updateBar').classList.add('show');
      hadController = true;
    });
  });
}
$('updateBar').addEventListener('click', () => location.reload());

// zoom buttons: step-zoom around the board's visual center
function zoomBy(factor) {
  const cx = vw / 2, cy = vh * 0.45;
  const z = clamp(G.zoom * factor, G.minZoom, G.maxZoom);
  const wx = (cx - G.panX) / G.zoom, wy = (cy - G.panY) / G.zoom;
  G.zoom = z;
  G.panX = cx - wx * z;
  G.panY = cy - wy * z;
  clampCamera();
  needRender = true;
}
$('btnZoomIn').addEventListener('click', () => { Sound.ac(); zoomBy(1.45); });
$('btnZoomOut').addEventListener('click', () => { Sound.ac(); zoomBy(1 / 1.45); });

// ---- backup & restore (Settings) — progress is precious, protect it
$('setAbout').addEventListener('click', () => {
  $('aboutVersion').textContent = 'Version ' + APP_VERSION;
  $('settingsSheet').classList.remove('open');
  $('aboutSheet').classList.add('open');
});
$('setBackup').addEventListener('click', () => {
  try {
    const data = { v: 1, at: Date.now(), profile: localStorage.getItem('sp_profile') || '{}', prog: {} };
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('sp_prog_')) data.prog[k] = localStorage.getItem(k);
    }
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const file = new File([blob], 'serene-canvas-backup.json', { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], title: 'Serene Canvas backup' }).catch(() => {});
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'serene-canvas-backup.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }
    Analytics.track('backup', {});
    toast('Backup saved \u2014 keep it somewhere cozy \uD83D\uDCBE');
  } catch (e) {
    bufferError({ m: 'backup: ' + e.message });
    toast('Backup hit a snag \u2014 try once more?');
  }
});
$('unlockWatch').addEventListener('click', () => {
  const level = pendingUnlock;
  if (!level) return;
  $('unlockSheet').classList.remove('open');
  // they have now seen and accepted the trade — don't explain it again
  profile.seenUnlockExplainer = true;
  saveNow();
  startUnlock(level);
});
// guarded: applyIapVisibility() has already stripped these from the DOM
// when IAP_ENABLED is false, and it runs earlier in the boot block
if ($('unlockBuyAll')) {
  $('unlockBuyAll').addEventListener('click', () => {
    $('unlockSheet').classList.remove('open');
    IAP.buy();
  });
}
if ($('setBuyAll')) $('setBuyAll').addEventListener('click', () => IAP.buy());
if ($('shopBuyAll')) $('shopBuyAll').addEventListener('click', () => IAP.buy());
$('unlockLater').addEventListener('click', () => {
  pendingUnlock = null;
  $('unlockSheet').classList.remove('open');
});

// ---- feedback. No backend: a pre-addressed mail draft the player can
// edit or delete freely. The app has been buffering runtime errors to
// sp_errors all along with nothing reading them — attaching the last few
// turns "it stopped working" into something diagnosable, while staying
// visible and removable so nothing is sent behind the player's back.
const SUPPORT_EMAIL = 'support@printabledrops.com';   // keep in sync with privacy.html
function feedbackDraft() {
  const done = LEVELS.filter((l) => levelProgressSummary(l).done).length;
  const errs = loadJSON('sp_errors', []).slice(-3)
    .map((e) => String(e.m || '').slice(0, 120));
  return [
    'What happened, or what would you like to see?',
    '',
    '',
    '— — — — —',
    'These lines help us find the problem. Delete them if you prefer.',
    `App ${APP_VERSION} · ${IS_NATIVE ? 'Android' : 'web'}`,
    `Screen ${innerWidth}×${innerHeight}`,
    `Paintings finished: ${done} of ${LEVELS.length}`,
    errs.length ? `Recent errors: ${errs.join(' | ')}` : 'No recent errors',
  ].join('\n');
}
$('setFeedback').addEventListener('click', () => {
  Analytics.track('feedback_open', {});
  const url = 'mailto:' + SUPPORT_EMAIL +
    '?subject=' + encodeURIComponent('Serene Canvas feedback') +
    '&body=' + encodeURIComponent(feedbackDraft());
  try {
    location.href = url;
  } catch {
    toast('Email us at ' + SUPPORT_EMAIL);
  }
});

$('setRestore').addEventListener('click', () => $('restoreFile').click());
$('restoreFile').addEventListener('change', async (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (!data || data.v !== 1 || typeof data.profile !== 'string') throw new Error('bad format');
    if (!confirm('Restore this backup? It replaces the progress on this device.')) return;
    JSON.parse(data.profile);                             // must be valid JSON
    localStorage.setItem('sp_profile', data.profile);
    for (const [k, v] of Object.entries(data.prog || {})) {
      if (k.startsWith('sp_prog_') && typeof v === 'string' && k.length < 64) {
        JSON.parse(v);                                    // validate each record
        localStorage.setItem(k, v);
      }
    }
    restoring = true;                                     // pagehide must not re-save old state
    location.reload();
  } catch (err) {
    bufferError({ m: 'restore: ' + err.message });
    toast("That file doesn't look like a Serene Canvas backup \uD83E\uDD14");
  }
});
