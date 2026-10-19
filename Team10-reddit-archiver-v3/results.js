/* Team 10 Reddit Archiver - results page.
 * 1) fetches the post + every comment from Reddit  2) downloads media for embedding
 * 3) (optional) captures the original Reddit page as one long ad-free PDF
 * 4) review: flag comments, pick images, highlight post/comment text to add information entries with quotes, fill in the Assessment
 * 5) export DOCX / TXT / PDF (original page or full thread) or copy DOCX content; add to the working document */
const $ = id => document.getElementById(id);
let job = null, data = null, builtAt = null, entries = [], pdfBlob = null;
const hlTargets = new Map();   // highlight key -> element on the review page
const commentUi = new Map();   // comment id -> { cb }
const commentById = new Map();
let entrySeq = 0;

/* ------------------------------------------------------------------ utilities */
const p2 = n => String(n).padStart(2, '0');
const logEl = $('log');
function log(t) { logEl.textContent += t + '\n'; logEl.scrollTop = logEl.scrollHeight; }
function setStatus(t) { $('status').textContent = t; }
function setBar(p) { $('bar').style.width = Math.max(0, Math.min(100, p)) + '%'; }
const sleep = ms => new Promise(r => setTimeout(r, ms));
function nowParts(d) { d = d || new Date(); return { d: `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`, t: `${p2(d.getHours())}:${p2(d.getMinutes())}` }; }
function tparts(t) {
  if (!t || !t.epoch) return null;
  const x = nowParts(new Date(t.epoch * 1000));
  return { d: x.d, t: x.t, approx: !!t.approx };
}
const stampAt = t => { const x = tparts(t); return x ? `${x.d} at ${x.t}${x.approx ? ' (approx.)' : ''}` : 'Unknown'; };
const stampComma = t => { const x = tparts(t); return x ? `${x.d}, ${x.t}${x.approx ? ' (approx.)' : ''}` : 'Unknown'; };
const dateOnly = t => { const x = tparts(t); return x ? x.d : 'Unknown date'; };
// Reddit's equivalent of a Facebook "group" is the subreddit.
const nameLine = e => (e.group ? `${e.name} (in subreddit: ${e.group.name})` : e.name) || 'Unknown';
const urlLine = e => [e.url, e.group ? `(subreddit: ${e.group.url})` : ''].filter(Boolean).join(' ');
// Removes emoji (and the invisible joiners/variation selectors that go with them), keeping (c) (R) (TM).
const EMOJI_RE = /(?![©®™])\p{Extended_Pictographic}|\p{Emoji_Presentation}|[\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}‍️⃣]/gu;
const stripEmoji = s => String(s == null ? '' : s).replace(EMOJI_RE, '')
  .replace(/(\S) {2,}(?=\S)/g, '$1 ').replace(/[ \t]+(\r?\n)/g, '$1').replace(/[ \t]+$/, '');
const lines = s => String(s || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
const safeName = s => String(s).replace(/[\\/:*?"<>|\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
const escHtml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const unesc = s => String(s || '').replace(/&amp;/g, '&');
const Q = s => '“' + s + '”';

function el(doc, tag, props, ...kids) {
  const e = doc.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (k === 'class') { if (v) e.className = v; }
    else if (k === 'text') e.textContent = v;
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  kids.flat().forEach(k => { if (k == null || k === false) return; e.append(k.nodeType ? k : doc.createTextNode(k)); });
  return e;
}
const linkIn = (doc, url, text) => url ? el(doc, 'a', { href: url, target: '_blank', rel: 'noopener', text: text || url }) : doc.createTextNode('');
const link = (url, text) => linkIn(document, url, text);

async function focusMe() {
  try {
    const t = await chrome.tabs.getCurrent();
    if (t) { await chrome.tabs.update(t.id, { active: true }); await chrome.windows.update(t.windowId, { focused: true }); }
  } catch (e) { /* ignore */ }
}

/* -------------------------------------------------------------------- capture */
async function fetchJSON(url, tries = 7) {
  for (let i = 0; i < tries; i++) {
    let res;
    try {
      res = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
    } catch (e) {
      log(`Network error (${e.message}); retry ${i + 1}/${tries}`);
      await sleep(2000 * (i + 1));
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      const ra = parseFloat(res.headers.get('retry-after')) || 0;
      const reset = parseFloat(res.headers.get('x-ratelimit-reset')) || 0;
      const wait = Math.max(ra, reset, Math.pow(2, i) * 2);
      log(`HTTP ${res.status}: backing off ${wait}s`);
      await sleep(wait * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const remaining = parseFloat(res.headers.get('x-ratelimit-remaining'));
    const reset = parseFloat(res.headers.get('x-ratelimit-reset'));
    if (!isNaN(remaining) && remaining < 3) {
      log(`Rate limit nearly exhausted, pausing ${reset || 10}s`);
      await sleep((reset || 10) * 1000);
    } else await sleep(600);
    return res.json();
  }
  throw new Error('Too many failed attempts: ' + url);
}

function parseRef(u) {
  try {
    const url = new URL(u);
    const m = url.pathname.match(/\/comments\/([a-z0-9]+)/i);
    if (m) return { id: m[1] };
    if (url.hostname === 'redd.it') {
      const m2 = url.pathname.match(/^\/([a-z0-9]+)\/?$/i);
      if (m2) return { id: m2[1] };
    }
  } catch (e) { /* ignore */ }
  return null;
}

async function resolveRef(u) {
  const direct = parseRef(u);
  if (direct) return direct;
  log('Resolving share/short link...');
  const res = await fetch(u, { redirect: 'follow', credentials: 'include' });
  const r = parseRef(res.url);
  if (r) return r;
  throw new Error('Could not find a Reddit post ID in: ' + u);
}

// Fetches the post, then expands every "load more comments" / "continue this thread" stub.
async function capture(inputUrl, sort) {
  const ref = await resolveRef(inputUrl);
  const q = `raw_json=1&limit=500&sort=${encodeURIComponent(sort)}`;
  const comments = new Map(), moreQ = [], contQ = [], orderHint = new Map(), queued = new Set();
  let post = null;

  const ingest = children => {
    children.forEach((c, i) => {
      if (c.kind === 't1') {
        const d = c.data;
        const { replies, ...rest } = d;
        if (!comments.has(d.name)) {
          rest._order = orderHint.has(d.id) ? orderHint.get(d.id) : i;
          comments.set(d.name, rest);
        }
        if (replies && replies.data && replies.data.children) ingest(replies.data.children);
      } else if (c.kind === 'more') {
        const d = c.data;
        if (d.children && d.children.length) {
          d.children.forEach((id, j) => {
            if (!queued.has(id) && !comments.has('t1_' + id)) { queued.add(id); orderHint.set(id, 1000 + j); moreQ.push(id); }
          });
        } else if (d.parent_id && d.parent_id.startsWith('t1_')) contQ.push(d.parent_id);
      }
    });
    if (post) setBar(Math.min(80, (comments.size / Math.max(1, post.num_comments)) * 80));
  };

  setStatus('Fetching post...');
  const first = await fetchJSON(`https://www.reddit.com/comments/${ref.id}.json?${q}`);
  const pc = first[0].data.children[0];
  if (!pc) throw new Error('Post not found (deleted, private or quarantined?)');
  post = pc.data;
  log(`Title: ${post.title}`);
  log(`Reddit reports ${post.num_comments} comments.`);
  ingest(first[1].data.children);

  setStatus('Expanding comments...');
  while (moreQ.length || contQ.length) {
    if (moreQ.length) {
      const batch = moreQ.splice(0, 100).filter(id => !comments.has('t1_' + id));
      if (!batch.length) continue;
      log(`Expanding ${batch.length} comments (${moreQ.length} queued, ${comments.size} collected)`);
      const r = await fetchJSON(`https://www.reddit.com/api/morechildren.json?api_type=json&raw_json=1&link_id=${post.name}` +
        `&sort=${encodeURIComponent(sort)}&children=${batch.join(',')}`);
      ingest((r.json && r.json.data && r.json.data.things) || []);
    } else {
      const pn = contQ.shift();
      log(`Following "continue this thread" at ${pn.slice(3)} (${contQ.length} more pending)`);
      try {
        const r = await fetchJSON(`https://www.reddit.com/comments/${ref.id}/_/${pn.slice(3)}.json?${q}&context=0`);
        ingest(r[1].data.children);
      } catch (e) { log('Failed continue-thread ' + pn + ': ' + e.message); }
    }
    setStatus(`Collected ${comments.size} of ~${post.num_comments} comments...`);
  }
  log(`Collected ${comments.size} comments (Reddit reported ${post.num_comments}).`);
  if (comments.size < post.num_comments) log('A shortfall is normal: removed, spam-filtered and hidden comments are counted by Reddit but not returned.');

  // Rebuild the thread tree in reading order.
  const kids = new Map(), roots = [];
  for (const c of comments.values()) {
    if (c.parent_id === post.name) roots.push(c);
    else if (comments.has(c.parent_id)) { if (!kids.has(c.parent_id)) kids.set(c.parent_id, []); kids.get(c.parent_id).push(c); }
    else { c._orphan = true; roots.push(c); }
  }
  const ordered = [];
  (function walk(list, depth) {
    list.sort((a, b) => a._order - b._order).forEach(c => {
      const k = kids.get(c.name) || [], start = ordered.length;
      c._depth = depth; ordered.push(c);
      walk(k, depth + 1);
      c._descendants = ordered.length - start - 1;
    });
  })(roots, 0);
  return { post, ordered };
}

/* ---------------------------------------------------------------- data model */
function metaMedia(mm, order) {
  const out = [];
  (order || Object.keys(mm || {})).forEach(id => {
    const m = mm && mm[id];
    if (!m || !m.s || (m.status && m.status !== 'valid')) return;
    const src = unesc(m.s.u || m.s.gif || '');
    if (src) out.push({ type: m.e === 'AnimatedImage' ? 'gif' : 'image', src, target: '' });
  });
  return out;
}

function postMedia(p) {
  const s = (p.crosspost_parent_list && p.crosspost_parent_list[0]) || p;
  const media = [], links = [], videos = [];
  if (s !== p) links.push('https://www.reddit.com' + s.permalink); // original post of a crosspost
  const direct = unesc(s.url_overridden_by_dest || s.url || '');
  const rv = (s.secure_media && s.secure_media.reddit_video) || (s.media && s.media.reddit_video);
  if (s.is_gallery && s.gallery_data && s.media_metadata) media.push(...metaMedia(s.media_metadata, s.gallery_data.items.map(i => i.media_id)));
  else if (s.media_metadata) media.push(...metaMedia(s.media_metadata));
  if (!media.length) {
    const prev = s.preview && s.preview.images && s.preview.images[0] && unesc(s.preview.images[0].source.url);
    if (s.post_hint === 'image' || /\.(jpe?g|png|gif|webp)(\?|$)/i.test(direct)) media.push({ type: 'image', src: direct, target: '' });
    else if (rv) { if (prev) media.push({ type: 'video thumbnail', src: prev, target: rv.fallback_url }); }
    else if (prev) media.push({ type: 'link preview', src: prev, target: direct });
  }
  if (rv && rv.fallback_url) { videos.push(rv.fallback_url); links.push(rv.fallback_url); }
  if (!s.is_self && !s.is_gallery && !rv && direct && !media.some(m => m.src === direct)) links.push(direct);
  return { media, links: [...new Set(links)], videos };
}

function buildData(post, ordered) {
  const sub = { name: post.subreddit_name_prefixed || 'r/' + post.subreddit, url: 'https://www.reddit.com/r/' + post.subreddit };
  const person = n => (!n || n === '[deleted]')
    ? { name: 'u/[deleted]', user: '[deleted]', url: '' }
    : { name: 'u/' + n, user: n, url: 'https://www.reddit.com/user/' + n };
  const pm = postMedia(post);
  const src = (post.crosspost_parent_list && post.crosspost_parent_list[0]) || post;
  const d = {
    id: post.id,
    url: 'https://www.reddit.com' + post.permalink,
    title: post.title || '(no title)',
    author: { ...person(post.author), group: sub },
    group: sub,
    posted: { epoch: post.created_utc },
    body: post.selftext || src.selftext || '',
    media: pm.media, links: pm.links, videos: pm.videos,
    commentCountReported: post.num_comments,
    comments: ordered.map(c => ({
      id: c.id, depth: c._depth, isReply: c._depth > 0,
      author: person(c.author), group: sub,
      posted: { epoch: c.created_utc },
      body: c.body || '', media: metaMedia(c.media_metadata),
      url: 'https://www.reddit.com' + c.permalink,
      repliesCaptured: c._descendants || 0, orphan: !!c._orphan,
      checked: false, reason: ''
    }))
  };
  // Every image starts selected for export; untick it on the review page to leave it out.
  [...d.media, ...d.comments.flatMap(c => c.media)].forEach(m => { m.include = true; });
  d.comments.forEach(c => commentById.set(c.id, c));
  return d;
}

/* ---------------------------------------------------------------------- media */
async function toJpeg(blob) {
  const bmp = await createImageBitmap(blob);
  const sc = Math.min(1, 1400 / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * sc)), h = Math.max(1, Math.round(bmp.height * sc));
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); ctx.drawImage(bmp, 0, 0, w, h);
  const out = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.85));
  const bytes = new Uint8Array(await out.arrayBuffer());
  const dataUrl = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(out); });
  return { bytes, w, h, dataUrl };
}

async function loadOne(src) {
  try {
    const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 20000);
    const res = await fetch(src, { signal: ctl.signal }); clearTimeout(to);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await toJpeg(await res.blob());
  } catch (e) { log('Could not embed media: ' + (e.message || e) + ' (' + src.slice(0, 80) + '...)'); return {}; }
}

async function fetchMedia(d) {
  const all = [...d.media, ...d.comments.flatMap(c => c.media)];
  if (!all.length) return;
  const cache = new Map();
  let next = 0, done = 0;
  const worker = async () => {
    while (next < all.length) {
      const m = all[next++];
      if (!cache.has(m.src)) cache.set(m.src, loadOne(m.src));
      Object.assign(m, await cache.get(m.src));
      done++;
      setStatus(`Downloading media ${done} of ${all.length}...`);
      setBar(80 + (done / all.length) * 10);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
}

/* ------------------------------------------ one long, ad-free PDF of the original Reddit page */
const dbgAttach = t => new Promise((res, rej) => chrome.debugger.attach(t, '1.3', () => chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res()));
const dbgSend = (t, m, p) => new Promise((res, rej) => chrome.debugger.sendCommand(t, m, p || {}, r => chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res(r)));
const dbgDetach = t => new Promise(res => chrome.debugger.detach(t, () => { void chrome.runtime.lastError; res(); }));

// The tab the post was captured from, if it is still showing this post; otherwise the post is opened in a temporary tab.
async function originalTab() {
  if (job.tabId) {
    try {
      const t = await chrome.tabs.get(job.tabId), r = parseRef(t.url || '');
      if (r && r.id === data.id) return { tab: t, temp: false };
    } catch (e) { /* closed */ }
  }
  log('PDF: the post is not open in a tab any more - opening it in a temporary tab...');
  const t = await chrome.tabs.create({ url: data.url, active: false });
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const x = await chrome.tabs.get(t.id).catch(() => null);
    if (!x) throw new Error('The temporary Reddit tab was closed.');
    if (x.status === 'complete') break;
  }
  await sleep(2500); // let Reddit draw the post and comments
  return { tab: await chrome.tabs.get(t.id), temp: true };
}

async function makePdf() {
  setStatus('Capturing the original Reddit page as a PDF (the Reddit tab will briefly come to the front)...');
  const { tab, temp } = await originalTab();
  const tabId = tab.id, target = { tabId };
  log('PDF: bringing the Reddit tab to the front, removing ads, loading lazy images...');
  await chrome.tabs.update(tabId, { active: true }); await chrome.windows.update(tab.windowId, { focused: true });
  await sleep(500);
  let attached = false;
  try {
    await chrome.scripting.executeScript({ target, files: ['cleanpage.js'] });
    const [r] = await chrome.scripting.executeScript({ target, func: () => window.__T10CLEAN.prepare() });
    const dims = (r && r.result) || { height: 4000, width: 1280 };
    const W = Math.min(1920, Math.max(800, dims.width)), H = Math.min(180000, dims.height + 40);
    const scale = Math.max(0.1, Math.min(1, (195 * 96) / H)); // keep the single page under ~200 in (PDF limit)
    log(`PDF: page is ${W} x ${H}px, scale ${scale.toFixed(2)}`);
    await dbgAttach(target); attached = true;
    await dbgSend(target, 'Emulation.setEmulatedMedia', { media: 'screen' });
    const out = await dbgSend(target, 'Page.printToPDF', {
      printBackground: true, scale, pageRanges: '1', preferCSSPageSize: false, transferMode: 'ReturnAsBase64',
      paperWidth: W * scale / 96, paperHeight: (H * 1.02) * scale / 96 + 0.05,
      marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0
    });
    const bin = atob(out.data), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    pdfBlob = new Blob([bytes], { type: 'application/pdf' });
    log(`PDF: created (${Math.round(bytes.length / 1024)} KB)`);
  } finally {
    if (attached) await dbgDetach(target);
    if (temp) await chrome.tabs.remove(tabId).catch(() => { });
    else { try { await chrome.scripting.executeScript({ target, func: () => window.__T10CLEAN && window.__T10CLEAN.restore() }); } catch (e) { /* tab gone */ } }
    await focusMe();
  }
}
async function ensurePdf() {
  if (pdfBlob) return;
  await makePdf();
}

/* ---------------------------------------------------------------- highlights */
// Highlight keys: 'title' (post title), 'body' (post text), 'c:<id>' (a comment).
const textFor = key => key === 'title' ? data.title : key === 'body' ? data.body
  : (commentById.get(key.slice(2)) || {}).body || '';

function srcFor(key) {
  if (key === 'title' || key === 'body') return { label: `Original post by ${data.author.name} in ${data.group.name}` + (key === 'title' ? ' (title)' : ''), date: stampComma(data.posted), url: data.url };
  const c = commentById.get(key.slice(2));
  return { label: `${c.isReply ? 'Reply' : 'Comment'} by ${c.author.name} in ${c.group.name}`, date: stampComma(c.posted), url: c.url, cid: c.id };
}
const srcText = s => s ? `${s.label}, ${s.date} – ${s.url}` : '';

// Renders text into e, wrapping every quoted range (from the information entries) in <mark>.
function paint(e, key, text) {
  const doc = e.ownerDocument;
  const ents = entries.filter(x => x.key === key && x.end > x.start);
  e.textContent = '';
  if (!ents.length) { e.textContent = text; return; }
  const pts = [...new Set([0, text.length, ...ents.flatMap(x => [x.start, x.end])])].sort((a, b) => a - b);
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1], seg = text.slice(a, b);
    if (!seg) continue;
    const cov = ents.filter(x => x.start <= a && x.end >= b);
    if (cov.length) e.append(el(doc, 'mark', { class: 'hl', 'data-e': cov.map(x => x.id).join(' '), title: 'Quoted in an information entry – click to see it' }, seg));
    else e.append(doc.createTextNode(seg));
  }
}
function hlEl(doc, tag, cls, key, text, interactive) {
  const e = el(doc, tag, { class: cls });
  if (!text) { e.textContent = '(no text)'; return e; }
  e.setAttribute('data-hl', key);
  paint(e, key, text);
  if (interactive) hlTargets.set(key, e);
  return e;
}
const repaintAll = () => hlTargets.forEach((e, key) => paint(e, key, textFor(key)));

function rootOf(n) { n = n && (n.nodeType === 1 ? n : n.parentElement); return n ? n.closest('[data-hl]') : null; }
function offsetIn(root, node, off) { const r = document.createRange(); r.setStart(root, 0); r.setEnd(node, off); return r.toString().length; }
// The highlighted text, as { key, start, end, quote }, if it lies inside the post title, the post text or one comment.
// A drag that starts or ends just outside the text (e.g. past the end of a comment) is clamped to that text.
function currentSel() {
  const s = window.getSelection();
  if (!s || !s.rangeCount || s.isCollapsed) return null;
  const r = s.getRangeAt(0), a = rootOf(r.startContainer), z = rootOf(r.endContainer), root = a || z;
  if (!root || (a && z && a !== z) || !$('view').contains(root)) return a && z ? { multi: true } : null;
  const key = root.getAttribute('data-hl'), text = textFor(key);
  let st = a ? offsetIn(root, r.startContainer, r.startOffset) : 0;
  let en = z ? offsetIn(root, r.endContainer, r.endOffset) : text.length;
  while (st < en && /\s/.test(text[st])) st++;
  while (en > st && /\s/.test(text[en - 1])) en--;
  if (en <= st) return null;
  return { key, start: st, end: en, quote: text.slice(st, en).replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n') };
}

function hideBar() { $('hlBar').style.display = 'none'; }
function onSelection() {
  if (document.querySelector('.ovl')) return;
  const sel = currentSel();
  if (!sel || sel.multi) { hideBar(); if (sel && sel.multi) toast('Highlight text within a single post or comment.'); return; }
  const bar = $('hlBar'), r = window.getSelection().getRangeAt(0).getBoundingClientRect();
  bar.style.display = 'block';
  const bw = bar.offsetWidth, bh = bar.offsetHeight;
  let top = r.top + scrollY - bh - 8;
  if (r.top - bh - 8 < 4) top = r.bottom + scrollY + 8;
  const left = Math.max(scrollX + 6, Math.min(r.left + scrollX + r.width / 2 - bw / 2, scrollX + document.documentElement.clientWidth - bw - 6));
  bar.style.top = top + 'px'; bar.style.left = left + 'px';
}
function startEntry(errId) {
  const sel = currentSel();
  if (!sel || sel.multi) {
    const msg = sel && sel.multi ? 'Highlight text within a single post or comment, then press the button.' : 'Highlight some text in the post or in a comment first, then press the button.';
    if (errId && $(errId)) $(errId).textContent = msg; else toast(msg);
    return;
  }
  if (errId && $(errId)) $(errId).textContent = '';
  hideBar(); openModal(sel);
}

function flash(node) { if (!node) return; node.classList.add('flash'); setTimeout(() => node.classList.remove('flash'), 1600); }
function jumpToMark(id) { const m = document.querySelector(`#view mark.hl[data-e~="${id}"]`); if (m) { m.scrollIntoView({ block: 'center', behavior: 'smooth' }); flash(m); } }
function jumpToEntry(id) { const c = document.getElementById('entry-' + id); if (c) { c.scrollIntoView({ block: 'center', behavior: 'smooth' }); flash(c); } }

let toastTimer = null;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.style.display = 'block';
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.style.display = 'none'; }, 2600);
}
function updateDock() {
  if (!data || !$('fInfo')) return;
  $('dockInfo').textContent = `Information: ${infoItems().length}`;
  $('dockFlag').textContent = `Flagged comments: ${selected().length}`;
}

/* ------------------------------------------------------------------ rendering */
function mediaEls(doc, list, interactive) {
  return list.map(m => {
    const kids = [
      m.dataUrl ? el(doc, 'img', { src: m.dataUrl, alt: m.type }) : el(doc, 'div', { class: 'meta', text: `[${m.type} could not be embedded – it will be exported as a URL only] ${m.src}` }),
      m.target ? el(doc, 'div', { class: 'meta' }, 'Points to: ', linkIn(doc, m.target)) : null
    ];
    if (!interactive) return el(doc, 'div', { class: 'media' }, kids);
    const box = el(doc, 'div', { class: 'media mbox' + (m.include === false ? ' off' : '') });
    const cb = el(doc, 'input', { type: 'checkbox', title: 'Include this image in the DOCX / TXT / clipboard export and the working document' });
    cb.checked = m.include !== false;
    const lbl = el(doc, 'span', { text: cb.checked ? 'Included in export' : 'Left out of export' });
    cb.addEventListener('change', () => {
      m.include = cb.checked; box.classList.toggle('off', !cb.checked);
      lbl.textContent = cb.checked ? 'Included in export' : 'Left out of export';
    });
    box.append(el(doc, 'label', { class: 'pickrow' }, cb, lbl), ...kids.filter(Boolean));
    const img = box.querySelector('img');
    if (img) img.addEventListener('click', () => { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')); });
    return box;
  });
}

function whoEls(doc, e, group) {
  return [
    el(doc, 'div', { class: 'name' }, e.url ? linkIn(doc, e.url, e.name) : e.name, group ? `  (in subreddit: ${group.name})` : ''),
    el(doc, 'div', { class: 'meta' }, 'Profile: ', linkIn(doc, e.url) || '', group ? [' | Subreddit: ', linkIn(doc, group.url)] : null)
  ];
}

function postBox(doc, interactive) {
  const d = data, media = mediaEls(doc, d.media, interactive);
  return el(doc, 'div', { class: 'box post' },
    el(doc, 'div', { class: 'meta', text: 'ORIGINAL POST' }),
    whoEls(doc, d.author, d.group),
    el(doc, 'div', { class: 'meta', text: 'Posted: ' + stampAt(d.posted) }),
    el(doc, 'div', { class: 'meta' }, 'Post URL: ', linkIn(doc, d.url)),
    el(doc, 'div', { class: 'name', style: 'margin-top:8px' }, 'Title: ', hlEl(doc, 'span', '', 'title', d.title, interactive)),
    hlEl(doc, 'div', 'body', 'body', d.body, interactive),
    interactive && media.length > 1 ? el(doc, 'div', { class: 'imggrid' }, media) : media,
    d.links.length ? el(doc, 'div', { class: 'meta' }, 'Post links to: ', d.links.map((u, i) => [i ? ' | ' : '', linkIn(doc, u)])) : null,
    el(doc, 'div', { class: 'meta', style: 'margin-top:8px', text: `Comments: ${d.commentCountReported != null ? d.commentCountReported : 'not shown'} reported by Reddit | ${d.comments.length} captured (including replies)` }));
}

function commentBox(doc, c, interactive) {
  const box = el(doc, 'div', { class: 'box comment' + (c.checked ? ' sel' : '') });
  box.style.marginLeft = (Math.min(c.depth, 12) * 28) + 'px';
  const cb = el(doc, 'input', { type: 'checkbox', title: 'Flag this comment to save' });
  cb.checked = !!c.checked;
  if (!interactive) cb.disabled = true;

  const reasonWrap = el(doc, 'div', { class: 'reason' });
  const body = el(doc, 'div', { class: 'cbody' },
    whoEls(doc, c.author, c.group),
    el(doc, 'div', { class: 'meta' }, (c.isReply ? 'Reply' : 'Comment') + ' | ' + stampAt(c.posted) + ' | ', linkIn(doc, c.url, 'Comment URL'),
      c.orphan ? ' | (parent comment not retrieved)' : ''),
    c.repliesCaptured ? el(doc, 'div', { class: 'meta', text: `Replies captured: ${c.repliesCaptured}` }) : null,
    hlEl(doc, 'div', 'body', 'c:' + c.id, c.body, interactive),
    mediaEls(doc, c.media, interactive),
    reasonWrap);

  if (interactive) {
    commentUi.set(c.id, { cb });
    const ta = el(doc, 'textarea', { rows: 2, placeholder: 'Why do you want to save this comment?' });
    ta.value = c.reason || '';
    ta.addEventListener('input', () => { c.reason = ta.value; });
    reasonWrap.append(el(doc, 'label', { text: 'Reason for saving this comment' }), ta);
    reasonWrap.style.display = c.checked ? 'block' : 'none';
    cb.addEventListener('change', () => {
      c.checked = cb.checked;
      box.classList.toggle('sel', cb.checked);
      reasonWrap.style.display = cb.checked ? 'block' : 'none';
      if (cb.checked && !document.querySelector('.ovl')) ta.focus({ preventScroll: true });
      updateDock();
    });
  } else if (c.checked) {
    reasonWrap.style.display = 'block';
    reasonWrap.append(el(doc, 'label', { text: 'Reason for saving this comment' }), el(doc, 'div', { class: 'printval', text: c.reason || 'None given' }));
  }
  box.append(el(doc, 'div', { class: 'cwrap' }, cb, body));
  return box;
}

/* ---- information entries with quotes */
function entryBox(e) {
  const box = el(document, 'div', { class: 'box entry', id: 'entry-' + e.id });
  const x = el(document, 'button', { type: 'button', class: 'xbtn', title: 'Delete this entry', text: '×' });
  x.addEventListener('click', () => { entries.splice(entries.indexOf(e), 1); box.remove(); repaintAll(); updateDock(); });
  const ta = el(document, 'textarea', { rows: 2 });
  ta.value = e.text;
  ta.addEventListener('input', () => { e.text = ta.value; });
  const show = el(document, 'button', { type: 'button', class: 'linkbtn', text: 'Show in page' });
  show.addEventListener('click', () => jumpToMark(e.id));
  box.append(x, ta, el(document, 'div', { class: 'printval quoteval', text: Q(e.quote) }),
    el(document, 'div', { class: 'srcline' }, 'Source: ', e.src.label + ', ' + e.src.date + ' – ', link(e.src.url, 'open on Reddit'), '  ', show));
  return box;
}

function openModal(sel) {
  const src = srcFor(sel.key);
  const c = src.cid ? commentById.get(src.cid) : null;
  const ov = el(document, 'div', { class: 'ovl' });
  const ta = el(document, 'textarea', { rows: 4, placeholder: 'Enter the information relating to this quote...' });
  const err = el(document, 'div', { class: 'err' });
  const flag = el(document, 'input', { type: 'checkbox' });
  const close = () => { ov.remove(); document.removeEventListener('keydown', onKey); };
  const add = () => {
    if (!ta.value.trim()) { err.textContent = 'Please enter the information before adding.'; ta.focus(); return; }
    const e = { id: 'e' + (++entrySeq), text: ta.value.trim(), quote: sel.quote, key: sel.key, start: sel.start, end: sel.end, src };
    entries.push(e); $('entries').append(entryBox(e));
    window.getSelection().removeAllRanges(); $('infoErr').textContent = '';
    close(); repaintAll();
    if (c && flag.checked) { const u = commentUi.get(c.id); if (u && !u.cb.checked) { u.cb.checked = true; u.cb.dispatchEvent(new Event('change')); } }
    updateDock();
    toast('Information entry added' + (c && flag.checked ? ' and comment flagged' : '') + '.');
  };
  const onKey = ev => { if (ev.key === 'Escape') close(); else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) add(); };
  const bAdd = el(document, 'button', { type: 'button', class: 'abtn', text: 'Add' });
  const bCancel = el(document, 'button', { type: 'button', class: 'abtn alt', text: 'Cancel' });
  bAdd.addEventListener('click', add); bCancel.addEventListener('click', close);
  ov.append(el(document, 'div', { class: 'mdl' },
    el(document, 'h3', { text: 'Add Information Entry With Quote' }),
    el(document, 'div', { class: 'meta', text: 'Quoted text' }),
    el(document, 'div', { class: 'printval quoteval', style: 'margin-left:0', text: Q(sel.quote) }),
    el(document, 'div', { class: 'meta', style: 'margin-top:6px', text: 'Source: ' + src.label + ', ' + src.date }),
    el(document, 'label', { text: 'Information' }), ta,
    c && !c.checked ? el(document, 'label', { class: 'chk' }, flag, 'Also flag this comment as a Comment of Interest') : null,
    err, el(document, 'div', { class: 'mbtns' }, bCancel, bAdd)));
  document.addEventListener('keydown', onKey);
  document.body.append(ov); ta.focus();
}

function assessment(doc, interactive, man) {
  const wrap = el(doc, 'div', { id: 'assess' });
  wrap.append(el(doc, 'h2', { class: 'sec', text: 'Assessment' }));
  const fld = (id, label, rows, hint, val) => el(doc, 'div', { class: 'field' },
    el(doc, 'label', {}, label, el(doc, 'span', { class: 'hint', text: interactive ? hint || '' : '' })),
    interactive ? el(doc, 'textarea', { id, rows }) : el(doc, 'div', { class: 'printval', text: val || '' }));
  wrap.append(fld('fNotes', 'Notes', 3, '', man.notes));
  if (interactive) {
    const info = fld('fInfo', 'Information', 4, ' (required – one item per line; entries added with quotes appear below)');
    info.append(el(doc, 'div', { class: 'err', id: 'infoErr' }), el(doc, 'div', { id: 'entries' }));
    wrap.append(info);
  } else {
    const f = el(doc, 'div', { class: 'field' }, el(doc, 'label', { text: 'Information' }));
    const items = infoItems();
    if (!items.length) f.append(el(doc, 'div', { class: 'printval', text: '' }));
    items.forEach(x => f.append(el(doc, 'div', { class: 'box entry', style: 'padding-left:12px' },
      el(doc, 'div', { class: 'body', text: x.text }),
      x.quote ? el(doc, 'div', { class: 'printval quoteval', text: Q(x.quote) }) : null,
      x.source ? el(doc, 'div', { class: 'srcline', text: 'Source: ' + x.source }) : null)));
    wrap.append(f);
  }
  wrap.append(fld('fNext', 'Next Action(s)', 4, ' (one item per line)', man.next));
  return wrap;
}

function buildView(doc, interactive) {
  const man = interactive ? { notes: '', next: '' } : manual();
  const wrap = el(doc, 'div', { id: 'archive' });
  wrap.append(el(doc, 'div', { class: 'hdrbox' }, 'Page built: ', el(doc, 'b', { text: builtAt.d + ', ' + builtAt.t }), '   |   Team Member: ', el(doc, 'b', { text: job.name })));
  if (interactive) wrap.append(el(doc, 'div', { class: 'tip' },
    el(doc, 'b', { text: 'How to use this page: ' }),
    'tick the comments of interest (and give a reason); highlight text in the post or in any comment and press "Add Information Entry With Quote"; ' +
    'untick an image to leave it out of the export; fill in the Assessment at the bottom, then press Export or Add to Working Document.'));
  wrap.append(postBox(doc, interactive));
  if (interactive) {
    const btn = el(doc, 'button', { type: 'button', class: 'abtn', text: 'Add Information Entry With Quote' });
    btn.addEventListener('mousedown', e => e.preventDefault()); // keep the text selection
    btn.addEventListener('click', () => startEntry('entryErr'));
    wrap.append(el(doc, 'div', { class: 'actionrow' }, btn, el(doc, 'div', { class: 'err', id: 'entryErr' })));
  }
  wrap.append(el(doc, 'h2', { class: 'sec', text: `Comments (${data.comments.length})` }));
  if (!data.comments.length) wrap.append(el(doc, 'div', { class: 'meta', text: 'No comments were captured.' }));
  data.comments.forEach(c => wrap.append(commentBox(doc, c, interactive)));
  wrap.append(assessment(doc, interactive, man));
  return wrap;
}

/* --------------------------------------------------------------------- export */
const manual = () => { const g = id => ($(id) ? $(id).value : ''); return { notes: g('fNotes').trim(), info: g('fInfo'), next: g('fNext') }; };
const infoItems = () => [
  ...lines(manual().info).map(text => ({ text })),
  ...entries.map(e => ({ text: (e.text || '').trim() || '(no comment)', quote: e.quote, source: srcText(e.src) }))
];
function validate() {
  const ok = infoItems().length > 0;
  $('infoErr').textContent = ok ? '' : 'Information is required – please enter at least one item (or add an entry with a quote) before exporting.';
  if (!ok) { $('fInfo').scrollIntoView({ block: 'center' }); $('fInfo').focus(); }
  return ok;
}

const heading = () => `${dateOnly(data.posted)} - ${data.author.name} - ${data.title}`;
const baseName = () => safeName(stripEmoji(`${dateOnly(data.posted)} - ${data.author.user} - ${data.title}`)) || 'Reddit post';
const selected = () => data.comments.filter(c => c.checked);
const included = list => list.filter(m => m.include !== false);

async function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  try { await chrome.downloads.download({ url, filename, saveAs: true }); }
  catch (e) { const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove(); }
  setTimeout(() => URL.revokeObjectURL(url), 120000);
}

const mediaModel = m => ({ url: m.target || m.src, bytes: m.bytes, w: m.w, h: m.h, dataUrl: m.dataUrl, fallback: m.target || m.src });
const mediaTxt = m => m.target || m.src;

// One model feeds the DOCX file, the clipboard copy, the TXT export and the working document.
function buildModel() {
  const man = manual();
  return {
    heading: heading(), title: data.title, subreddit: data.group.name, author: data.author.name,
    postedBy: nameLine(data.author), profileUrl: urlLine(data.author), postedOn: stampComma(data.posted), url: data.url,
    capturedOn: builtAt.d + ', ' + builtAt.t, capturedBy: job.name,
    body: data.body, links: data.links, media: included(data.media).map(mediaModel),
    comments: selected().map(c => ({
      username: nameLine({ name: c.author.name, group: c.group }), url: urlLine({ url: c.author.url, group: c.group }),
      commentUrl: c.url, date: stampComma(c.posted), text: c.body, media: included(c.media).map(mediaModel), reason: (c.reason || '').trim()
    })),
    notes: man.notes, info: infoItems(), next: lines(man.next)
  };
}

async function saveDocx() {
  const bytes = T10Docx.build(buildModel());
  await saveBlob(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), baseName() + '.docx');
}

function buildTxt() {
  const EQ = '='.repeat(80), DASH = '-'.repeat(80), m = buildModel(), L = [];
  const ind = (s, pad) => String(s).replace(/\r?\n/g, '\r\n' + pad);
  L.push(EQ, `--- ${m.heading} ---`, DASH,
    `Posted By: ${m.postedBy}`, `Profile/Page URL: ${m.profileUrl}`, `Posted On: ${m.postedOn}`, `Post URL: ${m.url}`, 'Archive Link:', DASH,
    `Captured On: ${m.capturedOn}`, `Captured By: ${m.capturedBy}`, DASH,
    '--- Original Post Text and/or Media ---', DASH, `Title: ${m.title}`, '', m.body || '(no text)');
  m.links.forEach(u => L.push(`Post links to: ${u}`));
  m.media.forEach(x => L.push(x.url));
  L.push(EQ, '', EQ, '--- Comment(s) of Interest ---');
  if (!m.comments.length) L.push(DASH, 'No comments selected.');
  m.comments.forEach((c, i) => {
    L.push(DASH, `Comment ${i + 1}`, DASH,
      `Username: ${c.username}`, `Profile URL: ${c.url}`, `Comment URL: ${c.commentUrl}`, `Commented On: ${c.date}`, DASH,
      `Comment: ${c.text}`);
    if (c.media.length) L.push(`Media: ${c.media.map(x => x.url).join(' ')}`);
    L.push(DASH, `Reason: ${c.reason || 'None given'}`);
  });
  L.push(EQ, '', EQ, '--- Assessment ---', `Notes: ${m.notes || 'No notes'}`, DASH, 'Information:');
  m.info.forEach(x => {
    L.push('  - ' + ind(x.text, '    '));
    if (x.quote) L.push('      ' + ind(Q(x.quote), '       '));
    if (x.source) L.push('      Source: ' + x.source);
  });
  L.push(DASH, 'Next Action(s):');
  if (m.next.length) m.next.forEach(x => L.push('  - ' + x)); else L.push('  No further actions recommended');
  L.push(EQ);
  return L.join('\r\n') + '\r\n';
}
async function saveTxt() {
  await saveBlob(new Blob([stripEmoji(buildTxt())], { type: 'text/plain;charset=utf-8' }), baseName() + '.txt');
}
async function savePdf() {
  await ensurePdf();
  await saveBlob(pdfBlob, baseName() + ' - original page.pdf');
}

// PDF of the post and every captured comment (with highlights, flags and the Assessment), via Chrome's print dialog.
// "long" = one continuous page, "pages" = A4.
const PAGE_W = 794, MAX_PAGE_H = 19000; // px at 96dpi; PDF pages top out around 200 inches
async function saveThreadPdf() {
  const css = await (await fetch('archive.css')).text();
  const long = (job.opts.pdfLayout || 'long') === 'long';
  const iframe = document.createElement('iframe');
  iframe.style.cssText = `position:fixed;left:-20000px;top:0;width:${PAGE_W}px;height:600px;border:0`;
  document.body.appendChild(iframe);
  const d = iframe.contentDocument;
  const name = baseName() + ' - full thread';
  d.open();
  d.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escHtml(name)}</title><style>${css}</style></head><body class="print"></body></html>`);
  d.close();
  if (long) d.head.append(el(d, 'style', { text: 'body.print{padding:24px 30px}' }));
  d.body.appendChild(buildView(d, false));
  await Promise.all([...d.images].map(i => i.decode().catch(() => { })));
  if (long) {
    const h = Math.ceil(d.documentElement.scrollHeight) + 4, ph = Math.min(h, MAX_PAGE_H);
    d.head.append(el(d, 'style', { text: `@page{size:${PAGE_W}px ${ph}px;margin:0}` + (h <= MAX_PAGE_H ? '@media print{.box,.box.entry{break-inside:auto}}' : '') }));
    if (h > MAX_PAGE_H) log(`Thread is too tall for one PDF page (${h}px) – split into ${Math.ceil(h / MAX_PAGE_H)} very long pages.`);
  }
  const oldTitle = document.title; document.title = name;
  const w = iframe.contentWindow;
  w.addEventListener('afterprint', () => { document.title = oldTitle; setTimeout(() => iframe.remove(), 500); });
  w.focus(); w.print();
  setTimeout(() => { document.title = oldTitle; if (iframe.isConnected) iframe.remove(); }, 300000);
}

/* ------------------------------------------------------- clipboard (DOCX content) */
// Same content and layout as the DOCX, as rich HTML so it pastes into Word / Google Docs with formatting.
function modelToHtml(m) {
  const e = s => escHtml(s == null ? '' : s).replace(/\r?\n/g, '<br>');
  const P = (inner, st) => `<p style="margin:0 0 6pt 0;${st || ''}">${inner}</p>`;
  const block = pairs => P(pairs.map(([l, v]) => `<b>${e(l)}</b>${v !== undefined && v !== '' ? ' ' + e(v) : ''}`).join('<br>'));
  const HS = { 2: ['Aptos Display', 16, '', 12], 3: ['Aptos', 14, '', 10], 4: ['Aptos', 12, 'font-style:italic;', 8] };
  const H = (n, t) => { const [f, sz, st, bf] = HS[n]; return `<h${n} style="font-family:'${f}',Calibri,Arial,sans-serif;font-size:${sz}pt;font-weight:normal;${st}color:#0F4761;margin:${bf}pt 0 4pt 0">${e(t)}</h${n}>`; };
  const img = x => {
    if (!x || !x.dataUrl) return P(e('[media not embedded] ' + ((x && x.fallback) || '')));
    const sc = Math.min(1, 480 / Math.max(1, x.w), 384 / Math.max(1, x.h));
    return P(`<img src="${x.dataUrl}" width="${Math.round(x.w * sc)}" height="${Math.round(x.h * sc)}" alt="">`);
  };
  const UL = lis => `<ul style="margin:0 0 6pt 0">${lis.join('')}</ul>`;
  const LI = (t, q, s) => `<li style="margin:0">${e(t)}${q ? `<br><i style="color:#595959">${e(Q(q))}</i>` : ''}${s ? `<br><span style="color:#595959;font-size:9pt">Source: ${e(s)}</span>` : ''}</li>`;
  const o = [];
  o.push(H(2, m.heading));
  o.push(block([['Posted By:', m.postedBy], ['Profile/Page URL:', m.profileUrl], ['Posted On:', m.postedOn], ['Post URL:', m.url],
    ['Archive Link:', ''], ['Captured On:', m.capturedOn], ['Captured By:', m.capturedBy]]));
  o.push(H(3, 'Original Post Text and/or Media'), P(`<b>${e(m.title)}</b>`));
  String(m.body || '').split(/\n\s*\n/).map(s => s.trim()).filter(Boolean).forEach(p => o.push(P(e(p))));
  m.links.forEach(u => o.push(block([['Post links to:', u]])));
  m.media.forEach(x => o.push(img(x)));
  o.push(H(3, 'Comment(s) of Interest'));
  if (!m.comments.length) o.push(P('No comments selected.'));
  m.comments.forEach((c, i) => {
    o.push(H(4, 'Comment ' + (i + 1)), block([['Username:', c.username], ['Profile URL:', c.url], ['Comment URL:', c.commentUrl], ['Commented On:', c.date]]),
      block([['Comment:', c.text]]));
    c.media.forEach((x, j) => { if (!j) o.push(P('<b>Media:</b>')); o.push(img(x)); });
    o.push(block([['Reason:', c.reason || 'None given']]));
  });
  o.push(H(3, 'Assessment'), block([['Notes:', m.notes || 'No notes']]), `<p style="margin:0;"><b>Information:</b></p>`);
  if (m.info.length) o.push(UL(m.info.map(x => LI(x.text, x.quote, x.source))));
  if (m.next.length) o.push(`<p style="margin:0;"><b>Next Action(s):</b></p>`, UL(m.next.map(x => LI(x))));
  else o.push(block([['Next Action(s):', 'No further actions recommended']]));
  return `<div style="font-family:Aptos,Calibri,Arial,sans-serif;font-size:12pt;color:#000000">${o.join('')}</div>`;
}

async function copyDocx() {
  const html = modelToHtml(buildModel()), text = buildTxt();
  try {
    if (!window.ClipboardItem || !navigator.clipboard || !navigator.clipboard.write) throw new Error('Async clipboard not available');
    await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) })]);
  } catch (err) {
    const holder = document.createElement('div');
    holder.contentEditable = 'true';
    holder.style.cssText = 'position:fixed;left:-99999px;top:0;width:800px';
    holder.innerHTML = html;
    document.body.appendChild(holder);
    const range = document.createRange(); range.selectNodeContents(holder);
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e2) { /* ignore */ }
    sel.removeAllRanges(); holder.remove();
    if (!ok) throw err;
  }
  setStatus('DOCX content copied to the clipboard – switch to your document and paste (Ctrl+V / Cmd+V).');
}

async function guarded(fn, label) {
  if (!validate()) return false;
  try { setStatus('Creating ' + label + '...'); await fn(); return true; }
  catch (e) { setStatus('Error creating ' + label + ': ' + (e.message || e)); log('Error (' + label + '): ' + (e.stack || e)); return false; }
}

async function doExport() {
  if (!validate()) return;
  $('exportBtn').disabled = true;
  const chosen = [];
  if (job.opts.docx) chosen.push([saveDocx, 'DOCX']);
  if (job.opts.txt) chosen.push([saveTxt, 'TXT']);
  if (job.opts.pdf) chosen.push([savePdf, 'PDF (original page)']);
  if (job.opts.thread) chosen.push([saveThreadPdf, 'PDF (full thread)']);
  if (!chosen.length) setStatus('No export formats were ticked in the popup – use the Download buttons above.');
  for (const [fn, label] of chosen) await guarded(fn, label);
  if (chosen.length) setStatus('Export finished (' + chosen.map(c => c[1]).join(', ') + '). Use the Download buttons to save a format again.');
  ['dlDocx', 'dlTxt', 'dlPdf', 'dlThread'].forEach(id => { $(id).disabled = false; });
  $('exportBtn').disabled = false;
}

/* ---------------------------------------------------------------------- videos */
const videoJobs = new Map(); // download id -> url
chrome.downloads.onChanged.addListener(d => {
  if (videoJobs.has(d.id) && d.state && d.state.current === 'interrupted') {
    setStatus('A video download was refused (the link may have expired). Opening it in a new tab instead – right-click the video there and choose "Save video as...".');
    window.open(videoJobs.get(d.id), '_blank');
    videoJobs.delete(d.id);
  }
});
async function dlVideo(url, n) {
  try {
    const id = await chrome.downloads.download({ url, filename: `${baseName()} - video ${n}.mp4`, saveAs: true });
    videoJobs.set(id, url);
    setStatus(`Video ${n} download started.`);
  } catch (e) { setStatus('Video download failed: ' + (e.message || e)); window.open(url, '_blank'); }
}
function renderVideoButtons() {
  if (!data.videos.length) return;
  const box = document.createElement('div');
  box.id = 'videoBtns';
  data.videos.forEach((url, i) => {
    const b = el(document, 'button', { text: `Download Video ${i + 1} (video only, no audio)` });
    b.addEventListener('click', () => dlVideo(url, i + 1));
    box.append(b);
  });
  box.append(el(document, 'div', { class: 'meta', style: 'margin:0 0 8px', text: 'Reddit stores a video\'s audio separately, so this saves the silent video track.' }));
  $('downloads').append(box);
}

/* ------------------------------------------------------- review-page wiring */
function wireReviewPage() {
  // Floating "Add Information Entry With Quote" button next to highlighted text (works in the post and in every comment).
  $('hlAdd').addEventListener('mousedown', e => e.preventDefault());
  $('hlAdd').addEventListener('click', () => startEntry(null));
  document.addEventListener('mouseup', e => { if (!$('hlBar').contains(e.target)) setTimeout(onSelection, 0); });
  document.addEventListener('keyup', e => { if (e.shiftKey || e.key === 'Shift') onSelection(); });
  document.addEventListener('selectionchange', () => { if (window.getSelection().isCollapsed) hideBar(); });
  // Click a highlight to jump to its information entry.
  $('view').addEventListener('click', e => {
    const m = e.target.closest && e.target.closest('mark.hl');
    if (m && window.getSelection().isCollapsed) jumpToEntry(m.getAttribute('data-e').split(' ')[0]);
  });
  $('fInfo').addEventListener('input', () => { updateDock(); if (infoItems().length) $('infoErr').textContent = ''; });
  $('dock').style.display = 'flex';
  $('dockAssess').addEventListener('click', () => $('assess').scrollIntoView({ behavior: 'smooth' }));
  $('dockTop').addEventListener('click', () => scrollTo({ top: 0, behavior: 'smooth' }));
  // Warn before closing the tab with review work in it.
  addEventListener('beforeunload', e => {
    const m = manual();
    if (data && (entries.length || selected().length || m.notes || m.info.trim() || m.next.trim())) { e.preventDefault(); e.returnValue = ''; }
  });
  updateDock();
}

/* ----------------------------------------------------------------------- main */
(async function main() {
  $('toggleLog').addEventListener('click', () => { logEl.style.display = logEl.style.display === 'none' ? 'block' : 'none'; });
  try {
    job = (await chrome.storage.local.get('job')).job;
    if (!job) throw new Error('No capture job found. Start again from the extension popup.');
    job.opts = job.opts || {};
    log('Team Member: ' + job.name);
    log('Source URL: ' + job.url);
    setStatus('Capturing post and loading all comments (keep this tab open)...');
    const cap = await capture(job.url, job.sort || 'confidence');
    data = buildData(cap.post, cap.ordered);
    await fetchMedia(data);
    setBar(90);
    if (job.opts.pdf) {
      try { await makePdf(); } catch (e) { log('PDF capture failed: ' + (e.message || e)); setStatus('PDF capture failed: ' + (e.message || e)); await sleep(2500); }
    }
    builtAt = nowParts();
    $('view').appendChild(buildView(document, true));
    $('postCtl').style.display = 'block';
    $('exportRow').style.display = 'block';
    $('dlDocx').addEventListener('click', () => guarded(saveDocx, 'DOCX'));
    $('dlTxt').addEventListener('click', () => guarded(saveTxt, 'TXT'));
    $('dlPdf').addEventListener('click', () => guarded(savePdf, 'PDF (original page)'));
    $('dlThread').addEventListener('click', () => guarded(saveThreadPdf, 'PDF (full thread)'));
    $('dlCopy').addEventListener('click', () => guarded(copyDocx, 'clipboard copy'));
    $('dlCopy').disabled = false;
    $('exportBtn').addEventListener('click', doExport);
    renderVideoButtons();
    wireReviewPage();
    await initWorkDoc().catch(e => log('Working document error: ' + (e.message || e)));
    setBar(100);
    setStatus(`Capture complete – ${data.comments.length} comments/replies. Tick the comments to save, highlight post or comment text to add information entries, fill in the Assessment, then press Export.`);
    logEl.style.display = 'none'; $('toggleLog').style.display = 'inline';
    await focusMe();
  } catch (e) {
    setStatus('Capture failed: ' + (e.message || e));
    log('ERROR: ' + (e.stack || e));
    await focusMe();
  }
})();
