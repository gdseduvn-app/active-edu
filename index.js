// ── AUTH STATE ──
// Đăng nhập học sinh lưu vào localStorage (khác với admin sessionStorage)
const USER_KEY = 'ae_user';

// Sanitize text để tránh XSS khi render vào HTML
function esc(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function getUser() {
  try {
    const u = JSON.parse(localStorage.getItem(USER_KEY));
    if (!u) return null;
    if (u.expiresAt && Date.now() > u.expiresAt) { clearUser(); return null; }
    return u;
  } catch { return null; }
}
function setUser(u) {
  u.expiresAt = Date.now() + 8 * 3600 * 1000;
  localStorage.setItem(USER_KEY, JSON.stringify(u));
}
function clearUser() { localStorage.removeItem(USER_KEY); }
function isLoggedIn() { return !!getUser(); }

// Tài khoản được quản lý qua NocoDB - không hardcode
const USERS = [];

// ── Rate limiting đăng nhập học sinh ──
const _STU_MAX_ATTEMPTS = 5;
const _STU_LOCKOUT_MS   = 10 * 60 * 1000; // 10 phút
const _STU_ATTEMPT_KEY  = 'ae_stu_login_attempts';
const _STU_LOCKOUT_KEY  = 'ae_stu_login_lockout';

function _stuGetAttempts() { try { return parseInt(localStorage.getItem(_STU_ATTEMPT_KEY) || '0'); } catch { return 0; } }
function _stuIncAttempts() {
  const n = _stuGetAttempts() + 1;
  localStorage.setItem(_STU_ATTEMPT_KEY, n);
  if (n >= _STU_MAX_ATTEMPTS) localStorage.setItem(_STU_LOCKOUT_KEY, Date.now() + _STU_LOCKOUT_MS);
  return n;
}
function _stuResetAttempts() { localStorage.removeItem(_STU_ATTEMPT_KEY); localStorage.removeItem(_STU_LOCKOUT_KEY); }
function _stuCheckLocked() {
  const until = parseInt(localStorage.getItem(_STU_LOCKOUT_KEY) || '0');
  if (!until) return null;
  const remaining = until - Date.now();
  if (remaining <= 0) { _stuResetAttempts(); return null; }
  return Math.ceil(remaining / 60000);
}

async function doUserLogin() {
  const u = (document.getElementById('lm-user').value || '').trim();
  const p = (document.getElementById('lm-pass').value || '').trim();
  const btn = document.querySelector('.lm-btn');
  const errEl = document.getElementById('lm-err');

  // ── Kiểm tra lockout ──
  const lockedMin = _stuCheckLocked();
  if (lockedMin !== null) {
    errEl.textContent = `🔒 Tạm khóa ${lockedMin} phút do đăng nhập sai quá nhiều lần.`;
    errEl.style.display = 'block';
    return;
  }

  if (btn) btn.disabled = true;

  const showErr = (msg) => {
    errEl.textContent = msg || '❌ Email hoặc mật khẩu không đúng!';
    errEl.style.display = 'block';
    document.getElementById('lm-pass').value = '';
    setTimeout(() => { if (errEl.style.display !== 'none') errEl.style.display = 'none'; }, 4000);
    if (btn) btn.disabled = false;
  };

  // Dùng /api/auth/login — Worker tự hash & verify
  try {
    const resp = await fetch(`${PROXY_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: u, password: p }),
    });
    const data = await resp.json();

    if (resp.ok && data.token) {
      // Đăng nhập thành công → reset counter
      _stuResetAttempts();
      setUser({
        username: data.user.email,
        displayName: data.user.displayName,
        role: data.user.role,
        token: data.token,
      });
      await loadUserPerms();
      closeLoginModal();
      renderUserArea();
      buildNav(contentTree);
      buildCards(contentTree);
      loadUserProgress(); // load progress after login
      if (pendingPrivateItem) { loadArticle(pendingPrivateItem); pendingPrivateItem = null; }
      else if (currentArticleId) {
        // Restart reading timer for article already loaded before login
        const _cur = findItemById(contentTree, currentArticleId);
        if (_cur) _startProgressTracking(_cur);
      }
      if (btn) btn.disabled = false;
      return;
    }

    // Sai mật khẩu → tăng counter
    if (resp.status === 401 || resp.status === 400) {
      const attempts = _stuIncAttempts();
      const remaining = _STU_MAX_ATTEMPTS - attempts;
      if (remaining <= 0) {
        showErr('🔒 Sai mật khẩu quá nhiều lần! Tài khoản bị tạm khóa 10 phút.');
      } else {
        showErr(`❌ Email hoặc mật khẩu không đúng! (còn ${remaining} lần)`);
      }
      return;
    }

  } catch(e) { console.warn('Login error:', e); }

  showErr();
}

function doLogout() {
  clearUser();
  _progressCache = null;
  _stopProgressTracking();
  const trigger = document.getElementById('lt-trigger');
  if (trigger) trigger.style.display = 'none';
  renderUserArea();
  showHome();
}

function renderUserArea() {
  const area = document.getElementById('user-area');
  const user = getUser();

  // Hiện/ẩn nút Quản trị Admin theo role
  const adminLink = document.getElementById('admin-link');
  if (adminLink) {
    adminLink.style.display = (user && user.role === 'admin') ? 'inline-flex' : 'none';
  }

  if (user) {
    const avatarSrc = user.avatar || '';
    const avatarHtml = avatarSrc
      ? `<img src="${avatarSrc}" style="width:28px;height:28px;border-radius:50%;object-fit:cover">`
      : `<div class="user-avatar">${user.displayName.charAt(0).toUpperCase()}</div>`;
    area.innerHTML = `
      <div class="user-badge" onclick="openProfile()" title="Hồ sơ cá nhân" style="position:relative">
        ${avatarHtml}
        <span>${user.displayName}</span>
        <i class="fas fa-chevron-down" style="font-size:10px;opacity:.6"></i>
      </div>`;
  } else {
    area.innerHTML = `<button class="login-btn" onclick="showLoginModal(true)"><i class="fas fa-sign-in-alt"></i> Đăng nhập</button>`;
  }
}

let loginModalCanClose = true;
let pendingPrivateItem = null;
let currentArticlePath = null;
let currentArticleId   = null;

function showLoginModal(canClose) {
  loginModalCanClose = canClose !== false;
  document.getElementById('lm-close').style.display = loginModalCanClose ? 'block' : 'none';
  document.getElementById('lm-err').style.display = 'none';
  document.getElementById('lm-user').value = '';
  document.getElementById('lm-pass').value = '';
  document.getElementById('login-modal').classList.add('show');
  setTimeout(() => document.getElementById('lm-user').focus(), 100);
}

function closeLoginModal() {
  document.getElementById('login-modal').classList.remove('show');
}

// ── CONTENT ──
let contentTree = [];
const COLORS = ['blue','indigo','teal','slate'];
const ICONS  = ['fas fa-book','fas fa-shapes','fas fa-calculator','fas fa-code','fas fa-flask','fas fa-globe'];

// ── Lấy config NocoDB từ localStorage (do admin đã cấu hình)
// ── Proxy-first: học sinh không cần config, token lưu trên Cloudflare Worker ──
const PROXY_URL = 'https://api.gds.edu.vn'; // Cloudflare Worker

// ── srcdoc helper: dùng srcdoc thay vì Blob URL (Blob bị chặn bởi CSP frame-src 'self' trên GitHub Pages) ──
function setBlobSrcdoc(iframe, html) {
  // Revoke blob cũ nếu có
  if (iframe._blobUrl) { URL.revokeObjectURL(iframe._blobUrl); iframe._blobUrl = null; }
  iframe.srcdoc = html;
}

function getNocoCfg() {
  try { return JSON.parse(localStorage.getItem('ae_config') || '{}'); } catch { return {}; }
}

// Map NocoDB table path → proxy route (dùng khi có localStorage config)
function mapToProxyPath(path, c) {
  const tableMap = {
    [c.nocoTable]:       '/api/articles',
    [c.nocoUserTable]:   '/api/users',
    [c.nocoFolderTable]: '/api/folders',
    [c.nocoPermTable]:   '/api/permissions',
  };
  for (const [tableId, route] of Object.entries(tableMap)) {
    if (tableId && path.includes(tableId)) {
      return path.replace(`/tables/${tableId}`, route);
    }
  }
  return path;
}

async function nocoFetch(path, opts = {}) {
  const proxy = PROXY_URL.replace(/\/$/, '');
  const url = `${proxy}${path}`;
  const headers = { 'Content-Type': 'application/json', ...(opts.headers||{}) };
  const r = await fetch(url, { ...opts, headers });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}


async function init() {
  renderUserArea();
  if (!PROXY_URL) {
    showEmptyState();
    return;
  }

  try {
    // Chỉ lấy metadata — Content được load riêng khi học sinh click bài (lazy load)
    const articlesPath = `/api/articles?limit=1000&sort=Folder`;
    const data = await nocoFetch(articlesPath);
    const records = data.list || [];

    // Build tree from NocoDB records
    const folderMap = {};
    const tree = [];

    for (const r of records) {
      const folder = r.Folder || '';
      const item = {
        type: 'file',
        name: r.Title || r.Path,
        path: r.Path,
        folder: folder,
        description: r.Description || '',
        access: r.Access || 'public',
        updated: r.Updated || '',
        nocoId: r.Id,
      };

      if (!folder) {
        tree.push(item);
      } else {
        // Support nested folders via "/" separator
        const parts = folder.split('/');
        let node = tree;
        let currentPath = '';
        for (const part of parts) {
          currentPath = currentPath ? currentPath + '/' + part : part;
          let found = node.find(i => i.type === 'folder' && i.name === part);
          if (!found) {
            found = { type: 'folder', name: part, children: [] };
            node.push(found);
          }
          node = found.children;
        }
        node.push(item);
      }
    }

    contentTree = tree;
    propagateFolderAccess(contentTree);
    await loadUserPerms();
    buildNav(contentTree);
    buildCards(contentTree);
    updateStats();
    // Load reading progress if already logged in (e.g. page refresh)
    if (isLoggedIn()) loadUserProgress();

    // Deep link routing
    const currentPath = window.location.pathname;
    const params      = new URLSearchParams(window.location.search);

    if (currentPath === '/courses') {
      // /courses — hiện danh sách khoá học
      showCoursesView();
    } else if (currentPath.match(/^\/course\/(\d+)/)) {
      // /course/{id} — hiện chi tiết khoá học
      const courseId = currentPath.match(/^\/course\/(\d+)/)[1];
      showCourseDetail(parseInt(courseId));
    } else {
      // /bai/{nocoId} hoặc ?article=... (backward compat)
      const pathMatch = currentPath.match(/\/bai\/([^/]+)/);
      const paramId   = params.get('article') || params.get('bai');
      const rawVal    = pathMatch ? decodeURIComponent(pathMatch[1]) : (paramId ? decodeURIComponent(paramId) : null);
      if (rawVal) {
        const item = /^\d+$/.test(rawVal)
          ? findItemById(contentTree, rawVal)
          : (findItemBySlug(contentTree, rawVal) || findItemById(contentTree, rawVal));
        if (item) loadArticle(item);
      }
    }
  } catch(e) {
    console.error('NocoDB load error:', e);
    showEmptyState();
  }
}

// Cache permissions per session
let _userPerms = null;

async function loadUserPerms() {
  const user = getUser();
  if (!user) { _userPerms = null; return; }
  try {
    const proxy = PROXY_URL.replace(/\/$/, '');
    const userData = await fetch(`${proxy}/api/users?where=(Email,eq,${encodeURIComponent(user.username)})&limit=1`).then(r=>r.json());
    const userRow = (userData.list || [])[0];
    if (!userRow) { _userPerms = null; return; }
    const permData = await fetch(`${proxy}/api/permissions?where=(UserId,eq,${userRow.Id})&limit=1000`).then(r=>r.json());
    _userPerms = permData.list || [];
  } catch(e) {
    console.warn('Permission load error:', e);
    _userPerms = null;
  }
}

function canViewArticle(item) {
  if (!item) return false;
  const user = getUser();
  // Admin sees everything
  if (user?.role === 'admin') return true;

  // Draft chỉ admin xem được
  if (item.access === 'draft') return false;

  const isPrivate = item.access === 'private';
  const folderPrivate = item.folderAccess === 'private'; // set during tree build

  // If both article and folder are public → everyone can view
  if (!isPrivate && !folderPrivate) return true;

  // Private content → must be logged in
  if (!isLoggedIn()) return false;

  // If no permissions table configured → any logged-in user can see private
  if (_userPerms === null) return true;

  // Check permissions
  const path = item.path;
  const folder = item.folder;
  return _userPerms.some(p =>
    p.TargetPath === path ||
    (folder && p.TargetPath === folder) ||
    (folder && folder.startsWith(p.TargetPath + '/'))
  );
}

// Check if a folder is accessible
function canViewFolder(folderItem) {
  const user = getUser();
  if (user?.role === 'admin') return true;
  if (!folderItem.access || folderItem.access === 'public') return true;
  if (!isLoggedIn()) return false;
  if (_userPerms === null) return true;
  const path = folderItem.path || folderItem.name;
  return _userPerms.some(p => p.TargetPath === path || path.startsWith(p.TargetPath + '/'));
}

function buildNav(tree) {
  const el = document.getElementById('nav-menu');
  el.innerHTML = '';
  if (!tree || !tree.length) {
    el.innerHTML = '<div style="padding:20px;text-align:center;color:rgba(255,255,255,.35);font-size:13px">Chưa có bài học nào</div>';
    return;
  }
  renderNavItems(tree, el);
}

function propagateFolderAccess(items, parentAccess = 'public') {
  for (const item of items||[]) {
    if (item.type === 'folder') {
      item.access = item.access || parentAccess;
      propagateFolderAccess(item.children, item.access);
    } else {
      item.folderAccess = parentAccess;
    }
  }
}

function renderNavItems(items, container) {
  items.forEach(item => {
    if (item.type === 'folder') {
      // Hide private folders from non-permitted users
      if (!canViewFolder(item)) return;
      const div = document.createElement('div');
      div.className = 'nav-folder';
      const lockIcon = item.access === 'private' ? ' <i class="fas fa-lock" style="font-size:9px;color:#fca5a5;margin-left:2px"></i>' : '';
      div.innerHTML = `
        <div class="nav-folder-header" onclick="this.parentElement.classList.toggle('open')">
          <i class="fas fa-folder icon" style="color:${item.access==='private'?'#f87171':'#60a5fa'}"></i>
          <span>${item.name}${lockIcon}</span>
          <i class="fas fa-chevron-right arrow"></i>
        </div>
        <div class="nav-folder-children"></div>`;
      renderNavItems(item.children || [], div.querySelector('.nav-folder-children'));
      container.appendChild(div);
    } else {
      const a = document.createElement('a');
      a.className = 'nav-item';
      a.href = item.nocoId ? `/bai/${item.nocoId}` : 'javascript:void(0)';
      a.dataset.path   = item.path;
      a.dataset.nocoid = item.nocoId || '';
      const lockIcon = item.access === 'private' ? '<i class="fas fa-lock lock-icon"></i>' : '';
      a.innerHTML = `<i class="fas fa-file-lines icon" style="color:#94a3b8"></i><span>${item.name}</span>${lockIcon}`;
      a.onclick = (e) => { e.preventDefault(); loadArticle(item); };
      container.appendChild(a);
    }
  });
}

function buildCards(tree) {
  const grid = document.getElementById('home-cards');
  grid.innerHTML = '';

  // Lấy TẤT CẢ bài từ mọi cấp, lọc theo quyền
  const allFiles = flatA(tree).filter(f => canViewArticle(f));

  if (!allFiles.length) {
    const c = getNocoCfg();
    const hasConfig = !!c.nocoToken && !!c.nocoTable;
    grid.innerHTML = hasConfig
      ? `<div class="empty-state" style="grid-column:1/-1"><div class="emoji">📂</div><h3>Chưa có nội dung</h3><p style="color:#94a3b8;font-size:13px;margin-top:8px">Vào Admin để thêm bài học</p></div>`
      : `<div class="empty-state" style="grid-column:1/-1"><div class="emoji">⚙️</div><h3>Chưa cấu hình NocoDB</h3><p style="color:#94a3b8;font-size:13px;margin-top:8px">Vào <a href='admin/' style='color:#2563eb'>Admin</a> → Cài đặt để kết nối</p></div>`;
    return;
  }

  allFiles.forEach((item, idx) => {
    const c = COLORS[idx % COLORS.length];
    const ico = ICONS[idx % ICONS.length];
    const isPrivate = item.access === 'private' || item.folderAccess === 'private';
    const canView = canViewArticle(item);

    const badge = isPrivate
      ? '<span class="access-badge badge-private"><i class="fas fa-lock" style="font-size:9px"></i> Private</span>'
      : '<span class="access-badge badge-public"><i class="fas fa-globe" style="font-size:9px"></i> Public</span>';

    // Breadcrumb thư mục: Toán 9 › Ôn tập giữa HKII
    const breadcrumb = item.folder
      ? `<span class="card-tag">${item.folder.replace(/\//g,' › ')}</span>` : '';

    const card = document.createElement('a');
    card.className = 'content-card';
    card.href = item.nocoId ? `/bai/${item.nocoId}` : 'javascript:void(0)';
    card.dataset.nocoid = item.nocoId || '';
    card.innerHTML = `
      <div class="card-banner ${c}"><i class="${ico}"></i></div>
      <div class="card-body">
        <div class="card-tags">${breadcrumb}${badge}</div>
        <div class="card-title">${esc(item.name)}</div>
        <div class="card-desc">${isPrivate && !canView
          ? '<i class="fas fa-lock" style="color:#94a3b8"></i> Đăng nhập để xem bài học này'
          : esc(item.description || 'Nhấn để xem bài học')}</div>
        <div class="card-footer">
          <span><i class="far fa-calendar-alt"></i> ${esc(item.updated || '')}</span>
          <span class="card-cta">${isPrivate && !canView
            ? 'Đăng nhập <i class="fas fa-arrow-right"></i>'
            : 'Học ngay <i class="fas fa-arrow-right"></i>'}</span>
        </div>
      </div>`;
    card.onclick = (e) => { e.preventDefault(); isPrivate && !canView ? showLoginModal() : loadArticle(item); };
    grid.appendChild(card);
  });
}


// ── Nhận chiều cao từ iframe, điều chỉnh theo orientation ──
window.addEventListener('message', (e) => {
  if (!e.data) return;
  // Hiện thông báo khi copy bị chặn
  if (e.data.type === 'ae-copy-blocked') {
    _showCopyBlockedToast();
    return;
  }
  if (e.data.type !== 'ae-iframe-height') return;
  const iframe = document.getElementById('article-iframe');
  if (!iframe) return;
  const h = Math.max(parseInt(e.data.height) || 0, 200);
  if (h < 200) return;
  // Portrait: scroll tự nhiên → dùng đúng height
  // Landscape: min 85% viewport height
  const isLandscape = window.innerWidth > window.innerHeight;
  const finalH = isLandscape ? Math.max(h, Math.round(window.innerHeight * 0.85)) : h;
  if (Math.abs(finalH - (parseInt(iframe.style.height) || 0)) >= 10) {
    iframe.style.height = finalH + 'px';
  }
});

// Re-measure khi xoay màn hình
window.addEventListener('orientationchange', () => {
  setTimeout(() => {
    const iframe = document.getElementById('article-iframe');
    if (!iframe) return;
    try {
      const iDoc = iframe.contentDocument || iframe.contentWindow?.document;
      if (!iDoc?.body) return;
      const h = Math.max(iDoc.body.scrollHeight, iDoc.documentElement?.scrollHeight || 0);
      const isLandscape = window.innerWidth > window.innerHeight;
      iframe.style.height = Math.max(h, isLandscape ? Math.round(window.innerHeight * 0.85) : 300) + 'px';
    } catch {}
  }, 350);
});

async function loadArticle(item) {
  // Deep link dùng nocoId — ổn định dù đổi tên/di chuyển bài
  currentArticlePath = item.path;
  currentArticleId   = item.nocoId || null;
  history.pushState({ id: item.nocoId }, '', `/bai/${item.nocoId}`);
  document.title = `${item.name} — ActiveEdu`;

  // Kiểm tra quyền truy cập
  if (item.access === 'private' && !isLoggedIn()) {
    document.getElementById('home-view').style.display = 'none';
    document.getElementById('article-view').style.display = 'none';
    document.getElementById('content-area').classList.remove('article-mode');
    document.getElementById('article-gate').style.display = 'block';
    document.getElementById('gate-title').textContent = item.name;
    document.getElementById('gate-tags').innerHTML = item.folder
      ? `<span class="article-hd-tag">${item.folder}</span><span class="article-hd-tag" style="background:#fef2f2;border-color:#fca5a5;color:#b91c1c"><i class="fas fa-lock"></i> Private</span>` : '';
    setBreadcrumb(item.name);
    setActiveNav(item.nocoId);
    pendingPrivateItem = item;
    window.scrollTo(0, 0);
    return;
  }

  // Có quyền → load bình thường
  document.getElementById('home-view').style.display = 'none';
  document.getElementById('article-gate').style.display = 'none';
  document.getElementById('article-view').style.display = 'block';
  document.getElementById('content-area').classList.add('article-mode');

  document.getElementById('article-title').textContent = item.name;
  const accessTag = item.access === 'private'
    ? '<span class="article-hd-tag" style="background:#fef2f2;border-color:#fca5a5;color:#b91c1c"><i class="fas fa-lock"></i> Private</span>'
    : '<span class="article-hd-tag" style="background:#f0fdf4;border-color:#86efac;color:#15803d"><i class="fas fa-globe"></i> Public</span>';
  document.getElementById('article-meta').innerHTML =
    `<i class="fas fa-folder" style="color:var(--primary)"></i> ${esc(item.folder||'Gốc')} &nbsp;•&nbsp; <i class="fas fa-calendar-alt"></i> ${esc(item.updated||'')}`;
  document.getElementById('article-tags').innerHTML =
    (item.folder ? `<span class="article-hd-tag">${esc(item.folder)}</span>` : '') + accessTag;
  setBreadcrumb(item.name);
  setActiveNav(item.nocoId);
  try {
    const iframe = document.getElementById('article-iframe');
    setBlobSrcdoc(iframe, '<div style="padding:40px;text-align:center;color:#64748b"><i class="fas fa-spinner fa-spin"></i> Đang tải...</div>');

    // Fetch bằng nocoId — trực tiếp, không dùng where=(Path,eq,...)
    const proxyBase = (PROXY_URL || 'https://api.gds.edu.vn').replace(/\/$/, '');
    let row = null;
    if (item.nocoId) {
      const resp = await fetch(`${proxyBase}/api/articles/${item.nocoId}`, {
        headers: isLoggedIn() ? { 'Authorization': `Bearer ${getUser()?.token || ''}` } : {}
      });
      if (resp.ok) row = await resp.json();
    }
    if (!row) {
      setBlobSrcdoc(iframe, '<p style="color:#ef4444;padding:40px;text-align:center">Không tìm thấy bài học.</p>');
      return;
    }
    if (row && row.Content) {
      let content = row.Content;
      if (content.startsWith('lz:')) {
        try {
          const decompressed = LZString.decompressFromBase64(content.slice(3));
          if (!decompressed) throw new Error('Kết quả giải nén rỗng');
          content = decompressed;
        } catch(e) {
          // Fallback: nếu phần sau prefix trông giống HTML thì dùng thẳng
          const rawBody = content.slice(3);
          if (rawBody.includes('<') && rawBody.includes('>')) {
            content = rawBody;
            console.warn('[LZ] Decompress failed, using raw body:', e);
          } else {
            content = '<p style="color:#ef4444;padding:40px;text-align:center">⚠️ Lỗi hiển thị bài học. Vui lòng thử lại.</p>';
            console.error('[LZ] Decompress failed, no fallback possible:', e);
          }
        }
      }

      // KaTeX snippet — dùng cdnjs để tránh CSP
      const mathJaxSnippet = [
        '<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.9/katex.min.css">',
        '<script src="https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.9/katex.min.js"><\/script>',
        '<script src="https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.9/contrib/auto-render.min.js"><\/script>',
        '<script>',
        'document.addEventListener("DOMContentLoaded", function() {',
        '  if (typeof renderMathInElement !== "undefined") {',
        '    renderMathInElement(document.body, {',
        '      delimiters: [',
        '        {left:"$$",right:"$$",display:true},',
        '        {left:"\\\\[",right:"\\\\]",display:true},',
        '        {left:"$",right:"$",display:false},',
        '        {left:"\\\\(",right:"\\\\)",display:false}',
        '      ],',
        '      throwOnError: false',
        '    });',
        '  }',
        '});',
        '<\/script>'
      ].join('\n');

      let finalContent;
      const isFullPage = content.trim().toLowerCase().startsWith('<!doctype') || content.trim().toLowerCase().startsWith('<html');

      if (isFullPage) {
        // Full HTML: inject vào </head>, tránh trùng nếu đã có
        if (!content.includes('katex') && !content.includes('MathJax')) {
          finalContent = content.replace('</head>', mathJaxSnippet + '</head>');
        } else {
          finalContent = content;
        }
      } else {
        // Fragment: wrap với đầy đủ head
        finalContent = `<!DOCTYPE html><html><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${mathJaxSnippet}
</head><body style="margin:0;padding:0">${content}</body></html>`;
      }

      // Inject CSS ổn định layout (chống trôi đồ thị khi resize)
      const stabilizeCSS = `<style>
/* Chống trôi đồ thị khi iframe resize */
canvas { display:block !important; }
[style*="position:sticky"], [style*="position: sticky"] { position:relative !important; }
.canvas-wrap, .chart-wrap, .graph-wrap,
[class*="canvas"], [class*="chart"], [class*="graph"],
[class*="interactive"], [class*="edtech"] {
  contain: layout style;
  overflow: hidden;
}
body { overflow-x: hidden; }
img { max-width: 100%; height: auto; }

/* ══ KHOÁ CHỈNH SỬA CSS ══════════════════════════════════ */

/* Tắt con trỏ gõ văn bản (caret) — không ảnh hưởng click */
* { caret-color: transparent !important; }

/* contenteditable: read-only via CSS — KHÔNG dùng pointer-events:none để không break click */
[contenteditable], [contenteditable="true"], [contenteditable=""] {
  -webkit-user-modify: read-only !important;
  cursor: default !important;
}

/* Tắt outline khi focus (không cần viền focus trên bài đọc) */
*:focus { outline: none !important; }

/* Lock input thường (không phải interactive) */
input[type="text"]:not([data-interactive]),
input[type="search"],
textarea:not([data-interactive]) {
  pointer-events: none !important;
  -webkit-user-modify: read-only !important;
}

/* ══ LỚP 1: CHỐNG COPY NỘI DUNG ══════════════════════════ */

/* 1a. Tắt select toàn bộ */
* {
  -webkit-user-select: none !important;
  -moz-user-select: none !important;
  -ms-user-select: none !important;
  user-select: none !important;
}

/* 1b. Tắt highlight khi chọn text */
::selection { background: transparent !important; }
::-moz-selection { background: transparent !important; }

/* 1c. Tắt kéo thả ảnh/text */
* { -webkit-user-drag: none !important; }
img { pointer-events: none !important; }

/* 1d. Tắt tooltip preview ảnh trên mobile */
img { -webkit-touch-callout: none !important; }

/* ══ MOBILE RESPONSIVE BÊN TRONG BÀI HỌC ══════════════════ */

/* Base: tất cả element không được tràn ngang */
*, *::before, *::after {
  max-width: 100% !important;
  box-sizing: border-box !important;
}

/* Fix width/height cứng bằng px trong inline style */
[style*="width:"][style*="px"] {
  max-width: 100% !important;
  width: auto !important;
}
[style*="min-width:"][style*="px"] {
  min-width: 0 !important;
}

/* Layout 2 cột → stack dọc trên mobile */
[style*="display:flex"], [style*="display: flex"] {
  flex-wrap: wrap !important;
}
[style*="display:grid"], [style*="display: grid"] {
  grid-template-columns: 1fr !important;
  gap: 12px !important;
}

/* Canvas / đồ thị interactive: scale xuống vừa màn hình */
canvas {
  max-width: 100% !important;
  height: auto !important;
  touch-action: pan-y pinch-zoom !important;
}

/* Bảng: scroll ngang thay vì tràn */
table {
  display: block !important;
  overflow-x: auto !important;
  -webkit-overflow-scrolling: touch !important;
  white-space: nowrap !important;
  max-width: 100% !important;
}
table td, table th {
  white-space: normal !important;
  min-width: 80px;
}

/* Tắt overflow ngang của body */
html, body {
  overflow-x: hidden !important;
  max-width: 100vw !important;
}

/* Ảnh */
img { max-width: 100% !important; height: auto !important; }

/* Iframe lồng nhau (video, GeoGebra...) */
iframe {
  max-width: 100% !important;
  width: 100% !important;
}

/* ── Breakpoint 600px ── */
@media (max-width: 600px) {
  body {
    font-size: 14px !important;
    padding: 12px 14px !important;
    margin: 0 !important;
  }
  h1 { font-size: 18px !important; line-height: 1.3 !important; }
  h2 { font-size: 16px !important; }
  h3 { font-size: 14.5px !important; }

  /* Cột bên cạnh đồ thị: stack dọc */
  [style*="float:left"], [style*="float: left"],
  [style*="float:right"], [style*="float: right"] {
    float: none !important;
    width: 100% !important;
    margin: 0 0 12px 0 !important;
  }

  /* Flex children: full width */
  [style*="display:flex"] > *,
  [style*="display: flex"] > * {
    flex: 1 1 100% !important;
    min-width: 0 !important;
    width: 100% !important;
  }

  /* Nếu bài dùng table layout 2 cột */
  table[style*="width"] td {
    display: block !important;
    width: 100% !important;
  }

  /* Code */
  pre { font-size: 12px !important; padding: 10px !important; overflow-x: auto !important; }
  code { font-size: 12px !important; }

  /* GeoGebra / interactive applet container */
  .applet_showhide_button,
  [id*="ggbApplet"], [class*="ggb"],
  [id*="geogebra"], [class*="geogebra"] {
    max-width: 100% !important;
    width: 100% !important;
    height: auto !important;
    min-height: 280px;
  }
}

/* ── Breakpoint 400px (điện thoại nhỏ) ── */
@media (max-width: 400px) {
  body { font-size: 13px !important; padding: 10px 12px !important; }
  h1 { font-size: 16px !important; }
  h2 { font-size: 14.5px !important; }
  table td, table th { font-size: 11px !important; padding: 4px 6px !important; }
}
</style>`;
      if (finalContent.includes('</head>')) {
        finalContent = finalContent.replace('</head>', stabilizeCSS + '</head>');
      }

      // Inject auto-resize script vào iframe: báo height ra ngoài qua postMessage
      const _resizeScript = `<script>
(function(){
  /* ── Auto resize: báo height qua postMessage ── */
  var _t = null;
  function rh() {
    var h = Math.max(
      document.body ? document.body.scrollHeight : 0,
      document.documentElement ? document.documentElement.scrollHeight : 0
    );
    if (h > 100) window.parent.postMessage({ type: 'ae-iframe-height', height: h }, 'https://activelearning.gds.edu.vn');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', rh);
  else rh();
  window.addEventListener('load', rh);
  try { new ResizeObserver(function(){ clearTimeout(_t); _t = setTimeout(rh, 50); }).observe(document.body); } catch(e){}
  try { new MutationObserver(function(){ clearTimeout(_t); _t = setTimeout(rh, 50); }).observe(document.body, {childList:true, subtree:true}); } catch(e){}
  [200, 500, 1000, 2000, 4000].forEach(function(t){ setTimeout(rh, t); });
  document.addEventListener('click', function(){ setTimeout(rh, 150); });

  /* ══ FIX MOBILE LAYOUT ══════════════════════════════════ */
  function fixMobileLayout() {
    if (window.innerWidth > 768) return;
    var vw = window.innerWidth;
    var all = document.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var el = all[i]; var s = el.style;
      if (s.width && s.width.indexOf('px') >= 0 && parseFloat(s.width) > vw)
        { s.maxWidth = '100%'; s.width = '100%'; }
      if (s.minWidth && parseFloat(s.minWidth) > vw * 0.5) s.minWidth = '0';
      if (s.display === 'flex' || s.display === '-webkit-flex')
        if (!s.flexWrap || s.flexWrap === 'nowrap') s.flexWrap = 'wrap';
      if (s.cssFloat === 'left' || s.cssFloat === 'right')
        { s.cssFloat = 'none'; s.width = '100%'; }
    }
    // Fix canvas quá rộng
    document.querySelectorAll('canvas').forEach(function(c) {
      if (c.scrollWidth > vw + 10) {
        var ratio = (vw - 8) / c.scrollWidth;
        c.style.transform = 'scale(' + ratio.toFixed(3) + ')';
        c.style.transformOrigin = 'top left';
        c.parentElement && (c.parentElement.style.overflow = 'hidden');
      }
    });
    setTimeout(rh, 150);
  }
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', function(){ setTimeout(fixMobileLayout, 400); });
  else setTimeout(fixMobileLayout, 400);
  window.addEventListener('load', function(){ setTimeout(fixMobileLayout, 600); });
  window.addEventListener('resize', function(){ setTimeout(fixMobileLayout, 200); });

  /* ══ LỚP 0: KHOÁ CHỈNH SỬA HOÀN TOÀN (iOS/iPad/Android) ══ */

  /* 0a. Tắt designMode và contentEditable trên toàn trang */
  document.designMode = 'off';
  function _lockEditing() {
    document.designMode = 'off';
    if (document.body) {
      document.body.contentEditable = 'false';
      document.body.setAttribute('contenteditable', 'false');
      /* Xóa contenteditable khỏi tất cả phần tử con */
      document.querySelectorAll('[contenteditable]').forEach(function(el) {
        el.removeAttribute('contenteditable');
        el.contentEditable = 'false';
      });
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _lockEditing);
  } else {
    _lockEditing();
  }
  window.addEventListener('load', _lockEditing);
  /* Chạy lại sau khi JS framework (React/Vue) có thể thêm contenteditable */
  setTimeout(_lockEditing, 500);
  setTimeout(_lockEditing, 1500);

  /* 0b. Block gõ phím CHỈ khi target là contenteditable — không block click/interact */
  function _isEditTarget(el) {
    if (!el) return false;
    var ce = el.getAttribute('contenteditable');
    if (ce === 'true' || ce === '') return true;
    /* Leo lên cây DOM tìm parent contenteditable */
    var p = el.parentElement;
    while (p && p !== document.body) {
      ce = p.getAttribute('contenteditable');
      if (ce === 'true' || ce === '') return true;
      p = p.parentElement;
    }
    return false;
  }
  document.addEventListener('input', function(e) {
    if (_isEditTarget(e.target)) { e.preventDefault(); e.stopPropagation(); return false; }
  }, true);
  document.addEventListener('keypress', function(e) {
    if (_isEditTarget(e.target)) { e.preventDefault(); e.stopPropagation(); return false; }
  }, true);
  document.addEventListener('keydown', function(e) {
    if (_isEditTarget(e.target)) { e.preventDefault(); e.stopPropagation(); return false; }
  }, true);

  /* 0c. Block paste */
  document.addEventListener('paste', function(e){ e.preventDefault(); e.stopPropagation(); return false; }, true);

  /* ══ LỚP 1: CHỐNG COPY JS ══════════════════════════════ */

  /* 1. Block copy / cut */
  document.addEventListener('copy',  function(e){ e.preventDefault(); e.stopPropagation(); return false; }, true);
  document.addEventListener('cut',   function(e){ e.preventDefault(); e.stopPropagation(); return false; }, true);

  /* 2. Block chuột phải (context menu) */
  document.addEventListener('contextmenu', function(e){ e.preventDefault(); return false; }, true);

  /* 3. Block keyboard shortcuts: Ctrl+C, Ctrl+A, Ctrl+U, Ctrl+S, Ctrl+P */
  document.addEventListener('keydown', function(e) {
    var ctrl = e.ctrlKey || e.metaKey;
    if (!ctrl) return;
    var k = e.key ? e.key.toLowerCase() : '';
    if (k === 'c' || k === 'a' || k === 'u' || k === 's' || k === 'p' || k === 'x' || k === 'f') {
      e.preventDefault();
      e.stopPropagation();
      return false;
    }
    /* Block F12, Ctrl+Shift+I, Ctrl+Shift+J, Ctrl+Shift+C */
    if (e.key === 'F12' || (ctrl && e.shiftKey && (k==='i'||k==='j'||k==='c'||k==='k'))) {
      e.preventDefault();
      return false;
    }
  }, true);

  /* 4. Block drag & drop text */
  document.addEventListener('dragstart', function(e){ e.preventDefault(); return false; }, true);

  /* 5. Block print */
  window.addEventListener('beforeprint', function(e){ e.preventDefault(); return false; });
  window.onbeforeprint = function(){ return false; };

  /* 6. Block selection qua JS (nếu extension cố select) */
  document.addEventListener('selectstart', function(e){ e.preventDefault(); return false; }, true);

  /* 7. Thông báo nhẹ nhàng khi cố copy */
  document.addEventListener('copy', function() {
    window.parent.postMessage({ type: 'ae-copy-blocked' }, 'https://activelearning.gds.edu.vn');
  }, true);

})();
<\/script>`;
      if (finalContent.includes('</body>')) {
        finalContent = finalContent.replace('</body>', _resizeScript + '</body>');
      } else {
        finalContent += _resizeScript;
      }

      // ── Watermark động cho bài PRIVATE ──────────────────────────────────
      if (item.access === 'private' || item.folderAccess === 'private') {
        const user = getUser();
        const wmName  = user ? (user.name  || user.email || 'Học sinh') : 'Học sinh';
        const wmEmail = user ? (user.email || '') : '';
        const wmTime  = new Date().toLocaleString('vi-VN', { hour:'2-digit', minute:'2-digit', day:'2-digit', month:'2-digit', year:'numeric' });
        const wmLine1 = wmName + (wmEmail ? ' · ' + wmEmail : '');
        const wmLine2 = wmTime;
        const wmScript = `<style>
#_ae_wm{position:fixed;inset:0;pointer-events:none;z-index:9999;overflow:hidden;}
#_ae_wm::before{
  content:'${wmLine1.replace(/'/g,"\\'")} — ${wmLine2.replace(/'/g,"\\'")}';
  position:absolute;top:50%;left:50%;
  transform:translate(-50%,-50%) rotate(-25deg);
  font-size:14px;font-family:sans-serif;
  color:rgba(0,0,0,0.07);white-space:nowrap;
  letter-spacing:1px;user-select:none;pointer-events:none;
  width:200%;text-align:center;line-height:3;
  text-shadow:0 0 0 transparent;
}
</style><div id="_ae_wm"></div>`;
        if (finalContent.includes('</body>')) {
          finalContent = finalContent.replace('</body>', wmScript + '</body>');
        } else {
          finalContent += wmScript;
        }
      }

      setBlobSrcdoc(iframe, finalContent);
      // Start progress tracking after content loads
      _startProgressTracking(item);
      // Show AI Tutor button
      _showAITutorBtn(item.name);
      // Fire-and-forget: increment view count in Analytics
      _trackArticleView(item.nocoId);
    } else {
      setBlobSrcdoc(iframe, '<p style="color:#ef4444;padding:40px;text-align:center">Bài học chưa có nội dung trong NocoDB.</p>');
    }
  } catch(e) {
    setBlobSrcdoc(document.getElementById('article-iframe'), `<p style="color:#ef4444;padding:40px;text-align:center">Lỗi tải bài: ${e.message}</p>`);
  }
  closeSidebar();
  window.scrollTo(0, 0);
}

function findItemByPath(tree, path) {
  for (const node of tree) {
    if (node.type === 'folder') {
      const found = findItemByPath(node.children || [], path);
      if (found) return found;
    } else if (node.path === path) {
      return node;
    }
  }
  return null;
}

// Tìm bài theo nocoId (ưu tiên) — ổn định dù đổi tên/path
function findItemById(tree, id) {
  const sid = String(id);
  for (const node of tree) {
    if (node.type === 'folder') {
      const found = findItemById(node.children || [], sid);
      if (found) return found;
    } else if (String(node.nocoId) === sid) {
      return node;
    }
  }
  return null;
}

function findItemBySlug(tree, slug) {
  for (const node of tree) {
    if (node.type === 'folder') {
      const found = findItemBySlug(node.children || [], slug);
      if (found) return found;
    } else {
      const nodeSlug = node.path.split('/').pop().replace(/\.html?$/i, '');
      if (nodeSlug === slug || node.path === slug) return node;
    }
  }
  return null;
}


// Auto-close sidebar khi resize lên desktop (>1024px)
window.addEventListener('resize', () => {
  if (window.innerWidth > 1024) {
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('overlay').classList.remove('show');
    document.body.style.overflow = '';
  }
});

// Toast thông báo khi copy bị chặn
function _showCopyBlockedToast() {
  var existing = document.getElementById('_copy-toast');
  if (existing) { clearTimeout(existing._t); existing.remove(); }
  var toast = document.createElement('div');
  toast.id = '_copy-toast';
  toast.textContent = '🔒 Nội dung được bảo vệ bản quyền';
  toast.style.cssText = [
    'position:fixed','bottom:24px','left:50%','transform:translateX(-50%)',
    'background:#1e293b','color:#f8fafc','padding:10px 20px',
    'border-radius:100px','font-size:13px','font-weight:500',
    'z-index:9999','pointer-events:none',
    'box-shadow:0 4px 16px rgba(0,0,0,.25)',
    'opacity:0','transition:opacity .2s'
  ].join(';');
  document.body.appendChild(toast);
  requestAnimationFrame(function() { toast.style.opacity = '1'; });
  toast._t = setTimeout(function() {
    toast.style.opacity = '0';
    setTimeout(function() { toast.remove(); }, 200);
  }, 2000);
}


function shareArticle() {
  if (!currentArticleId) { showToast && showToast('Không có bài để chia sẻ', 'warn'); return; }
  const url = window.location.origin + '/bai/' + currentArticleId;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(url).then(() => {
      const toast = document.getElementById('share-toast');
      if (toast) { toast.style.display = 'inline'; setTimeout(() => toast.style.display = 'none', 2500); }
    }).catch(() => prompt('Sao chép link này:', url));
  } else {
    prompt('Sao chép link này:', url);
  }
}

function _hideAllViews() {
  document.getElementById('home-view').style.display = 'none';
  document.getElementById('article-view').style.display = 'none';
  document.getElementById('article-gate').style.display = 'none';
  const cv = document.getElementById('courses-view');
  if (cv) cv.style.display = 'none';
  const cdv = document.getElementById('course-detail-view');
  if (cdv) cdv.style.display = 'none';
  const ev = document.getElementById('exam-view');
  if (ev) ev.style.display = 'none';
}

function showHome() {
  _stopProgressTracking();
  _resetReactionPanel();
  _hideAITutorBtn();
  _hideAllViews();
  document.getElementById('home-view').style.display = 'block';
  setBreadcrumb(null);
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  pendingPrivateItem = null;
  history.pushState(null, '', '/');
  document.title = 'ActiveEdu — Nền tảng học tập';
  buildCards(contentTree);
}

function setBreadcrumb(title) {
  document.getElementById('breadcrumb').innerHTML = title
    ? `<span class="bc-home" onclick="showHome()"><i class="fas fa-home"></i> Trang chủ</span><span class="bc-sep">›</span><span class="bc-cur">${title}</span>`
    : `<span class="bc-home" onclick="showHome()"><i class="fas fa-home"></i> Trang chủ</span>`;
}
function setActiveNav(nocoId) {
  document.querySelectorAll('.nav-item').forEach(el =>
    el.classList.toggle('active', el.dataset.nocoid === String(nocoId)));
}
function countA(items) { return (items||[]).reduce((n,i) => n+(i.type==='file'?1:countA(i.children)),0); }
function flatA(tree)   { return (tree||[]).flatMap(i => i.type==='file'?[i]:flatA(i.children)); }

function flatFolders(tree) { return (tree||[]).flatMap(i => i.type==='folder'?[i,...flatFolders(i.children)]:[]); }

function updateStats() {
  const all  = flatA(contentTree);
  const priv = all.filter(i => i.access === 'private' || i.folderAccess === 'private');
  const folders = flatFolders(contentTree);
  document.getElementById('stat-articles').textContent = all.length;
  document.getElementById('stat-folders').textContent  = folders.length;
  document.getElementById('stat-private').textContent  = priv.length;
  document.getElementById('article-count').textContent = all.length + ' bài học';
}
function expandFolder(name) {
  document.querySelectorAll('.nav-folder-header').forEach(h => {
    if (h.textContent.trim().includes(name)) {
      h.parentElement.classList.add('open');
      h.scrollIntoView({behavior:'smooth',block:'center'});
    }
  });
}
function filterNav(q) {
  const lq = q.toLowerCase();
  document.querySelectorAll('.nav-item').forEach(el => { el.style.display = el.textContent.toLowerCase().includes(lq)?'':'none'; });
  document.querySelectorAll('.nav-folder').forEach(f => {
    const vis = [...f.querySelectorAll('.nav-item')].some(a => a.style.display !== 'none');
    f.style.display = (vis||!q)?'':'none';
    if (q&&vis) f.classList.add('open');
  });
}
function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('overlay').classList.toggle('show');
  document.body.style.overflow = document.getElementById('sidebar').classList.contains('open') ? 'hidden' : '';
}
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.body.style.overflow = '';
  document.getElementById('overlay').classList.remove('show');
}

// ── Swipe trái để đóng sidebar (mobile/tablet) ──────────────────
(function() {
  var _tx = 0, _ty = 0, _dragging = false;
  document.addEventListener('touchstart', function(e) {
    _tx = e.touches[0].clientX;
    _ty = e.touches[0].clientY;
    _dragging = false;
  }, { passive: true });
  document.addEventListener('touchmove', function(e) {
    if (!document.getElementById('sidebar').classList.contains('open')) return;
    var dx = e.touches[0].clientX - _tx;
    var dy = e.touches[0].clientY - _ty;
    if (!_dragging && Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 8) _dragging = true;
    if (_dragging && dx < 0) {
      var progress = Math.min(1, Math.abs(dx) / 80);
      document.getElementById('sidebar').style.transform = 'translateX(' + (dx < -280 ? -280 : dx) + 'px)';
    }
  }, { passive: true });
  document.addEventListener('touchend', function(e) {
    if (!_dragging) return;
    var dx = e.changedTouches[0].clientX - _tx;
    document.getElementById('sidebar').style.transform = '';
    if (dx < -60) closeSidebar();
    _dragging = false;
  }, { passive: true });
})();

// ── Scroll xuống autohide sidebar trên mobile ───────────────────
(function() {
  var _lastScroll = 0;
  window.addEventListener('scroll', function() {
    if (window.innerWidth > 1024) return;
    var cur = window.scrollY || document.documentElement.scrollTop;
    if (cur > _lastScroll + 30 && document.getElementById('sidebar').classList.contains('open')) {
      closeSidebar();
    }
    _lastScroll = cur <= 0 ? 0 : cur;
  }, { passive: true });
})();
function showEmptyState() {
  const c = getNocoCfg();
  document.getElementById('nav-menu').innerHTML = '<div style="padding:20px;text-align:center;color:rgba(255,255,255,.35);font-size:13px">Chưa có bài học nào</div>';
  document.getElementById('home-cards').innerHTML = `<div class="empty-state" style="grid-column:1/-1"><div class="emoji">📂</div><h3>Chưa có nội dung</h3><p style="color:#94a3b8;font-size:13px;margin-top:8px">Vào Admin để thêm bài học</p></div>`;
  updateStats();
}

init();

// Xử lý nút Back/Forward của trình duyệt
window.addEventListener('popstate', () => {
  const pathMatch = window.location.pathname.match(/\/bai\/([^/]+)/);
  if (pathMatch) {
    const rawVal = decodeURIComponent(pathMatch[1]);
    const item = /^\d+$/.test(rawVal)
      ? findItemById(contentTree, rawVal)
      : findItemBySlug(contentTree, rawVal);
    if (item) { loadArticle(item); return; }
  }
  showHome();
});

// ═══════════════════════════════════════════════════
// PROFILE
// ═══════════════════════════════════════════════════
let profileUserRow = null;

async function openProfile() {
  const user = getUser();
  if (!user) return;
  document.getElementById('profile-modal').classList.add('show');
  document.getElementById('pf-name').value    = user.displayName || '';
  document.getElementById('pf-email').value   = user.email || user.username || '';
  document.getElementById('pf-phone').value   = user.phone || '';
  document.getElementById('pf-bio').value     = user.bio || '';
  document.getElementById('pf-pass-old').value    = '';
  document.getElementById('pf-pass-new').value    = '';
  document.getElementById('pf-pass-confirm').value = '';
  document.getElementById('profile-msg').innerHTML = '';
  updateProfileHeader(user);
  const proxy = PROXY_URL.replace(/\/$/, '');
  try {
    const data = await fetch(`${proxy}/api/users?where=(Email,eq,${encodeURIComponent(user.email||user.username)})&limit=1`).then(r=>r.json());
    profileUserRow = (data.list||[])[0]||null;
    if (profileUserRow) {
      document.getElementById('pf-name').value  = profileUserRow.Name||profileUserRow.FullName||profileUserRow.HoTen||user.displayName;
      document.getElementById('pf-email').value = profileUserRow.Email||user.username;
      document.getElementById('pf-phone').value = profileUserRow.Phone||profileUserRow.SDT||'';
      document.getElementById('pf-bio').value   = profileUserRow.Bio||profileUserRow.GioiThieu||profileUserRow.Note||'';
    }
  } catch(e) {}
}

function updateProfileHeader(user) {
  const name = user.displayName || 'User';
  const roleMap = {admin:'Quản trị viên', teacher:'Giáo viên', student:'Học sinh'};
  document.getElementById('profile-header-name').textContent = name;
  document.getElementById('profile-header-role').textContent = roleMap[user.role] || 'Học sinh';
  const el = document.getElementById('profile-avatar-display');
  if (user.avatar) {
    el.innerHTML = `<img src="${user.avatar}" style="width:80px;height:80px;border-radius:50%;object-fit:cover">`;
    el.style = '';
  } else {
    el.textContent = name.charAt(0).toUpperCase();
    el.style.cssText = 'width:80px;height:80px;border-radius:50%;border:3px solid rgba(255,255,255,.5);display:flex;align-items:center;justify-content:center;font-size:32px;color:#fff;font-weight:700;margin:0 auto;background:rgba(255,255,255,.2)';
  }
}

function closeProfile() {
  document.getElementById('profile-modal').classList.remove('show');
  profileUserRow = null;
}

function handleAvatarChange(input) {
  const file = input.files[0];
  if (!file) return;
  if (file.size > 2*1024*1024) { showProfileMsg('Ảnh quá lớn! Tối đa 2MB.','error'); return; }
  const reader = new FileReader();
  reader.onload = (e) => {
    const dataUrl = e.target.result;
    document.getElementById('profile-avatar-display').innerHTML =
      `<img src="${dataUrl}" style="width:80px;height:80px;border-radius:50%;object-fit:cover">`;
    const user = getUser(); user.avatar = dataUrl; setUser(user);
    renderUserArea();
    showProfileMsg('✓ Ảnh đại diện đã cập nhật!','success');
  };
  reader.readAsDataURL(file);
  input.value = '';
}

async function saveProfile() {
  const user = getUser(); if (!user) return;
  const name     = document.getElementById('pf-name').value.trim();
  const email    = document.getElementById('pf-email').value.trim();
  const phone    = document.getElementById('pf-phone').value.trim();
  const bio      = document.getElementById('pf-bio').value.trim();
  const passOld  = document.getElementById('pf-pass-old').value;
  const passNew  = document.getElementById('pf-pass-new').value;
  const passConf = document.getElementById('pf-pass-confirm').value;
  if (!name) { showProfileMsg('Vui lòng nhập họ tên!','error'); return; }
  let changePass = false;
  if (passNew) {
    if (passNew.length < 6) { showProfileMsg('Mật khẩu mới tối thiểu 6 ký tự!','error'); return; }
    if (passNew !== passConf) { showProfileMsg('Mật khẩu xác nhận không khớp!','error'); return; }
    if (!passOld) { showProfileMsg('Nhập mật khẩu hiện tại để đổi!','error'); return; }
    changePass = true;
  }
  showProfileMsg('<i class="fas fa-spinner fa-spin"></i> Đang lưu...','');
  user.displayName = name; user.email = email; user.phone = phone; user.bio = bio;
  setUser(user); renderUserArea();

  try {
    // Đổi mật khẩu qua endpoint bảo mật (Worker tự hash)
    if (changePass) {
      const r = await fetch(`${PROXY_URL}/api/auth/change-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${user.token || ''}` },
        body: JSON.stringify({ oldPassword: passOld, newPassword: passNew }),
      });
      const res = await r.json();
      if (!r.ok) { showProfileMsg(res.error || 'Lỗi đổi mật khẩu!', 'error'); return; }
      ['pf-pass-old','pf-pass-new','pf-pass-confirm'].forEach(id => document.getElementById(id).value='');
    }

    // Cập nhật thông tin profile (không bao gồm password)
    if (profileUserRow) {
      await fetch(`${PROXY_URL}/api/users`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([{
          Id: profileUserRow.Id,
          Name: name, FullName: name, HoTen: name,
          Phone: phone, SDT: phone,
          Bio: bio, GioiThieu: bio, Note: bio,
          NgayCapNhat: new Date().toLocaleDateString('vi-VN'),
        }])
      });
    }
    showProfileMsg('✓ Đã lưu thông tin thành công!','success');
  } catch(e) { showProfileMsg('Lỗi: '+e.message,'error'); }
}

function showProfileMsg(msg, type) {
  const el = document.getElementById('profile-msg');
  const colors = {success:'#16a34a',error:'#dc2626',warn:'#d97706','':`var(--text-muted)`};
  el.innerHTML = `<span style="color:${colors[type]||colors['']}">${msg}</span>`;
}

document.addEventListener('click', (e) => {
  if (e.target === document.getElementById('profile-modal')) closeProfile();
});

// ═══════════════════════════════════════════════════
// GLOBAL ERROR HANDLER
// ═══════════════════════════════════════════════════
window.addEventListener('unhandledrejection', e => {
  const msg = e.reason?.message || String(e.reason) || '';
  if (!msg || msg.toLowerCase().includes('aborted') || msg.toLowerCase().includes('abort')) return;
  console.warn('[AE] Unhandled error:', msg);
});

// ═══════════════════════════════════════════════════
// API HEALTH CHECK — kiểm tra Worker sau khi trang load
// ═══════════════════════════════════════════════════
(async function checkStudentAPIHealth() {
  // Chờ 3s sau khi trang load mới kiểm tra
  await new Promise(r => setTimeout(r, 3000));
  try {
    const r = await fetch(PROXY_URL.replace(/\/$/, '') + '/api/articles?limit=1', {
      signal: AbortSignal.timeout(7000)
    });
    if (!r.ok && r.status !== 401 && r.status !== 404) {
      _showOfflineBanner('Máy chủ phản hồi lỗi ' + r.status);
    }
    // Nếu ok → không làm gì (trang bình thường)
  } catch(e) {
    if (e.name !== 'AbortError') _showOfflineBanner('Không kết nối được tới máy chủ');
  }
})();

// ══════════════════════════════════════════════════════════════
// ACTIVE LEARNING: PROGRESS TRACKING + REACTIONS + LỘ TRÌNH HỌC
// ══════════════════════════════════════════════════════════════

// ── Progress cache ──────────────────────────────────────────
let _progressCache = null;   // Map<articleId, {completed, reaction}>
let _progressLoading = false;

async function loadUserProgress() {
  if (!isLoggedIn()) return;
  if (_progressLoading) return;
  _progressLoading = true;
  try {
    const proxyBase = (PROXY_URL || 'https://api.gds.edu.vn').replace(/\/$/, '');
    const u = getUser();
    const resp = await fetch(`${proxyBase}/api/progress`, {
      headers: { 'Authorization': `Bearer ${u.token}` }
    });
    if (!resp.ok) return;
    const data = await resp.json();
    _progressCache = new Map();
    for (const row of (data.list || [])) {
      _progressCache.set(String(row.ArticleId), { completed: !!row.Completed, score: row.Score || null, reaction: row.Reactions || null });
    }
    _updateLoTrinh();
    _updateProgressBadges();
  } catch { /* silent */ } finally {
    _progressLoading = false;
  }
}

// ── Reading timer ────────────────────────────────────────────
let _readTimer = null;
let _readInterval = null;
let _readProgress = 0;
const READ_DURATION_MS = 30000; // 30s để đánh dấu đã đọc
const READ_TICK_MS = 500;

function _startProgressTracking(item) {
  _stopProgressTracking();
  if (!isLoggedIn()) return;

  const fill = document.getElementById('reading-timer-fill');
  const reactionWrap = document.getElementById('reaction-panel-wrap');
  const completeBanner = document.getElementById('read-complete-bar');
  if (fill) { fill.style.width = '0%'; fill.style.transition = 'none'; }

  // Check if already completed
  const cached = _progressCache && _progressCache.get(String(item.nocoId));
  if (cached && cached.completed) {
    if (fill) fill.style.width = '100%';
    if (completeBanner) completeBanner.style.display = 'flex';
    if (reactionWrap) reactionWrap.style.display = 'block';
    _applyExistingReaction(cached.reaction);
    return;
  }

  _readProgress = 0;
  const startTs = Date.now();
  _readInterval = setInterval(() => {
    const elapsed = Date.now() - startTs;
    _readProgress = Math.min(elapsed / READ_DURATION_MS, 1);
    if (fill) {
      fill.style.transition = `width ${READ_TICK_MS}ms linear`;
      fill.style.width = (_readProgress * 100).toFixed(1) + '%';
    }
    if (_readProgress >= 1) {
      clearInterval(_readInterval);
      _readInterval = null;
      _onArticleCompleted(item);
    }
  }, READ_TICK_MS);
}

function _stopProgressTracking() {
  if (_readInterval) { clearInterval(_readInterval); _readInterval = null; }
  if (_readTimer) { clearTimeout(_readTimer); _readTimer = null; }
  _readProgress = 0;
}

function _onArticleCompleted(item) {
  const fill = document.getElementById('reading-timer-fill');
  const completeBanner = document.getElementById('read-complete-bar');
  const reactionWrap = document.getElementById('reaction-panel-wrap');
  if (fill) fill.style.width = '100%';
  if (completeBanner) completeBanner.style.display = 'flex';
  if (reactionWrap) reactionWrap.style.display = 'block';

  // POST to worker
  _markArticleRead(String(item.nocoId));

  // Update local cache
  if (_progressCache) {
    const existing = _progressCache.get(String(item.nocoId)) || {};
    _progressCache.set(String(item.nocoId), { ...existing, completed: true });
  }
  _updateLoTrinh();
  _updateProgressBadges();
}

async function _markArticleRead(articleId) {
  try {
    const proxyBase = (PROXY_URL || 'https://api.gds.edu.vn').replace(/\/$/, '');
    const u = getUser();
    await fetch(`${proxyBase}/api/progress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${u.token}` },
      body: JSON.stringify({ articleId, completed: true }),
    });
  } catch { /* silent */ }
}

// ── Reactions ───────────────────────────────────────────────
async function sendReaction(type) {
  if (!isLoggedIn() || !currentArticleId) return;
  const btns = { easy: 'rb-easy', hard: 'rb-hard', example: 'rb-example' };

  // Toggle UI immediately
  Object.values(btns).forEach(id => {
    const b = document.getElementById(id);
    if (b) b.classList.remove('selected');
  });
  const activeBtn = document.getElementById(btns[type]);
  if (activeBtn) activeBtn.classList.add('selected');

  const doneMsg = document.getElementById('reaction-done-msg');
  if (doneMsg) doneMsg.style.display = 'block';

  // Update local cache
  if (_progressCache && currentArticleId) {
    const existing = _progressCache.get(String(currentArticleId)) || {};
    _progressCache.set(String(currentArticleId), { ...existing, reaction: type });
  }

  // POST to worker
  try {
    const proxyBase = (PROXY_URL || 'https://api.gds.edu.vn').replace(/\/$/, '');
    const u = getUser();
    await fetch(`${proxyBase}/api/reactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${u.token}` },
      body: JSON.stringify({ articleId: String(currentArticleId), reaction: type }),
    });
  } catch { /* silent */ }
}

function _applyExistingReaction(reaction) {
  const doneMsg = document.getElementById('reaction-done-msg');
  if (!reaction) return;
  const btns = { easy: 'rb-easy', hard: 'rb-hard', example: 'rb-example' };
  const activeBtn = document.getElementById(btns[reaction]);
  if (activeBtn) activeBtn.classList.add('selected');
  if (doneMsg) doneMsg.style.display = 'block';
}

function _resetReactionPanel() {
  ['rb-easy', 'rb-hard', 'rb-example'].forEach(id => {
    const b = document.getElementById(id);
    if (b) b.classList.remove('selected');
  });
  const doneMsg = document.getElementById('reaction-done-msg');
  if (doneMsg) doneMsg.style.display = 'none';
  const reactionWrap = document.getElementById('reaction-panel-wrap');
  if (reactionWrap) reactionWrap.style.display = 'none';
  const completeBanner = document.getElementById('read-complete-bar');
  if (completeBanner) completeBanner.style.display = 'none';
  const fill = document.getElementById('reading-timer-fill');
  if (fill) { fill.style.transition = 'none'; fill.style.width = '0%'; }
}

// ── Progress badges on nav/cards ─────────────────────────────
function _updateProgressBadges() {
  if (!_progressCache) return;

  // Nav items
  document.querySelectorAll('.nav-item[data-nocoid]').forEach(a => {
    const id = a.dataset.nocoid;
    const prog = _progressCache.get(id);
    // Remove old badge
    const old = a.querySelector('.nav-read-badge');
    if (old) old.remove();
    if (prog && prog.completed) {
      const badge = document.createElement('span');
      badge.className = 'nav-read-badge';
      badge.innerHTML = '<i class="fas fa-check"></i>';
      a.appendChild(badge);
    }
  });

  // Cards: rebuild to show read chips (easier than patching DOM)
  // Use a lightweight update: add/remove class on card elements
  document.querySelectorAll('.content-card[data-nocoid]').forEach(card => {
    const id = card.dataset.nocoid;
    const prog = _progressCache.get(id);
    const existing = card.querySelector('.card-read-chip');
    if (prog && prog.completed && !existing) {
      const footer = card.querySelector('.card-footer');
      if (footer) {
        const chip = document.createElement('span');
        chip.className = 'card-read-chip';
        chip.innerHTML = '<i class="fas fa-check"></i> Đã đọc';
        footer.prepend(chip);
      }
    }
  });
}

// ── Lộ trình học panel ────────────────────────────────────────
function showLoTrinh() {
  document.getElementById('lo-trinh-overlay').style.display = 'block';
  document.getElementById('lo-trinh-panel').style.display = 'flex';
  _renderLoTrinh();
}

function hideLoTrinh() {
  document.getElementById('lo-trinh-overlay').style.display = 'none';
  document.getElementById('lo-trinh-panel').style.display = 'none';
}

function _updateLoTrinh() {
  if (!_progressCache || !contentTree) return;
  const allFiles = flatA(contentTree).filter(f => canViewArticle(f));
  const doneCount = allFiles.filter(f => {
    const p = _progressCache.get(String(f.nocoId));
    return p && p.completed;
  }).length;
  const total = allFiles.length;
  const pct = total ? Math.round(doneCount / total * 100) : 0;

  // Update sidebar trigger
  const trigger = document.getElementById('lt-trigger');
  const triggerPct = document.getElementById('lt-trigger-pct');
  if (trigger) trigger.style.display = 'block';
  if (triggerPct) triggerPct.textContent = pct + '%';

  // Update panel header stats
  const doneEl = document.getElementById('lt-done-count');
  const totalEl = document.getElementById('lt-total-count');
  const pctEl = document.getElementById('lt-pct-val');
  const barFill = document.getElementById('lt-overall-fill');
  if (doneEl) doneEl.textContent = doneCount;
  if (totalEl) totalEl.textContent = total;
  if (pctEl) pctEl.textContent = pct + '%';
  if (barFill) barFill.style.width = pct + '%';
}

function _renderLoTrinh() {
  _updateLoTrinh();
  if (!contentTree) return;
  const container = document.getElementById('lt-content');
  if (!container) return;
  container.innerHTML = '';

  const allFiles = flatA(contentTree).filter(f => canViewArticle(f));

  // Group by folder
  const grouped = new Map(); // folderName → [items]
  for (const item of allFiles) {
    const folder = item.folder || '(Gốc)';
    if (!grouped.has(folder)) grouped.set(folder, []);
    grouped.get(folder).push(item);
  }

  grouped.forEach((items, folder) => {
    const doneInFolder = items.filter(f => {
      const p = _progressCache && _progressCache.get(String(f.nocoId));
      return p && p.completed;
    }).length;
    const pct = items.length ? Math.round(doneInFolder / items.length * 100) : 0;

    const section = document.createElement('div');
    section.className = 'lt-folder-section';
    section.innerHTML = `
      <div class="lt-folder-hd">
        <span class="lt-folder-name"><i class="fas fa-folder" style="color:#60a5fa;margin-right:5px"></i>${esc(folder)}</span>
        <span class="lt-folder-prog">${doneInFolder}/${items.length}</span>
      </div>
      <div class="lt-folder-bar-wrap"><div class="lt-folder-bar-fill" style="width:${pct}%"></div></div>`;

    for (const item of items) {
      const prog = _progressCache && _progressCache.get(String(item.nocoId));
      const done = prog && prog.completed;
      const row = document.createElement('div');
      row.className = 'lt-article' + (done ? ' done' : '');
      row.innerHTML = `
        <div class="lt-dot${done ? ' done' : ''}">${done ? '<i class="fas fa-check"></i>' : ''}</div>
        <span class="lt-article-name">${esc(item.name)}</span>`;
      row.onclick = () => { hideLoTrinh(); loadArticle(item); };
      section.appendChild(row);
    }
    container.appendChild(section);
  });
}

// Fire-and-forget: báo Worker tăng Views trong Analytics
function _trackArticleView(articleId) {
  if (!articleId) return;
  const proxyBase = (PROXY_URL || 'https://api.gds.edu.vn').replace(/\/$/, '');
  fetch(`${proxyBase}/api/analytics/view`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ articleId: String(articleId) }),
  }).catch(() => {});
}

function _showOfflineBanner(reason) {
  if (document.getElementById('offline-banner')) return;
  const banner = document.createElement('div');
  banner.id = 'offline-banner';
  banner.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:9999;background:#1e293b;color:#fff;padding:12px 20px;display:flex;align-items:center;gap:10px;font-size:13px;font-family:inherit;box-shadow:0 -4px 20px rgba(0,0,0,.3)';
  banner.innerHTML = `
    <span style="font-size:16px">⚠️</span>
    <span><strong>Sự cố kết nối:</strong> ${reason}. Nội dung có thể không tải được.</span>
    <button onclick="this.closest('#offline-banner').remove()"
      style="margin-left:auto;border:none;background:rgba(255,255,255,.15);color:#fff;padding:4px 12px;border-radius:6px;cursor:pointer;font-size:12px;font-family:inherit">Đóng</button>`;
  document.body.appendChild(banner);
}

// ═══════════════════════════════════════════════════
// COURSES — Canvas LMS model (student view)
// ═══════════════════════════════════════════════════

let _coursesCache = null;
let _modulesCache = {};

async function showCoursesView() {
  _hideAllViews();
  document.getElementById('courses-view').style.display = 'block';
  document.getElementById('content-area').classList.remove('article-mode');
  history.pushState(null, '', '/courses');
  document.title = 'Khoá học — ActiveEdu';
  await _renderCoursesList();
}

async function _renderCoursesList() {
  const grid = document.getElementById('courses-grid');
  grid.innerHTML = '<div style="text-align:center;padding:40px;color:#64748b"><i class="fas fa-spinner fa-spin"></i> Đang tải khoá học...</div>';

  try {
    const proxyBase = (PROXY_URL || 'https://api.gds.edu.vn').replace(/\/$/, '');
    const r = await fetch(`${proxyBase}/api/courses?where=(Status,eq,published)&sort=Title&limit=100`);
    if (!r.ok) throw new Error('Không tải được danh sách khoá học');
    const data = await r.json();
    _coursesCache = data.list || [];

    if (!_coursesCache.length) {
      grid.innerHTML = '<div style="text-align:center;padding:60px;color:#64748b">Chưa có khoá học nào được công bố.</div>';
      return;
    }

    grid.innerHTML = '';
    _coursesCache.forEach(course => {
      const card = document.createElement('div');
      card.className = 'course-card';
      card.innerHTML = `
        <div class="course-card-title"><i class="fas fa-book-open" style="color:var(--primary);margin-right:6px"></i>${esc(course.Title)}</div>
        ${course.Description ? `<div class="course-card-desc">${esc(course.Description)}</div>` : ''}
        <div class="course-card-meta">
          <span><i class="fas fa-layer-group"></i> Các modules</span>
          <span style="margin-left:auto;color:var(--primary);font-weight:600">Xem khoá học <i class="fas fa-arrow-right"></i></span>
        </div>`;
      card.onclick = () => showCourseDetail(course.Id);
      grid.appendChild(card);
    });
  } catch(e) {
    grid.innerHTML = `<div style="text-align:center;padding:40px;color:#dc2626">${e.message}</div>`;
  }
}

async function showCourseDetail(courseId) {
  _hideAllViews();
  document.getElementById('course-detail-view').style.display = 'block';
  document.getElementById('content-area').classList.remove('article-mode');
  history.pushState(null, '', `/course/${courseId}`);

  // Lấy thông tin khoá học
  const proxyBase = (PROXY_URL || 'https://api.gds.edu.vn').replace(/\/$/, '');
  let course = _coursesCache?.find(c => c.Id === courseId);
  if (!course) {
    try {
      const r = await fetch(`${proxyBase}/api/courses/${courseId}`);
      if (r.ok) course = await r.json();
    } catch { }
  }

  document.getElementById('course-detail-title').textContent = course?.Title || 'Khoá học';
  document.getElementById('course-detail-desc').textContent = course?.Description || '';
  document.getElementById('course-tags').innerHTML = `<span class="article-hd-tag">${esc(course?.Status || 'published')}</span>`;
  document.title = `${course?.Title || 'Khoá học'} — ActiveEdu`;

  // Load modules
  const container = document.getElementById('modules-container');
  container.innerHTML = '<div style="text-align:center;padding:40px;color:#64748b"><i class="fas fa-spinner fa-spin"></i> Đang tải modules...</div>';

  try {
    const r = await fetch(`${proxyBase}/api/modules?where=(CourseId,eq,${courseId})&sort=Position&limit=100`);
    if (!r.ok) throw new Error('Không tải được modules');
    const data = await r.json();
    const modules = data.list || [];
    _modulesCache[courseId] = modules;

    if (!modules.length) {
      container.innerHTML = '<div style="text-align:center;padding:40px;color:#64748b">Khoá học này chưa có module nào.</div>';
      return;
    }

    // Load articles for this course (có ModuleId) + exams cho course này
    const [artResp, examResp] = await Promise.all([
      fetch(`${proxyBase}/api/articles?where=(ModuleId,nnull,true)&fields=Id,Title,Access,ItemType,ModuleId,Position,Published&limit=500`).catch(() => null),
      fetch(`${proxyBase}/api/exams?where=(ModuleId,nnull,true)&fields=Id,Title,ModuleId,TimeLimit,PassScore,TotalPoints,Status`).catch(() => null),
    ]);
    const artData = artResp?.ok ? await artResp.json() : { list: [] };
    const examData = examResp?.ok ? await examResp.json() : { list: [] };
    // Chỉ hiện items đã được publish (Published !== false)
    const allItems = (artData.list || []).filter(a => a.Published !== false);
    const allExams = (examData.list || []).filter(e => e.Status === 'published');

    // Kiểm tra unlock condition từng module (parallel, best-effort)
    const unlockResults = {};
    if (isLoggedIn()) {
      await Promise.all(modules.map(async mod => {
        if (!mod.UnlockCondition) { unlockResults[mod.Id] = { ok: true }; return; }
        try {
          const r = await fetch(`${proxyBase}/api/module-unlock/${mod.Id}`, {
            headers: { 'Authorization': `Bearer ${getUser()?.token || ''}` }
          });
          unlockResults[mod.Id] = r.ok ? await r.json() : { ok: true };
        } catch { unlockResults[mod.Id] = { ok: true }; }
      }));
    }

    container.innerHTML = '';
    const typeLabel = { article: 'Bài đọc', interactive: 'Tương tác', quiz: 'Trắc nghiệm' };

    modules.forEach((mod, idx) => {
      const items = allItems.filter(a => String(a.ModuleId) === String(mod.Id))
        .sort((a, b) => (a.Position || 0) - (b.Position || 0));
      const exams = allExams.filter(e => String(e.ModuleId) === String(mod.Id));
      const unlock = unlockResults[mod.Id] || { ok: !mod.UnlockCondition };
      const isLocked = !unlock.ok;

      const block = document.createElement('div');
      block.className = `module-block${isLocked ? ' module-locked' : ''}`;
      block.innerHTML = `
        <div class="module-block-hd">
          <div class="module-block-num" style="${isLocked ? 'background:#94a3b8' : ''}">${isLocked ? '🔒' : (mod.Position || idx + 1)}</div>
          <div class="module-block-title">${esc(mod.Title)}</div>
          ${isLocked
            ? `<span class="module-lock-badge" title="${esc(unlock.reason || 'Cần hoàn thành module trước')}"><i class="fas fa-lock"></i> Chưa mở khoá</span>`
            : (mod.UnlockCondition ? '<span style="margin-left:auto;font-size:11px;color:#16a34a"><i class="fas fa-lock-open"></i> Đã mở</span>' : '')}
        </div>
        ${isLocked
          ? `<div class="module-lock-overlay"><i class="fas fa-lock"></i> ${esc(unlock.reason || 'Hoàn thành module trước để mở khoá')}</div>`
          : `<div class="module-block-items">
              ${items.map(item => {
                const type = item.ItemType || 'article';
                const isPrivate = item.Access === 'private';
                return `<div class="module-item-row" onclick="_openModuleItemWithPrereqCheck(${item.Id}, '${esc(item.Title || '')}')">
                  <span class="module-item-type type-${type}">${typeLabel[type] || type}</span>
                  <span style="flex:1;font-size:13px">${esc(item.Title || `Bài ${item.Id}`)}</span>
                  ${isPrivate ? '<i class="fas fa-lock" style="color:#94a3b8;font-size:11px" title="Cần đăng nhập"></i>' : ''}
                  <i class="fas fa-chevron-right" style="color:#94a3b8;font-size:11px"></i>
                </div>`;
              }).join('')}
              ${exams.map(exam => `
                <div class="module-item-row" onclick="openExamView(${exam.Id})">
                  <span class="module-item-type type-quiz">📝 Đề thi</span>
                  <span style="flex:1;font-size:13px">${esc(exam.Title)}</span>
                  ${exam.TimeLimit ? `<span style="font-size:11px;color:#64748b"><i class="fas fa-clock"></i> ${exam.TimeLimit} phút</span>` : ''}
                  <i class="fas fa-chevron-right" style="color:#94a3b8;font-size:11px"></i>
                </div>`).join('')}
              ${!items.length && !exams.length ? '<div style="padding:12px 18px;font-size:13px;color:#94a3b8">Module này chưa có bài học.</div>' : ''}
            </div>`}`;
      container.appendChild(block);
    });
  } catch(e) {
    container.innerHTML = `<div style="text-align:center;padding:40px;color:#dc2626">${e.message}</div>`;
  }
}

function showCoursesView_back() { showCoursesView(); }

function _openModuleItem(articleId) {
  const item = findItemById(contentTree, String(articleId));
  if (item) {
    loadArticle(item);
  } else {
    const synth = { nocoId: String(articleId), name: 'Bài học', path: '', folder: '', access: 'public' };
    loadArticle(synth);
  }
}

async function _openModuleItemWithPrereqCheck(articleId, title) {
  // Không cần check prereq nếu chưa login (loadArticle sẽ tự hiện gate)
  if (!isLoggedIn()) {
    _openModuleItem(articleId);
    return;
  }
  const proxyBase = (PROXY_URL || 'https://api.gds.edu.vn').replace(/\/$/, '');
  try {
    const r = await fetch(`${proxyBase}/api/prereq/${articleId}`, {
      headers: { 'Authorization': `Bearer ${getUser()?.token || ''}` }
    });
    const check = r.ok ? await r.json() : { ok: true };
    if (!check.ok) {
      _showPrereqGate(title, check.reason, check.missing);
      return;
    }
  } catch { /* network error → cho qua */ }
  _openModuleItem(articleId);
}

function _showPrereqGate(title, reason, missingId) {
  // Hiển thị toast + inline message thay vì block hoàn toàn
  const msg = reason || 'Bạn cần hoàn thành bài học trước đó';
  // Tạo overlay thông báo nhẹ
  const existing = document.getElementById('prereq-toast');
  if (existing) existing.remove();
  const div = document.createElement('div');
  div.id = 'prereq-toast';
  div.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);z-index:9999;background:#1e293b;color:#fff;padding:14px 22px;border-radius:12px;font-size:14px;box-shadow:0 8px 30px rgba(0,0,0,.3);display:flex;align-items:center;gap:12px;max-width:420px;text-align:left';
  div.innerHTML = `
    <i class="fas fa-lock-keyhole" style="font-size:20px;color:#f59e0b;flex-shrink:0"></i>
    <div>
      <div style="font-weight:600;margin-bottom:3px">🔒 ${esc(title)}</div>
      <div style="font-size:12px;color:#94a3b8">${esc(msg)}</div>
    </div>
    <button onclick="this.closest('#prereq-toast').remove()" style="background:none;border:none;color:#94a3b8;cursor:pointer;font-size:16px;padding:0 0 0 8px;flex-shrink:0">✕</button>`;
  document.body.appendChild(div);
  setTimeout(() => div.remove(), 5000);
}

// ═══════════════════════════════════════════════════
// SOCRATIC AI TUTOR
// ═══════════════════════════════════════════════════

let _socraticOpen = false;
let _socraticArticleTitle = '';
let _currentDraftWordCount = 0; // theo dõi số từ học sinh đã viết (từ iframe postMessage)

function toggleSocraticPanel() {
  _socraticOpen = !_socraticOpen;
  const panel = document.getElementById('socratic-panel');
  if (panel) panel.style.display = _socraticOpen ? 'block' : 'none';
  if (_socraticOpen && !document.getElementById('socratic-messages').children.length) {
    _addSocraticMessage('system', '👋 Tôi là AI Tutor Socratic. Tôi sẽ không cho đáp án trực tiếp — chỉ đặt câu hỏi để dẫn dắt bạn tự tìm ra. Hãy hỏi tôi sau khi bạn đã đọc và suy nghĩ!');
  }
}

function _showAITutorBtn(articleTitle) {
  _socraticArticleTitle = articleTitle || '';
  const btn = document.getElementById('ai-tutor-btn');
  if (btn) btn.style.display = '';
  // Reset panel khi load bài mới
  _socraticOpen = false;
  const panel = document.getElementById('socratic-panel');
  if (panel) { panel.style.display = 'none'; }
  const msgs = document.getElementById('socratic-messages');
  if (msgs) msgs.innerHTML = '';
}

function _hideAITutorBtn() {
  const btn = document.getElementById('ai-tutor-btn');
  if (btn) btn.style.display = 'none';
  const panel = document.getElementById('socratic-panel');
  if (panel) panel.style.display = 'none';
  _socraticOpen = false;
}

function _addSocraticMessage(type, text) {
  const msgs = document.getElementById('socratic-messages');
  if (!msgs) return;
  const div = document.createElement('div');
  div.className = `socratic-msg ${type}`;
  div.textContent = text;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}

async function sendSocraticMessage() {
  const input = document.getElementById('socratic-input');
  const btn = document.getElementById('socratic-send-btn');
  const message = input?.value?.trim();
  if (!message) return;

  if (!isLoggedIn()) {
    _addSocraticMessage('system', '⚠️ Vui lòng đăng nhập để dùng AI Tutor.');
    return;
  }

  input.value = '';
  _addSocraticMessage('user', message);
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';

  try {
    const proxyBase = (PROXY_URL || 'https://api.gds.edu.vn').replace(/\/$/, '');
    const r = await fetch(`${proxyBase}/api/ai/socratic`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${getUser()?.token || ''}`,
      },
      body: JSON.stringify({
        message,
        articleTitle: _socraticArticleTitle,
        wordCount: _currentDraftWordCount || 60, // default pass nếu không track được
      }),
    });

    const data = await r.json();
    if (!r.ok) {
      _addSocraticMessage('system', `⚠️ ${data.error || 'Lỗi kết nối AI'}`);
    } else {
      _addSocraticMessage('ai', data.reply);
    }
  } catch(e) {
    _addSocraticMessage('system', '⚠️ Không kết nối được AI. Thử lại sau.');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-paper-plane"></i>';
  }
}

// Enter để gửi (Shift+Enter = xuống dòng)
document.addEventListener('DOMContentLoaded', () => {
  const input = document.getElementById('socratic-input');
  if (input) {
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendSocraticMessage(); }
    });
  }
});


// ═══════════════════════════════════════════════════
// EXAM VIEW (học sinh làm bài)
// ═══════════════════════════════════════════════════

let _examTimer = null;
let _examData = null;
let _examAnswers = {}; // { questionId: { sectionId, bankId, origIdx, optionId } }
let _examStartedFrom = 'home'; // để quay lại đúng chỗ

async function openExamView(examId) {
  if (!isLoggedIn()) { showLoginModal(false); return; }

  _examStartedFrom = document.getElementById('course-detail-view').style.display !== 'none' ? 'course' : 'home';
  _hideAllViews();
  const examBody = document.getElementById('exam-body');
  document.getElementById('exam-view').style.display = 'block';
  document.getElementById('content-area').classList.remove('article-mode');
  examBody.innerHTML = '<div style="text-align:center;padding:60px;color:#64748b"><i class="fas fa-spinner fa-spin fa-2x"></i><div style="margin-top:12px">Đang tải đề thi...</div></div>';
  document.getElementById('exam-tags').innerHTML = '';
  document.getElementById('exam-timer-display').style.display = 'none';
  history.pushState(null, '', `/exam/${examId}`);

  const proxyBase = (PROXY_URL || 'https://api.gds.edu.vn').replace(/\/$/, '');
  try {
    const r = await fetch(`${proxyBase}/api/exam/${examId}`, {
      headers: { 'Authorization': `Bearer ${getUser()?.token || ''}` }
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      examBody.innerHTML = `<div style="text-align:center;padding:60px;color:#dc2626"><i class="fas fa-exclamation-triangle fa-2x"></i><div style="margin-top:12px">${err.error || 'Không tải được đề thi'}</div></div>`;
      return;
    }
    _examData = await r.json();
    _examAnswers = {};
    document.getElementById('exam-view-title').textContent = _examData.title;
    document.getElementById('exam-view-meta').innerHTML =
      `<i class="fas fa-star" style="color:#f59e0b"></i> ${_examData.totalPoints} điểm &nbsp;·&nbsp; ` +
      `<i class="fas fa-check-circle" style="color:#16a34a"></i> Đạt ${_examData.passScore}% &nbsp;·&nbsp; ` +
      `<i class="fas fa-list-ol"></i> ${_examData.sections.reduce((s,sec) => s + sec.questions.length, 0)} câu`;
    document.getElementById('exam-tags').innerHTML = `<span class="article-hd-tag" style="background:#fef3c7;border-color:#fde68a;color:#92400e">📝 Đề thi</span>`;

    _renderExamQuestions();

    // Start timer nếu có TimeLimit
    if (_examData.timeLimit > 0) {
      let remaining = _examData.timeLimit * 60;
      document.getElementById('exam-timer-display').style.display = '';
      _updateTimerDisplay(remaining);
      _examTimer = setInterval(() => {
        remaining--;
        _updateTimerDisplay(remaining);
        if (remaining <= 0) {
          clearInterval(_examTimer);
          showToast('⏰ Hết thời gian! Đang nộp bài...', 'warn');
          _submitExam(examId, true);
        }
      }, 1000);
    }
  } catch(e) {
    examBody.innerHTML = `<div style="text-align:center;padding:60px;color:#dc2626">Lỗi: ${e.message}</div>`;
  }
}

function _updateTimerDisplay(seconds) {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = (seconds % 60).toString().padStart(2, '0');
  const el = document.getElementById('exam-timer-text');
  if (el) el.textContent = `${m}:${s}`;
  // Đỏ khi còn < 5 phút
  const wrap = document.getElementById('exam-timer-display');
  if (wrap) wrap.style.background = seconds < 300 ? '#fef2f2' : '#f0fdf4';
}

function _renderExamQuestions() {
  const body = document.getElementById('exam-body');
  if (!_examData?.sections?.length) {
    body.innerHTML = '<div style="padding:40px;text-align:center;color:#64748b">Đề thi không có câu hỏi.</div>';
    return;
  }

  let qCounter = 0;
  const examId = _examData.examId;
  let html = '';

  if (_examData.description) {
    html += `<div style="background:#f8fafc;border:1px solid var(--border);border-radius:10px;padding:14px 18px;margin-bottom:20px;font-size:14px;color:var(--text)">${esc(_examData.description)}</div>`;
  }

  _examData.sections.forEach(sec => {
    html += `<div class="exam-section-block">
      <div class="exam-sec-hd"><i class="fas fa-layer-group"></i> ${esc(sec.bankTitle)} <span class="exam-sec-pts">${sec.pointsPerQuestion} điểm/câu</span></div>`;

    sec.questions.forEach(q => {
      qCounter++;
      html += `<div class="exam-q-card" id="eq-${q.id}">
        <div class="exam-q-num">Câu ${qCounter} <span style="font-size:11px;color:#94a3b8">(${q.points} điểm)</span></div>
        <div class="exam-q-text">${esc(q.question)}</div>
        <div class="exam-q-options">
          ${(q.options || []).map(opt => `
            <label class="exam-option" id="eo-${q.id}-${opt.id}">
              <input type="radio" name="eq-${q.id}" value="${opt.id}"
                data-qid="${q.id}" data-sid="${sec.sectionId}" data-bid="${sec.bankId || ''}" data-origidx="${q.origIdx}"
                onchange="_recordAnswer('${q.id}', ${opt.id}, '${sec.sectionId}', ${q.origIdx})">
              <span>${esc(opt.text)}</span>
            </label>`).join('')}
        </div>
      </div>`;
    });
    html += '</div>';
  });

  html += `<div style="text-align:center;margin-top:32px;padding-bottom:24px">
    <button class="lm-btn" style="max-width:260px;margin:0 auto;background:linear-gradient(135deg,#2563eb,#1d4ed8)" onclick="_submitExam(${examId})">
      <i class="fas fa-paper-plane"></i> Nộp bài
    </button>
  </div>`;

  body.innerHTML = html;
}

function _recordAnswer(questionId, optionId, sectionId, origIdx) {
  _examAnswers[questionId] = { questionId, optionId, sectionId: parseInt(sectionId), origIdx };
  // Highlight selected option
  document.querySelectorAll(`[name="eq-${questionId}"]`).forEach(inp => {
    inp.closest('.exam-option')?.classList.toggle('selected', inp.value == optionId);
  });
}

async function _submitExam(examId, autoSubmit = false) {
  if (!autoSubmit) {
    const totalQ = _examData?.sections?.reduce((s, sec) => s + sec.questions.length, 0) || 0;
    const answered = Object.keys(_examAnswers).length;
    if (answered < totalQ) {
      if (!confirm(`Bạn còn ${totalQ - answered} câu chưa trả lời. Nộp bài ngay?`)) return;
    }
  }

  if (_examTimer) { clearInterval(_examTimer); _examTimer = null; }

  const answers = Object.values(_examAnswers);
  const proxyBase = (PROXY_URL || 'https://api.gds.edu.vn').replace(/\/$/, '');
  try {
    const r = await fetch(`${proxyBase}/api/exam/${examId}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getUser()?.token || ''}` },
      body: JSON.stringify({ answers, totalPoints: _examData?.totalPoints || 100 }),
    });
    const result = await r.json();
    if (!r.ok) { showToast(result.error || 'Lỗi nộp bài', 'error'); return; }
    _renderExamResult(result);
  } catch(e) {
    showToast('Lỗi kết nối khi nộp bài', 'error');
  }
}

function _renderExamResult(result) {
  const body = document.getElementById('exam-body');
  const passed = result.score >= (_examData?.passScore || 60);
  const icon = passed ? '🎉' : '📚';
  const color = passed ? '#16a34a' : '#dc2626';
  const bg = passed ? '#f0fdf4' : '#fef2f2';

  // Gom kết quả theo questionId
  const resultMap = {};
  (result.sectionResults || []).forEach(sec => {
    (sec.results || []).forEach(r => { resultMap[r.questionId] = r; });
  });

  let html = `
    <div style="text-align:center;padding:32px;background:${bg};border-radius:16px;margin-bottom:28px">
      <div style="font-size:48px;margin-bottom:8px">${icon}</div>
      <div style="font-size:36px;font-weight:800;color:${color}">${result.score}%</div>
      <div style="font-size:14px;color:var(--text-muted);margin-top:4px">${result.earnedPoints}/${result.totalPoints} điểm</div>
      <div style="margin-top:12px;font-size:15px;font-weight:600;color:${color}">${passed ? '✅ Đạt yêu cầu!' : '❌ Chưa đạt — Hãy ôn tập thêm!'}</div>
    </div>
    <h3 style="margin-bottom:16px">📋 Xem lại đáp án</h3>`;

  let qCounter = 0;
  _examData?.sections?.forEach(sec => {
    sec.questions.forEach(q => {
      qCounter++;
      const res = resultMap[q.id];
      const isCorrect = res?.isCorrect;
      html += `<div class="exam-q-card" style="border-color:${isCorrect ? '#86efac' : '#fca5a5'};background:${isCorrect ? '#f0fdf4' : '#fff7f7'}">
        <div class="exam-q-num" style="color:${isCorrect ? '#16a34a' : '#dc2626'}">
          ${isCorrect ? '✅' : '❌'} Câu ${qCounter}
        </div>
        <div class="exam-q-text">${esc(q.question)}</div>
        <div class="exam-q-options">
          ${(q.options || []).map(opt => {
            const isSelected = _examAnswers[q.id]?.optionId === opt.id;
            const isAnswerCorrect = res?.correctOptionId === opt.id;
            let cls = 'exam-option';
            let style = '';
            if (isAnswerCorrect) { cls += ' correct'; style = 'background:#dcfce7;border-color:#86efac'; }
            else if (isSelected && !isAnswerCorrect) { cls += ' wrong'; style = 'background:#fee2e2;border-color:#fca5a5'; }
            return `<label class="${cls}" style="${style}">
              <span>${isAnswerCorrect ? '✓' : (isSelected ? '✗' : '○')}</span>
              <span>${esc(opt.text)}</span>
            </label>`;
          }).join('')}
        </div>
        ${res?.explanation ? `<div class="exam-explanation"><i class="fas fa-lightbulb" style="color:#f59e0b"></i> ${esc(res.explanation)}</div>` : ''}
      </div>`;
    });
  });

  html += `<div style="text-align:center;margin-top:28px">
    <button class="back-btn" onclick="closeExamView()" style="margin:0 auto;display:inline-flex">
      <i class="fas fa-arrow-left"></i> Quay lại khoá học
    </button>
  </div>`;

  body.innerHTML = html;
  document.getElementById('exam-timer-display').style.display = 'none';
  window.scrollTo(0, 0);
}

function closeExamView() {
  if (_examTimer) { clearInterval(_examTimer); _examTimer = null; }
  _examData = null;
  _examAnswers = {};
  document.getElementById('exam-view').style.display = 'none';
  // Quay lại đúng chỗ
  if (history.state?.courseId || window.location.pathname.startsWith('/course/')) {
    history.back();
  } else {
    showHome();
  }
}
