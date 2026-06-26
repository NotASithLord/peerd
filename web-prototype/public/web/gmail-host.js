// web/gmail-host.js — a fake email web app for the peerd-lite mock browser.
//
// Why this exists: the web surface deliberately CAN'T drive your real tabs &
// sessions (that's the extension's job — the funnel boundary). But a fake site
// that WE render is fair game, so it lets peerd-lite finally demo the headline
// thing — an agent operating a real-looking web app — safely, no real account.
//
// mountMail(el) renders the inbox and returns an AGENT API. The agent's tools
// (wired in index.html) call this API; every call animates the UI so a watcher
// SEES the agent read a message, open it, type a reply, send it — the same
// read-the-DOM / click / type loop the extension runs on real tabs, here over a
// clean in-page interface instead of a DOM bridge. Same-origin panel (matches
// the notebook/peers tabs); the iframe+DOM-walk version is a later refinement.

const INBOX = [
  { id: 'm1', from: 'Sarah Chen', addr: 'sarah@northwind.co', subject: 'Re: Q3 roadmap review — can we move to Thu?',
    time: '9:14 AM', unread: true, star: false, label: 'work',
    body: `Hey — something came up Wednesday afternoon. Could we push the roadmap review to Thursday at 3pm instead? Same room. Let me know if that works for you and I'll send an updated invite.\n\nThanks,\nSarah` },
  { id: 'm2', from: 'Vercel', addr: 'no-reply@vercel.com', subject: 'Your deployment is live ✓',
    time: '8:02 AM', unread: true, star: false, label: 'updates',
    body: `peerd-lite (production) deployed successfully.\n\nCommit: feat(lite): mock browser\nBuild time: 41s\nURL: peerd-lite.pages.dev\n\nView the deployment in your dashboard.` },
  { id: 'm3', from: 'Marcus Webb', addr: 'marcus@acme-supply.com', subject: 'Invoice #4471 — due Friday',
    time: 'Yesterday', unread: true, star: true, label: 'work',
    body: `Hi,\n\nAttached is invoice #4471 for the March order — $2,480, net-30, due this Friday. Let me know if you need a PO number on it.\n\nBest,\nMarcus` },
  { id: 'm4', from: 'GitHub', addr: 'notifications@github.com', subject: '[NotASithLord/peerd] PR #6 ready for review',
    time: 'Yesterday', unread: false, star: false, label: 'updates',
    body: `jonybur opened pull request #6: "built by an AI, played together, no server".\n\n+417 −0 · 6 files\n\nReview the changes on GitHub.` },
  { id: 'm5', from: 'Mom', addr: 'lindap@gmail.com', subject: 'dinner sunday?',
    time: 'Tue', unread: false, star: false, label: '',
    body: `are you coming to dinner this sunday? bring nothing, just yourself. love you xx` },
];

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const initials = (name) => name.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase();
const hue = (s) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CSS = `
.gm{position:absolute;inset:0;display:grid;grid-template-columns:200px 1fr;grid-template-rows:52px 1fr;background:#fff;color:#202124;font-family:'Inter',Roboto,Arial,sans-serif;font-size:13.5px;border-radius:0 0 12px 12px;overflow:hidden}
.gm-top{grid-column:1/3;display:flex;align-items:center;gap:14px;padding:0 16px;border-bottom:1px solid #e8eaed;background:#fff}
.gm-logo{display:flex;align-items:center;gap:8px;font-size:20px;color:#5f6368;font-weight:500}
.gm-logo b{color:#c5221f}.gm-logo .b1{color:#4285f4}.gm-logo .b2{color:#ea4335}.gm-logo .b3{color:#fbbc04}.gm-logo .b4{color:#34a853}
.gm-search{flex:1;max-width:560px;background:#eaf1fb;border-radius:8px;padding:9px 14px;color:#5f6368;font-size:13px}
.gm-acct{width:30px;height:30px;border-radius:50%;background:#1a73e8;color:#fff;display:grid;place-items:center;font-weight:600;font-size:13px}
.gm-side{border-right:1px solid #f1f3f4;padding:10px 8px;overflow:auto}
.gm-compose{display:flex;align-items:center;gap:10px;background:#c2e7ff;color:#001d35;border-radius:16px;padding:11px 18px;font-weight:600;font-size:13px;margin:0 0 14px;cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,.1)}
.gm-fold{display:flex;align-items:center;gap:14px;padding:7px 14px;border-radius:0 16px 16px 0;color:#202124;cursor:pointer;font-size:13.5px}
.gm-fold.on{background:#d3e3fd;font-weight:700;color:#001d35}
.gm-fold .ct{margin-left:auto;font-size:11.5px;font-weight:700}
.gm-list{overflow:auto;background:#fff}
.gm-row{display:flex;align-items:center;gap:12px;padding:10px 16px;border-bottom:1px solid #f1f3f4;cursor:pointer;position:relative}
.gm-row:hover{box-shadow:inset 0 0 0 9999px rgba(0,0,0,.012);z-index:1}
.gm-row.unread{background:#fff;font-weight:700}.gm-row.unread .gm-snip{color:#202124}
.gm-row:not(.unread){background:#f6f8fc;color:#5f6368}
.gm-av{width:34px;height:34px;border-radius:50%;display:grid;place-items:center;color:#fff;font-size:13px;font-weight:600;flex:none}
.gm-star{color:#dadce0;font-size:16px;flex:none}.gm-star.on{color:#f4b400}
.gm-from{width:150px;flex:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gm-mid{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gm-subj{}.gm-snip{font-weight:400;color:#5f6368}
.gm-time{flex:none;font-size:12px;color:#5f6368;font-weight:600}
.gm-row.reading{box-shadow:inset 3px 0 0 #1a73e8, 0 1px 8px rgba(26,115,232,.25);background:#fff;z-index:2}
.gm-read{position:absolute;top:52px;left:200px;right:0;bottom:0;background:#fff;display:none;flex-direction:column;overflow:auto;z-index:3}
.gm-read.show{display:flex}
.gm-rhead{padding:14px 24px;border-bottom:1px solid #f1f3f4;display:flex;align-items:center;gap:12px}
.gm-back{cursor:pointer;color:#5f6368;font-size:18px}
.gm-rsubj{font-size:20px;font-weight:400}
.gm-rmeta{padding:6px 24px 0;color:#5f6368;font-size:12.5px;display:flex;align-items:center;gap:10px}
.gm-rbody{padding:16px 24px;white-space:pre-wrap;line-height:1.6;font-size:14px;flex:1}
.gm-reply{margin:0 24px 20px;border:1px solid #dadce0;border-radius:12px;padding:12px 14px;box-shadow:0 1px 4px rgba(0,0,0,.08)}
.gm-reply .to{color:#5f6368;font-size:12.5px;margin-bottom:8px}
.gm-reply textarea{width:100%;border:none;outline:none;resize:none;font:inherit;font-size:14px;min-height:64px;color:#202124}
.gm-reply .send{margin-top:8px;background:#1a73e8;color:#fff;border:none;border-radius:18px;padding:8px 22px;font-weight:600;cursor:pointer;font-size:13px}
.gm-agent{position:absolute;left:0;right:0;bottom:0;background:linear-gradient(90deg,#00B7EB,#D946EF);color:#fff;font-size:12.5px;font-weight:600;padding:8px 16px;display:flex;align-items:center;gap:8px;transform:translateY(100%);transition:transform .25s;z-index:5;font-family:'JetBrains Mono',monospace}
.gm-agent.show{transform:none}
.gm-agent .dot{width:7px;height:7px;border-radius:50%;background:#fff;animation:gmp 1s infinite}
@keyframes gmp{50%{opacity:.3}}
.gm-toast{position:absolute;left:50%;bottom:54px;transform:translateX(-50%);background:#202124;color:#fff;padding:10px 18px;border-radius:8px;font-size:13px;opacity:0;transition:opacity .25s;z-index:6;box-shadow:0 4px 14px rgba(0,0,0,.3)}
.gm-toast.show{opacity:1}
`;

/**
 * @param {HTMLElement} el  the tab panel to render into
 * @param {(s: string) => void} [onAgent]  narration sink (also drives the in-app banner)
 */
export function mountMail(el, onAgent) {
  if (!document.getElementById('gm-css')) {
    const st = document.createElement('style'); st.id = 'gm-css'; st.textContent = CSS; document.head.appendChild(st);
  }
  const mail = INBOX.map((m) => ({ ...m }));
  el.style.position = 'relative';
  el.innerHTML = `<div class="gm">
    <div class="gm-top">
      <div class="gm-logo"><span class="b1">M</span><span class="b2">a</span><span class="b3">i</span><span class="b4">l</span></div>
      <div class="gm-search">Search mail</div>
      <div class="gm-acct">J</div>
    </div>
    <div class="gm-side">
      <div class="gm-compose">✎ Compose</div>
      <div class="gm-fold on">📥 Inbox <span class="ct" id="gm-unread"></span></div>
      <div class="gm-fold">⭐ Starred</div>
      <div class="gm-fold">➤ Sent</div>
      <div class="gm-fold">🗎 Drafts</div>
    </div>
    <div class="gm-list" id="gm-list"></div>
    <div class="gm-read" id="gm-read"></div>
    <div class="gm-agent" id="gm-agent"><span class="dot"></span><span id="gm-agent-txt"></span></div>
    <div class="gm-toast" id="gm-toast"></div>
  </div>`;

  const list = el.querySelector('#gm-list');
  const readPane = el.querySelector('#gm-read');
  const banner = el.querySelector('#gm-agent');
  const bannerTxt = el.querySelector('#gm-agent-txt');
  const toast = el.querySelector('#gm-toast');
  const unreadCt = el.querySelector('#gm-unread');

  const renderList = () => {
    unreadCt.textContent = mail.filter((m) => m.unread).length || '';
    list.innerHTML = mail.map((m) => `
      <div class="gm-row ${m.unread ? 'unread' : ''}" data-id="${m.id}">
        <span class="gm-star ${m.star ? 'on' : ''}">${m.star ? '★' : '☆'}</span>
        <div class="gm-av" style="background:hsl(${hue(m.from)} 55% 50%)">${initials(m.from)}</div>
        <span class="gm-from">${esc(m.from)}</span>
        <span class="gm-mid"><span class="gm-subj">${esc(m.subject)}</span> <span class="gm-snip">— ${esc(m.body.split('\n')[0].slice(0, 60))}</span></span>
        <span class="gm-time">${esc(m.time)}</span>
      </div>`).join('');
  };
  renderList();

  const rowEl = (id) => list.querySelector(`.gm-row[data-id="${id}"]`);
  const flagAgent = (txt) => { if (txt) { bannerTxt.textContent = txt; banner.classList.add('show'); } else banner.classList.remove('show'); onAgent && txt && onAgent(txt); };
  const showToast = async (txt) => { toast.textContent = txt; toast.classList.add('show'); await sleep(1600); toast.classList.remove('show'); };

  const openEmail = (id) => {
    const m = mail.find((x) => x.id === id); if (!m) return;
    m.unread = false; renderList();
    list.querySelectorAll('.gm-row').forEach((r) => r.classList.remove('reading'));
    rowEl(id)?.classList.add('reading');
    readPane.innerHTML = `
      <div class="gm-rhead"><span class="gm-back" id="gm-back">←</span><span class="gm-rsubj">${esc(m.subject)}</span></div>
      <div class="gm-rmeta"><div class="gm-av" style="width:28px;height:28px;background:hsl(${hue(m.from)} 55% 50%)">${initials(m.from)}</div><b>${esc(m.from)}</b> &lt;${esc(m.addr)}&gt; · ${esc(m.time)}</div>
      <div class="gm-rbody">${esc(m.body)}</div>
      <div class="gm-reply"><div class="to">Reply to ${esc(m.from)}</div><textarea id="gm-reply-text" placeholder="Write a reply…"></textarea><button class="send" id="gm-send">Send</button></div>`;
    readPane.classList.add('show');
    readPane.querySelector('#gm-back').onclick = () => { readPane.classList.remove('show'); rowEl(id)?.classList.remove('reading'); };
    readPane.querySelector('#gm-send').onclick = async () => { await doSend(m); };
    return m;
  };

  const doSend = async (m) => {
    const ta = readPane.querySelector('#gm-reply-text');
    if (!ta || !ta.value.trim()) return;
    const sendBtn = readPane.querySelector('#gm-send');
    if (sendBtn) { sendBtn.textContent = 'Sent ✓'; sendBtn.style.background = '#188038'; sendBtn.disabled = true; }
    // keep the thread open so the reply + confirmation stay on screen (the demo's payoff)
    await showToast(`Sent to ${m.from.split(' ')[0]} ✓`);
  };

  list.addEventListener('click', (e) => { const row = e.target.closest('.gm-row'); if (row) openEmail(row.dataset.id); });

  // type text into the reply box, char-by-char, so the agent is seen "typing"
  const typeReply = async (text) => {
    const ta = readPane.querySelector('#gm-reply-text'); if (!ta) return;
    ta.focus(); ta.value = '';
    for (let i = 0; i < text.length; i++) { ta.value += text[i]; ta.scrollTop = ta.scrollHeight; await sleep(14); }
  };

  // ---- the AGENT API (what the agent's tools call) ------------------------
  return {
    /** list the inbox (id, from, subject, unread) — the agent's "get" */
    list: () => mail.map((m) => ({ id: m.id, from: m.from, subject: m.subject, unread: m.unread, time: m.time })),
    /** read one message: scroll to it, open it, return the body */
    open: async (id) => {
      flagAgent(`agent · reading "${(mail.find((m) => m.id === id)?.subject || '').slice(0, 40)}"`);
      rowEl(id)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      await sleep(450); const m = openEmail(id); await sleep(550); flagAgent('');
      return m ? { from: m.from, subject: m.subject, body: m.body } : null;
    },
    /** reply to a message: open it, type the draft, send — all visible */
    reply: async (id, text) => {
      flagAgent('agent · drafting a reply');
      const m = openEmail(id); if (!m) return 'no such message';
      await sleep(400); await typeReply(text); await sleep(350);
      await doSend(m); flagAgent('');
      return `replied to ${m.from}`;
    },
    /** flag/narrate (for summaries the agent reports back in chat) */
    flag: flagAgent,
    raw: mail,
  };
}
