/**
 * ActiveEdu — Student AI Agent v1.0
 * ===================================
 * Nhúng vào index.html bằng: <script src="ai-agent.js"></script>
 *
 * Sau khi bài học load xong, gọi:
 *   AiAgent.setArticle({ title, content, nocoId, path })
 *
 * Agent sẽ tự:
 *   - Hiển thị floating button góc phải màn hình
 *   - Theo dõi & cập nhật learner profile (localStorage)
 *   - Cá nhân hóa bài tập theo năng lực
 *   - Gamification: XP, streak, level, huy hiệu
 *   - Chatbot AI Tutor dùng Anthropic API
 */

;(function(window) {
  'use strict';

  // ─── Config ─────────────────────────────────────────────────────────────────
  const API_URL    = 'https://api.anthropic.com/v1/messages';
  const AI_MODEL   = 'claude-sonnet-4-20250514';
  const STORE_KEY  = 'ae_learner_v2';
  const EVENT_KEY  = 'ae_events_v1';

  // XP per action
  const XP = { readArticle: 10, completeQuiz: 20, perfectQuiz: 50, chatQuestion: 2, dailyStreak: 30 };
  const LEVELS = [
    { min: 0,    name: 'Người mới bắt đầu', icon: '🌱' },
    { min: 100,  name: 'Học sinh tích cực',  icon: '⚡' },
    { min: 300,  name: 'Người học chăm chỉ', icon: '🔥' },
    { min: 600,  name: 'Nhà nghiên cứu nhỏ', icon: '🔬' },
    { min: 1000, name: 'Học giả xuất sắc',   icon: '🏆' },
  ];
  const BADGES = [
    { id: 'first_read',    label: 'Bước đầu tiên',   cond: p => p.articlesRead >= 1 },
    { id: 'streak_3',      label: 'Chuỗi 3 ngày',     cond: p => p.streak >= 3 },
    { id: 'streak_7',      label: 'Chuỗi 7 ngày',     cond: p => p.streak >= 7 },
    { id: 'perfect_quiz',  label: 'Hoàn hảo 100%',    cond: p => p.perfectQuizzes >= 1 },
    { id: 'curious',       label: 'Tò mò ham học',    cond: p => p.chatCount >= 10 },
    { id: 'scholar',       label: 'Nhà học giả',      cond: p => p.xp >= 1000 },
  ];

  // ─── State ──────────────────────────────────────────────────────────────────
  let _article = { title: '', content: '', nocoId: '', path: '' };
  let _panelOpen = false;
  let _activeTab = 'tutor';
  let _chatHistory = [];
  let _quizData = [];
  let _quizAnswers = {};
  let _quizCorrect = {};
  let _isGenerating = false;

  // ─── Learner Profile ────────────────────────────────────────────────────────
  function loadProfile() {
    try {
      return JSON.parse(localStorage.getItem(STORE_KEY)) || createProfile();
    } catch { return createProfile(); }
  }

  function createProfile() {
    return {
      xp: 0, streak: 0, lastVisit: null, articlesRead: 0,
      chatCount: 0, perfectQuizzes: 0, quizScores: [],
      weakTopics: [], strongTopics: [], badges: [],
      readArticles: [], totalTime: 0
    };
  }

  function saveProfile(p) {
    localStorage.setItem(STORE_KEY, JSON.stringify(p));
  }

  function getLevel(xp) {
    for (let i = LEVELS.length - 1; i >= 0; i--) {
      if (xp >= LEVELS[i].min) return LEVELS[i];
    }
    return LEVELS[0];
  }

  function getNextLevel(xp) {
    for (let i = 0; i < LEVELS.length; i++) {
      if (xp < LEVELS[i].min) return LEVELS[i];
    }
    return null;
  }

  function updateStreak(p) {
    const today = new Date().toDateString();
    if (p.lastVisit === today) return p;
    const yesterday = new Date(Date.now() - 86400000).toDateString();
    if (p.lastVisit === yesterday) {
      p.streak += 1;
      if (p.streak > 1) awardXP(p, XP.dailyStreak, `Chuỗi ${p.streak} ngày! 🔥`);
    } else if (p.lastVisit !== today) {
      p.streak = 1;
    }
    p.lastVisit = today;
    return p;
  }

  function checkBadges(p) {
    const newBadges = [];
    for (const b of BADGES) {
      if (!p.badges.includes(b.id) && b.cond(p)) {
        p.badges.push(b.id);
        newBadges.push(b.label);
      }
    }
    if (newBadges.length) showToast(`🏅 Huy hiệu mới: ${newBadges.join(', ')}`, 'success');
    return p;
  }

  let _xpAnimTimeout = null;
  function awardXP(p, amount, reason) {
    const prevLevel = getLevel(p.xp);
    p.xp += amount;
    const newLevel = getLevel(p.xp);
    if (newLevel.min > prevLevel.min) {
      showToast(`🎉 Lên cấp: ${newLevel.icon} ${newLevel.name}!`, 'success');
    } else {
      showToast(`+${amount} XP — ${reason}`, 'xp');
    }
    updateXPBar(p);
    return p;
  }

  // ─── Event logging ──────────────────────────────────────────────────────────
  function logEvent(type, data) {
    try {
      const events = JSON.parse(localStorage.getItem(EVENT_KEY) || '[]');
      events.push({ type, data, ts: Date.now(), nocoId: _article.nocoId });
      // Giữ tối đa 500 events
      if (events.length > 500) events.splice(0, events.length - 500);
      localStorage.setItem(EVENT_KEY, JSON.stringify(events));
    } catch {}
  }

  // ─── CSS Injection ──────────────────────────────────────────────────────────
  function injectCSS() {
    if (document.getElementById('ae-agent-css')) return;
    const s = document.createElement('style');
    s.id = 'ae-agent-css';
    s.textContent = `
#ae-fab{position:fixed;bottom:24px;right:24px;z-index:9000;display:flex;flex-direction:column;align-items:flex-end;gap:10px}
#ae-fab-btn{width:54px;height:54px;border-radius:50%;background:#1a3a5c;color:#fff;border:none;cursor:pointer;font-size:22px;box-shadow:0 4px 20px rgba(26,58,92,.35);transition:transform .2s;display:flex;align-items:center;justify-content:center;position:relative}
#ae-fab-btn:hover{transform:scale(1.08)}
#ae-fab-xp{position:absolute;top:-4px;right:-4px;background:#e8a020;color:#412402;font-size:10px;font-weight:700;padding:2px 6px;border-radius:10px;white-space:nowrap}
#ae-panel{position:fixed;bottom:90px;right:24px;width:390px;max-height:min(600px,calc(100vh - 110px));background:var(--card-bg,#fff);border:1px solid var(--border,rgba(0,0,0,.1));border-radius:18px;box-shadow:0 8px 40px rgba(0,0,0,.15);z-index:8999;display:none;flex-direction:column;overflow:hidden;font-family:'Be Vietnam Pro',sans-serif}
#ae-panel.open{display:flex}
@media(max-width:480px){#ae-panel{width:calc(100vw - 20px);right:10px;bottom:80px}}
.ae-head{background:#1a3a5c;color:#fff;padding:14px 16px;display:flex;align-items:center;gap:10px;flex-shrink:0}
.ae-head-ico{width:32px;height:32px;background:rgba(232,160,32,.25);border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:16px}
.ae-head-info{flex:1;min-width:0}
.ae-head-title{font-size:14px;font-weight:600;color:#fff}
.ae-head-sub{font-size:11px;color:rgba(255,255,255,.5);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ae-level-bar{height:3px;background:rgba(255,255,255,.15);border-radius:2px;margin-top:6px;overflow:hidden}
.ae-level-fill{height:100%;background:#e8a020;border-radius:2px;transition:width .6s}
.ae-close{width:28px;height:28px;background:rgba(255,255,255,.1);border:none;border-radius:50%;color:#fff;cursor:pointer;font-size:16px;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.ae-close:hover{background:rgba(255,255,255,.2)}
.ae-tabs{display:flex;border-bottom:1px solid var(--border,rgba(0,0,0,.08));background:var(--bg,#f8f7f3);flex-shrink:0}
.ae-tab{flex:1;padding:9px 4px;border:none;background:transparent;font-size:11px;color:#666;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:4px;border-bottom:2px solid transparent;transition:all .15s;font-family:inherit}
.ae-tab:hover{color:#1a3a5c}
.ae-tab.on{color:#1a3a5c;border-bottom-color:#1a3a5c;background:#fff;font-weight:600}
.ae-body{flex:1;overflow:hidden;display:flex;flex-direction:column}
.ae-pane{display:none;flex:1;flex-direction:column;overflow:hidden}
.ae-pane.on{display:flex}

/* ── Tutor chat ── */
.ae-chat{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px}
.ae-msg{display:flex;gap:8px;align-items:flex-start;animation:aeFadeUp .2s ease}
@keyframes aeFadeUp{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:translateY(0)}}
.ae-msg.user{flex-direction:row-reverse}
.ae-avatar{width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;flex-shrink:0}
.ae-avatar.ai{background:#e1f5ee;color:#085041}
.ae-avatar.user{background:#eeedfe;color:#3c3489}
.ae-bubble{max-width:80%;padding:8px 12px;border-radius:12px;font-size:13px;line-height:1.6}
.ae-msg.ai .ae-bubble{background:var(--bg,#f5f3ee);border:1px solid var(--border,rgba(0,0,0,.08));border-top-left-radius:3px}
.ae-msg.user .ae-bubble{background:#1a3a5c;color:#fff;border-top-right-radius:3px}
.ae-typing{display:flex;gap:4px;padding:4px}
.ae-dot{width:6px;height:6px;background:#aaa;border-radius:50%;animation:aeBounce 1.2s infinite}
.ae-dot:nth-child(2){animation-delay:.2s}
.ae-dot:nth-child(3){animation-delay:.4s}
@keyframes aeBounce{0%,60%,100%{transform:translateY(0);opacity:.5}30%{transform:translateY(-5px);opacity:1}}
.ae-quick{padding:8px 14px 0;display:flex;gap:6px;flex-wrap:wrap;flex-shrink:0}
.ae-qbtn{padding:4px 10px;border-radius:20px;border:1px solid var(--border,rgba(0,0,0,.1));background:var(--bg,#f5f3ee);font-size:11px;color:#555;cursor:pointer;transition:all .15s;font-family:inherit}
.ae-qbtn:hover{border-color:#1a3a5c;color:#1a3a5c}
.ae-input-row{padding:10px 14px;border-top:1px solid var(--border,rgba(0,0,0,.08));display:flex;gap:8px;align-items:flex-end;background:var(--card-bg,#fff);flex-shrink:0}
.ae-input-row textarea{flex:1;resize:none;padding:7px 10px;font-size:13px;border-radius:8px;min-height:34px;max-height:90px;font-family:inherit;background:var(--bg,#f5f3ee);border:1px solid var(--border,rgba(0,0,0,.08));color:var(--text,#1c1c1c);line-height:1.5}
.ae-input-row textarea:focus{outline:none;border-color:#1a3a5c}
.ae-send{width:34px;height:34px;border-radius:8px;background:#1a3a5c;color:#fff;border:none;cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:opacity .15s}
.ae-send:hover{opacity:.85}
.ae-send:disabled{opacity:.4;cursor:default}

/* ── Quiz ── */
.ae-quiz-body{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:12px}
.ae-quiz-cfg{display:flex;gap:8px;flex-wrap:wrap}
.ae-quiz-cfg select{padding:6px 10px;font-size:12px;border-radius:8px;background:var(--bg,#f5f3ee);border:1px solid var(--border,rgba(0,0,0,.1));color:var(--text,#1c1c1c);font-family:inherit}
.ae-gen-btn{padding:6px 14px;background:#1D9E75;color:#fff;border:none;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;transition:opacity .15s}
.ae-gen-btn:hover{opacity:.85}
.ae-gen-btn:disabled{opacity:.5;cursor:default}
.ae-qcard{border:1px solid var(--border,rgba(0,0,0,.1));border-radius:12px;background:var(--card-bg,#fff);overflow:hidden;margin-bottom:4px}
.ae-qcard-hd{padding:10px 13px;font-size:13px;font-weight:600;color:var(--text,#1c1c1c);border-bottom:1px solid var(--border,rgba(0,0,0,.06));line-height:1.5}
.ae-qnum{font-size:11px;color:#888;margin-bottom:2px;font-weight:400}
.ae-opts{padding:8px 13px;display:flex;flex-direction:column;gap:5px}
.ae-opt{padding:7px 11px;border:1px solid var(--border,rgba(0,0,0,.1));border-radius:8px;font-size:12px;cursor:pointer;display:flex;align-items:center;gap:8px;transition:all .15s;background:var(--bg,#f8f7f3);color:var(--text,#1c1c1c);font-family:inherit;text-align:left;width:100%}
.ae-opt:hover{border-color:#1a3a5c}
.ae-opt.correct{border-color:#0F6E56;background:#e1f5ee;color:#04342C}
.ae-opt.wrong{border-color:#993C1D;background:#faece7;color:#4A1B0C}
.ae-opt-ltr{width:20px;height:20px;border-radius:50%;background:var(--card-bg,#fff);border:1px solid var(--border,rgba(0,0,0,.1));display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;flex-shrink:0}
.ae-score-card{padding:18px;background:var(--bg,#f5f3ee);border:1px solid var(--border,rgba(0,0,0,.08));border-radius:12px;text-align:center}
.ae-score-num{font-size:36px;font-weight:700;color:#1a3a5c}
.ae-score-sub{font-size:13px;color:#888;margin-top:4px}
.ae-score-msg{font-size:13px;color:var(--text,#1c1c1c);margin-top:10px;line-height:1.6}

/* ── Profile ── */
.ae-profile-body{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:12px}
.ae-stat-row{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px}
.ae-stat{background:var(--bg,#f5f3ee);border-radius:10px;padding:10px;text-align:center}
.ae-stat-val{font-size:22px;font-weight:700;color:#1a3a5c}
.ae-stat-lbl{font-size:11px;color:#888;margin-top:2px}
.ae-badges{display:flex;flex-wrap:wrap;gap:6px}
.ae-badge{background:#eeedfe;color:#3c3489;border-radius:20px;padding:4px 10px;font-size:11px;font-weight:600}
.ae-badge.locked{background:var(--bg,#f5f3ee);color:#aaa}
.ae-section-title{font-size:12px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:.5px}
.ae-rec-card{border:1px solid var(--border,rgba(0,0,0,.1));border-radius:10px;padding:12px;background:var(--card-bg,#fff)}
.ae-rec-label{font-size:11px;color:#1D9E75;font-weight:700;margin-bottom:4px}
.ae-rec-text{font-size:13px;color:var(--text,#1c1c1c);line-height:1.5}

/* ── Toast ── */
#ae-toast-wrap{position:fixed;top:20px;right:20px;z-index:10000;display:flex;flex-direction:column;gap:6px;pointer-events:none}
.ae-toast{padding:10px 16px;border-radius:10px;font-size:13px;font-family:'Be Vietnam Pro',sans-serif;animation:aeToastIn .3s ease;max-width:300px}
.ae-toast.xp{background:#e8a020;color:#412402;font-weight:600}
.ae-toast.success{background:#1D9E75;color:#04342C;font-weight:600}
.ae-toast.info{background:#1a3a5c;color:#fff}
@keyframes aeToastIn{from{opacity:0;transform:translateX(20px)}to{opacity:1;transform:translateX(0)}}
@keyframes aeToastOut{to{opacity:0;transform:translateX(20px)}}
`;
    document.head.appendChild(s);
  }

  // ─── DOM ────────────────────────────────────────────────────────────────────
  function buildDOM() {
    // Toast wrapper
    const tw = document.createElement('div');
    tw.id = 'ae-toast-wrap';
    document.body.appendChild(tw);

    // FAB
    const fab = document.createElement('div');
    fab.id = 'ae-fab';
    fab.innerHTML = `
      <div id="ae-fab-btn" title="AI Learning Assistant">
        <span>✦</span>
        <span id="ae-fab-xp"></span>
      </div>`;
    document.body.appendChild(fab);
    document.getElementById('ae-fab-btn').addEventListener('click', togglePanel);

    // Panel
    const panel = document.createElement('div');
    panel.id = 'ae-panel';
    panel.innerHTML = `
      <div class="ae-head">
        <div class="ae-head-ico">✦</div>
        <div class="ae-head-info">
          <div class="ae-head-title">AI Learning Agent</div>
          <div class="ae-head-sub" id="ae-article-title">Chưa có bài học</div>
          <div class="ae-level-bar"><div class="ae-level-fill" id="ae-lvl-fill" style="width:0%"></div></div>
        </div>
        <button class="ae-close" id="ae-close-btn">✕</button>
      </div>
      <div class="ae-tabs">
        <button class="ae-tab on" data-tab="tutor">🤖 Gia sư AI</button>
        <button class="ae-tab" data-tab="quiz">🧠 Luyện tập</button>
        <button class="ae-tab" data-tab="profile">🏅 Hồ sơ</button>
      </div>
      <div class="ae-body">

        <!-- TUTOR TAB -->
        <div class="ae-pane on" id="ae-pane-tutor">
          <div class="ae-quick" id="ae-quick"></div>
          <div class="ae-chat" id="ae-chat"></div>
          <div class="ae-input-row">
            <textarea id="ae-input" placeholder="Hỏi gì về bài học này..." rows="1"></textarea>
            <button class="ae-send" id="ae-send">➤</button>
          </div>
        </div>

        <!-- QUIZ TAB -->
        <div class="ae-pane" id="ae-pane-quiz">
          <div class="ae-quiz-body" id="ae-quiz-body">
            <div class="ae-quiz-cfg">
              <select id="ae-quiz-n"><option value="3">3 câu</option><option value="5" selected>5 câu</option><option value="8">8 câu</option></select>
              <select id="ae-quiz-lvl"><option value="easy">Cơ bản</option><option value="medium" selected>Trung bình</option><option value="hard">Nâng cao</option></select>
              <button class="ae-gen-btn" id="ae-quiz-gen">✦ Tạo bài tập</button>
            </div>
            <div id="ae-quiz-content">
              <div style="text-align:center;padding:32px 0;color:#aaa;font-size:13px">
                Nhấn <strong>Tạo bài tập</strong> để AI tạo câu hỏi phù hợp với năng lực của bạn
              </div>
            </div>
          </div>
        </div>

        <!-- PROFILE TAB -->
        <div class="ae-pane" id="ae-pane-profile">
          <div class="ae-profile-body" id="ae-profile-body">
            <div style="text-align:center;padding:20px;color:#aaa;font-size:13px">Đang tải...</div>
          </div>
        </div>

      </div>
    `;
    document.body.appendChild(panel);

    // Event bindings
    document.getElementById('ae-close-btn').addEventListener('click', closePanel);
    document.querySelectorAll('.ae-tab').forEach(btn => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });
    document.getElementById('ae-send').addEventListener('click', sendMessage);
    document.getElementById('ae-input').addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });
    document.getElementById('ae-input').addEventListener('input', function() {
      this.style.height = 'auto';
      this.style.height = Math.min(this.scrollHeight, 90) + 'px';
    });
    document.getElementById('ae-quiz-gen').addEventListener('click', generateQuiz);
  }

  // ─── Panel ──────────────────────────────────────────────────────────────────
  function togglePanel() { _panelOpen ? closePanel() : openPanel(); }

  function openPanel() {
    _panelOpen = true;
    document.getElementById('ae-panel').classList.add('open');
    if (_activeTab === 'profile') renderProfile();
    if (document.getElementById('ae-chat').childElementCount === 0) initChat();
    updateXPBar(loadProfile());
  }

  function closePanel() {
    _panelOpen = false;
    document.getElementById('ae-panel').classList.remove('open');
  }

  function switchTab(tab) {
    _activeTab = tab;
    document.querySelectorAll('.ae-tab').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
    document.querySelectorAll('.ae-pane').forEach(p => p.classList.toggle('on', p.id === `ae-pane-${tab}`));
    if (tab === 'profile') renderProfile();
  }

  function updateXPBar(p) {
    const lvl = getLevel(p.xp);
    const next = getNextLevel(p.xp);
    const pct = next ? Math.round((p.xp - lvl.min) / (next.min - lvl.min) * 100) : 100;
    const fill = document.getElementById('ae-lvl-fill');
    if (fill) fill.style.width = pct + '%';
    const xpBadge = document.getElementById('ae-fab-xp');
    if (xpBadge) xpBadge.textContent = `${p.xp} XP`;
    const sub = document.getElementById('ae-article-title');
    if (sub) sub.textContent = _article.title || 'Chưa có bài học';
  }

  // ─── Toast ──────────────────────────────────────────────────────────────────
  function showToast(msg, type = 'info') {
    const wrap = document.getElementById('ae-toast-wrap');
    if (!wrap) return;
    const t = document.createElement('div');
    t.className = `ae-toast ${type}`;
    t.textContent = msg;
    wrap.appendChild(t);
    setTimeout(() => {
      t.style.animation = 'aeToastOut .3s ease forwards';
      setTimeout(() => t.remove(), 300);
    }, 3000);
  }

  // ─── Chat / Tutor ───────────────────────────────────────────────────────────
  function initChat() {
    const chat = document.getElementById('ae-chat');
    chat.innerHTML = '';
    const profile = loadProfile();
    const lvl = getLevel(profile.xp);

    const greeting = profile.xp === 0
      ? 'Xin chào! Tôi là Gia sư AI của ActiveEdu. Tôi sẽ giúp bạn hiểu sâu bài học và luyện tập hiệu quả. Hãy bắt đầu bằng cách đặt câu hỏi!'
      : `Chào lại ${lvl.icon}! Bạn đang ở level "${lvl.name}" với ${profile.xp} XP. Hôm nay muốn học gì?`;

    addBubble('ai', greeting);
    renderQuickPrompts();
  }

  function renderQuickPrompts() {
    const profile = loadProfile();
    const prompts = profile.weakTopics.length
      ? [`Giải thích về "${profile.weakTopics[0]}"`, 'Tóm tắt bài này', 'Cho ví dụ thực tế', 'Liên kết kiến thức']
      : ['Giải thích khái niệm chính', 'Tóm tắt 3 ý chính', 'Cho ví dụ thực tế', 'Câu hỏi luyện tập'];

    const wrap = document.getElementById('ae-quick');
    wrap.innerHTML = prompts.map(p => `<button class="ae-qbtn" data-prompt="${p}">${p}</button>`).join('');
    wrap.querySelectorAll('.ae-qbtn').forEach(b => {
      b.addEventListener('click', () => {
        document.getElementById('ae-input').value = b.dataset.prompt;
        sendMessage();
      });
    });
  }

  function addBubble(role, html, isTyping = false) {
    const chat = document.getElementById('ae-chat');
    const div = document.createElement('div');
    div.className = `ae-msg ${role}`;
    const avatar = role === 'ai' ? '✦' : '👤';
    div.innerHTML = isTyping
      ? `<div class="ae-avatar ai">${avatar}</div><div class="ae-bubble"><div class="ae-typing"><div class="ae-dot"></div><div class="ae-dot"></div><div class="ae-dot"></div></div></div>`
      : `<div class="ae-avatar ${role}">${avatar}</div><div class="ae-bubble">${html}</div>`;
    div.id = isTyping ? 'ae-typing' : '';
    chat.appendChild(div);
    chat.scrollTop = chat.scrollHeight;
    return div;
  }

  function mdLight(text) {
    return text
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/`(.*?)`/g, '<code style="background:rgba(0,0,0,.06);padding:1px 4px;border-radius:3px">$1</code>')
      .replace(/\n/g, '<br>');
  }

  function buildSystemPrompt(profile) {
    const lvl = getLevel(profile.xp);
    const contentSnippet = (_article.content || '').slice(0, 2000);
    return `Bạn là Gia sư AI thông minh trong ActiveEdu — hệ thống học tập thích ứng của Việt Nam.

THÔNG TIN HỌC SINH:
- Cấp độ: ${lvl.name} (${profile.xp} XP)
- Chuỗi học: ${profile.streak} ngày
- Bài đã đọc: ${profile.articlesRead}
- Điểm yếu: ${profile.weakTopics.join(', ') || 'Chưa xác định'}
- Điểm mạnh: ${profile.strongTopics.join(', ') || 'Chưa xác định'}

BÀI HỌC HIỆN TẠI: "${_article.title}"
NỘI DUNG:
---
${contentSnippet}
---

HƯỚNG DẪN:
- Điều chỉnh ngôn ngữ phù hợp cấp độ học sinh (cấp thấp: đơn giản, nhiều ví dụ; cấp cao: sâu hơn, kết nối lý thuyết)
- Trả lời bằng tiếng Việt, ngắn gọn, sinh động, khuyến khích
- Thêm ví dụ thực tế khi giải thích khái niệm
- Kết thúc bằng câu hỏi kích thích tư duy nếu phù hợp
- Tối đa 200 từ mỗi câu trả lời`;
  }

  async function sendMessage() {
    const input = document.getElementById('ae-input');
    const text = input.value.trim();
    if (!text || _isGenerating) return;

    input.value = '';
    input.style.height = 'auto';
    document.getElementById('ae-send').disabled = true;
    _isGenerating = true;

    addBubble('user', mdLight(text));
    addBubble('ai', '', true);

    const profile = loadProfile();

    try {
      _chatHistory.push({ role: 'user', content: text });
      const messages = _chatHistory.slice(-10); // context window: 10 turns

      const resp = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: AI_MODEL,
          max_tokens: 1000,
          system: buildSystemPrompt(profile),
          messages
        })
      });

      const data = await resp.json();
      const answer = data.content?.[0]?.text || 'Xin lỗi, không thể xử lý. Thử lại nhé!';
      _chatHistory.push({ role: 'assistant', content: answer });

      const typing = document.getElementById('ae-typing');
      if (typing) {
        typing.querySelector('.ae-bubble').innerHTML = mdLight(answer);
        typing.removeAttribute('id');
      }

      // Award XP
      profile.chatCount = (profile.chatCount || 0) + 1;
      logEvent('chat', { question: text.slice(0, 100) });
      const updated = awardXP(profile, XP.chatQuestion, 'câu hỏi hay!');
      saveProfile(checkBadges(updated));

    } catch (e) {
      const typing = document.getElementById('ae-typing');
      if (typing) {
        typing.querySelector('.ae-bubble').textContent = 'Lỗi kết nối. Kiểm tra mạng và thử lại.';
        typing.removeAttribute('id');
      }
    }

    document.getElementById('ae-send').disabled = false;
    _isGenerating = false;
  }

  // ─── Adaptive Quiz ──────────────────────────────────────────────────────────
  async function generateQuiz() {
    const profile = loadProfile();
    const btn = document.getElementById('ae-quiz-gen');
    const content = document.getElementById('ae-quiz-content');
    const n = document.getElementById('ae-quiz-n').value;
    const lvlSel = document.getElementById('ae-quiz-lvl').value;

    // Adaptive: tự điều chỉnh độ khó theo lịch sử
    const avgScore = profile.quizScores.length
      ? profile.quizScores.slice(-5).reduce((a, b) => a + b, 0) / Math.min(5, profile.quizScores.length)
      : 0.5;
    const adaptedLevel = lvlSel === 'medium'
      ? (avgScore > 0.8 ? 'hard' : avgScore < 0.4 ? 'easy' : 'medium')
      : lvlSel;

    const levelMap = { easy: 'dễ (nhận biết, tái hiện)', medium: 'trung bình (hiểu, vận dụng)', hard: 'khó (phân tích, tổng hợp, đánh giá)' };

    btn.disabled = true;
    btn.textContent = 'Đang tạo...';
    _quizData = [];
    _quizAnswers = {};
    _quizCorrect = {};

    content.innerHTML = `<div style="text-align:center;padding:32px 0;color:#aaa;font-size:13px">AI đang tạo ${n} câu hỏi mức <strong>${levelMap[adaptedLevel]}</strong>...</div>`;

    try {
      const contentSnippet = (_article.content || '').slice(0, 3000);
      const resp = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: AI_MODEL,
          max_tokens: 1000,
          system: `Tạo ${n} câu hỏi trắc nghiệm 4 đáp án về bài: "${_article.title}". 
Mức độ: ${levelMap[adaptedLevel]}.
Nội dung:
---
${contentSnippet}
---
Trả về JSON duy nhất không có text khác:
{"questions":[{"q":"câu hỏi","opts":["A. ...","B. ...","C. ...","D. ..."],"correct":0,"explain":"giải thích ngắn"}]}
correct = index 0-3 của đáp án đúng.`,
          messages: [{ role: 'user', content: 'Tạo quiz' }]
        })
      });

      const raw = await resp.json();
      const text = (raw.content?.[0]?.text || '{}').replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(text);
      _quizData = parsed.questions || [];

      if (!_quizData.length) throw new Error('No questions');

      _quizData.forEach((q, i) => { _quizCorrect[i] = q.correct; });
      renderQuizCards();
      logEvent('quiz_start', { n, level: adaptedLevel });

    } catch (e) {
      content.innerHTML = `<div style="text-align:center;padding:24px;color:#c00;font-size:13px">Không thể tạo câu hỏi. Vui lòng thử lại.</div>`;
    }

    btn.disabled = false;
    btn.textContent = '✦ Tạo bài tập';
  }

  function renderQuizCards() {
    const content = document.getElementById('ae-quiz-content');
    content.innerHTML = _quizData.map((q, qi) => `
      <div class="ae-qcard" id="ae-qcard-${qi}">
        <div class="ae-qcard-hd">
          <div class="ae-qnum">Câu ${qi + 1} / ${_quizData.length}</div>
          ${q.q}
        </div>
        <div class="ae-opts">
          ${q.opts.map((opt, oi) => `
            <button class="ae-opt" id="ae-opt-${qi}-${oi}" data-qi="${qi}" data-oi="${oi}">
              <div class="ae-opt-ltr">${['A','B','C','D'][oi]}</div>
              <span>${opt.replace(/^[A-D]\.\s*/,'')}</span>
            </button>`).join('')}
        </div>
        <div id="ae-explain-${qi}" style="display:none;padding:8px 13px 10px;font-size:12px;color:#555;border-top:1px solid rgba(0,0,0,.06);line-height:1.6"></div>
      </div>`).join('');

    content.querySelectorAll('.ae-opt').forEach(btn => {
      btn.addEventListener('click', () => selectOpt(+btn.dataset.qi, +btn.dataset.oi));
    });
  }

  function selectOpt(qi, oi) {
    if (_quizAnswers[qi] !== undefined) return;
    _quizAnswers[qi] = oi;
    const correct = _quizCorrect[qi];
    const isRight = oi === correct;

    for (let i = 0; i < 4; i++) {
      const el = document.getElementById(`ae-opt-${qi}-${i}`);
      if (!el) continue;
      if (i === correct) el.classList.add('correct');
      else if (i === oi && !isRight) el.classList.add('wrong');
    }

    // Show explanation
    const explain = document.getElementById(`ae-explain-${qi}`);
    if (explain && _quizData[qi]?.explain) {
      explain.style.display = 'block';
      explain.innerHTML = `<strong>${isRight ? '✓ Đúng!' : '✗ Sai.'}</strong> ${_quizData[qi].explain}`;
    }

    if (Object.keys(_quizAnswers).length === _quizData.length) {
      finishQuiz();
    }
  }

  function finishQuiz() {
    const score = Object.entries(_quizAnswers).filter(([qi, oi]) => +oi === _quizCorrect[+qi]).length;
    const total = _quizData.length;
    const pct = score / total;

    const profile = loadProfile();
    profile.quizScores = [...(profile.quizScores || []), pct];
    let updated = awardXP(profile, XP.completeQuiz, 'hoàn thành bài tập!');
    if (pct === 1) {
      updated.perfectQuizzes = (updated.perfectQuizzes || 0) + 1;
      updated = awardXP(updated, XP.perfectQuiz - XP.completeQuiz, 'điểm tuyệt đối! 🎯');
    }
    // Cập nhật weak/strong topics dựa theo điểm
    if (pct < 0.5 && _article.title) {
      if (!updated.weakTopics.includes(_article.title)) {
        updated.weakTopics = [_article.title, ...updated.weakTopics].slice(0, 5);
        updated.strongTopics = updated.strongTopics.filter(t => t !== _article.title);
      }
    } else if (pct >= 0.8 && _article.title) {
      if (!updated.strongTopics.includes(_article.title)) {
        updated.strongTopics = [_article.title, ...updated.strongTopics].slice(0, 5);
        updated.weakTopics = updated.weakTopics.filter(t => t !== _article.title);
      }
    }
    saveProfile(checkBadges(updated));
    logEvent('quiz_done', { score, total, pct });

    const msg = pct === 1 ? '🎯 Xuất sắc! Bạn trả lời đúng tất cả!'
      : pct >= 0.8 ? '🔥 Rất tốt! Bạn nắm chắc bài học.'
      : pct >= 0.5 ? '👍 Tốt rồi! Ôn lại những câu sai nhé.'
      : '💪 Cần ôn thêm. Đọc lại bài và thử lại!';

    const body = document.getElementById('ae-quiz-body');
    const scoreCard = document.createElement('div');
    scoreCard.className = 'ae-score-card';
    scoreCard.innerHTML = `
      <div class="ae-score-num">${score}/${total}</div>
      <div class="ae-score-sub">câu đúng · ${Math.round(pct * 100)}%</div>
      <div class="ae-score-msg">${msg}</div>
      <button class="ae-gen-btn" style="margin-top:12px" id="ae-retry-btn">Tạo bài tập mới</button>`;
    body.insertBefore(scoreCard, document.getElementById('ae-quiz-content'));
    scoreCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    document.getElementById('ae-retry-btn').addEventListener('click', () => {
      scoreCard.remove();
      generateQuiz();
    });
  }

  // ─── Profile ────────────────────────────────────────────────────────────────
  function renderProfile() {
    const p = loadProfile();
    const lvl = getLevel(p.xp);
    const next = getNextLevel(p.xp);
    const pct = next ? Math.round((p.xp - lvl.min) / (next.min - lvl.min) * 100) : 100;
    const avgScore = p.quizScores?.length
      ? Math.round(p.quizScores.slice(-5).reduce((a, b) => a + b, 0) / Math.min(5, p.quizScores.length) * 100)
      : 0;

    const body = document.getElementById('ae-profile-body');
    body.innerHTML = `
      <div style="text-align:center;padding:8px 0 4px">
        <div style="font-size:32px">${lvl.icon}</div>
        <div style="font-size:15px;font-weight:700;color:var(--text,#1c1c1c);margin-top:6px">${lvl.name}</div>
        <div style="font-size:12px;color:#888">${p.xp} XP ${next ? `· còn ${next.min - p.xp} XP lên cấp tiếp` : '· Đỉnh cao!'}</div>
        <div style="background:rgba(0,0,0,.06);border-radius:4px;height:6px;margin:10px 0;overflow:hidden">
          <div style="height:100%;width:${pct}%;background:#e8a020;border-radius:4px;transition:width .6s"></div>
        </div>
      </div>

      <div class="ae-stat-row">
        <div class="ae-stat"><div class="ae-stat-val">${p.streak}</div><div class="ae-stat-lbl">Chuỗi ngày</div></div>
        <div class="ae-stat"><div class="ae-stat-val">${p.articlesRead}</div><div class="ae-stat-lbl">Bài đã đọc</div></div>
        <div class="ae-stat"><div class="ae-stat-val">${avgScore}%</div><div class="ae-stat-lbl">Điểm TB Quiz</div></div>
      </div>

      <div>
        <div class="ae-section-title" style="margin-bottom:8px">Huy hiệu</div>
        <div class="ae-badges">
          ${BADGES.map(b => {
            const earned = p.badges.includes(b.id);
            return `<div class="ae-badge ${earned ? '' : 'locked'}" title="${earned ? 'Đạt được' : 'Chưa đạt'}">${b.label}${earned ? ' ✓' : ' 🔒'}</div>`;
          }).join('')}
        </div>
      </div>

      ${p.weakTopics.length ? `
      <div>
        <div class="ae-section-title" style="margin-bottom:8px">Cần ôn tập</div>
        <div class="ae-rec-card">
          <div class="ae-rec-label">AI gợi ý</div>
          <div class="ae-rec-text">Bạn nên ôn lại: <strong>${p.weakTopics.slice(0,3).join(', ')}</strong></div>
        </div>
      </div>` : ''}

      ${p.strongTopics.length ? `
      <div>
        <div class="ae-section-title" style="margin-bottom:8px">Điểm mạnh</div>
        <div class="ae-badges">
          ${p.strongTopics.slice(0,5).map(t => `<div class="ae-badge">${t}</div>`).join('')}
        </div>
      </div>` : ''}

      <button onclick="if(confirm('Xóa toàn bộ hồ sơ học tập?')){localStorage.removeItem('${STORE_KEY}');localStorage.removeItem('${EVENT_KEY}');window.location.reload()}" style="padding:8px 16px;border:1px solid rgba(200,0,0,.3);border-radius:8px;background:transparent;color:#c00;font-size:12px;cursor:pointer;font-family:inherit;margin-top:4px">Xóa hồ sơ</button>
    `;
  }

  // ─── Public API ─────────────────────────────────────────────────────────────
  const AiAgent = {
    /**
     * Gọi sau khi bài học được load vào DOM.
     * @param {object} opts - { title, content (text thuần), nocoId, path }
     */
    setArticle(opts) {
      _article = { title: '', content: '', nocoId: '', path: '', ...opts };
      _chatHistory = [];
      _quizData = [];
      _quizAnswers = {};

      // Update header
      const sub = document.getElementById('ae-article-title');
      if (sub) sub.textContent = _article.title || 'Bài học';

      // Track article read
      let p = loadProfile();
      p = updateStreak(p);
      if (_article.nocoId && !p.readArticles.includes(_article.nocoId)) {
        p.readArticles.push(_article.nocoId);
        p.articlesRead = p.readArticles.length;
        p = awardXP(p, XP.readArticle, `đọc bài "${_article.title}"`);
      }
      saveProfile(checkBadges(p));
      updateXPBar(p);

      // Reset chat
      if (_panelOpen && _activeTab === 'tutor') initChat();
      logEvent('article_view', { nocoId: _article.nocoId });
    },

    /** Lấy toàn bộ event log để xuất cho Admin */
    getEventLog() {
      try { return JSON.parse(localStorage.getItem(EVENT_KEY) || '[]'); }
      catch { return []; }
    },

    /** Lấy learner profile */
    getProfile() { return loadProfile(); }
  };

  window.AiAgent = AiAgent;

  // ─── Init ───────────────────────────────────────────────────────────────────
  function init() {
    injectCSS();
    buildDOM();
    const p = updateStreak(loadProfile());
    saveProfile(p);
    updateXPBar(p);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})(window);
