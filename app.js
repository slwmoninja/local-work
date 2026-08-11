// Bump on every future code change to this file so a reload can be visually
// confirmed against what was actually deployed (Settings > About shows this).
// Distinct from STORE_KEY's "_v1" suffix, which is the localStorage data-shape
// version -- don't conflate the two.
const APP_VERSION = '1.1.0';
const STORE_KEY = 'localwork_v1';

let RESUME = null;
let JOBS = [];        // raw jobs from data/jobs.json, scored + id'd
let TRACK = loadTrack();
let activeTab = 'matches';
let strongOnly = false;
let showLocal = true;
let showRemote = true;

const els = {
  tabs: document.getElementById('tabs'),
  jobList: document.getElementById('jobList'),
  emptyState: document.getElementById('emptyState'),
  strongOnly: document.getElementById('strongOnly'),
  showLocal: document.getElementById('showLocal'),
  showRemote: document.getElementById('showRemote'),
  jobModalBackdrop: document.getElementById('jobModalBackdrop'),
  jobModal: document.getElementById('jobModal'),
  infoModalBackdrop: document.getElementById('infoModalBackdrop'),
  btnInfo: document.getElementById('btnInfo'),
  btnSettings: document.getElementById('btnSettings'),
  settingsModalBackdrop: document.getElementById('settingsModalBackdrop'),
  settingsModal: document.getElementById('settingsModal'),
  restoreFileInput: document.getElementById('restoreFileInput'),
  installPillSlot: document.getElementById('installPillSlot'),
  pullRefresh: document.getElementById('pullRefresh'),
};

// ---------- persistence ----------
function loadTrack(){
  try{ return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; }catch(e){ return {}; }
}
function saveTrack(){
  localStorage.setItem(STORE_KEY, JSON.stringify(TRACK));
}
function getTrack(jobId){
  return TRACK[jobId] || { status: null, appliedDate: null, notes: '' };
}
function setTrack(jobId, patch){
  TRACK[jobId] = Object.assign({}, getTrack(jobId), patch);
  saveTrack();
}

// ---------- id / slug ----------
function slugify(s){
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'');
}
function jobId(job){
  return job.id || slugify(`${job.employer}|${job.title}|${job.url||''}`);
}

// ---------- matching engine ----------
function normalize(s){ return String(s||'').toLowerCase(); }

function matchRequirement(reqText, resume){
  const norm = normalize(reqText);
  for(const dq of resume.hardDisqualifiers){
    for(const pat of dq.patterns){
      try{
        const re = new RegExp(pat, 'i');
        if(re.test(reqText)) return { status:'hard', dq };
      }catch(e){ /* skip bad pattern */ }
    }
  }
  const matchedSkills = [];
  for(const skill of resume.skills){
    for(const syn of skill.synonyms){
      if(norm.includes(syn.toLowerCase())){ matchedSkills.push(skill); break; }
    }
  }
  if(matchedSkills.length) return { status:'matched', matchedSkills };
  return { status:'unmatched' };
}

// Two scoring sources:
//  - "ai": job.ai was precomputed offline by Claude actually reading the posting
//    (distinguishes real qualifications from job duties/perks, reasons about
//    "preferred" vs "required") and reused here as-is. No API call happens
//    in the browser — this is just reading a static field shipped in jobs.json.
//  - "local": no job.ai present, so fall back to the always-available, zero-cost
//    in-browser keyword/synonym/regex matcher below. Less accurate on nuance,
//    but instant and works for any job without waiting for a data refresh.
function scoreJobLocal(job, resume){
  const reqs = Array.isArray(job.requirements) ? job.requirements.filter(Boolean) : [];
  if(!reqs.length){
    return { score:50, eliminated:false, eliminatedReason:null, results:[], matchedCount:0, total:0, source:'local' };
  }
  const results = reqs.map(r => Object.assign({ text: r }, matchRequirement(r, resume)));
  const hardHits = results.filter(r => r.status === 'hard');
  const matchedCount = results.filter(r => r.status === 'matched').length;
  const total = results.length;
  const pct = Math.round((matchedCount / total) * 100);
  const belowThreshold = pct < (resume.matchThresholdPercent || 40);
  const eliminated = hardHits.length > 0 || belowThreshold;
  let eliminatedReason = null;
  if(hardHits.length){
    eliminatedReason = `Requires "${hardHits[0].dq.label}" — not on your resume.`;
  } else if(belowThreshold){
    eliminatedReason = `Only ${pct}% of requirements matched your resume (need ${resume.matchThresholdPercent}%+).`;
  }
  return { score: pct, eliminated, eliminatedReason, results, matchedCount, total, source:'local' };
}

function scoreJobAi(job, resume){
  const reqs = Array.isArray(job.ai.requirements) ? job.ai.requirements : [];
  const results = reqs.map(r => {
    const status = r.matched === false ? (r.hard ? 'hard' : 'unmatched') : 'matched';
    // Still run the local synonym matcher on matched items purely to derive
    // skill chips for the card UI — doesn't affect the score or verdict.
    let matchedSkills = [];
    if(status === 'matched'){
      const local = matchRequirement(r.text, resume);
      if(local.status === 'matched') matchedSkills = local.matchedSkills;
    }
    return { text: r.text, status, matchedSkills, note: r.note || null };
  });
  const matchedCount = results.filter(r => r.status === 'matched').length;
  const total = results.length || 1;
  const score = (job.ai.score != null) ? job.ai.score : Math.round((matchedCount/total)*100);
  return {
    score,
    eliminated: !!job.ai.eliminated,
    eliminatedReason: job.ai.eliminatedReason || null,
    results, matchedCount, total: reqs.length, source:'ai'
  };
}

// Freshness window/bonus is configured in resume-profile.json (`freshness`)
// so it's tunable without touching code. Unknown postedDate is treated as
// neutral (neither stale nor fresh) -- several real postings never show a
// date on the page, and that's not evidence the listing is old.
function freshnessInfo(job, resume){
  const cfg = (resume && resume.freshness) || { windowDays:7, bonusWithinDays:1, bonusPoints:8 };
  if(!job.postedDate) return { known:false, days:null, stale:false, fresh:false, cfg };
  const posted = new Date(job.postedDate + 'T00:00:00');
  if(isNaN(posted.getTime())) return { known:false, days:null, stale:false, fresh:false, cfg };
  const days = Math.floor((Date.now() - posted.getTime()) / 86400000);
  return { known:true, days, stale: days > cfg.windowDays, fresh: days >= 0 && days <= cfg.bonusWithinDays, cfg };
}

function scoreJob(job, resume){
  const base = (job.ai && Array.isArray(job.ai.requirements) && job.ai.requirements.length)
    ? scoreJobAi(job, resume)
    : scoreJobLocal(job, resume);
  const freshness = freshnessInfo(job, resume);
  let score = base.score;
  if(freshness.fresh) score = Math.min(100, score + freshness.cfg.bonusPoints);
  let eliminated = base.eliminated;
  let eliminatedReason = base.eliminatedReason;
  if(!eliminated && freshness.stale){
    eliminated = true;
    eliminatedReason = `Posted ${freshness.days} days ago — older than the ${freshness.cfg.windowDays}-day freshness window.`;
  }
  return Object.assign({}, base, { score, eliminated, eliminatedReason, freshness });
}

function uniqueMatchedSkills(scoreResult){
  const seen = new Map();
  for(const r of scoreResult.results || []){
    if(r.status === 'matched'){
      for(const s of r.matchedSkills) if(!seen.has(s.id)) seen.set(s.id, s);
    }
  }
  return [...seen.values()].sort((a,b)=> (b.weight||0) - (a.weight||0));
}

// ---------- data load ----------
async function loadData(){
  const [resumeRes, jobsRes] = await Promise.all([
    fetch('./data/resume-profile.json', {cache:'no-store'}),
    fetch('./data/jobs.json', {cache:'no-store'})
  ]);
  RESUME = await resumeRes.json();
  const rawJobs = await jobsRes.json();
  JOBS = rawJobs.map(job => {
    const id = jobId(job);
    const sr = scoreJob(job, RESUME);
    return Object.assign({}, job, { id, _score: sr });
  });
  render();
}

// ---------- derived lists ----------
function classify(job){
  const t = getTrack(job.id);
  if(t.status === 'applied' || t.status === 'interviewing' || t.status === 'offer' || t.status === 'rejected') return 'tracking';
  if(t.status === 'dismissed') return 'notfit';
  if(t.status === 'saved') return 'saved';
  if(job._score.eliminated) return 'notfit';
  return 'matches';
}

function jobsForTab(tab){
  let list = JOBS.filter(j => classify(j) === tab);
  if(tab === 'matches' || tab === 'saved'){
    if(strongOnly) list = list.filter(j => j._score.score >= 60);
    list = list.filter(j => (j.remote ? showRemote : showLocal));
    list.sort((a,b) => b._score.score - a._score.score);
  } else if(tab === 'notfit'){
    list.sort((a,b) => b._score.score - a._score.score);
  } else if(tab === 'tracking'){
    list.sort((a,b) => (getTrack(b.id).appliedDate||'').localeCompare(getTrack(a.id).appliedDate||''));
  }
  return list;
}

const TAB_DEFS = [
  { id:'matches', label:'Matches' },
  { id:'saved', label:'Saved' },
  { id:'tracking', label:'Tracking' },
  { id:'notfit', label:'Not a Fit' },
];

// ---------- render ----------
function scoreClass(score){
  if(score >= 70) return 'score-hi';
  if(score >= 45) return 'score-mid';
  return 'score-lo';
}

function renderTabs(){
  els.tabs.innerHTML = TAB_DEFS.map(t => {
    const count = jobsForTab(t.id).length;
    return `<button class="tab ${t.id===activeTab?'active':''}" data-tab="${t.id}">${t.label}<span class="count">${count}</span></button>`;
  }).join('');
  els.tabs.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => goToTab(btn.dataset.tab));
  });
}

function statusPillHtml(job){
  const t = getTrack(job.id);
  if(!t.status || t.status === 'dismissed') return '';
  const labels = { saved:'Saved', applied:'Applied', interviewing:'Interviewing', offer:'Offer', rejected:'Rejected' };
  if(!labels[t.status]) return '';
  return `<span class="status-pill status-${t.status}">${labels[t.status]}</span>`;
}

function cardHtml(job){
  const s = job._score;
  const matched = uniqueMatchedSkills(s);
  const chipsHtml = matched.slice(0,5).map(m => `<span class="chip">${m.label}</span>`).join('')
    + (matched.length > 5 ? `<span class="chip more">+${matched.length-5} more</span>` : '');
  const workType = job.remote ? `Remote (${job.remoteTiedTo || 'VA'})` : (job.estDriveMinutesFrom23185 != null ? `${job.estDriveMinutesFrom23185} min drive` : null);
  const postedBit = job.postedDate ? `Posted ${job.postedDate}${s.freshness.fresh ? ' 🔥' : ''}` : null;
  const metaBits = [job.location || job.employerLocation, workType, job.salary || null, postedBit].filter(Boolean);
  const reasonHtml = s.eliminated ? `<div class="reason">${s.eliminatedReason}</div>` : '';
  return `
  <div class="card" data-id="${job.id}">
    <div class="card-top">
      <div>
        <p class="card-title">${job.title}</p>
        <div class="card-employer">${job.employer}</div>
      </div>
      <div class="score-badge ${scoreClass(s.score)}">${s.score}<span class="lbl">MATCH</span></div>
    </div>
    <div class="meta-row">${metaBits.map(m=>`<span>${m}</span>`).join('')}</div>
    ${statusPillHtml(job)}
    ${job.description ? `<div class="desc">${job.description}</div>` : ''}
    ${reasonHtml}
    ${matched.length ? `<div class="chips">${chipsHtml}</div>` : ''}
    <div class="card-actions">
      <button class="btn btn-ghost small" data-action="view">Details</button>
      <a class="btn btn-ghost small" href="${job.url}" target="_blank" rel="noopener">View Posting ↗</a>
      ${cardActionButtons(job)}
    </div>
  </div>`;
}

function cardActionButtons(job){
  const t = getTrack(job.id);
  const cls = classify(job);
  const btns = [];
  if(cls === 'notfit'){
    btns.push(`<button class="btn btn-ghost small" data-action="restore">Restore to Matches</button>`);
  } else {
    if(t.status !== 'saved') btns.push(`<button class="btn btn-ghost small" data-action="save">Save</button>`);
    if(!['applied','interviewing','offer','rejected'].includes(t.status)) btns.push(`<button class="btn btn-primary small" data-action="apply">Apply &amp; Track</button>`);
    btns.push(`<button class="btn btn-danger btn-ghost small" data-action="dismiss">Eliminate</button>`);
  }
  return btns.join('');
}

function emptyMessage(tab){
  const msgs = {
    matches: { big:'🔎', text:'No matching roles right now. Refresh the job data snapshot (see README.md) to pull a new batch.' },
    saved: { big:'⭐', text:'Nothing saved yet. Tap Save on a role in Matches to keep it here.' },
    tracking: { big:'📌', text:'No applications tracked yet. Tap "Apply & Track" on a role to start tracking it here.' },
    notfit: { big:'🚫', text:'Nothing eliminated yet. Roles land here automatically when a requirement clearly isn\'t on your resume, or when you tap Eliminate.' },
  };
  return msgs[tab] || { big:'—', text:'Nothing here.' };
}

function render(){
  renderTabs();
  const list = jobsForTab(activeTab);
  if(!list.length){
    els.jobList.innerHTML = '';
    const m = emptyMessage(activeTab);
    els.emptyState.style.display = 'block';
    els.emptyState.innerHTML = `<span class="big">${m.big}</span>${m.text}`;
  } else {
    els.emptyState.style.display = 'none';
    els.jobList.innerHTML = list.map(cardHtml).join('');
  }
  wireCardActions();
}

function wireCardActions(){
  els.jobList.querySelectorAll('.card').forEach(card => {
    const id = card.dataset.id;
    const job = JOBS.find(j => j.id === id);
    card.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        handleAction(btn.dataset.action, job);
      });
    });
  });
}

function handleAction(action, job){
  if(action === 'view') return openJobModal(job);
  if(action === 'save') { setTrack(job.id, { status:'saved' }); render(); }
  if(action === 'dismiss') { setTrack(job.id, { status:'dismissed' }); render(); }
  if(action === 'restore') { setTrack(job.id, { status:null }); render(); }
  if(action === 'apply') { openApplyFlow(job); }
}

function openApplyFlow(job){
  window.open(job.url, '_blank', 'noopener');
  const t = getTrack(job.id);
  setTrack(job.id, { status: t.status && ['interviewing','offer','rejected'].includes(t.status) ? t.status : 'applied', appliedDate: t.appliedDate || new Date().toISOString().slice(0,10) });
  render();
  openJobModal(job);
}

// ---------- job detail modal ----------
function reqMarkHtml(status){
  if(status === 'matched') return `<span class="req-mark mk-yes">✓</span>`;
  if(status === 'hard') return `<span class="req-mark mk-bad">✕</span>`;
  return `<span class="req-mark mk-no">–</span>`;
}

function reqItemHtml(r){
  const note = r.note ? `<div style="font-size:11.5px;color:var(--muted);margin-top:2px">${r.note}</div>` : '';
  return `<li>${reqMarkHtml(r.status)}<span>${r.text}${note}</span></li>`;
}

function openJobModal(job){
  const s = job._score;
  const t = getTrack(job.id);
  const reqListHtml = (s.results || []).map(reqItemHtml).join('')
    || `<li style="color:var(--muted)">No structured requirements were captured for this posting — check the full listing.</li>`;
  const trackingCls = ['applied','interviewing','offer','rejected'];
  const showTracker = trackingCls.includes(t.status);
  const scoreSourceLabel = (s.source === 'ai'
    ? 'Scored by Claude reading the full posting'
    : 'Scored by on-device keyword match (no Claude read-through yet for this posting)')
    + (s.freshness.fresh ? ` · 🔥 +${s.freshness.cfg.bonusPoints} freshness bonus (posted ${s.freshness.days === 0 ? 'today' : s.freshness.days + ' day(s) ago'})` : '');
  els.jobModal.innerHTML = `
    <button class="close-x" data-close="jobModalBackdrop">✕</button>
    <div class="score-badge ${scoreClass(s.score)}" style="float:right;margin-top:2px">${s.score}<span class="lbl">MATCH</span></div>
    <h2>${job.title}</h2>
    <div class="card-employer">${job.employer} — ${job.location || job.employerLocation || ''}</div>
    ${job.remote ? `<div style="font-size:12px;color:var(--muted);margin-top:4px">Remote (tied to ${job.remoteTiedTo || 'VA'})${job.salary?` · ${job.salary}`:''}</div>`
      : job.estDriveMinutesFrom23185!=null ? `<div style="font-size:12px;color:var(--muted);margin-top:4px">${job.estDriveMinutesFrom23185} min drive from 23185${job.salary?` · ${job.salary}`:''}</div>`:''}
    ${job.description ? `<p style="font-size:13.5px;color:#c6d8d0;line-height:1.5">${job.description}</p>` : ''}
    ${s.eliminated ? `<div class="reason">${s.eliminatedReason}</div>` : ''}
    <div class="section-label">Requirements match (${s.matchedCount}/${s.total})</div>
    <div style="font-size:11px;color:var(--muted);margin-bottom:4px">${scoreSourceLabel}</div>
    <ul class="req-list">${reqListHtml}</ul>
    <div class="card-actions" style="margin-top:14px">
      <a class="btn btn-primary small" href="${job.url}" target="_blank" rel="noopener">View Posting ↗</a>
      ${t.status!=='saved' ? `<button class="btn btn-ghost small" data-modal-action="save">Save</button>` : ''}
      ${!trackingCls.includes(t.status) ? `<button class="btn btn-ghost small" data-modal-action="apply">Apply &amp; Track</button>` : ''}
      ${classify(job)!=='notfit' ? `<button class="btn btn-danger btn-ghost small" data-modal-action="dismiss">Eliminate</button>` : `<button class="btn btn-ghost small" data-modal-action="restore">Restore</button>`}
    </div>
    ${showTracker ? trackerHtml(job, t) : ''}
  `;
  els.jobModal.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => closeModal(b.dataset.close)));
  els.jobModal.querySelectorAll('[data-modal-action]').forEach(b => {
    b.addEventListener('click', (e) => {
      e.preventDefault();
      const a = b.dataset.modalAction;
      if(a === 'save'){ setTrack(job.id,{status:'saved'}); render(); openJobModal(job); }
      if(a === 'dismiss'){ setTrack(job.id,{status:'dismissed'}); render(); closeModal('jobModalBackdrop'); }
      if(a === 'restore'){ setTrack(job.id,{status:null}); render(); openJobModal(job); }
      if(a === 'apply'){ openApplyFlow(job); }
    });
  });
  if(showTracker) wireTracker(job);
  els.jobModalBackdrop.classList.add('open');
}

function trackerHtml(job, t){
  return `
  <div class="track-box">
    <div class="section-label" style="margin-top:0">Application tracker</div>
    <label>Status</label>
    <select id="trackStatus">
      <option value="applied" ${t.status==='applied'?'selected':''}>Applied</option>
      <option value="interviewing" ${t.status==='interviewing'?'selected':''}>Interviewing</option>
      <option value="offer" ${t.status==='offer'?'selected':''}>Offer</option>
      <option value="rejected" ${t.status==='rejected'?'selected':''}>Rejected</option>
    </select>
    <label>Applied date</label>
    <input type="date" id="trackDate" value="${t.appliedDate||''}">
    <label>Notes</label>
    <textarea id="trackNotes" placeholder="Contact name, interview notes, follow-up date...">${t.notes||''}</textarea>
  </div>`;
}

function wireTracker(job){
  const statusEl = document.getElementById('trackStatus');
  const dateEl = document.getElementById('trackDate');
  const notesEl = document.getElementById('trackNotes');
  const save = () => { setTrack(job.id, { status: statusEl.value, appliedDate: dateEl.value, notes: notesEl.value }); render(); };
  statusEl.addEventListener('change', save);
  dateEl.addEventListener('change', save);
  notesEl.addEventListener('blur', save);
}

function closeModal(id){
  document.getElementById(id).classList.remove('open');
}
function closeAllModals(){
  document.querySelectorAll('.modal-backdrop.open').forEach(m => m.classList.remove('open'));
  document.querySelectorAll('.popup-backdrop').forEach(m => m.remove());
}

// ---------- misc small helpers ----------
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
// Non-blocking, self-dismissing feedback for backup/restore events -- unlike
// alert(), it never freezes the page waiting for a tap.
let toastTimer = null;
function showToast(message, tone){
  let el = document.getElementById('toast');
  if(!el){ el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
  el.textContent = message;
  el.className = 'toast show' + (tone==='bad' ? ' toast-bad' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.classList.remove('show'); }, 3200);
}
// Generic centered popup, reused for the install prompt, the restore-detected
// prompt, and platform install/uninstall step lists -- same visual language as
// the app's existing bottom-sheet modals rather than a position-anchored
// tooltip (a tooltip pinned to the top-right install pill would run off-screen).
function openPopup(title, bodyHtml){
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop popup-backdrop open center';
  wrap.innerHTML = `
    <div class="modal">
      <button class="close-x" data-popup-close>✕</button>
      <h2>${title}</h2>
      <div style="font-size:13.5px;color:#c6d8d0;line-height:1.5">${bodyHtml}</div>
    </div>`;
  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.querySelector('[data-popup-close]').addEventListener('click', close);
  wrap.addEventListener('click', (e) => { if(e.target === wrap) close(); });
  return wrap;
}

// ---------- diagnostics (storage-persistence denials, etc.) ----------
// There's no way to test real storage-eviction behavior on someone else's
// actual phone from here, so a denial gets logged (not just swallowed) --
// visible in Settings later if data loss is ever reported.
const DIAG_LOG_KEY = 'localwork_diag_log';
function loadDiagLog(){
  try{ return JSON.parse(localStorage.getItem(DIAG_LOG_KEY)) || []; }catch(e){ return []; }
}
function logDiag(message){
  const log = loadDiagLog();
  log.unshift({ ts: Date.now(), message });
  try{ localStorage.setItem(DIAG_LOG_KEY, JSON.stringify(log.slice(0,5))); }catch(e){}
}
function diagLogHtml(){
  const log = loadDiagLog();
  if(!log.length) return '';
  return `<div class="section-label">Diagnostics</div>
    <div class="track-box" style="font-size:11.5px;color:var(--muted);line-height:1.5">
      ${log.map(e => `<div style="margin-bottom:6px">${new Date(e.ts).toLocaleString()} — ${escapeHtml(e.message)}</div>`).join('')}
    </div>`;
}

/* =========================================================
   BACKUP / RESTORE
   Manual-only, never automatic -- gated entirely behind explicit taps in
   Settings, so it never piles up files from background activity. Only
   TRACK (saved/eliminated/applied/tracking status, keyed by job id) is
   backed up -- job listings themselves are a static snapshot re-fetched
   from data/jobs.json and don't need protecting.
   ========================================================= */
const BACKUP_HANDLE_DB = 'localworkBackupHandles';
const BACKUP_HANDLE_STORE = 'handles';
const BACKUP_HANDLE_KEY = 'backupFile';
function openHandleDb(){
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(BACKUP_HANDLE_DB, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(BACKUP_HANDLE_STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function loadSavedBackupHandle(){
  try{
    const db = await openHandleDb();
    return await new Promise((resolve, reject) => {
      const req = db.transaction(BACKUP_HANDLE_STORE, 'readonly').objectStore(BACKUP_HANDLE_STORE).get(BACKUP_HANDLE_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }catch(e){ return null; }
}
async function saveBackupHandle(handle){
  try{
    const db = await openHandleDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(BACKUP_HANDLE_STORE, 'readwrite');
      tx.objectStore(BACKUP_HANDLE_STORE).put(handle, BACKUP_HANDLE_KEY);
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
  }catch(e){ /* best-effort */ }
}
// Desktop Chrome/Edge only (feature-detected) -- lets repeat backups overwrite
// the same on-disk file instead of prompting every time. A saved, already-
// granted handle is reused silently; only the very first backup (or a revoked
// permission) pops the picker.
async function getWritableBackupHandle(){
  if(!window.showSaveFilePicker) return null;
  try{
    let handle = await loadSavedBackupHandle();
    if(handle){
      const perm = await handle.queryPermission({ mode:'readwrite' });
      if(perm === 'granted') return handle;
      const req = await handle.requestPermission({ mode:'readwrite' });
      if(req === 'granted') return handle;
      return null;
    }
    handle = await window.showSaveFilePicker({
      suggestedName: 'localwork-data.json',
      types: [{ description:'LocalWork backup', accept: {'application/json':['.json']} }]
    });
    await saveBackupHandle(handle);
    return handle;
  }catch(e){
    return null; // user cancelled the picker, or any other failure -- caller falls back
  }
}
// TRACK has no auto-churning bookkeeping fields (unlike e.g. a background
// sync's lastSyncAt), so the whole object is fair game for the fingerprint.
function backupFingerprint(){
  return JSON.stringify(TRACK);
}
const BACKUP_LAST_FINGERPRINT_KEY = 'localwork_last_backup_fingerprint';
function buildBackupPayload(){
  return { app:'LocalWork', schemaVersion:1, exportedAt: new Date().toISOString(), track: TRACK };
}
// Manual/on-demand only -- never called from saveTrack() or on backgrounding.
// Skips writing/downloading anything when nothing has changed since the last
// backup: on browsers without the File System Access API (iOS Safari, most
// Android Chrome) every tap would otherwise create a brand-new timestamped
// file whether or not the data actually changed. Returns whether it actually
// wrote a backup so the caller's toast can say "saved" vs "already up to date"
// instead of always claiming success.
async function runBackup(){
  const fp = backupFingerprint();
  if(fp === localStorage.getItem(BACKUP_LAST_FINGERPRINT_KEY)) return false;
  const json = JSON.stringify(buildBackupPayload(), null, 2);

  const handle = await getWritableBackupHandle();
  if(handle){
    try{
      const writable = await handle.createWritable();
      await writable.write(json);
      await writable.close();
      localStorage.setItem(BACKUP_LAST_FINGERPRINT_KEY, fp);
      return true;
    }catch(e){ /* fall through to the timestamped-download fallback below */ }
  }
  try{
    const blob = new Blob([json], { type:'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    // Timestamped, not fixed -- a fixed name hits a hard "file already exists"
    // failure on-device rather than silently renaming, on the browsers that
    // land here (no File System Access API, or no granted handle yet).
    const stamp = new Date().toISOString().replace(/[:.]/g,'-');
    a.download = `localwork-data-${stamp}.json`;
    a.click();
    localStorage.setItem(BACKUP_LAST_FINGERPRINT_KEY, fp);
    return true;
  }catch(e){ return false; }
}
async function handleBackupNowClick(){
  try{
    const wrote = await runBackup();
    showToast(wrote ? 'Backup saved.' : 'Already up to date — no changes since last backup.');
  }catch(e){
    showToast('Backup failed: ' + e.message, 'bad');
  }
}

function validateBackupShape(parsed){
  return !!(parsed && typeof parsed === 'object' && parsed.track && typeof parsed.track === 'object');
}
// Shared by the manual Restore button and the startup auto-detect prompt --
// validates, confirms, then merges onto an empty default (TRACK's own default
// shape is just {}, and each job's tracker is read with sensible per-field
// defaults via getTrack() anyway) rather than a raw replace, so a backup from
// an older schema version doesn't leave anything half-applied.
async function importBackupFromFile(file, opts){
  opts = opts || {};
  if(!file) return false;
  try{
    const text = await file.text();
    const parsed = JSON.parse(text);
    if(!validateBackupShape(parsed)) throw new Error('This file does not look like a LocalWork backup.');
    if(!opts.skipConfirm && !confirm('This will replace all current saved/eliminated/applied status on this device with the contents of this backup. Continue?')) return false;
    TRACK = Object.assign({}, parsed.track);
    saveTrack();
    closeAllModals();
    activeTab = 'matches';
    render();
    showToast('Backup restored.');
    return true;
  }catch(e){
    showToast('Could not restore that file: ' + e.message, 'bad');
    return false;
  }
}
// Auto-selects the newest file out of whatever got picked, so restoring never
// requires eyeballing filenames -- matches this app's own timestamped naming
// (localwork-data-<ISO stamp>.json) first since the stamp sorts correctly as a
// string; anything else (e.g. a renamed file) falls back to File.lastModified.
function pickLatestBackupFile(files){
  const list = Array.from(files || []).filter(f => /\.(json|js)$/i.test(f.name));
  if(!list.length) return null;
  const stampOf = f => { const m = f.name.match(/localwork-data-(.+)\.(?:json|js)$/i); return m ? m[1] : null; };
  list.sort((a,b) => {
    const sa = stampOf(a), sb = stampOf(b);
    if(sa && sb) return sa < sb ? 1 : sa > sb ? -1 : 0;
    if(sa && !sb) return -1;
    if(sb && !sa) return 1;
    return b.lastModified - a.lastModified;
  });
  return list[0];
}
function importLatestBackupFromFiles(files){
  const latest = pickLatestBackupFile(files);
  if(!latest){ if(files && files.length) showToast('No .json backup file found in what you selected.', 'bad'); return; }
  importBackupFromFile(latest);
}
async function openRestorePicker(){
  if(window.showOpenFilePicker){
    try{
      const handles = await window.showOpenFilePicker({
        multiple: true, startIn: 'downloads',
        types: [{ description:'LocalWork backup', accept: {
          'application/json':['.json'], 'text/javascript':['.js'], 'application/javascript':['.js']
        }}]
      });
      const files = await Promise.all(handles.map(h => h.getFile()));
      importLatestBackupFromFiles(files);
      return;
    }catch(e){
      if(e.name === 'AbortError') return; // user backed out -- don't chain into a second picker
    }
  }
  els.restoreFileInput.click();
}

/* =========================================================
   RESTORE PROMPT AT STARTUP (Step 7a) -- only meaningful on browsers with the
   File System Access API, since only a saved+already-granted handle can be
   silently re-read without a user gesture. Only fires when TRACK looks
   freshly wiped (fresh profile, "Erase All Data", silent storage eviction)
   AND permission on a previously-saved handle is already 'granted' --
   queryPermission only, never requestPermission this early (no user gesture
   yet, and forcing that would throw a blocking native prompt on every load).
   ========================================================= */
async function maybeOfferStartupRestore(){
  if(!window.showSaveFilePicker) return false;
  if(Object.keys(TRACK).length) return false; // real data present -- never prompt
  const handle = await loadSavedBackupHandle();
  if(!handle) return false;
  try{
    const perm = await handle.queryPermission({ mode:'read' });
    if(perm !== 'granted') return false;
    const file = await handle.getFile();
    const text = await file.text();
    const parsed = JSON.parse(text);
    if(!validateBackupShape(parsed)) return false;
    const count = Object.keys(parsed.track).length;
    if(!count) return false;
    return await new Promise(resolve => {
      const dateStr = parsed.exportedAt ? new Date(parsed.exportedAt).toLocaleDateString() : 'an earlier session';
      const wrap = openPopup('Load latest backup?', `
        <div style="margin-bottom:14px">Found ${count} saved job status${count===1?'':'es'} from a backup saved on ${dateStr}, but this device's data looks empty right now. Load it?</div>
        <button class="btn btn-primary" id="restore-prompt-yes" style="width:100%;display:block;margin-bottom:8px">Yes, load it</button>
        <button class="btn btn-ghost" id="restore-prompt-no" style="width:100%;display:block">No</button>
      `);
      wrap.querySelector('#restore-prompt-yes').addEventListener('click', async () => {
        wrap.remove();
        await importBackupFromFile(file, { skipConfirm:true });
        resolve(true);
      });
      wrap.querySelector('#restore-prompt-no').addEventListener('click', () => { wrap.remove(); resolve(true); });
    });
  }catch(e){ return false; }
}

/* =========================================================
   INSTALL / HOME SCREEN
   ========================================================= */
function isStandaloneApp(){
  return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
}
const INSTALL_ACCEPTED_KEY = 'localworkInstallAccepted';
function isInstalled(){
  return isStandaloneApp() || localStorage.getItem(INSTALL_ACCEPTED_KEY) === '1';
}
const STEPS_LIST_STYLE = 'margin:4px 0 0;padding-left:18px;';
const INSTALL_STEPS_HTML = `
  <strong>iPhone/iPad (Safari):</strong>
  <ol style="${STEPS_LIST_STYLE}">
    <li>Tap the Share icon (square with an arrow) in the toolbar.</li>
    <li>Scroll down and tap "Add to Home Screen".</li>
    <li>Tap "Add" in the top right.</li>
  </ol><br>
  <strong>Android (Chrome):</strong>
  <ol style="${STEPS_LIST_STYLE}">
    <li>Tap the ⋮ menu in the top right.</li>
    <li>Tap "Add to Home screen" or "Install app".</li>
    <li>Tap "Install" (or "Add") to confirm.</li>
  </ol><br>
  <strong>Desktop Chrome/Edge:</strong>
  <ol style="${STEPS_LIST_STYLE}">
    <li>Click the install icon at the right edge of the address bar (or the ⋮ menu → "Install LocalWork...").</li>
    <li>Click "Install" to confirm.</li>
  </ol>`;
const UNINSTALL_STEPS_HTML = `
  <strong>iPhone/iPad:</strong>
  <ol style="${STEPS_LIST_STYLE}">
    <li>Touch and hold the LocalWork icon on the Home Screen.</li>
    <li>Tap "Remove App".</li>
    <li>Tap "Delete App" to confirm.</li>
  </ol><br>
  <strong>Android:</strong>
  <ol style="${STEPS_LIST_STYLE}">
    <li>Touch and hold the LocalWork icon on the Home screen.</li>
    <li>Tap "Uninstall" (or drag it to "Uninstall" at the top of the screen).</li>
    <li>Confirm when prompted.</li>
  </ol><br>
  <strong>Desktop Chrome/Edge:</strong>
  <ol style="${STEPS_LIST_STYLE}">
    <li>Right-click the LocalWork icon (Start Menu/Taskbar/Dock).</li>
    <li>Click "Uninstall".</li>
    <li>Confirm when prompted.</li>
  </ol>`;
let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  renderInstallUI();
});
window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  localStorage.setItem(INSTALL_ACCEPTED_KEY, '1');
  renderInstallUI();
});
// Shared by the topbar pill's tap and the proactive install-prompt popup's
// "Install" button -- one native-vs-manual branch, not two.
async function triggerInstall(){
  if(deferredInstallPrompt){
    const promptEvent = deferredInstallPrompt;
    deferredInstallPrompt = null; // one-shot -- the browser invalidates it after a single use either way
    promptEvent.prompt();
    const choice = await promptEvent.userChoice;
    if(choice.outcome === 'accepted'){
      localStorage.setItem(INSTALL_ACCEPTED_KEY, '1');
      showToast('Installed — look for it on your Home Screen.');
    }
    renderInstallUI();
  } else {
    openPopup('Install on Home Screen', INSTALL_STEPS_HTML);
  }
}
// Shown top-right on the header (present on every tab -- the header is
// persistent chrome shared by Matches/Saved/Tracking/Not a Fit) plus, with
// keepAfterInstall=true, inside Settings as an inert "Installed" status line
// once installed rather than disappearing there too.
function installTopbarBtnHtml(keepAfterInstall){
  const installed = isInstalled();
  if(installed && !keepAfterInstall) return '';
  return `<button class="topbar-install-btn${installed?' installed':''}" id="btnInstallPill">${installed?'Installed':'Install'}</button>`;
}
function wireInstallBtn(btn){
  if(!btn) return;
  btn.addEventListener('click', () => {
    if(isInstalled()){ openPopup('Uninstall LocalWork', UNINSTALL_STEPS_HTML); return; }
    triggerInstall();
  });
}
// Persistent chrome (the header) is never rebuilt by render() -- only #tabs/
// #jobList are -- so this replaces the slot's whole innerHTML (a fresh button
// node each call) rather than being called from inside render() itself, which
// keeps this from ever accumulating duplicate listeners on a node that's
// never discarded.
function renderInstallUI(){
  els.installPillSlot.innerHTML = installTopbarBtnHtml(false);
  wireInstallBtn(document.getElementById('btnInstallPill'));
  if(els.settingsModalBackdrop.classList.contains('open')) renderSettingsModal();
}
const INSTALL_PROMPT_ASKED_KEY = 'localworkInstallPromptAsked';
function maybeShowInstallPrompt(){
  if(isInstalled()) return;
  try{ if(localStorage.getItem(INSTALL_PROMPT_ASKED_KEY)) return; }catch(e){}
  if(isInstalled()) return; // could have installed (or been asked elsewhere) since this was scheduled
  try{ localStorage.setItem(INSTALL_PROMPT_ASKED_KEY, '1'); }catch(e){}
  const wrap = openPopup('Install LocalWork?', `
    <div style="margin-bottom:14px">Installing adds LocalWork to your Home Screen and gives it the strongest protection against your browser silently clearing its saved/eliminated/applied job status.</div>
    <button class="btn btn-primary" id="install-prompt-yes" style="width:100%;display:block;margin-bottom:8px">Install</button>
    <button class="btn btn-ghost" id="install-prompt-no" style="width:100%;display:block">Not now</button>
  `);
  wrap.querySelector('#install-prompt-yes').addEventListener('click', () => { wrap.remove(); triggerInstall(); });
  wrap.querySelector('#install-prompt-no').addEventListener('click', () => {
    wrap.remove();
    showToast('No problem — look for the Install button in Settings whenever you\'re ready.');
  });
}
// Restore-detected takes priority over the install ask when both would apply
// on the same fresh load -- resolved first since it's about not losing data.
// The 1.5s delay lets beforeinstallprompt (which can arrive a moment after
// load) populate deferredInstallPrompt first, so "Install" gets the same shot
// at the one-tap native flow the topbar pill has.
window.addEventListener('load', () => {
  setTimeout(async () => {
    await maybeOfferStartupRestore();
    maybeShowInstallPrompt();
  }, 1500);
});

/* =========================================================
   SETTINGS MODAL
   ========================================================= */
function settingsModalHtml(){
  return `
    <button class="close-x" data-close="settingsModalBackdrop">✕</button>
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin:2px 0 2px">
      <h2 style="margin:0">Settings</h2>
      ${installTopbarBtnHtml(true)}
    </div>
    <div class="section-label" style="margin-top:16px">About</div>
    <div class="track-box">
      <div style="display:flex;justify-content:space-between;font-size:13px">
        <span style="color:var(--muted)">Version</span><span>${APP_VERSION}</span>
      </div>
    </div>
    <div class="section-label">Backup your job status</div>
    <p style="font-size:12.5px;color:var(--muted);line-height:1.5;margin:0 0 10px">
      Your Saved / Eliminated / Applied &amp; Track status lives only in this browser's storage. Back it up to a file so you can restore it if this device's data is ever lost — job listings themselves aren't included since they're re-fetched from the live snapshot.
    </p>
    <div class="card-actions" style="margin-bottom:14px">
      <button class="btn btn-primary small" id="btnBackupNow">Back up now</button>
      <button class="btn btn-ghost small" id="btnRestoreBackup">Restore from backup</button>
    </div>
    ${diagLogHtml()}
  `;
}
function renderSettingsModal(){
  els.settingsModal.innerHTML = settingsModalHtml();
  els.settingsModal.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => closeModal(b.dataset.close)));
  wireInstallBtn(document.getElementById('btnInstallPill'));
  document.getElementById('btnBackupNow').addEventListener('click', handleBackupNowClick);
  document.getElementById('btnRestoreBackup').addEventListener('click', () => openRestorePicker());
}

/* =========================================================
   UPDATE CHECKING -- two independent signals run together, since a CSS/JS-
   only edit that never touches index.html's own bytes would otherwise go
   undetected by the etag signal alone.
   ========================================================= */
function isUserTyping(){
  const el = document.activeElement;
  if(!el) return false;
  if(el.tagName === 'TEXTAREA') return true;
  if(el.tagName === 'INPUT') return /^(text|search|number|date)$/i.test(el.type || 'text');
  return false;
}
const DEPLOYED_TAG_KEY = 'localworkDeployedTag';
let deployedVersionTag = (function(){ try{ return localStorage.getItem(DEPLOYED_TAG_KEY); }catch(e){ return null; } })();
let swReloadPending = false;
let swReloadTriggered = false;
function reloadForNewServiceWorker(){
  if(swReloadTriggered) return; // controllerchange can fire more than once per page life
  if(isUserTyping()){ swReloadPending = true; return; } // retried from checkForUpdate's next call
  swReloadTriggered = true;
  location.reload();
}
if('serviceWorker' in navigator){
  navigator.serviceWorker.addEventListener('controllerchange', reloadForNewServiceWorker);
}
// Returns a status string so callers wanting feedback (pull-to-refresh) can
// react -- the load/visibilitychange callers below just ignore it.
async function checkForUpdate(){
  if(swReloadPending && !isUserTyping()){ reloadForNewServiceWorker(); return 'reloading'; }
  if('serviceWorker' in navigator && navigator.serviceWorker.getRegistration){
    try{
      const reg = await navigator.serviceWorker.getRegistration();
      if(reg) reg.update().catch(()=>{});
    }catch(e){}
  }
  try{
    const res = await fetch(location.pathname + '?_=' + Date.now(), { cache:'no-store', method:'HEAD' });
    const tag = res.headers.get('etag') || res.headers.get('last-modified');
    if(!tag) return 'unknown';
    if(deployedVersionTag === null){
      deployedVersionTag = tag;
      try{ localStorage.setItem(DEPLOYED_TAG_KEY, tag); }catch(e){}
      return 'up-to-date';
    }
    if(tag === deployedVersionTag) return 'up-to-date';
    if(isUserTyping()) return 'deferred'; // try again next check instead of interrupting active input
    deployedVersionTag = tag;
    try{ localStorage.setItem(DEPLOYED_TAG_KEY, tag); }catch(e){}
    location.reload();
    return 'reloading';
  }catch(e){ return 'offline'; }
}

/* =========================================================
   PULL-TO-REFRESH -- forces checkForUpdate() on demand instead of waiting for
   the next visibilitychange. Only activates from the very top of the page and
   not while a modal/popup is open. All listeners are {passive:true} -- this
   gesture only reads finger position and moves its own indicator, so it never
   needs preventDefault() and normal scrolling is untouched.
   ========================================================= */
(function(){
  const indicator = els.pullRefresh;
  const THRESHOLD = 70;
  let startY = null, dragging = false, ready = false;
  document.addEventListener('touchstart', e => {
    if(window.scrollY === 0 && !document.querySelector('.modal-backdrop.open')){
      startY = e.touches[0].clientY;
      dragging = true; ready = false;
      indicator.classList.remove('hidden');
      indicator.classList.add('dragging');
    }
  }, { passive:true });
  document.addEventListener('touchmove', e => {
    if(!dragging || startY === null) return;
    const dy = e.touches[0].clientY - startY;
    if(dy > 0 && window.scrollY === 0){
      const dist = Math.min(dy, THRESHOLD * 1.6);
      ready = dy > THRESHOLD;
      indicator.style.transform = `translate(-50%, ${dist-60}px)`;
      indicator.classList.toggle('ready', ready);
    }
  }, { passive:true });
  document.addEventListener('touchend', async () => {
    if(!dragging) return;
    dragging = false;
    indicator.classList.remove('dragging');
    if(!ready){
      indicator.classList.remove('ready');
      indicator.style.transform = '';
      indicator.classList.add('hidden');
      startY = null;
      return;
    }
    indicator.classList.remove('ready');
    indicator.classList.add('spinning');
    indicator.style.transform = 'translate(-50%, 10px)';
    const status = await checkForUpdate();
    if(status !== 'reloading'){ // otherwise the page is already navigating away
      indicator.classList.remove('spinning');
      indicator.style.transform = '';
      indicator.classList.add('hidden');
    }
    startY = null;
  }, { passive:true });
})();

/* =========================================================
   STORAGE PERSISTENCE -- best-effort ask not to auto-evict this site's
   storage under low-disk pressure. Chrome auto-grants/denies based on its own
   heuristics with no user-visible prompt; a denial is logged (with a rough
   usage/quota estimate) since there's no way to test real eviction behavior
   remotely.
   ========================================================= */
(async function checkStoragePersistence(){
  if(!(navigator.storage && navigator.storage.persist)) return;
  try{
    let persisted = await (navigator.storage.persisted ? navigator.storage.persisted() : Promise.resolve(false));
    if(!persisted) persisted = await navigator.storage.persist();
    if(!persisted){
      let detail = '';
      try{
        const est = await navigator.storage.estimate();
        if(est && est.quota) detail = ` (using ~${Math.round((est.usage||0)/1048576)}MB of ~${Math.round(est.quota/1048576)}MB available to this browser)`;
      }catch(e){}
      logDiag(`Storage is NOT persisted${detail} — this browser may silently evict LocalWork's saved job status under storage pressure, even without clearing history. Install to Home Screen for the strongest protection.`);
    }
  }catch(e){ /* best effort */ }
})();

/* =========================================================
   BACK-GESTURE NAVIGATION (Step 9b) -- one pushState per tab switch so
   hardware back / Android gesture-nav / iOS edge-swipe (all of which already
   fire native 'popstate') walk one tab backward at a time instead of exiting
   straight past the app. Modals layer on top without their own history entry
   -- popstate closes any that are open as part of moving to the target tab.
   ========================================================= */
function goToTab(tab){
  if(tab === activeTab && !document.querySelector('.modal-backdrop.open')) return;
  activeTab = tab;
  history.pushState({ tab }, '');
  closeAllModals();
  render();
}
window.addEventListener('popstate', e => {
  activeTab = (e.state && e.state.tab) || 'matches';
  closeAllModals();
  render();
});
history.replaceState({ tab: activeTab }, ''); // baseline entry so the first tab switch has something to push atop

// ---------- global wiring ----------
els.strongOnly.addEventListener('change', () => { strongOnly = els.strongOnly.checked; render(); });
els.showLocal.addEventListener('change', () => { showLocal = els.showLocal.checked; render(); });
els.showRemote.addEventListener('change', () => { showRemote = els.showRemote.checked; render(); });
els.btnInfo.addEventListener('click', () => els.infoModalBackdrop.classList.add('open'));
els.btnSettings.addEventListener('click', () => { renderSettingsModal(); els.settingsModalBackdrop.classList.add('open'); });
els.restoreFileInput.addEventListener('change', (e) => { importLatestBackupFromFiles(e.target.files); e.target.value = ''; });
document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => closeModal(b.dataset.close)));
els.jobModalBackdrop.addEventListener('click', (e) => { if(e.target === els.jobModalBackdrop) closeModal('jobModalBackdrop'); });
els.infoModalBackdrop.addEventListener('click', (e) => { if(e.target === els.infoModalBackdrop) closeModal('infoModalBackdrop'); });
els.settingsModalBackdrop.addEventListener('click', (e) => { if(e.target === els.settingsModalBackdrop) closeModal('settingsModalBackdrop'); });
renderInstallUI();

// ---------- service worker ----------
if('serviceWorker' in navigator){
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').then(() => {
      checkForUpdate();
      document.addEventListener('visibilitychange', () => { if(document.visibilityState==='visible') checkForUpdate(); });
    }).catch(()=>{});
  });
} else {
  checkForUpdate();
  document.addEventListener('visibilitychange', () => { if(document.visibilityState==='visible') checkForUpdate(); });
}

loadData();
