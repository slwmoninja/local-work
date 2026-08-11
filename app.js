const APP_VERSION = '1.0.0';
const STORE_KEY = 'localwork_v1';

let RESUME = null;
let JOBS = [];        // raw jobs from data/jobs.json, scored + id'd
let TRACK = loadTrack();
let activeTab = 'matches';
let strongOnly = false;

const els = {
  tabs: document.getElementById('tabs'),
  jobList: document.getElementById('jobList'),
  emptyState: document.getElementById('emptyState'),
  strongOnly: document.getElementById('strongOnly'),
  jobModalBackdrop: document.getElementById('jobModalBackdrop'),
  jobModal: document.getElementById('jobModal'),
  infoModalBackdrop: document.getElementById('infoModalBackdrop'),
  btnInfo: document.getElementById('btnInfo'),
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

function scoreJob(job, resume){
  if(job.ai && Array.isArray(job.ai.requirements) && job.ai.requirements.length){
    return scoreJobAi(job, resume);
  }
  return scoreJobLocal(job, resume);
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
  if(job._score.eliminated) return 'notfit';
  if(t.status === 'saved') return 'saved';
  return 'matches';
}

function jobsForTab(tab){
  let list = JOBS.filter(j => classify(j) === tab);
  if(tab === 'matches' || tab === 'saved'){
    if(strongOnly) list = list.filter(j => j._score.score >= 60);
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
    btn.addEventListener('click', () => { activeTab = btn.dataset.tab; render(); });
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
  const drive = (job.estDriveMinutesFrom23185 != null) ? `${job.estDriveMinutesFrom23185} min drive` : null;
  const metaBits = [job.location || job.employerLocation, drive, job.salary || null, job.postedDate ? `Posted ${job.postedDate}` : null].filter(Boolean);
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
  const scoreSourceLabel = s.source === 'ai'
    ? 'Scored by Claude reading the full posting'
    : 'Scored by on-device keyword match (no Claude read-through yet for this posting)';
  els.jobModal.innerHTML = `
    <button class="close-x" data-close="jobModalBackdrop">✕</button>
    <div class="score-badge ${scoreClass(s.score)}" style="float:right;margin-top:2px">${s.score}<span class="lbl">MATCH</span></div>
    <h2>${job.title}</h2>
    <div class="card-employer">${job.employer} — ${job.location || job.employerLocation || ''}</div>
    ${job.estDriveMinutesFrom23185!=null ? `<div style="font-size:12px;color:var(--muted);margin-top:4px">${job.estDriveMinutesFrom23185} min drive from 23185${job.salary?` · ${job.salary}`:''}</div>`:''}
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

// ---------- global wiring ----------
els.strongOnly.addEventListener('change', () => { strongOnly = els.strongOnly.checked; render(); });
els.btnInfo.addEventListener('click', () => els.infoModalBackdrop.classList.add('open'));
document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => closeModal(b.dataset.close)));
els.jobModalBackdrop.addEventListener('click', (e) => { if(e.target === els.jobModalBackdrop) closeModal('jobModalBackdrop'); });
els.infoModalBackdrop.addEventListener('click', (e) => { if(e.target === els.infoModalBackdrop) closeModal('infoModalBackdrop'); });

// ---------- service worker ----------
if('serviceWorker' in navigator){
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').then(reg => {
      reg.update();
      document.addEventListener('visibilitychange', () => { if(document.visibilityState==='visible') reg.update(); });
    }).catch(()=>{});
  });
}

loadData();
