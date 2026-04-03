
// Auth được xử lý trong DOMContentLoaded bên dưới

// ═══════════════════════════════════════════════════
// SETTINGS & AUTH
// ═══════════════════════════════════════════════════
const CFG_KEY     = 'ae_config';
// TREE_KEY removed — indexTree không lưu local, luôn load từ NocoDB
const SESSION_KEY = 'ae_session';

function getCfg() {
  try { return JSON.parse(localStorage.getItem(CFG_KEY) || '{}'); }
  catch { return {}; }
}
function saveCfg(c) {
  try {
    localStorage.setItem(CFG_KEY, JSON.stringify(c));
  } catch(e) {
    // Quota exceeded hoặc private browsing block
    console.warn('[CFG] localStorage unavailable:', e.message);
    showToast('⚠️ Không lưu được cấu hình (localStorage đầy)', 'warn');
  }
}

function getDefaultCfg() {
  return { token:'', repo:'', branch:'main', contentDir:'content', title:'ActiveEdu', url:'', adminUser:'admin', adminPass:'', proxyUrl:'https://api.gds.edu.vn' };
}
function cfg() { return { ...getDefaultCfg(), ...getCfg() }; }

// ── Auth ──
const ADMIN_USER = 'admin';

// ── Rate limiting: chống brute-force login ──
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MS   = 15 * 60 * 1000; // 15 phút
const LOGIN_ATTEMPT_KEY  = 'ae_login_attempts';
const LOGIN_LOCKOUT_KEY  = 'ae_login_lockout';

function _getLoginAttempts() {
  try { return parseInt(sessionStorage.getItem(LOGIN_ATTEMPT_KEY) || '0'); } catch { return 0; }
}
function _incLoginAttempts() {
  const n = _getLoginAttempts() + 1;
  sessionStorage.setItem(LOGIN_ATTEMPT_KEY, n);
  if (n >= LOGIN_MAX_ATTEMPTS) {
    sessionStorage.setItem(LOGIN_LOCKOUT_KEY, Date.now() + LOGIN_LOCKOUT_MS);
  }
  return n;
}
function _resetLoginAttempts() {
  sessionStorage.removeItem(LOGIN_ATTEMPT_KEY);
  sessionStorage.removeItem(LOGIN_LOCKOUT_KEY);
}
function _checkLoginLocked() {
  const until = parseInt(sessionStorage.getItem(LOGIN_LOCKOUT_KEY) || '0');
  if (!until) return null;
  const remaining = until - Date.now();
  if (remaining <= 0) { _resetLoginAttempts(); return null; }
  return Math.ceil(remaining / 60000); // số phút còn lại
}

async function doLogin() {
  const u = document.getElementById('login-user').value.trim();
  const p = document.getElementById('login-pass').value.trim();
  const btn = document.querySelector('#login-screen button');
  const errEl = document.getElementById('login-err');
  errEl.style.display = 'none';

  // ── Kiểm tra lockout ──
  const lockedMinutes = _checkLoginLocked();
  if (lockedMinutes !== null) {
    errEl.textContent = `🔒 Tài khoản tạm khóa. Thử lại sau ${lockedMinutes} phút.`;
    errEl.style.display = 'block';
    if (btn) btn.disabled = true;
    return;
  }

  if (!u || !p) {
    errEl.textContent = 'Vui lòng nhập đầy đủ!';
    errEl.style.display = 'block';
    return;
  }

  if (btn) { btn.disabled = true; btn.textContent = 'Đang xác thực...'; }

  try {
    // Xác thực qua /admin/auth → nhận session token (8h)
    const proxyUrl = cfg().proxyUrl || 'https://api.gds.edu.vn';
    const r = await fetch(`${proxyUrl}/admin/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: p }),
    });

    if (r.status === 401) {
      const attempts = _incLoginAttempts();
      const remaining = LOGIN_MAX_ATTEMPTS - attempts;
      if (remaining <= 0) {
        errEl.textContent = `🔒 Sai mật khẩu quá nhiều lần. Tài khoản bị khóa 15 phút!`;
        if (btn) btn.disabled = true;
      } else {
        errEl.textContent = `Sai mật khẩu! Còn ${remaining} lần thử.`;
        if (btn) { btn.disabled = false; btn.textContent = 'Đăng nhập →'; }
      }
      errEl.style.display = 'block';
      return;
    }

    if (r.status === 429) {
      errEl.textContent = '⏳ Quá nhiều yêu cầu. Vui lòng đợi rồi thử lại!';
      errEl.style.display = 'block';
      if (btn) { btn.disabled = false; btn.textContent = 'Đăng nhập →'; }
      return;
    }

    if (!r.ok) {
      errEl.textContent = 'Lỗi kết nối Worker. Thử lại sau!';
      errEl.style.display = 'block';
      return;
    }

    const authData = await r.json();
    // Đăng nhập thành công → lưu token (không lưu password)
    _resetLoginAttempts();
    sessionStorage.setItem('ae_auth', '1');
    sessionStorage.setItem('ae_admin_token', authData.token || '');
    // Giữ password tạm để fallback nếu worker cũ chưa có /admin/auth
    sessionStorage.setItem('ae_admin_pass', p);
    document.getElementById('login-screen').style.display = 'none';
    initAdmin();

  } catch(e) {
    errEl.textContent = 'Lỗi kết nối: ' + e.message;
    errEl.style.display = 'block';
  } finally {
    const stillLocked = _checkLoginLocked() !== null;
    if (btn && !stillLocked) { btn.disabled = false; btn.textContent = 'Đăng nhập →'; }
  }
}

function doLogout() {
  sessionStorage.removeItem('ae_auth');
  sessionStorage.removeItem('ae_admin_pass');
  sessionStorage.removeItem('ae_admin_token');
  location.reload();
}

// ═══════════════════════════════════════════════════
// TREE RENDER
// ═══════════════════════════════════════════════════


// ═══════════════════════════════════════════════════
// GITHUB API — DEPRECATED (không còn dùng)
// NocoDB là source of truth, rebuildAndPushIndex() là no-op.
// Giữ lại phòng trường hợp muốn restore tính năng sync GitHub.
// TODO: Xóa hoàn toàn khi confirm không cần sync GH nữa.
// ═══════════════════════════════════════════════════
/* const GH = {
  base: 'https://api.github.com',

  headers() {
    const c = cfg();
    return { 'Authorization': `Bearer ${c.token}`, 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json' };
  },

  async getFile(path) {
    const c = cfg();
    const url = `${this.base}/repos/${c.repo}/contents/${path}?ref=${c.branch}&t=${Date.now()}`;
    const r = await fetch(url, { headers: this.headers() });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`GitHub ${r.status}: ${await r.text()}`);
    const d = await r.json();
    const raw = d.content.replace(/\n/g,'');
    let decoded;
    try { decoded = decodeURIComponent(atob(raw).split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join('')); }
    catch { decoded = atob(raw); }
    return { content: decoded, sha: d.sha, path: d.path };
  },

  async putFile(path, content, message, sha = null) {
    const c = cfg();
    const url = `${this.base}/repos/${c.repo}/contents/${path}`;
    const body = { message, content: btoa(unescape(encodeURIComponent(content))), branch: c.branch };
    if (sha) body.sha = sha;
    const r = await fetch(url, { method: 'PUT', headers: this.headers(), body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`GitHub ${r.status}: ${await r.text()}`);
    return await r.json();
  },

  async deleteFile(path, sha, message) {
    const c = cfg();
    const url = `${this.base}/repos/${c.repo}/contents/${path}`;
    const body = { message, sha, branch: c.branch };
    const r = await fetch(url, { method: 'DELETE', headers: this.headers(), body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`GitHub ${r.status}: ${await r.text()}`);
    return true;
  },

  async listDir(path) {
    const c = cfg();
    const url = `${this.base}/repos/${c.repo}/contents/${path}?ref=${c.branch}&t=${Date.now()}`;
    const r = await fetch(url, { headers: this.headers() });
    if (r.status === 404) return [];
    if (!r.ok) throw new Error(`GitHub ${r.status}`);
    return await r.json();
  },

  async getTree() {
    const c = cfg();
    const url = `${this.base}/repos/${c.repo}/git/trees/${c.branch}?recursive=1&t=${Date.now()}`;
    const r = await fetch(url, { headers: this.headers() });
    if (!r.ok) throw new Error(`GitHub tree ${r.status}`);
    const d = await r.json();
    const dir = c.contentDir || 'content';
    return d.tree.filter(i => i.path.startsWith(dir + '/') && i.path !== dir + '/index.json');
  },

  async test() {
    const c = cfg();
    const url = `${this.base}/repos/${c.repo}`;
    const r = await fetch(url, { headers: this.headers() });
    if (!r.ok) throw new Error(`${r.status}`);
    return await r.json();
  }
}; */

// ═══════════════════════════════════════════════════
// TREE STATE — rebuilt from GitHub on every sync
// ═══════════════════════════════════════════════════
let ghTree   = [];   // raw GitHub tree items
let indexTree = [];  // structured tree for index.json

// ── setIndexTree: cập nhật indexTree và sync tất cả panels ──
// Gọi hàm này MỌI LÚC muốn thay đổi indexTree
function setIndexTree(tree) {
  indexTree = tree;
  // Không lưu local — indexTree luôn từ NocoDB/GitHub
  _syncAllPanels();
}

// Cập nhật indexTree tại chỗ rồi broadcast
function commitIndexTree() {
  // Không lưu local — chỉ sync panels trong memory
  _syncAllPanels();
}

// Broadcast thay đổi đến tất cả panels
function _syncAllPanels() {
  renderUnifiedTree(indexTree);  // Unified tree (Soạn thảo)
  updateDashboard();             // Dashboard
  updateFolderSelects();         // Editor - folder dropdown
  // NocoDB panel: chỉ reload nếu đang active (tránh request thừa)
}
let fileShaMap = {}; // path → sha (for updates)
let selectedFolder = '';
let currentEditPath  = null;
let isDirty = false;

// Convert flat GitHub tree → nested tree for index.json
function buildIndexTree(ghItems) {
  const c = cfg();
  const dir = (c.contentDir || 'content') + '/';

  // Build nested folder map đúng cấp bậc
  const folderMap = {}; // path -> folder node

  // Pass 1: tạo tất cả folder nodes (mọi cấp)
  ghItems
    .filter(i => i.type === 'tree')
    .sort((a, b) => a.path.length - b.path.length) // xử lý cha trước con
    .forEach(i => {
      const rel = i.path.slice(dir.length);
      if (!rel) return;
      const parts = rel.split('/');
      const name  = parts[parts.length - 1];
      folderMap[rel] = { type:'folder', name, path:rel, folderPath:rel, children:[], access:'public' };
    });

  // Pass 2: lồng folder vào đúng cha
  const root = [];
  Object.entries(folderMap).forEach(([rel, node]) => {
    const parts = rel.split('/');
    if (parts.length === 1) {
      root.push(node); // folder gốc
    } else {
      const parentPath = parts.slice(0, -1).join('/');
      const parent = folderMap[parentPath];
      if (parent) {
        parent.children.push(node);
      } else {
        root.push(node); // fallback
      }
    }
  });

  // Pass 3: thêm files vào đúng folder
  const rootFiles = [];
  ghItems.filter(i => i.type === 'blob' && i.path.endsWith('.html')).forEach(i => {
    const rel      = i.path.slice(dir.length);
    const parts    = rel.split('/');
    const fileName = parts[parts.length - 1];
    const folderRel = parts.length > 1 ? parts.slice(0, -1).join('/') : '';
    const name = fileNameToTitle(fileName);

    const cached = fileShaMap['_access_' + (dir + rel)];
    const item = {
      type: 'file', name,
      path: rel,
      folder: folderRel,
      description: '',
      access: cached || 'public',
      updated: new Date().toISOString().split('T')[0],
      sha: i.sha
    };
    fileShaMap[dir + rel] = i.sha;
    const prevItem = flattenFiles(indexTree||[]).find(x => x.path === rel);
    if (prevItem && prevItem.access) fileShaMap['_access_' + (dir + rel)] = prevItem.access;

    if (folderRel && folderMap[folderRel]) {
      folderMap[folderRel].children.push(item);
    } else {
      rootFiles.push(item);
    }
  });

  return [...root, ...rootFiles];
}

function fileNameToTitle(fileName) {
  return fileName.replace('.html','').replace(/-/g,' ').replace(/(^|\s)\S/g, t => t.toUpperCase());
}

// Sync: read GitHub tree → update local state → re-render
async function syncFromGitHub() {
  if (!cfg().token || !cfg().repo) {
    showToast('Chưa cấu hình GitHub!', 'warn');
    showPanel('settings', document.querySelectorAll('.sb-item')[3]);
    return;
  }
  setSyncBar(true, 'Đang đọc cây thư mục từ GitHub...');
  showLoading('Đồng bộ từ GitHub...');
  try {
    ghTree = await GH.getTree();
    setIndexTree(buildIndexTree(ghTree));
    setSyncBar(false, `✓ Đồng bộ xong — ${flattenFiles(indexTree).length} bài viết`, new Date().toLocaleTimeString('vi-VN'));
    updateGhStatus(true);
    showToast(`✓ Đồng bộ xong! ${flattenFiles(indexTree).length} bài`, 'success');

    // Also update index.json on GitHub
    await rebuildAndPushIndex();
  } catch(e) {
    setSyncBar(false, '✗ Lỗi: ' + e.message, '', true);
    showToast('Lỗi GitHub: ' + e.message, 'error');
    updateGhStatus(false);
  } finally { hideLoading(); }
}

// Push index.json to GitHub
async function pushIndexToGitHub() {
  if (!indexTree.length) { showToast('Chưa có dữ liệu để đẩy!', 'warn'); return; }
  showLoading('Đẩy index.json lên GitHub...');
  try {
    await rebuildAndPushIndex();
    showToast('✓ Đã đẩy index.json lên GitHub!', 'success');
  } catch(e) {
    showToast('Lỗi: ' + e.message, 'error');
  } finally { hideLoading(); }
}

async function rebuildAndPushIndex() {
  // NocoDB is source of truth — no-op
  return;
}
// ═══════════════════════════════════════════════════
// CREATE FOLDER / FILE
// ═══════════════════════════════════════════════════
let createMode = 'file';

function showNewFolder() {
  createMode = 'folder';
  document.getElementById('modal-title').textContent = '📁 Tạo thư mục mới';
  document.getElementById('modal-label').textContent = 'Tên thư mục';
  document.getElementById('modal-name').placeholder = 'vd: Chương 1, Đại số...';
  document.getElementById('modal-parent-group').style.display = 'block';
  document.getElementById('modal-note').textContent = 'Thư mục sẽ được lưu vào NocoDB Folders table.';
  populateParentModal(true);
  // Auto-select folder đang active trong cây (nếu có)
  if (selectedFolder) setTimeout(() => autoSelectModalFolder(selectedFolder), 200);
  document.getElementById('modal-name').value = '';
  document.getElementById('modal-create').classList.add('show');
  setTimeout(() => document.getElementById('modal-name').focus(), 100);
}

function showNewFile() {
  createMode = 'file';
  document.getElementById('modal-title').textContent = '📄 Tạo tệp bài học mới';
  document.getElementById('modal-label').textContent = 'Tên bài học';
  document.getElementById('modal-name').placeholder = 'vd: Bài 1 - Giới thiệu...';
  document.getElementById('modal-parent-group').style.display = 'block';
  document.getElementById('modal-note').textContent = 'Bài sẽ được lưu vào NocoDB khi bạn nhấn Lưu trong Soạn thảo.';
  populateParentModal(false);
  // Auto-chọn thư mục đang chọn trong cây bên trái
  if (selectedFolder) setTimeout(() => autoSelectModalFolder(selectedFolder), 200);
  document.getElementById('modal-name').value = '';
  document.getElementById('modal-create').classList.add('show');
  setTimeout(() => document.getElementById('modal-name').focus(), 100);
}

function populateParentModal(forFolder = false) {
  // Đổi label theo mode
  const lbl = document.getElementById('modal-parent-label');
  if (lbl) lbl.textContent = forFolder ? 'Thư mục cha (tuỳ chọn)' : 'Thư mục chứa bài';

  // Reset selection
  document.getElementById('modal-parent').value = '';
  document.getElementById('modal-selected-path').innerHTML = '<i class="fas fa-folder-open"></i> (gốc)';

  // Render tree
  renderModalTree(indexTree, document.getElementById('modal-tree-body'), '');

  // Fallback từ NocoDB nếu indexTree rỗng
  if (!indexTree || !indexTree.length) {
    NOCO.listFolders().then(data => {
      const folders = (data.list||[]).map(f => ({
        type:'folder', name:f.Name||f.Path.split('/').pop(),
        path:f.Path, folderPath:f.Path, children:[]
      }));
      renderModalTree(folders, document.getElementById('modal-tree-body'), '');
    }).catch(()=>{});
  }
}


// Auto-select folder trong modal tree theo path
function autoSelectModalFolder(targetPath) {
  if (!targetPath) return;
  const parts = targetPath.split('/');
  let container = document.getElementById('modal-tree-body');
  // Mở từng cấp thư mục theo path
  for (let i = 0; i < parts.length; i++) {
    if (!container) break;
    const partPath = parts.slice(0, i + 1).join('/');
    const folders = container.querySelectorAll(':scope > .modal-tree-folder');
    for (const wrap of folders) {
      const hd = wrap.querySelector('.modal-tree-folder-hd');
      const label = hd?.querySelector('span');
      if (label && label.textContent.trim() === parts[i]) {
        if (i < parts.length - 1) {
          // Mở folder trung gian
          wrap.classList.add('open');
          container = wrap.querySelector('.modal-tree-folder-children');
        } else {
          // Chọn folder đích
          modalSelectFolder(partPath, wrap);
        }
        break;
      }
    }
  }
}

function renderModalTree(items, container, parentPath, depth) {
  if (!container) return;
  depth = depth || 0;
  container.innerHTML = '';
  (items||[]).forEach(item => {
    if (item.type !== 'folder') return;
    const folderPath = parentPath ? parentPath + '/' + item.name : item.name;
    const childFolders = (item.children||[]).filter(c => c.type === 'folder');
    const hasChildren = childFolders.length > 0;

    const wrap = document.createElement('div');
    wrap.className = 'modal-tree-folder';

    const hd = document.createElement('div');
    hd.className = 'modal-tree-folder-hd';
    hd.onclick = () => modalSelectFolder(folderPath, wrap);

    if (hasChildren) {
      const arrow = document.createElement('i');
      arrow.className = 'fas fa-chevron-right';
      arrow.style.cssText = 'font-size:9px;color:#94a3b8;transition:transform .15s;flex-shrink:0';
      arrow.onclick = (e) => { e.stopPropagation(); wrap.classList.toggle('open'); };
      hd.appendChild(arrow);
    } else {
      const spacer = document.createElement('span');
      spacer.style.cssText = 'width:13px;display:inline-block;flex-shrink:0';
      hd.appendChild(spacer);
    }

    const icon = document.createElement('i');
    // Màu folder theo depth
    const colors = ['#3b82f6','#6366f1','#0ea5e9','#14b8a6'];
    icon.className = 'fas fa-folder';
    icon.style.cssText = `color:${colors[depth % colors.length]};font-size:13px;flex-shrink:0`;
    hd.appendChild(icon);

    const label = document.createElement('span');
    label.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    label.textContent = item.name;
    hd.appendChild(label);

    const children = document.createElement('div');
    children.className = 'modal-tree-folder-children';

    wrap.appendChild(hd);
    wrap.appendChild(children);

    if (hasChildren) {
      renderModalTree(item.children||[], children, folderPath, depth + 1);
    }
    container.appendChild(wrap);
  });
}

function modalSelectFolder(path, folderEl) {
  // Bỏ chọn cũ
  document.querySelectorAll('#modal-tree-body .modal-tree-folder-hd.selected').forEach(el => el.classList.remove('selected'));
  folderEl.querySelector('.modal-tree-folder-hd').classList.add('selected');
  document.getElementById('modal-parent').value = path;
  const display = path.replace(/\//g, ' › ');
  document.getElementById('modal-selected-path').innerHTML =
    `<i class="fas fa-folder-open" style="color:#3b82f6"></i> ${display}`;
}

function modalSelectRoot() {
  document.querySelectorAll('#modal-tree-body .modal-tree-folder-hd.selected').forEach(el => el.classList.remove('selected'));
  document.getElementById('modal-parent').value = '';
  document.getElementById('modal-selected-path').innerHTML = '<i class="fas fa-folder-open"></i> (gốc)';
}

function closeModal() { document.querySelectorAll('.modal-overlay').forEach(m => m.classList.remove('show')); }

async function confirmCreate() {
  const name = document.getElementById('modal-name').value.trim();
  if (!name) { showToast('Nhập tên!', 'warn'); return; }

  if (createMode === 'folder') {
    const parentPath = document.getElementById('modal-parent').value;
    function findTarget(items, path) {
      if (!path) return items;
      const parts = path.split('/');
      let node = items;
      for (const part of parts) {
        const found = node.find(i => i.type === 'folder' && i.name === part);
        if (!found) return null;
        node = found.children || (found.children = []);
      }
      return node;
    }
    const target = findTarget(indexTree, parentPath) || indexTree;
    if (target.find && target.find(i => i.type === 'folder' && i.name === name)) {
      showToast('Thư mục đã tồn tại!', 'warn'); return;
    }
    const folderPath = parentPath ? parentPath + '/' + name : name;
    const depth = folderPath.split('/').length;

    // Hiển thị loading trong khi lưu NocoDB
    closeModal();
    showLoading(`Đang tạo thư mục "${name}"...`);
    try {
      // ── LUÔN lưu NocoDB TRƯỚC ──────────────────────────
      // Đảm bảo folder cha đã tồn tại trong NocoDB (cần cho cấp 3+)
      if (parentPath) {
        const existingFolders = await NOCO.listFolders();
        const parentInDB = (existingFolders.list || []).find(f =>
          f.Path === parentPath || f.Name === parentPath
        );
        if (!parentInDB) {
          // Folder cha chưa có trong DB → tạo folder cha trước (đệ quy)
          const parts = parentPath.split('/');
          for (let i = 1; i <= parts.length; i++) {
            const ancestorPath = parts.slice(0, i).join('/');
            const ancestorName = parts[i - 1];
            const ancestorParent = i > 1 ? parts.slice(0, i - 1).join('/') : '';
            const alreadyExists = (existingFolders.list || []).find(f => f.Path === ancestorPath);
            if (!alreadyExists) {
              await NOCO.createFolder({
                Name: ancestorName,
                Path: ancestorPath,
                Parent: ancestorParent,
                Access: 'public'
              });
            }
          }
        }
      }
      // Tạo folder hiện tại vào NocoDB
      await NOCO.createFolder({
        Name: name,
        Path: folderPath,
        Parent: parentPath || '',
        Access: 'public'
      });
      // ── Chỉ cập nhật local tree SAU KHI NocoDB thành công ──
      target.push({ type:'folder', name, path: folderPath, folderPath, access:'public', children:[] });
      selectedFolder = folderPath;
      commitIndexTree();
      showToast(
        depth >= 3
          ? `✓ Đã tạo thư mục cấp ${depth} "${name}" và lưu NocoDB!`
          : `✓ Đã tạo thư mục "${name}"!`,
        'success'
      );
    } catch(e) {
      // NocoDB fail → KHÔNG cập nhật local tree → không mất toàn vẹn
      showToast(`✗ Lỗi tạo thư mục: ${e.message}`, 'error');
    } finally {
      hideLoading();
    }
  } else {
    const folder = document.getElementById('modal-parent').value;
    closeModal();
    // Chuyển sang editor, điền sẵn tên + thư mục
    _activatePanel('editor');
    setTimeout(() => {
      initCodeMirror();
      if (cmEditor) cmEditor.refresh();
      currentEditPath = null;
      document.getElementById('e-title').value  = name;
      document.getElementById('e-folder').value = folder;
      document.getElementById('e-desc').value   = '';
      document.getElementById('e-access').value = 'public';
      document.getElementById('e-path-label').innerHTML =
        `<i class="fas fa-file-plus" style="color:var(--primary)"></i> Bài mới — chưa lưu`;
      // Nội dung mẫu ban đầu
      const initHtml = `<h2>${name}</h2><p>Nội dung bài học...</p>`;
      if (cmEditor) cmEditor.setValue(initHtml);
      initTinyMCE(initHtml);
      editorTab = 'rich';
      isDirty = true;
      markDirty();
      document.getElementById('save-status').textContent = 'Bài mới — chưa lưu';
      // Focus vào title để user nhập ngay
      setTimeout(() => document.getElementById('e-title').select(), 50);
    }, 80);
  }
}

// ═══════════════════════════════════════════════════
// DELETE
// ═══════════════════════════════════════════════════

// ── Toggle access thư mục (public ↔ private) ──
async function toggleFolderAccess(folderPath, currentAccess) {
  const newAccess = currentAccess === 'private' ? 'public' : 'private';

  // Cập nhật indexTree
  function findAndUpdate(items, path) {
    for (const item of items) {
      if (item.type === 'folder') {
        if (item.folderPath === path || item.path === path) {
          item.access = newAccess;
          return true;
        }
        if (findAndUpdate(item.children||[], path)) return true;
      }
    }
    return false;
  }
  findAndUpdate(indexTree, folderPath);

  // Cập nhật NocoDB Folders table
  try {
    const fData = await NOCO.listFolders();
    const folder = (fData.list||[]).find(f =>
      f.Path === folderPath || f.Name === folderPath
    );
    if (folder) {
      await NOCO.call('folders', '', 'PATCH',
        [{ Id: folder.Id, Access: newAccess }]);
    }
    commitIndexTree();
    showToast(`✓ Đã đổi quyền thư mục thành ${newAccess === 'private' ? '🔒 Private' : '🌐 Public'}`, 'success');
  } catch(e) {
    showToast('Lỗi đổi quyền: ' + e.message, 'error');
    commitIndexTree();
  }
}

// ── Toggle access bài viết (public ↔ private) ──
// ── ID-first helper: lấy NocoDB row Id từ path, ưu tiên nocoId trong indexTree ──
async function _getNocoId(path) {
  if (!path) return null;
  const item = flattenFiles(indexTree).find(f => f.path === path);
  if (item?.nocoId) return item.nocoId;
  // Fallback: query by path
  try {
    const ep = path.replace(/"/g, '\\"');
    const data = await NOCO.listRecords({ where: `(Path,eq,"${ep}")`, limit: 1 });
    const row = (data.list || [])[0];
    if (row?.Id) {
      if (item) item.nocoId = row.Id; // cache vào tree
      return row.Id;
    }
  } catch(e) { console.warn('[_getNocoId] fallback query failed:', e.message); }
  return null;
}

async function toggleFileAccess(filePath, currentAccess) {
  const newAccess = currentAccess === 'private' ? 'public' : 'private';

  // Cập nhật indexTree
  function findAndUpdate(items) {
    for (const item of items) {
      if (item.type === 'file' && item.path === filePath) {
        item.access = newAccess; return true;
      }
      if (item.type === 'folder' && findAndUpdate(item.children||[])) return true;
    }
    return false;
  }
  findAndUpdate(indexTree);

  // Cập nhật NocoDB Articles table
  try {
    const rowId = await _getNocoId(filePath);
    if (rowId) {
      await NOCO.updateRecord(rowId, { Access: newAccess });
    }
    commitIndexTree();
    showToast(`✓ Đã đổi quyền bài thành ${newAccess === 'private' ? '🔒 Private' : '🌐 Public'}`, 'success');
  } catch(e) {
    showToast('Lỗi đổi quyền: ' + e.message, 'error');
    commitIndexTree();
  }
}

async function confirmDeleteFile(path) {
  if (!path) { showToast('Bài này chưa có Path — xóa trực tiếp trong NocoDB.', 'warn'); return; }
  if (!confirm(`Xóa bài "${path}" khỏi NocoDB?`)) return;
  showLoading('Đang xóa trong NocoDB...');
  try {
    const rowId = await _getNocoId(path);
    if (!rowId) { showToast('Bài không tồn tại trong NocoDB', 'warn'); hideLoading(); return; }
    await NOCO.deleteRecord(rowId);
    // CASCADE: xóa permissions liên quan đến bài này
    if (true) { // proxy handles permissions
      try {
        const perms = await NOCO.call('permissions', '', 'GET', undefined,
          `where=${encodeURIComponent('(TargetPath,eq,"' + path + '")')}&limit=100`);
        for (const p of (perms.list||[])) {
          await NOCO.call('permissions', '', 'DELETE', [{Id: p.Id}]);
        }
      } catch(e) { console.warn('Permission cascade on article delete:', e.message); }
    }
    removeFromTree(indexTree, path);
    commitIndexTree();
    // Reset editor nếu đang mở bài vừa xóa
    if (currentEditPath === path) {
      currentEditPath = null;
      document.getElementById('e-title').value = '';
      document.getElementById('e-path-label').innerHTML = '<i class="fas fa-file"></i> Bài mới';
      setEditorHTML('');
      isDirty = false;
      document.getElementById('save-status').textContent = 'Bài đã xóa';
    }
    showToast('✓ Đã xóa bài và quyền liên quan!', 'success');
  } catch(e) {
    showToast('Lỗi xóa: ' + e.message, 'error');
  } finally { hideLoading(); }
}

// ── Xóa bản ghi NocoDB trực tiếp bằng Id (dùng cho bài không có Path) ──
async function confirmDeleteById(rowId, label) {
  if (!confirm(`Xóa bản ghi "${label}" (Id: ${rowId}) khỏi NocoDB?\nBản ghi này không có Path nên không thể sửa.`)) return;
  showLoading('Đang xóa...');
  try {
    await NOCO.deleteRecord(rowId);
    showToast('✓ Đã xóa bản ghi rác!', 'success');
    await syncFromNoco();
  } catch(e) {
    showToast('Lỗi xóa: ' + e.message, 'error');
  } finally { hideLoading(); }
}

function renameFolder(folderPath, currentName) {
  // Tìm span tên folder trong DOM để inline edit (Windows Explorer style)
  const allHds = document.querySelectorAll('.tree-folder-hd');
  let targetSpan = null;
  let targetHd = null;
  for (const hd of allHds) {
    // Tìm hd chứa button có onclick khớp folderPath
    const btn = hd.querySelector('.tree-act-btn[title="Đổi tên"]');
    if (btn && btn.getAttribute('onclick').includes(folderPath.replace(/'/g,"\'"))) {
      targetSpan = hd.querySelector('span[style*="flex:1"]') || hd.querySelector('span');
      targetHd = hd;
      break;
    }
  }
  if (!targetSpan || !targetHd) {
    // Fallback: prompt nếu không tìm thấy DOM element
    const newName = prompt('Đổi tên thư mục:', currentName);
    if (newName && newName.trim() && newName.trim() !== currentName)
      doRenameFolder(folderPath, currentName, newName.trim());
    return;
  }

  // Tạo input thay thế span
  const input = document.createElement('input');
  input.className = 'tree-rename-input';
  input.value = currentName;
  input.setAttribute('data-old-path', folderPath);

  // Ẩn các element khác trong hd, hiện input
  const hiddenEls = [];
  for (const child of targetHd.children) {
    if (child !== targetSpan && !child.classList.contains('tree-actions')) {
      // Giữ icon folder và chevron, ẩn các actions
    }
  }
  targetSpan.replaceWith(input);
  targetHd.onclick = null; // tạm tắt toggle khi đang edit
  input.focus();
  input.select();

  // Xử lý confirm: Enter hoặc blur
  const confirmRename = async () => {
    const newName = input.value.trim();
    input.removeEventListener('blur', onBlur);
    // Khôi phục span
    const span = document.createElement('span');
    span.style.flex = '1';
    span.textContent = newName || currentName;
    input.replaceWith(span);
    // Khôi phục onclick
    targetHd.onclick = (e) => {
      targetHd.parentElement.classList.toggle('open');
      selectFolder(folderPath, targetHd);
    };
    if (!newName || newName === currentName) return;
    await doRenameFolder(folderPath, currentName, newName);
  };

  const onBlur = () => confirmRename();
  const onKey = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); confirmRename(); }
    if (e.key === 'Escape') {
      input.removeEventListener('blur', onBlur);
      const span = document.createElement('span');
      span.style.flex = '1';
      span.textContent = currentName;
      input.replaceWith(span);
      targetHd.onclick = () => { targetHd.parentElement.classList.toggle('open'); selectFolder(folderPath, targetHd); };
    }
  };
  input.addEventListener('blur', onBlur);
  input.addEventListener('keydown', onKey);
}

async function doRenameFolder(folderPath, currentName, newName) {
  function findAndRename(items, path) {
    for (const item of items) {
      if (item.type === 'folder') {
        if (item.folderPath === path || item.path === path) {
          const oldPath = item.folderPath || item.path;
          const parentPath = oldPath.split('/').slice(0,-1).join('/');
          const newPath = parentPath ? parentPath + '/' + newName : newName;
          item.name = newName;
          item.folderPath = newPath;
          item.path = newPath;
          return { oldPath, newPath };
        }
        const found = findAndRename(item.children||[], path);
        if (found) return found;
      }
    }
    return null;
  }

  const result = findAndRename(indexTree, folderPath);
  if (!result) { showToast('Không tìm thấy thư mục!', 'warn'); return; }

  showLoading('Đang đổi tên thư mục...');
  try {
    const fData = await NOCO.listFolders();
    const allFolders = fData.list || [];
    // Match linh hoạt: Path, Name, hoặc kết hợp
    const folder = allFolders.find(f =>
      f.Path === result.oldPath ||
      f.Name === result.oldPath ||
      f.Path === folderPath ||
      f.Name === folderPath ||
      f.Name === currentName && (f.Path||'').endsWith(currentName)
    );
    if (folder) {
      await NOCO.call('folders', '', 'PATCH',
        [{ Id: folder.Id, Name: newName, Path: result.newPath }]);
      commitIndexTree();
      // Cập nhật currentEditPath nếu bài đang mở nằm trong folder vừa rename
      if (currentEditPath && result && currentEditPath.startsWith(result.oldPath + '/')) {
        currentEditPath = result.newPath + currentEditPath.slice(result.oldPath.length);
        const lbl = document.getElementById('e-path-label');
        if (lbl) lbl.innerHTML = `<i class="fas fa-file-lines" style="color:var(--primary)"></i> ${currentEditPath}`;
      }
      showToast(`✓ Đã đổi tên thành "${newName}"`, 'success');
    } else {
      console.warn('[rename] Folder không có trong NocoDB, chỉ đổi tên local:', folderPath);
      commitIndexTree();
      showToast(`✓ Đã đổi tên thành "${newName}" (chỉ local)`, 'warn');
    }
  } catch(e) {
    showToast('Lỗi đổi tên: ' + e.message, 'error');
    commitIndexTree();
  } finally { hideLoading(); }
}

async function confirmDeleteFolder(folderPath) {
  // Tìm folder node trong indexTree theo path
  function findFolderByPath(items, path) {
    for (const i of items) {
      if (i.type === 'folder') {
        if (i.path === path || i.folderPath === path) return i;
        const found = findFolderByPath(i.children||[], path);
        if (found) return found;
      }
    }
    return null;
  }
  const folder = findFolderByPath(indexTree, folderPath);
  const files = folder ? flattenFiles(folder.children||[]) : [];
  const subFolders = folder ? flattenFolders(folder.children||[]) : [];
  const name = folder?.name || folderPath.split('/').pop();

  // Cảnh báo nếu có bài viết
  let msg = `Xóa thư mục "${name}"?`;
  if (files.length > 0) {
    msg = `⚠️ Thư mục "${name}" còn ${files.length} bài viết${subFolders.length ? ` và ${subFolders.length} thư mục con` : ''}.

Xóa sẽ XÓA VĨNH VIỄN tất cả bài viết trong NocoDB.
Bạn có chắc chắn muốn tiếp tục không?`;
  } else if (subFolders.length > 0) {
    msg = `⚠️ Thư mục "${name}" còn ${subFolders.length} thư mục con (không có bài).

Xóa thư mục này?`;
  }
  if (!confirm(msg)) return;

  showLoading(`Đang xóa thư mục "${name}"...`);
  try {
    // Xóa tất cả bài viết trong thư mục khỏi NocoDB
    for (const file of files) {
      try {
        const rowId = file.nocoId || await _getNocoId(file.path);
        if (rowId) await NOCO.deleteRecord(rowId);
      } catch(e) { console.warn('Delete article:', file.path, e.message); }
    }

    // Xóa folder khỏi Folders table
    if (true) { // proxy handles folders
      try {
        const fData = await NOCO.listFolders();
        for (const f of (fData.list||[])) {
          if (f.Path === folderPath || (f.Path||'').startsWith(folderPath + '/')) {
            await NOCO.call('folders', '', 'DELETE', [{Id: f.Id}]);
          }
        }
      } catch(e) { console.warn('Delete folder NocoDB:', e.message); }
    }

    // CASCADE: xóa permissions
    if (true) { // proxy handles permissions
      try {
        const perms = await NOCO.call('permissions', '', 'GET', undefined, 'limit=1000');
        for (const p of (perms.list||[])) {
          const tp = p.TargetPath || '';
          if (tp === folderPath || tp.startsWith(folderPath + '/')) {
            await NOCO.call('permissions', '', 'DELETE', [{Id: p.Id}]);
          }
        }
      } catch(e) { console.warn('Permission cascade:', e.message); }
    }

    // Xóa khỏi indexTree
    function removeFolderByPath(items, path) {
      for (let i = items.length-1; i >= 0; i--) {
        const item = items[i];
        if (item.type === 'folder' && (item.path === path || item.folderPath === path)) {
          items.splice(i, 1); return true;
        }
        if (item.children && removeFolderByPath(item.children, path)) return true;
      }
      return false;
    }
    removeFolderByPath(indexTree, folderPath);
    commitIndexTree();
    // Reset editor nếu đang mở bài trong folder vừa xóa
    if (currentEditPath && currentEditPath.startsWith(folderPath + '/')) {
      currentEditPath = null;
      document.getElementById('e-title').value = '';
      const _lbl = document.getElementById('e-path-label');
      if (_lbl) _lbl.innerHTML = '<i class="fas fa-file"></i> Bài mới';
      setEditorHTML(''); isDirty = false;
      document.getElementById('save-status').textContent = 'Thư mục đã xóa';
    }
    showToast(`✓ Đã xóa thư mục "${name}"${files.length ? ` và ${files.length} bài viết` : ''}!`, 'success');
  } catch(e) {
    showToast('Lỗi xóa: ' + e.message, 'error');
  } finally { hideLoading(); }
}

function removeFromTree(tree, path) {
  for (let i = tree.length-1; i >= 0; i--) {
    if (tree[i].type === 'file' && tree[i].path === path) { tree.splice(i,1); return true; }
    if (tree[i].type === 'folder' && removeFromTree(tree[i].children||[], path)) return true;
  }
  return false;
}

// ═══════════════════════════════════════════════════
// EDITOR
// ═══════════════════════════════════════════════════
let editorTab = 'rich';
let cmEditor = null;      // CodeMirror instance
let _richLoading = false; // true trong 200ms đầu sau setRichHTML — bỏ qua _onRichChange
let _cmLoading   = false; // true khi applyHTMLToEditor đang set value — bỏ qua cmEditor.on('change')

function initCodeMirror() {
  if (cmEditor) return;
  const ta = document.getElementById('html-source');
  if (!ta || typeof CodeMirror === 'undefined') return;
  cmEditor = CodeMirror.fromTextArea(ta, {
    mode: 'htmlmixed', theme: 'default',
    lineNumbers: true, lineWrapping: true,
    matchBrackets: true, autoCloseTags: true,
    tabSize: 2, indentWithTabs: false,
    extraKeys: { 'Ctrl-S': () => saveToNoco(), 'Tab': cm => cm.execCommand('indentMore') }
  });
  cmEditor.on('change', () => { if (!_cmLoading) { markDirty(); updateEditorStats(); } });
  cmEditor.setSize('100%', '100%');
}


// ── Detect full-page HTML ──
function isFullPageHTML(html) {
  const trimmed = (html || '').trim().toLowerCase();
  return trimmed.startsWith('<!doctype') || trimmed.startsWith('<html');
}

// ── Blob URL helper: dùng cho student viewer (index.html style, không cần DOM access) ──
function setBlobSrcdoc(iframe, html) {
  if (iframe._blobUrl) { URL.revokeObjectURL(iframe._blobUrl); iframe._blobUrl = null; }
  const blob = new Blob([html], { type: 'text/html' });
  const url  = URL.createObjectURL(blob);
  iframe._blobUrl = url;
  iframe.src = url;
}

// ── srcdoc helper: dùng cho rich-iframe editor (cần DOM access qua contentDocument) ──
function setIframeSrcdoc(iframe, html) {
  // Revoke blob nếu có từ trước
  if (iframe._blobUrl) { URL.revokeObjectURL(iframe._blobUrl); iframe._blobUrl = null; }
  iframe.srcdoc = html;
}

// ══ PASTE HANDLER: Smart paste với LaTeX support ══════════════

function _detectPasteSource(html) {
  if (!html) return 'plain';
  if (html.indexOf('gemini.google.com') >= 0 || html.indexOf('chat-app') >= 0) return 'gemini';
  if (html.indexOf('docs.google.com') >= 0 || html.indexOf('docs-internal') >= 0) return 'gdocs';
  if (html.indexOf('mso-') >= 0 || html.indexOf('urn:schemas-microsoft') >= 0) return 'word';
  return 'generic';
}

function _latexSpan(math, display) {
  if (display) {
    return '<span data-math-display="1" style="display:block;text-align:center;padding:6px 10px;background:#fef9c3;border-radius:6px;font-family:\'Courier New\',monospace;font-size:14px;color:#854d0e;margin:6px 0">' + math.trim() + '</span>';
  }
  return '<span data-math="1" style="background:#fef9c3;padding:1px 6px;border-radius:4px;font-family:\'Courier New\',monospace;font-size:13px;color:#854d0e">' + math.trim() + '</span>';
}

function _processLatexInText(text) {
  if (!text) return text;
  // Display $$...$$
  text = text.replace(/\$\$([^$]+?)\$\$/g, function(_, m) { return _latexSpan(m, true); });
  // Inline $...$ (no newline inside)
  text = text.replace(/\$([^$\r\n]+?)\$/g, function(_, m) {
    // Skip if looks like currency (preceded by digit or space+digit)
    return _latexSpan(m, false);
  });
  return text;
}

function _processLatexInDOM(root) {
  var nodes = [];
  var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
  var n;
  while ((n = walker.nextNode())) {
    if (n.textContent.indexOf('$') >= 0) {
      var p = n.parentElement;
      if (p && (p.tagName === 'CODE' || p.tagName === 'PRE' || p.tagName === 'SCRIPT')) continue;
      nodes.push(n);
    }
  }
  nodes.forEach(function(tn) {
    var processed = _processLatexInText(tn.textContent);
    if (processed !== tn.textContent) {
      var span = document.createElement('span');
      span.innerHTML = processed;
      tn.parentNode.replaceChild(span, tn);
    }
  });
}

function _cleanPastedHTML(html, source) {
  var tmp = document.createElement('div');
  tmp.innerHTML = html;

  // Remove unwanted tags
  tmp.querySelectorAll('script,style,link,meta,head,noscript,iframe,form,input,button,select,textarea,chat-app').forEach(function(el) { el.remove(); });
  tmp.querySelectorAll('[ng-non-bindable],[data-ng-non-bindable]').forEach(function(el) { el.remove(); });

  // For Gemini: extract meaningful blocks only
  if (source === 'gemini') {
    var blocks = tmp.querySelectorAll('p,h1,h2,h3,h4,h5,h6,li,pre,code,blockquote');
    if (blocks.length > 0) {
      var result = document.createElement('div');
      blocks.forEach(function(b) {
        var clone = b.cloneNode(true);
        clone.querySelectorAll('[role="button"],button,[aria-label]').forEach(function(e) { e.remove(); });
        result.appendChild(clone);
      });
      tmp.innerHTML = result.innerHTML;
    }
  }

  // Clean styles - keep only formatting
  tmp.querySelectorAll('[style]').forEach(function(el) {
    var s = el.getAttribute('style') || '';
    var keep = [];
    if (/font-weight\s*:\s*(bold|700|800|900)/i.test(s)) keep.push('font-weight:700');
    if (/font-style\s*:\s*italic/i.test(s)) keep.push('font-style:italic');
    if (/text-decoration[^;]*underline/i.test(s)) keep.push('text-decoration:underline');
    if (/text-decoration[^;]*line-through/i.test(s)) keep.push('text-decoration:line-through');
    var cm = s.match(/(?:^|;)\s*color\s*:\s*([^;]+)/i);
    if (cm) {
      var c = cm[1].trim();
      if (!/(rgb\(0,\s*0,\s*0\)|#000000|#000\b|black|rgb\(255,\s*255,\s*255\)|white|#fff)/i.test(c))
        keep.push('color:' + c);
    }
    if (keep.length) el.setAttribute('style', keep.join(';'));
    else el.removeAttribute('style');
  });

  // Remove classes and unwanted attrs
  tmp.querySelectorAll('[class]').forEach(function(el) { el.removeAttribute('class'); });
  var KEEP = {href:1,src:1,alt:1,title:1,style:1,'data-math':1,'data-math-display':1,target:1,colspan:1,rowspan:1};
  tmp.querySelectorAll('*').forEach(function(el) {
    Array.from(el.attributes).forEach(function(a) {
      if (!KEEP[a.name]) el.removeAttribute(a.name);
    });
  });

  // Flatten empty spans
  tmp.querySelectorAll('span').forEach(function(el) {
    if (!el.getAttribute('style') && !el.getAttribute('data-math') && !el.getAttribute('data-math-display')) {
      while (el.firstChild) el.parentNode.insertBefore(el.firstChild, el);
      el.remove();
    }
  });

  return tmp.innerHTML;
}

function _buildPasteHTML(plainText, htmlText) {
  var source = _detectPasteSource(htmlText);

  // Gemini + LaTeX: use plain text (simpler and more reliable)
  if (source === 'gemini' && plainText && plainText.indexOf('$') >= 0) {
    return plainText.split('\n').map(function(line) {
      return line.trim() ? '<p>' + _processLatexInText(line) + '</p>' : '';
    }).filter(Boolean).join('');
  }

  // Has HTML: clean it
  if (htmlText && htmlText.indexOf('<') >= 0) {
    var clean = _cleanPastedHTML(htmlText, source);
    var wrapper = document.createElement('div');
    wrapper.innerHTML = clean;
    if (plainText && plainText.indexOf('$') >= 0) {
      _processLatexInDOM(wrapper);
    }
    return wrapper.innerHTML;
  }

  // Plain text only
  if (!plainText) return '';
  return plainText.split('\n').map(function(line) {
    return line.trim() ? '<p>' + _processLatexInText(line) + '</p>' : '';
  }).filter(Boolean).join('') || '<p>' + _processLatexInText(plainText) + '</p>';
}

function _handlePaste(e, doc) {
  e.preventDefault();
  var cd = e.clipboardData || window.clipboardData;
  if (!cd) return;
  var html  = cd.getData('text/html')  || '';
  var plain = cd.getData('text/plain') || '';
  if (!html && !plain) return;

  var insertHTML = _buildPasteHTML(plain, html);
  if (!insertHTML) return;

  var sel = doc.getSelection();
  if (!sel || !sel.rangeCount) return;
  var range = sel.getRangeAt(0);
  range.deleteContents();
  try {
    var frag = range.createContextualFragment(insertHTML);
    var last = frag.lastChild;
    range.insertNode(frag);
    if (last) {
      range.setStartAfter(last);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  } catch(err) {
    doc.execCommand('insertHTML', false, insertHTML);
  }
}





// ── Apply HTML to editor ──────────────────────────
function applyHTMLToEditor(html) {
  // Sync vào CodeMirror — set _cmLoading để không trigger markDirty
  _cmLoading = true;
  if (cmEditor) cmEditor.setValue(html || '');
  else { const src = document.getElementById('html-source'); if (src) src.value = html || ''; }
  _cmLoading = false;
  // Load vào rich iframe nếu đang ở tab Soạn thảo
  if (editorTab === 'rich') initTinyMCE(html || '');
}

// ── TinyMCE Init ──
function initTinyMCE(html, callback) {
  tinyEditor = { getContent: getRichHTML, setContent: setRichHTML };
  tinyReady = true;
  _richHistory = [];
  _richFuture  = [];
  setRichHTML(html || '');
  if (callback) callback();
}

function _getRichIframeDoc() {
  const f = document.getElementById('rich-iframe');
  return f ? (f.contentDocument || f.contentWindow?.document) : null;
}

function setRichHTML(html) {
  const iframe = document.getElementById('rich-iframe');
  if (!iframe) return;

  const isFullPage = isFullPageHTML(html);
  let fullHTML;

  if (isFullPage) {
    fullHTML = html.replace('</head>', `
<style>
  body { outline: none; min-height: 200px; }
  [contenteditable]:focus { outline: none; }
  iframe { pointer-events: none; }
</style>
</head>`);
  } else {
    const bodyContent = html || '<p>&#8203;</p>';
    fullHTML = `<!DOCTYPE html><html><head>
<meta charset="UTF-8">
<style>
  body {
    font-family: 'Segoe UI', system-ui, sans-serif;
    font-size: 14px; line-height: 1.85; color: #1e293b;
    margin: 24px 32px; outline: none; min-height: 300px;
  }
  body:empty::before, p:only-child:empty::before {
    content: 'Bắt đầu nhập nội dung bài học...';
    color: #94a3b8; pointer-events: none;
  }
  h1{font-size:22px;font-weight:700;color:#0f172a;margin:16px 0 8px;border-bottom:2px solid #dbeafe;padding-bottom:6px}
  h2{font-size:18px;font-weight:700;color:#1e293b;margin:14px 0 6px}
  h3{font-size:15px;font-weight:600;color:#334155;margin:12px 0 5px}
  h4{font-size:13px;font-weight:600;color:#475569;margin:10px 0 4px}
  blockquote{border-left:4px solid #2563eb;background:#eff6ff;padding:10px 14px;margin:10px 0;border-radius:0 6px 6px 0;color:#1e40af}
  pre{background:#1e293b;color:#e2e8f0;padding:14px;border-radius:8px;overflow-x:auto;font-size:13px;font-family:'Courier New',monospace;white-space:pre-wrap}
  code{background:#f1f5f9;padding:2px 6px;border-radius:4px;font-size:12px;color:#1e40af;font-family:'Courier New',monospace}
  table{border-collapse:collapse;width:100%;margin:10px 0}
  td,th{border:1px solid #e2e8f0;padding:8px 12px}
  th{background:#f8fafc;font-weight:600}
  a{color:#2563eb;text-decoration:underline}
  img{max-width:100%;border-radius:6px}
  ul,ol{padding-left:24px;margin:8px 0}
  li{margin-bottom:4px}
  hr{border:none;border-top:2px solid #e2e8f0;margin:16px 0}
  p{margin-bottom:10px}
  [data-math]{background:#fef9c3;padding:2px 8px;border-radius:4px;font-family:'Courier New',monospace;font-size:13px;color:#854d0e}
</style>
</head><body>${bodyContent}</body></html>`;
  }

  setIframeSrcdoc(iframe, fullHTML);
  _richLoading = true; // bỏ qua _onRichChange trong khi iframe đang load

  // Wait for iframe to load then make body editable
  iframe.onload = () => {
    richDoc = iframe.contentDocument || iframe.contentWindow?.document;
    if (!richDoc) return;
    const body = richDoc.body;
    if (!body) return;
    body.contentEditable = 'true';
    body.spellcheck = false;
    body.style.outline = 'none';

    body.addEventListener('paste', (e) => _handleSmartPaste(e, richDoc));
    body.addEventListener('input', () => { _onRichChange(); });

    richDoc.addEventListener('keydown', (e) => {
      if ((e.ctrlKey||e.metaKey) && e.key === 'z') { e.preventDefault(); richUndo(); }
      if ((e.ctrlKey||e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key==='z'))) { e.preventDefault(); richRedo(); }
    });

    richDoc.addEventListener('paste', e => { _handlePaste(e, richDoc); setTimeout(_onRichChange, 100); });

    _richLastHTML = getRichHTML();
    _richHistory = [_richLastHTML];

    // Hết giai đoạn load — cho phép _onRichChange hoạt động trở lại
    setTimeout(() => { _richLoading = false; }, 200);

    // Stats cập nhật SAU khi iframe load xong
    updateEditorStats();
  };
}

function _onRichChange() {
  if (_richLoading) return; // bỏ qua khi iframe đang load ban đầu
  const html = getRichHTML();
  if (html === _richLastHTML) return;
  _richHistory.push(html);
  if (_richHistory.length > 100) _richHistory.shift();
  _richFuture = [];
  _richLastHTML = html;
  // Sync to CodeMirror (tab HTML)
  _syncRichToCodeMirror();
  markDirty();
  updateEditorStats();
}

function _syncRichToCodeMirror() {
  const d = _getRichIframeDoc();
  if (!d) return;
  // Chỉ lấy body.innerHTML (nội dung bài thật) — không lấy outerHTML vì sẽ bao gồm
  // toàn bộ <head> với CSS framework (Tailwind, KaTeX...) làm tăng size lên hàng trăm KB
  // Ngoại lệ: nếu bài gốc đã là full-page HTML → giữ nguyên full HTML
  const bodyHTML = d.body ? d.body.innerHTML : '';
  // Kiểm tra xem bài có phải full-page HTML không bằng CodeMirror value hiện tại
  const cmVal = cmEditor ? cmEditor.getValue() : '';
  const html = isFullPageHTML(cmVal) ? getFinalHTML() : bodyHTML;
  if (cmEditor && cmEditor.getValue() !== html) {
    const cursor = cmEditor.getCursor();
    _cmLoading = true;
    cmEditor.setValue(html);
    _cmLoading = false;
    try { cmEditor.setCursor(cursor); } catch {}
  }
}

function getRichHTML() {
  const d = _getRichIframeDoc();
  if (!d || !d.body) return '';
  return d.body.innerHTML;
}

function getFinalHTML() {
  const d = _getRichIframeDoc();
  if (!d) return '';
  // Return full page HTML preserving head + body edits
  return '<!DOCTYPE html>' + d.documentElement.outerHTML;
}

function getVisualHTML() { return getFinalHTML(); }

function richUndo() {
  if (_richHistory.length <= 1) return;
  _richFuture.push(_richHistory.pop());
  const prev = _richHistory[_richHistory.length - 1];
  const d = _getRichIframeDoc();
  if (d && d.body) { d.body.innerHTML = prev; _richLastHTML = prev; }
}

function richRedo() {
  if (!_richFuture.length) return;
  const next = _richFuture.pop();
  const d = _getRichIframeDoc();
  if (d && d.body) { d.body.innerHTML = next; _richLastHTML = next; _richHistory.push(next); }
}

// Execute command in iframe document
function _rCmd(cmd, val) {
  const d = _getRichIframeDoc();
  if (!d) return;
  d.execCommand(cmd, false, val || null);
  _onRichChange();
}

function richToggle(cmd) { _rCmd(cmd); }

function richColor(prop, val) {
  const d = _getRichIframeDoc();
  if (!d) return;
  const sel = d.getSelection();
  if (!sel || sel.isCollapsed) return;
  const range = sel.getRangeAt(0);
  const span = d.createElement('span');
  span.style[prop] = val;
  range.surroundContents(span);
  _onRichChange();
}

function richAlign(dir) {
  const d = _getRichIframeDoc();
  if (!d) return;
  const cmds = {left:'justifyLeft',center:'justifyCenter',right:'justifyRight'};
  d.execCommand(cmds[dir] || 'justifyLeft', false, null);
  _onRichChange();
}

function richList(type) {
  _rCmd(type === 'ul' ? 'insertUnorderedList' : 'insertOrderedList');
}

function richWrap(tag) {
  if (!tag) return;
  _rCmd('formatBlock', tag);
}

function richInsertLink() {
  const d = _getRichIframeDoc();
  if (!d) return;
  const sel = d.getSelection();
  const text = sel ? sel.toString() : '';
  const url = prompt('Nhập URL:', 'https://');
  if (!url) return;
  const label = text || url;
  d.execCommand('insertHTML', false, `<a href="${url}" target="_blank">${label}</a>`);
  _onRichChange();
}

function richInsertImage() {
  // Hiển thị dialog chọn: upload file hoặc nhập URL
  const choice = confirm('Tải ảnh từ máy tính?\n\nOK = Chọn file\nCancel = Nhập URL');
  if (choice) {
    richUploadImage();
  } else {
    const url = prompt('Nhập URL hình ảnh:');
    if (!url) return;
    const alt = prompt('Mô tả (alt text):', '') || '';
    const w = prompt('Chiều rộng (px hoặc %, để trống = 100%):', '100%') || '100%';
    const d = _getRichIframeDoc();
    if (!d) return;
    d.execCommand('insertHTML', false,
      `<img src="${url}" alt="${alt}" style="max-width:${w};border-radius:6px;display:block;margin:8px 0">`);
    _onRichChange();
  }
}

// ── Upload ảnh từ máy: nén qua Canvas → base64 → lưu inline trong bài ──
function richUploadImage() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { showToast('Ảnh quá lớn (tối đa 10MB)', 'warn'); return; }
    showLoading('Đang nén ảnh...');
    try {
      const dataUrl = await _compressImageToBase64(file, 1200, 0.82);
      const alt = file.name.replace(/\.[^.]+$/, '');
      const d = _getRichIframeDoc();
      if (!d) { hideLoading(); return; }
      d.execCommand('insertHTML', false,
        `<img src="${dataUrl}" alt="${alt}" style="max-width:100%;border-radius:6px;display:block;margin:8px 0">`);
      _onRichChange();
      const kb = Math.round(dataUrl.length * 0.75 / 1024);
      showToast(`✓ Đã chèn ảnh (~${kb} KB, lưu inline)`, 'success');
    } catch(e) {
      showToast('Lỗi nén ảnh: ' + e.message, 'error');
    } finally { hideLoading(); }
  };
  input.click();
}

/**
 * Nén ảnh qua Canvas: resize về maxPx cạnh dài, encode JPEG quality q.
 * Trả về data URI string (data:image/jpeg;base64,...).
 */
function _compressImageToBase64(file, maxPx = 1200, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Không đọc được file'));
    reader.onload = e => {
      const img = new Image();
      img.onerror = () => reject(new Error('Không decode được ảnh'));
      img.onload = () => {
        let w = img.naturalWidth, h = img.naturalHeight;
        if (w === 0 || h === 0) { reject(new Error('Ảnh rỗng')); return; }
        // Scale down nếu lớn hơn maxPx
        if (w > maxPx || h > maxPx) {
          if (w >= h) { h = Math.round(h * maxPx / w); w = maxPx; }
          else        { w = Math.round(w * maxPx / h); h = maxPx; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        // Thử WebP trước, fallback JPEG
        let dataUrl = canvas.toDataURL('image/webp', quality);
        if (!dataUrl.startsWith('data:image/webp')) {
          dataUrl = canvas.toDataURL('image/jpeg', quality);
        }
        resolve(dataUrl);
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

function richInsertTable() {
  const rows = parseInt(prompt('Số hàng:', '3')) || 3;
  const cols = parseInt(prompt('Số cột:', '3')) || 3;
  let html = '<table style="border-collapse:collapse;width:100%;margin:10px 0"><thead><tr>';
  for (let c = 0; c < cols; c++) html += `<th style="border:1px solid #e2e8f0;padding:8px 12px;background:#f8fafc;font-weight:600">Cột ${c+1}</th>`;
  html += '</tr></thead><tbody>';
  for (let r = 0; r < rows; r++) {
    html += '<tr>';
    for (let c = 0; c < cols; c++) html += '<td style="border:1px solid #e2e8f0;padding:8px 12px">&nbsp;</td>';
    html += '</tr>';
  }
  html += '</tbody></table><p></p>';
  const d = _getRichIframeDoc();
  if (!d) return;
  d.execCommand('insertHTML', false, html);
  _onRichChange();
}

function richInsertMath() {
  const formula = prompt('Nhập công thức:', 'x^2 + y^2 = r^2');
  if (!formula) return;
  const d = _getRichIframeDoc();
  if (!d) return;
  d.execCommand('insertHTML', false, `<span data-math="1" style="background:#fef9c3;padding:2px 8px;border-radius:4px;font-family:'Courier New',monospace;font-size:13px;color:#854d0e">${formula}</span>`);
  _onRichChange();
}

function richInsertEmbed() {
  const input = prompt(
    '🎬 Nhúng học liệu\n\nDán vào:\n• Link YouTube\n• Link Google Docs/Slides/Forms/Sheets\n• Link Google Drive\n• Link Canva, Padlet...\n• Mã <iframe> đầy đủ\n• Bất kỳ URL nào:', ''
  );
  if (!input) return;
  const trimmed = input.trim();
  let embedHTML = '';

  if (trimmed.toLowerCase().startsWith('<iframe')) {
    embedHTML = trimmed;
  } else if (trimmed.match(/youtube\.com\/watch\?v=([a-zA-Z0-9_-]+)/)) {
    const id = trimmed.match(/v=([a-zA-Z0-9_-]+)/)[1];
    embedHTML = `<iframe width="100%" height="450" src="https://www.youtube.com/embed/${id}" frameborder="0" allowfullscreen style="border-radius:8px;display:block;margin:12px 0"></iframe>`;
  } else if (trimmed.match(/youtu\.be\/([a-zA-Z0-9_-]+)/)) {
    const id = trimmed.match(/youtu\.be\/([a-zA-Z0-9_-]+)/)[1];
    embedHTML = `<iframe width="100%" height="450" src="https://www.youtube.com/embed/${id}" frameborder="0" allowfullscreen style="border-radius:8px;display:block;margin:12px 0"></iframe>`;
  } else if (trimmed.includes('docs.google.com/document')) {
    const url = trimmed.split('?')[0].replace('/edit','') + '/preview';
    embedHTML = `<iframe src="${url}" width="100%" height="600" frameborder="0" style="border-radius:8px;display:block;margin:12px 0"></iframe>`;
  } else if (trimmed.includes('docs.google.com/presentation')) {
    const url = trimmed.split('?')[0].replace('/edit','') + '/embed?start=false&loop=false';
    embedHTML = `<iframe src="${url}" width="100%" height="480" frameborder="0" allowfullscreen style="border-radius:8px;display:block;margin:12px 0"></iframe>`;
  } else if (trimmed.includes('docs.google.com/forms')) {
    const url = trimmed.split('?')[0].replace('/edit','') + '/viewform?embedded=true';
    embedHTML = `<iframe src="${url}" width="100%" height="600" frameborder="0" style="border-radius:8px;display:block;margin:12px 0"></iframe>`;
  } else if (trimmed.includes('docs.google.com/spreadsheets')) {
    const url = trimmed.split('?')[0].replace('/edit','') + '/pubhtml';
    embedHTML = `<iframe src="${url}" width="100%" height="500" frameborder="0" style="border-radius:8px;display:block;margin:12px 0"></iframe>`;
  } else if (trimmed.includes('drive.google.com/file')) {
    const idM = trimmed.match(/\/d\/([a-zA-Z0-9_-]+)/);
    if (idM) embedHTML = `<iframe src="https://docs.google.com/viewer?url=https://drive.google.com/uc?id=${idM[1]}&embedded=true" width="100%" height="480" frameborder="0" style="border-radius:8px;display:block;margin:12px 0"></iframe>`;
  } else if (trimmed.includes('canva.com') || trimmed.includes('padlet.com')) {
    embedHTML = `<iframe src="${trimmed}" width="100%" height="480" frameborder="0" allowfullscreen style="border-radius:8px;display:block;margin:12px 0"></iframe>`;
  } else if (trimmed.startsWith('http')) {
    const h = parseInt(prompt('Chiều cao iframe (px):', '500')) || 500;
    embedHTML = `<iframe src="${trimmed}" width="100%" height="${h}" frameborder="0" style="border-radius:8px;display:block;margin:12px 0"></iframe>`;
  } else {
    showToast('Không nhận dạng được. Vui lòng dán mã <iframe> đầy đủ.', 'warn');
    return;
  }

  const d = _getRichIframeDoc();
  if (!d) return;
  d.execCommand('insertHTML', false, embedHTML + '<p></p>');
  _onRichChange();
  showToast('✅ Đã nhúng nội dung!', 'success');
}


function switchTab(tab) {
  const prevTab = editorTab;

  // Sync OUT: khi rời tab Soạn thảo → sync iframe → CodeMirror
  if (prevTab === 'rich' && tab === 'html') {
    _syncRichToCodeMirror();
  }

  editorTab = tab;

  // Show/hide panels
  document.getElementById('wrap-rich').style.display = tab==='rich' ? 'flex' : 'none';
  document.getElementById('wrap-html').style.display = tab==='html' ? 'flex' : 'none';
  // wrap-preview không còn dùng nữa

  document.querySelectorAll('.etab').forEach(b => b.classList.remove('active'));
  document.getElementById('etab-' + tab)?.classList.add('active');

  if (tab === 'rich') {
    // Sync IN: CodeMirror → iframe
    const html = cmEditor ? cmEditor.getValue() : (document.getElementById('html-source')?.value || '');
    initTinyMCE(html);
  } else if (tab === 'html') {
    setTimeout(() => { initCodeMirror(); if (cmEditor) cmEditor.refresh(); }, 50);
  }
}

function getEditorHTML() {
  if (editorTab === 'rich') {
    // Trả về body.innerHTML để stats/size tính đúng nội dung thật
    // (không bao gồm <head> CSS của iframe)
    const d = _getRichIframeDoc();
    return d?.body ? d.body.innerHTML : '';
  }
  return cmEditor ? cmEditor.getValue() : (document.getElementById('html-source')?.value || '');
}

function setEditorHTML(html) {
  applyHTMLToEditor(html);
}

function updateEditorStats() {
  const html = getEditorHTML();
  const text = (html || '').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
  const chars = text.length;
  const words = text ? text.split(/\s+/).filter(Boolean).length : 0;
  const ec = document.getElementById('e-chars');
  const ew = document.getElementById('e-words');
  const es = document.getElementById('e-size');
  if (ec) ec.textContent = chars.toLocaleString() + ' ký tự';
  if (ew) ew.textContent = words.toLocaleString() + ' từ';
  if (es) {
    const rawLen = (html || '').length;
    const kb = (rawLen / 1024).toFixed(1);
    if (rawLen > 20000) {
      es.textContent = `~${kb}KB · sẽ nén LZ`;
      es.style.color = 'var(--warn)';
    } else {
      es.textContent = `~${kb}KB`;
      es.style.color = 'var(--text-muted)';
    }
  }
}

// ── Auto-save draft ────────────────────────────────
const DRAFT_KEY     = 'ae_editor_draft';
const DRAFT_DELAY   = 30 * 1000; // 30 giây
let   _autoSaveTimer = null;

function _getEditorContent() {
  if (typeof editorTab !== 'undefined' && editorTab === 'rich') {
    try { _syncRichToCodeMirror(); } catch(e) {}
  }
  if (typeof cmEditor !== 'undefined' && cmEditor) return cmEditor.getValue();
  return document.getElementById('html-source')?.value || '';
}

function _saveDraft() {
  if (!currentEditPath && !document.getElementById('e-title')?.value?.trim()) return;
  try {
    const draft = {
      path:    currentEditPath || '',
      title:   document.getElementById('e-title')?.value  || '',
      folder:  document.getElementById('e-folder')?.value || '',
      desc:    document.getElementById('e-desc')?.value   || '',
      access:  document.getElementById('e-access')?.value || 'public',
      content: _getEditorContent(),
      ts:      Date.now()
    };
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    const ss = document.getElementById('save-status');
    if (ss && isDirty) ss.textContent = '💾 Nháp tự động ' + new Date().toLocaleTimeString('vi-VN', {hour:'2-digit',minute:'2-digit'});
  } catch(e) { /* quota exceeded — bỏ qua */ }
}

function _clearDraft() {
  sessionStorage.removeItem(DRAFT_KEY);
  _autoSaveTimer && clearTimeout(_autoSaveTimer);
  _autoSaveTimer = null;
}

function _scheduleAutoSave() {
  _autoSaveTimer && clearTimeout(_autoSaveTimer);
  _autoSaveTimer = setTimeout(_saveDraft, DRAFT_DELAY);
}

function _restoreDraftIfAny() {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    if (!raw) return;
    const draft = JSON.parse(raw);
    // Chỉ restore nếu draft < 2 tiếng và có nội dung
    if (!draft.content || (Date.now() - draft.ts) > 2 * 60 * 60 * 1000) { _clearDraft(); return; }
    const age = Math.round((Date.now() - draft.ts) / 60000);
    if (confirm(`💾 Tìm thấy bản nháp tự động (${age} phút trước) của bài "${draft.title || draft.path}".\n\nKhôi phục lại không?`)) {
      if (draft.title)  document.getElementById('e-title').value  = draft.title;
      if (draft.folder) document.getElementById('e-folder').value = draft.folder;
      if (draft.desc)   document.getElementById('e-desc').value   = draft.desc;
      if (draft.access) document.getElementById('e-access').value = draft.access;
      if (draft.path)   currentEditPath = draft.path;
      setTimeout(() => {
        if (typeof applyHTMLToEditor === 'function') applyHTMLToEditor(draft.content);
        markDirty();
        showToast('✓ Đã khôi phục bản nháp tự động!', 'success');
      }, 200);
    }
    _clearDraft();
  } catch(e) { /* parse error */ }
}
// ───────────────────────────────────────────────────

function markDirty() {
  isDirty = true;
  const dot = document.getElementById('save-dot');
  if (dot) dot.className = 'save-dot unsaved';
  const s = document.getElementById('save-status');
  if (s) s.textContent = 'Chưa lưu';
  _scheduleAutoSave(); // kích hoạt auto-save sau 30s
}
function markSaved(t) {
  isDirty = false;
  _clearDraft(); // draft đã lưu thật → xóa bản nháp
  const dot = document.getElementById('save-dot');
  if (dot) dot.className = 'save-dot';
  document.getElementById('save-status').textContent = '✓ ' + t;
}
function markSaving() {
  const dot = document.getElementById('save-dot');
  if (dot) dot.className = 'save-dot saving';
  document.getElementById('save-status').textContent = 'Đang lưu...';
}


// ═══════════════════════════════════════════════════
// EDITOR SIDEBAR — Cây thư mục giống panel Quản lý tệp
// ═══════════════════════════════════════════════════



// Mở editor với bài cụ thể
async function openArticleEditor(path) {
  if (!path) return;
  if (!document.getElementById('panel-editor').classList.contains('active')) {
    _activatePanel('editor');
  }
  setTimeout(() => { initCodeMirror(); if (cmEditor) cmEditor.refresh(); }, 30);
  await editFile(path);
  // Highlight file active trong unified tree
  document.querySelectorAll('#unified-tree-body .utree-file').forEach(el => {
    el.classList.toggle('active', el.dataset.path === path);
  });
}

// ── _activatePanel: chuyển panel không trigger showPanel logic ──
function _activatePanel(id) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.getElementById('panel-' + id)?.classList.add('active');
  document.querySelectorAll('.sb-item').forEach(n => n.classList.remove('active'));
  const idx = {dashboard:0, editor:1, users:2, courses:3, qbank:4, exams:5, analytics:6, settings:7};
  document.querySelectorAll('.sb-item')[idx[id]]?.classList.add('active');
  const titles = {dashboard:'Dashboard', editor:'Soạn thảo', users:'Người dùng', courses:'Khoá học', qbank:'Ngân hàng đề', exams:'Đề bài tập', analytics:'Học tập', settings:'Cài đặt'};
  document.getElementById('panel-title').textContent = titles[id] || id;
}

// ── editFile: load 1 bài từ NocoDB vào editor ──
async function editFile(path) {
  if (!path) return;
  if (isDirty && currentEditPath && !confirm('Bài hiện tại chưa lưu. Tiếp tục sẽ mất thay đổi. Bạn có chắc?')) return;
  currentEditPath = path;
  showLoading('Tải nội dung từ NocoDB...');
  try {
    // Ưu tiên dùng nocoId từ indexTree để tránh query by path với Unicode
    const _cached = flattenFiles(indexTree).find(f => f.path === path);
    let row = null;
    if (_cached?.nocoId) {
      try {
        row = await NOCO.getRecord(_cached.nocoId);
      } catch(e) {
        console.warn('[editFile] getRecord by id failed, fallback to path query:', e.message);
      }
    }
    if (!row) {
      // Fallback: query by path
      const _ep = path.replace(/"/g, '\\"');
      const data = await NOCO.listRecords({ where: `(Path,eq,"${_ep}")`, limit: 1 });
      row = (data.list || [])[0];
    }
    let title = '', folder = '', desc = '', access = 'public', html = '';
    if (row) {
      title  = row.Title       || '';
      folder = row.Folder      || '';
      desc   = row.Description || '';
      access = row.Access      || 'public';
      // Giải nén nếu Content được nén bằng LZ-String
      const _raw = row.Content || '';
      if (_raw.startsWith('lz:')) {
        try {
          const decompressed = LZString.decompressFromBase64(_raw.slice(3));
          if (!decompressed) throw new Error('Kết quả giải nén rỗng');
          html = decompressed;
        } catch(e) {
          // Fallback: nếu raw có dấu hiệu là HTML thật thì dùng thẳng (bỏ prefix lz:)
          const rawBody = _raw.slice(3);
          if (rawBody.includes('<') && rawBody.includes('>')) {
            html = rawBody;
            showToast('⚠️ Giải nén thất bại — hiển thị nội dung gốc', 'warn');
          } else {
            html = `<p style="color:red;padding:20px">⚠️ Lỗi giải nén: ${e.message}<br><small>Vui lòng lưu lại bài để sửa.</small></p>`;
          }
          console.error('[LZ] Decompress failed:', e);
        }
      } else {
        html = _raw;
      }
    } else {
      const cached = flattenFiles(indexTree).find(f => f.path === path);
      if (cached) { title=cached.name; folder=cached.folder||''; desc=cached.description||''; access=cached.access||'public'; }
      showToast('Bài chưa có trong NocoDB, sẽ tạo mới khi lưu.', 'warn');
    }

    // Điền form metadata
    document.getElementById('e-title').value  = title;
    document.getElementById('e-desc').value   = desc;
    document.getElementById('e-access').value = access;

    // Folder dropdown: update options trước, set value sau
    updateFolderSelects();
    // Đặt timeout nhỏ để đảm bảo options đã render xong
    setTimeout(() => {
      const folderEl = document.getElementById('e-folder');
      if (folderEl) {
        folderEl.value = folder;
        // Nếu không tìm thấy option → thêm tạm
        if (folderEl.value !== folder && folder) {
          const opt = document.createElement('option');
          opt.value = folder;
          opt.textContent = folder;
          folderEl.appendChild(opt);
          folderEl.value = folder;
        }
      }
    }, 50);

    // Path label ở footer
    document.getElementById('e-path-label').innerHTML =
      `<i class="fas fa-file-lines" style="color:var(--primary)"></i> ${folder ? folder+'/' : ''}${path.split('/').pop()}`;

    // Cập nhật breadcrumb topbar
    const bc = document.getElementById('editor-breadcrumb');
    if (bc) bc.innerHTML = `<i class="fas fa-file-lines" style="color:var(--primary)"></i> ${folder ? folder.replace(/\//g,' › ') + ' › ' : ''}${title || path.split('/').pop()}`;

    // Load HTML vào editor — isDirty=false sau khi iframe load xong (300ms = 100 init + 200 _richLoading)
    setTimeout(() => {
      initCodeMirror();
      applyHTMLToEditor(html);
      setTimeout(() => {
        isDirty = false;
        const dot = document.getElementById('save-dot');
        if (dot) dot.className = 'save-dot';
        const ss = document.getElementById('save-status');
        if (ss) ss.textContent = `Đã tải: ${title}`;
        _updatePreviewBtn();
      }, 300);
    }, 100);

  } catch(e) {
    showToast('Lỗi tải bài: ' + e.message, 'error');
  } finally {
    hideLoading();
  }
}

// ── SAVE TO GITHUB ──
async function saveToNoco() {
  const title  = document.getElementById('e-title').value.trim();
  const folder = document.getElementById('e-folder').value.trim();
  const desc   = document.getElementById('e-desc').value.trim();
  const access = document.getElementById('e-access').value || 'public';
  if (!title) { showToast('Nhập tên bài học!', 'warn'); return; }
  // Proxy luôn sẵn sàng - không cần check nocoToken

  // Lấy HTML — luôn sync iframe → CodeMirror trước để đảm bảo source of truth
  if (editorTab === 'rich') {
    _syncRichToCodeMirror();
  }
  let htmlContent = cmEditor ? cmEditor.getValue() : (document.getElementById('html-source')?.value || '');

  // Cảnh báo nội dung rỗng nhưng KHÔNG chặn lưu, KHÔNG xóa cây thư mục
  if (!htmlContent || htmlContent.trim() === '' || htmlContent.trim() === '<p><br></p>') {
    if (!confirm('Nội dung bài đang trống. Bạn có chắc muốn lưu không?')) return;
  }
  markSaving();
  const _saveBtn = document.getElementById('btn-save');
  if (_saveBtn) _saveBtn.disabled = true;
  showLoading('Đang lưu vào NocoDB...');
  try {
    const now = new Date().toISOString().split('T')[0];
    let filePath;
    if (currentEditPath) {
      filePath = currentEditPath;
    } else {
      const slug = title.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/đ/gi,'d').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'') + '.html';
      filePath = folder ? folder + '/' + slug : slug;
    }
    // ── Nén nội dung nếu > 100,000 ký tự (LZ-String), dưới ngưỡng lưu thẳng ──
    const LZ_THRESHOLD = 50000; // ~50KB — chỉ nén bài lớn, tránh overhead với bài nhỏ
    let contentValue = htmlContent;
    if (htmlContent.length > LZ_THRESHOLD) {
      showLoading('Đang nén nội dung LZ-String...');
      const compressed = LZString.compressToBase64(htmlContent);
      contentValue = 'lz:' + compressed;
      const ratio = Math.round((1 - compressed.length / htmlContent.length) * 100);
      console.log(`[LZ] ${htmlContent.length} → ${compressed.length} ký tự (nén ${ratio}%)`);
    }
    const payload = { Title:title, Path:filePath, Folder:folder||'', Description:desc||'', Access:access, Updated:now, Content:contentValue,
      Excerpt: htmlContent.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim().slice(0, 150) };

    // Ưu tiên dùng nocoId từ indexTree để tránh query by path với Unicode
    const _treeItem = flattenFiles(indexTree).find(f => f.path === filePath);
    let existingId = _treeItem?.nocoId || null;
    if (!existingId) {
      // Fallback: query by path
      const _ep = filePath.replace(/"/g, '\\"');
      const existing = await NOCO.listRecords({ where: `(Path,eq,"${_ep}")`, limit: 1 });
      existingId = (existing.list || [])[0]?.Id || null;
    }
    if (existingId) { await NOCO.updateRecord(existingId, payload); }
    else { payload.NgayTao = now; const created = await NOCO.createRecord(payload); }
    currentEditPath = filePath;
    document.getElementById('e-path-label').innerHTML = `<i class="fas fa-file-lines" style="color:var(--primary)"></i> ${filePath}`;
    const existingItem = flattenFiles(indexTree).find(f => f.path === filePath);
    if (existingItem) {
      existingItem.name = title; existingItem.description = desc; existingItem.access = access; existingItem.updated = now;
      if (existingId) existingItem.nocoId = existingId;
    } else {
      const newItem = { type:'file', name:title, path:filePath, folder, description:desc, access, updated:now, nocoId: existingId };
      // insertIntoTree: chỉ tạo folder mới nếu chưa tồn tại, không reset children
      function insertIntoTree(tree, folderPath, item) {
        if (!folderPath) {
          if (!tree.find(i => i.type==='file' && i.path === item.path)) tree.push(item);
          return;
        }
        const parts = folderPath.split('/');
        let node = tree;
        for (const part of parts) {
          let found = node.find(i => i.type==='folder' && i.name===part);
          if (!found) {
            found = { type:'folder', name:part, path:parts.slice(0, parts.indexOf(part)+1).join('/'), children:[] };
            node.push(found);
          }
          node = found.children;
        }
        if (!node.find(i => i.type==='file' && i.path === item.path)) node.push(item);
      }
      insertIntoTree(indexTree, folder, newItem);
    }
    // Broadcast thay đổi đến tất cả panels
    commitIndexTree();

    // Cập nhật path label trong editor
    document.getElementById('e-path-label').innerHTML =
      `<i class="fas fa-file-lines" style="color:var(--primary)"></i> ${filePath}`;

    markSaved(new Date().toLocaleTimeString('vi-VN'));
    _updatePreviewBtn();
    showToast('✓ Đã lưu!', 'success');
  } catch(e) {
    showToast('Lỗi NocoDB: ' + e.message, 'error');
    markDirty();
  } finally {
    hideLoading();
    const _sb = document.getElementById('btn-save');
    if (_sb) _sb.disabled = false;
  }
}
async function saveToGitHub() { return saveToNoco(); }

// ═══════════════════════════════════════════════════
// DASHBOARD & UTILS
// ═══════════════════════════════════════════════════
function flattenFolders(tree) {
  return (tree||[]).flatMap(i => i.type==='folder' ? [i, ...flattenFolders(i.children)] : []);
}

function updateDashboard() {
  const files   = flattenFiles(indexTree);
  const folders = flattenFolders(indexTree);
  document.getElementById('d-articles').textContent = files.length;
  document.getElementById('d-folders').textContent  = folders.length;
  const c = cfg();
  document.getElementById('d-repo').textContent = c.repo || '—';
  document.getElementById('d-sync').textContent = new Date().toLocaleTimeString('vi-VN');
  document.getElementById('top-repo').textContent = c.nocoUrl ? c.nocoUrl.replace('https://','').split('/')[0] : '';

  const tbody = document.getElementById('dash-table');
  if (!files.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:28px">Chưa có bài viết. Kết nối NocoDB hoặc tạo bài mới.</td></tr>';
    return;
  }
  tbody.innerHTML = files.slice(-12).reverse().map(f => `
    <tr>
      <td><i class="fas fa-file-lines" style="color:var(--text-muted)"></i> <b>${f.name}</b></td>
      <td>${f.folder ? `<span class="badge badge-blue">${f.folder}</span>` : '<span style="color:var(--text-muted)">Gốc</span>'}</td>
      <td>${f.access === 'private' ? '<span class="badge" style="background:#fee2e2;color:#b91c1c">🔒 Private</span>' : '<span class="badge badge-green">🌐 Public</span>'}</td>
      <td style="font-size:12px;color:var(--text-muted)">${f.updated||'—'}</td>
      <td style="white-space:nowrap">
        <button class="btn btn-outline btn-sm" onclick="openArticleEditor('${f.path}')"><i class="fas fa-pen"></i></button>
        <button class="btn btn-danger btn-sm" onclick="confirmDeleteFile('${f.path}')"><i class="fas fa-trash"></i></button>
      </td>
    </tr>`).join('');
}

// ═══════════════════════════════════════════════════
// ANALYTICS — Learning Progress
// ═══════════════════════════════════════════════════
async function loadAnalytics() {
  // Reset loading state
  ['an-reaction-bars','an-top-articles','an-students'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:28px"><i class="fas fa-circle-notch fa-spin"></i> Đang tải...</td></tr>';
  });
  const reactionBars = document.getElementById('an-reaction-bars');
  if (reactionBars) reactionBars.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:24px"><i class="fas fa-circle-notch fa-spin"></i> Đang tải...</div>';

  try {
    // Fetch all progress rows (admin)
    const adminPass = sessionStorage.getItem('ae_admin_pass') || '';
    const proxyBase = (cfg().proxyUrl || 'https://api.gds.edu.vn').replace(/\/$/, '');
    let allRows = [];
    let offset = 0;
    const pageSize = 200;
    while (true) {
      const resp = await fetch(`${proxyBase}/admin/progress?limit=${pageSize}&offset=${offset}`, {
        headers: { 'Admin-Password': adminPass }
      });
      if (!resp.ok) throw new Error('Lỗi tải dữ liệu tiến độ');
      const data = await resp.json();
      const rows = data.list || [];
      allRows = allRows.concat(rows);
      if (rows.length < pageSize) break;
      offset += pageSize;
    }

    if (!allRows.length) {
      _anShowEmpty();
      return;
    }

    // ── Tính toán tổng quan ──
    const completedRows = allRows.filter(r => r.Completed);
    const studentIds = new Set(allRows.map(r => r.UserId).filter(Boolean));
    const reactions = allRows.filter(r => r.Reaction);
    const easyCount    = reactions.filter(r => r.Reaction === 'easy').length;
    const hardCount    = reactions.filter(r => r.Reaction === 'hard').length;
    const exampleCount = reactions.filter(r => r.Reaction === 'example').length;
    const totalReact   = reactions.length || 1;

    document.getElementById('an-total-done').textContent = completedRows.length;
    document.getElementById('an-total-students').textContent = studentIds.size;
    document.getElementById('an-easy-pct').textContent = Math.round(easyCount / totalReact * 100) + '%';
    document.getElementById('an-improve-pct').textContent = Math.round((hardCount + exampleCount) / totalReact * 100) + '%';

    // ── Reaction bars ──
    const bars = [
      { label: '😊 Dễ hiểu',       count: easyCount,    color: '#16a34a', bg: '#f0fdf4' },
      { label: '🤔 Khó hiểu',       count: hardCount,    color: '#dc2626', bg: '#fef2f2' },
      { label: '💡 Cần ví dụ thêm', count: exampleCount, color: '#d97706', bg: '#fffbeb' },
    ];
    const maxBar = Math.max(...bars.map(b => b.count), 1);
    if (reactionBars) {
      reactionBars.innerHTML = bars.map(b => `
        <div style="display:flex;align-items:center;gap:12px">
          <span style="width:160px;font-size:13px;flex-shrink:0">${b.label}</span>
          <div style="flex:1;height:22px;background:#f1f5f9;border-radius:100px;overflow:hidden">
            <div style="height:100%;width:${Math.round(b.count/maxBar*100)}%;background:${b.color};border-radius:100px;transition:width .5s;display:flex;align-items:center;justify-content:flex-end;padding-right:8px">
              ${b.count > 0 ? `<span style="font-size:11px;color:#fff;font-weight:700">${b.count}</span>` : ''}
            </div>
          </div>
          <span style="width:32px;text-align:right;font-size:13px;color:var(--text-muted)">${b.count}</span>
        </div>`).join('');
    }

    // ── Top articles ──
    const byArticle = new Map();
    for (const row of allRows) {
      const aid = String(row.ArticleId || '');
      if (!aid) continue;
      if (!byArticle.has(aid)) byArticle.set(aid, { done: 0, easy: 0, hard: 0, example: 0 });
      const e = byArticle.get(aid);
      if (row.Completed) e.done++;
      if (row.Reaction === 'easy') e.easy++;
      if (row.Reaction === 'hard') e.hard++;
      if (row.Reaction === 'example') e.example++;
    }
    const sortedArticles = [...byArticle.entries()].sort((a, b) => b[1].done - a[1].done).slice(0, 15);

    // Try to get article names from indexTree
    const nameMap = new Map();
    const flatFiles = flattenFiles(indexTree);
    for (const f of flatFiles) {
      if (f.nocoId) nameMap.set(String(f.nocoId), f.name);
    }

    const tbody = document.getElementById('an-top-articles');
    if (tbody) {
      if (!sortedArticles.length) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:24px">Chưa có dữ liệu</td></tr>';
      } else {
        tbody.innerHTML = sortedArticles.map(([aid, s], i) => `
          <tr>
            <td style="color:var(--text-muted);width:32px">${i + 1}</td>
            <td><b>${nameMap.get(aid) ? escHtml(nameMap.get(aid)) : `ID: ${aid}`}</b></td>
            <td><span class="badge badge-blue">${s.done} lượt</span></td>
            <td style="color:#16a34a">${s.easy > 0 ? '😊 ' + s.easy : '—'}</td>
            <td style="color:#dc2626">${s.hard > 0 ? '🤔 ' + s.hard : '—'}</td>
            <td style="color:#d97706">${s.example > 0 ? '💡 ' + s.example : '—'}</td>
          </tr>`).join('');
      }
    }

    // ── Students progress ──
    const totalArticles = flatFiles.length || 1;
    document.getElementById('an-student-note').textContent = `(tổng ${flatFiles.length} bài học)`;

    const byStudent = new Map();
    for (const row of allRows) {
      const uid = String(row.UserId || '');
      if (!uid) continue;
      if (!byStudent.has(uid)) byStudent.set(uid, { done: 0, reactions: [] });
      const e = byStudent.get(uid);
      if (row.Completed) e.done++;
      if (row.Reaction) e.reactions.push(row.Reaction);
    }
    const sortedStudents = [...byStudent.entries()].sort((a, b) => b[1].done - a[1].done);

    const stbody = document.getElementById('an-students');
    if (stbody) {
      if (!sortedStudents.length) {
        stbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:24px">Chưa có dữ liệu</td></tr>';
      } else {
        stbody.innerHTML = sortedStudents.map(([uid, s]) => {
          const pct = Math.round(s.done / flatFiles.length * 100);
          const reactionEmoji = s.reactions.length
            ? (s.reactions.filter(r=>r==='easy').length > s.reactions.length/2 ? '😊' : '🤔')
            : '—';
          return `<tr>
            <td style="font-size:12px;color:var(--text-muted)">UID ${uid}</td>
            <td><b>${s.done}</b></td>
            <td>${flatFiles.length}</td>
            <td>
              <div style="display:flex;align-items:center;gap:8px">
                <div style="flex:1;height:6px;background:#e2e8f0;border-radius:6px;min-width:60px">
                  <div style="height:100%;width:${pct}%;background:${pct>=80?'#16a34a':pct>=40?'#3b82f6':'#f59e0b'};border-radius:6px"></div>
                </div>
                <span style="font-size:12px;color:var(--text-muted);width:34px">${pct}%</span>
              </div>
            </td>
            <td>${reactionEmoji}</td>
          </tr>`;
        }).join('');
      }
    }

  } catch(e) {
    showToast('Lỗi tải analytics: ' + e.message, 'error');
    _anShowEmpty('Lỗi: ' + e.message);
  }
}

function _anShowEmpty(msg = 'Chưa có dữ liệu tiến độ học sinh') {
  const empty = `<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:28px">${msg}</td></tr>`;
  ['an-top-articles','an-students'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = empty;
  });
  const reactionBars = document.getElementById('an-reaction-bars');
  if (reactionBars) reactionBars.innerHTML = `<div style="text-align:center;color:var(--text-muted);padding:20px">${msg}</div>`;
  ['an-total-done','an-total-students','an-easy-pct','an-improve-pct'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = '0';
  });
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function updateFolderSelects() {
  function collectOpts(items, prefix = '') {
    let opts = [];
    for (const i of items) {
      if (i.type === 'folder') {
        const path = prefix ? prefix + '/' + i.name : i.name;
        opts.push(`<option value="${path}">${path.replace(/\//g, ' › ')}</option>`);
        if (i.children) opts = opts.concat(collectOpts(i.children, path));
      }
    }
    return opts;
  }

  // Build từ indexTree
  let folderOpts = collectOpts(indexTree);

  // Nếu không có folder trong indexTree → lấy từ NocoDB Folders table
  if (folderOpts.length === 0) {
    NOCO.listFolders().then(data => {
      const folders = (data.list || []).map(f => f.Path || f.Name || '').filter(Boolean);
      const opts = '<option value="">— Chọn thư mục —</option>' +
        folders.map(f => `<option value="${f}">${f.replace(/\//g,' › ')}</option>`).join('');
      const ef = document.getElementById('e-folder');
      if (ef) {
        const prev = ef.value;
        ef.innerHTML = opts;
        if (prev) ef.value = prev;
      }
    }).catch(() => {});
    return;
  }

  const ef = document.getElementById('e-folder');
  if (!ef) return;
  const prev = ef.value; // giữ lại giá trị đang chọn
  ef.innerHTML = '<option value="">📁 Chọn thư mục...</option>' + folderOpts.join('');
  if (prev) ef.value = prev; // khôi phục nếu vẫn còn trong danh sách
}

function updateGhStatus(connected) {
  // GitHub status removed — NocoDB is source of truth
}

function setSyncBar(syncing, text, time = '', error = false) {
  ['dash'].forEach(k => {
    const bar = document.getElementById(`sync-bar-${k}`);
    if (!bar) return;
    bar.style.display = 'flex';
    bar.className = 'sync-bar' + (syncing?' syncing':'') + (error?' error':'');
    const t = document.getElementById(`sync-text-${k}`);
    const tm = document.getElementById(`sync-time-${k}`);
    if (t) t.textContent = text;
    if (tm) tm.textContent = time;
  });
}

function flattenFiles(tree) {
  return (tree||[]).flatMap(i => i.type==='file' ? [i] : flattenFiles(i.children||[]));
}

// ═══════════════════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════════════════
function loadSettings() {
  const c = cfg();
  // Helper: set value only if element exists
  const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };

  // GitHub (optional - may not exist in HTML)
  setVal('s-token', c.token || '');
  setVal('s-repo', c.repo || '');
  setVal('s-branch', c.branch || 'main');
  setVal('s-content-dir', c.contentDir || 'content');

  // General
  setVal('s-title', c.title || 'ActiveEdu');
  setVal('s-url', c.url || '');

  // NocoDB
  setVal('s-proxy-url',        c.proxyUrl        || '');
}

function saveSettings() {
  const c = cfg();
  const getVal = (id, def='') => document.getElementById(id)?.value?.trim() || def;

  c.proxyUrl   = getVal('s-proxy-url');
  c.token      = getVal('s-token');
  c.repo       = getVal('s-repo');
  c.branch     = getVal('s-branch', 'main');
  c.contentDir = getVal('s-content-dir', 'content');
  c.title      = getVal('s-title', 'ActiveEdu');
  c.url        = document.getElementById('s-url').value.trim();
  // NocoDB
  // NocoDB config handled by Cloudflare Worker
  saveCfg(c);
  updateGhStatus(!!c.token && !!c.repo);
  updateNocoStatus(true, 'api.gds.edu.vn');
  document.getElementById('top-repo').textContent = c.nocoUrl ? c.nocoUrl.replace('https://','').split('/')[0] : '';
  showToast('✓ Đã lưu cài đặt!', 'success');
}

// ═══════════════════════════════════════════════════
// PANELS
// ═══════════════════════════════════════════════════
function showPanel(id, navEl) {
  _activatePanel(id);
  // Override active nav if explicit navEl passed
  if (navEl) {
    document.querySelectorAll('.sb-item').forEach(n => n.classList.remove('active'));
    navEl.classList.add('active');
  }

  const c = cfg();
  const hasNoco = true; // Luôn dùng proxy

  if (id === 'settings') {
    loadSettings();

  } else if (id === 'editor') {
    renderUnifiedTree(indexTree);
    updateFolderSelects();
    setTimeout(() => {
      initCodeMirror();
      if (cmEditor) cmEditor.refresh();
      if (editorTab === 'rich' && !currentEditPath) {
        initTinyMCE(cmEditor ? cmEditor.getValue() : '');
      }
    }, 80);

  } else if (id === 'dashboard') {
    updateDashboard();

  } else if (id === 'users') {
    loadUsers();
  } else if (id === 'courses') {
    loadCourses();
  } else if (id === 'qbank') {
    loadQBanks();
  } else if (id === 'exams') {
    loadExams();
  } else if (id === 'analytics') {
    loadAnalytics();
  }
}

// ═══════════════════════════════════════════════════
// LOADING & TOAST
// ═══════════════════════════════════════════════════
function showLoading(txt='Đang xử lý...') {
  document.getElementById('loading-text').textContent = txt;
  document.getElementById('loading').classList.add('show');
}
function hideLoading() { document.getElementById('loading').classList.remove('show'); }
function showToast(msg, type='info') {
  const t = document.getElementById('toast');
  const icons = { success:'fa-circle-check', error:'fa-circle-xmark', warn:'fa-triangle-exclamation', info:'fa-circle-info' };
  t.innerHTML = `<i class="fas ${icons[type]||icons.info}"></i> ${msg}`;
  t.className = `toast ${type} show`;
  setTimeout(() => t.classList.remove('show'), 3500);
}

// ═══════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════
function initAdmin() {
  // Không load từ localStorage — luôn fetch từ NocoDB khi init
  const c = cfg();
  const hasNoco = true; // Luôn dùng proxy
  const hasGH   = !!c.token && !!c.repo;
  updateGhStatus(hasGH);
  updateNocoStatus(true, 'api.gds.edu.vn');
  document.getElementById('top-repo').textContent = 'api.gds.edu.vn';

  if (hasNoco) {
    syncFromNoco().then(() => {
      updateDashboard();
      updateFolderSelects();
      // Sau khi tree sẵn sàng, kiểm tra có bản nháp chưa lưu không
      setTimeout(_restoreDraftIfAny, 500);
    });
  } else {
    showPanel('settings', document.querySelectorAll('.sb-item')[3]);
    setTimeout(() => showToast('Cấu hình NocoDB để bắt đầu!', 'warn'), 500);
  }
}

async function syncFromNoco() {
  setSyncBar(true, 'Đang tải cây thư mục...');
  showLoading('Đang tải từ NocoDB...');
  try {
    // Chỉ lấy metadata — KHÔNG lấy Content (lazy load khi user click bài)
    // fields param: NocoDB sẽ trả đúng các cột này, bỏ Content (~90% bandwidth)
    

    const [artData, folderData] = await Promise.all([
      NOCO.listRecords({ limit: 1000, sort: 'Folder' }),
      NOCO.listFolders().catch(() => ({ list: [] }))
    ]);
    const records = artData.list || [];
    const folders = folderData.list || [];

    const tree = [];

    function ensureFolderPath(tree, folderPath, extraProps = {}) {
      if (!folderPath) return tree;
      const parts = folderPath.split('/');
      let node = tree;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const currentPath = parts.slice(0, i+1).join('/');
        let found = node.find(n => n.type === 'folder' && n.name === part);
        if (!found) {
          found = { type:'folder', name:part, path:currentPath, children:[], access:'public' };
          node.push(found);
        }
        if (i === parts.length - 1) Object.assign(found, extraProps);
        node = found.children;
      }
      return node;
    }

    // Step 1: Folders (bao gồm thư mục rỗng + access info)
    for (const f of folders) {
      const path = f.Path || f.Name || f.name || '';
      if (!path) continue;
      ensureFolderPath(tree, path, { nocoFolderId: f.Id, access: f.Access || 'public' });
    }

    // Step 2: Articles metadata — KHÔNG có Content, lazy load khi click
    const validRecords = records.filter(r => r.Path && r.Path.trim() && r.Path !== '—');
    const skipped = records.length - validRecords.length;
    if (skipped > 0) console.warn(
      `[ActiveEdu] Bỏ qua ${skipped} record không có Path:`,
      records.filter(r => !r.Path || !r.Path.trim() || r.Path === '—').map(r => ({ Id: r.Id, Title: r.Title }))
    );

    for (const r of validRecords) {
      const folder = (r.Folder || '').trim();
      const item = {
        type:        'file',
        name:        (r.Title || '').trim() || r.Path.split('/').pop(),
        path:        r.Path.trim(),
        folder,
        description: r.Description || '',
        access:      r.Access || 'public',
        updated:     r.Updated || '',
        excerpt:     r.Excerpt || '',
        nocoId:      r.Id,
        // Content KHÔNG có ở đây — sẽ load khi user click (editFile → getRecord)
      };
      if (!folder) {
        tree.push(item);
      } else {
        const targetChildren = ensureFolderPath(tree, folder);
        if (!targetChildren.find(n => n.type === 'file' && n.path === item.path)) {
          targetChildren.push(item);
        }
      }
    }

    setIndexTree(tree);

    if (currentEditPath) {
      const folderEl = document.getElementById('e-folder');
      const item = flattenFiles(indexTree).find(f => f.path === currentEditPath);
      if (item && folderEl) folderEl.value = item.folder || '';
    }

    const totalFolders = flattenFolders(indexTree).length;
    const syncMsg = `✓ ${totalFolders} thư mục · ${validRecords.length} bài` + (skipped ? ` (${skipped} bỏ qua)` : '');
    setSyncBar(false, syncMsg, new Date().toLocaleTimeString('vi-VN'));
    updateNocoStatus(true, 'api.gds.edu.vn');
    showToast(syncMsg, 'success');
  } catch(e) {
    setSyncBar(false, '✗ Lỗi: ' + e.message, '', true);
    showToast('Lỗi tải NocoDB: ' + e.message, 'error');
  } finally { hideLoading(); }
}

// ═══════════════════════════════════════════════════
// NOCODB API — qua Cloudflare Worker proxy (không cần token ở client)
// ═══════════════════════════════════════════════════
const PROXY = 'https://api.gds.edu.vn';

function adminHeaders() {
  const token = sessionStorage.getItem('ae_admin_token') || '';
  if (token) {
    // Dùng session token (không lộ password)
    return { 'Content-Type': 'application/json', 'Admin-Token': token };
  }
  // Fallback legacy: plain-text password (cho worker cũ chưa update)
  const pass = sessionStorage.getItem('ae_admin_pass') || '';
  return { 'Content-Type': 'application/json', 'Admin-Password': pass };
}

const NOCO = {
  async call(route, path, method, body, params) {
    path = path || '';
    method = method || 'GET';
    params = params || '';
    const url = `${PROXY}/admin/${route}${path}${params ? '?' + params : ''}`;
    const r = await fetch(url, {
      method,
      headers: adminHeaders(),
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 401) throw new Error('Sai mật khẩu Admin!');
    if (!r.ok) throw new Error(`Lỗi ${r.status}: ${await r.text()}`);
    return r.json();
  },

  async listRecords(opts) {
    opts = opts || {};
    var limit = opts.limit || 25, offset = opts.offset || 0, where = opts.where || '', sort = opts.sort || '', fields = opts.fields || '';
    var p = 'limit=' + limit + '&offset=' + offset;
    if (where)  p += '&where='  + encodeURIComponent(where);
    if (sort)   p += '&sort='   + encodeURIComponent(sort);
    if (fields) p += '&fields=' + encodeURIComponent(fields);
    return this.call('articles', '', 'GET', undefined, p);
  },
  async getRecord(rowId)   { return this.call('articles', '/' + rowId); },
  async createRecord(data) { return this.call('articles', '', 'POST', [data]); },
  async updateRecord(rowId, data) { return this.call('articles', '', 'PATCH', [Object.assign({}, data, {Id: rowId})]); },
  async deleteRecord(rowId) { return this.call('articles', '', 'DELETE', [{Id: rowId}]); },

  async getFields() {
    var data = await this.listRecords({limit: 1});
    var rows = data.list || [];
    var keys = rows.length > 0 ? Object.keys(rows[0]).filter(function(k){ return k !== 'Id' && k !== 'nc_order'; }) : [];
    return { list: keys.map(function(k){ return {title: k, id: k}; }) };
  },
  async testConnection() {
    await this.listRecords({limit: 1});
    return { title: 'Articles', table_name: 'articles' };
  },

  async listPermissions(userId) {
    return this.call('permissions', '', 'GET', undefined, 'where=(UserId,eq,' + userId + ')&limit=1000');
  },
  async setPermissions(userId, perms) {
    var existing = await this.listPermissions(userId);
    for (var row of (existing.list || [])) {
      await this.call('permissions', '', 'DELETE', [{Id: row.Id}]);
    }
    if (perms.length === 0) return;
    var records = perms.map(function(p){ return {UserId: userId, Type: p.type, TargetId: p.targetId, TargetPath: p.targetPath}; });
    return this.call('permissions', '', 'POST', records);
  },
  async getUserPermissions(userId) {
    var data = await this.listPermissions(userId);
    return data.list || [];
  },

  async listFolders() { return this.call('folders', '', 'GET', undefined, 'limit=500&sort=Path'); },
  async createFolder(data) { return this.call('folders', '', 'POST', [data]); },
  async deleteFolder(rowId) { return this.call('folders', '', 'DELETE', [{Id: rowId}]); },

  async listUsers(opts) {
    opts = opts || {};
    var limit = opts.limit || 25, offset = opts.offset || 0, where = opts.where || '', sort = opts.sort || '-NgayTao';
    var p = 'limit=' + limit + '&offset=' + offset + '&sort=' + encodeURIComponent(sort);
    if (where) p += '&where=' + encodeURIComponent(where);
    return this.call('users', '', 'GET', undefined, p);
  },
  async getUser(rowId)   { return this.call('users', '/' + rowId); },
  async createUser(data) { return this.call('users', '', 'POST', [data]); },
  async updateUser(rowId, data) { return this.call('users', '', 'PATCH', [Object.assign({}, data, {Id: rowId})]); },
  async deleteUser(rowId) { return this.call('users', '', 'DELETE', [{Id: rowId}]); },

  headers()    { return adminHeaders(); },
  folderBase() { return PROXY + '/admin/folders'; },
  permBase()   { return PROXY + '/admin/permissions'; },
};

// ═══════════════════════════════════════════════════
// QUẢN LÝ NGƯỜI DÙNG
// ═══════════════════════════════════════════════════
// allUsers / filteredUsers đã xóa — thay bằng server-side pagination
// ── Server-side pagination state ──
let userPageIndex  = 0;
let userTotalCount = 0;
const USER_LIMIT   = 20;
let editingUserId  = null;
let _userSearchQ   = '';   // search query hiện tại
let _userRoleQ     = '';   // role filter hiện tại
let _userStatusQ   = '';   // status filter hiện tại

// Xây dựng where clause gửi lên server
function _buildUserWhere(q, role, status) {
  const parts = [];
  if (role)   parts.push(`(Role,eq,${role})`);
  if (status) parts.push(`(Status,eq,${status})`);
  if (q) {
    const encoded = encodeURIComponent(q);
    parts.push(`(Name,like,%${encoded}%)~or(Email,like,%${encoded}%)`);
  }
  return parts.length > 1 ? parts.join('~and') : (parts[0] || '');
}

async function loadUsers() {
  const tbody = document.getElementById('users-tbody');
  tbody.innerHTML = '<tr><td colspan="6" style="padding:40px;text-align:center;color:var(--text-muted)"><i class="fas fa-spinner fa-spin"></i> Đang tải...</td></tr>';
  try {
    const offset = userPageIndex * USER_LIMIT;
    const where  = _buildUserWhere(_userSearchQ, _userRoleQ, _userStatusQ);
    const data = await NOCO.listUsers({ limit: USER_LIMIT, offset, where, sort: '-NgayTao' });
    userTotalCount = data.pageInfo?.totalRows ?? data.pageInfo?.rowCount ?? (data.list?.length ?? 0);
    renderUsersTable(data.list || []);
    // Cập nhật stats bar (chỉ khi ở trang đầu và không filter)
    if (userPageIndex === 0 && !_userSearchQ && !_userRoleQ && !_userStatusQ) updateUserStats();
  } catch(e) {
    tbody.innerHTML = `<tr><td colspan="6" style="padding:40px;text-align:center;color:var(--danger)">${e.message}</td></tr>`;
  }
}

// filterUsers: cập nhật state filter rồi reload từ server (trang 1)
function filterUsers() {
  _userSearchQ  = (document.getElementById('user-search')?.value || '').trim();
  _userRoleQ    = document.getElementById('user-role-filter')?.value || '';
  _userStatusQ  = document.getElementById('user-status-filter')?.value || '';
  userPageIndex = 0;
  loadUsers();
}

// ── Bulk select state ──
let _selectedUserIds = new Set();

// renderUsersTable: nhận page data trực tiếp từ server
function renderUsersTable(page) {
  const tbody = document.getElementById('users-tbody');
  const total = userTotalCount;
  const start = userPageIndex * USER_LIMIT;
  const totalPages = Math.max(1, Math.ceil(total / USER_LIMIT));

  document.getElementById('user-count-label').textContent =
    total ? `${start + 1}–${Math.min(start + page.length, total)} / ${total} người dùng` : '';
  document.getElementById('user-page-label').textContent  = `Trang ${userPageIndex + 1} / ${totalPages}`;
  document.getElementById('user-prev-btn').disabled = userPageIndex === 0;
  document.getElementById('user-next-btn').disabled = start + USER_LIMIT >= total;
  // Reset select-all checkbox
  const selAll = document.getElementById('select-all-users');
  if (selAll) selAll.checked = false;
  _selectedUserIds.clear();
  updateBulkBar();

  if (page.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" style="padding:56px;text-align:center;color:#94a3b8"><i class="fas fa-users-slash" style="font-size:28px;display:block;margin-bottom:12px;opacity:.4"></i>Không tìm thấy người dùng nào</td></tr>';
    return;
  }

  const avatarColors = { admin:'#ef4444', teacher:'#4338ca', student:'#2563eb' };
  const roleLabel = {
    admin:   `<span style="display:inline-flex;align-items:center;gap:4px;background:#fef2f2;color:#b91c1c;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700;border:1px solid #fecaca"><i class="fas fa-shield-halved" style="font-size:9px"></i>Admin</span>`,
    teacher: `<span style="display:inline-flex;align-items:center;gap:4px;background:#f5f3ff;color:#4338ca;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700;border:1px solid #c4b5fd"><i class="fas fa-chalkboard-teacher" style="font-size:9px"></i>Giáo viên</span>`,
    student: `<span style="display:inline-flex;align-items:center;gap:4px;background:#f0fdf4;color:#15803d;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700;border:1px solid #bbf7d0"><i class="fas fa-graduation-cap" style="font-size:9px"></i>Học sinh</span>`,
  };

  tbody.innerHTML = page.map(u => {
    const name    = u.FullName || u.HoTen || u.Name || '(chưa đặt tên)';
    const email   = u.Email || '';
    const role    = u.Role  || u.VaiTro    || 'student';
    const status  = u.Status|| u.TrangThai || 'active';
    const phone   = u.Phone || u.SDT       || '';
    const created = u.NgayTao || '';
    const uid     = u.Id;

    const initials    = name.trim().split(/\s+/).map(w=>w[0]).slice(-2).join('').toUpperCase() || '?';
    const avatarColor = avatarColors[role] || '#2563eb';
    const isInactive  = status !== 'active';
    const isSelected  = _selectedUserIds.has(uid);

    // Status chip (clickable quick-toggle)
    const statusChip = status === 'active'
      ? `<button class="status-chip active" onclick="quickToggleStatus(${uid},'${esc(name)}','active')" title="Nhấn để vô hiệu hóa">
           <span class="status-dot"></span> Hoạt động
         </button>`
      : `<button class="status-chip inactive" onclick="quickToggleStatus(${uid},'${esc(name)}','inactive')" title="Nhấn để kích hoạt">
           <span class="status-dot"></span> Vô hiệu
         </button>`;

    // Perm badge (will be lazy-loaded)
    const permBadge = `<button class="perm-chip no-perms" id="perm-chip-${uid}"
        onclick="openPermModal(${uid},'${esc(name)}')" title="Quản lý quyền truy cập">
        <i class="fas fa-shield-halved" style="font-size:10px"></i>
        <span id="perm-chip-val-${uid}">···</span>
      </button>`;

    return `<tr class="urow${isInactive?' urow-inactive':''}${isSelected?' urow-selected':''}" id="urow-${uid}">
      <td style="padding:10px 14px">
        <input type="checkbox" class="user-row-cb" data-id="${uid}"
          ${isSelected?'checked':''}
          onchange="onUserRowCheck(this,${uid})"
          style="width:15px;height:15px;accent-color:#2563eb;cursor:pointer">
      </td>
      <td style="padding:10px 16px">
        <div style="display:flex;align-items:center;gap:11px">
          <div style="width:38px;height:38px;border-radius:50%;background:${avatarColor};color:#fff;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;flex-shrink:0;letter-spacing:.5px;box-shadow:0 2px 6px ${avatarColor}55">${initials}</div>
          <div style="min-width:0">
            <div style="font-weight:600;color:#1e293b;font-size:13.5px;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(name)}</div>
            <div style="font-size:11.5px;color:#64748b;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(email)}</div>
            ${phone ? `<div style="font-size:11px;color:#94a3b8;margin-top:1px"><i class="fas fa-phone" style="font-size:9px"></i> ${esc(phone)}</div>` : ''}
          </div>
        </div>
      </td>
      <td style="padding:10px 14px">${roleLabel[role] || roleLabel.student}</td>
      <td style="padding:10px 14px">${statusChip}</td>
      <td style="padding:10px 14px;text-align:center">${permBadge}</td>
      <td style="padding:10px 14px;color:#94a3b8;font-size:12px;white-space:nowrap">${esc(created)}</td>
      <td style="padding:10px 14px">
        <div style="display:flex;align-items:center;gap:5px;justify-content:center">
          <button onclick="editUser(${uid})"
            style="width:30px;height:30px;border-radius:7px;border:1px solid #e2e8f0;background:#fff;color:#64748b;font-size:12px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .15s"
            onmouseover="this.style.background='#eff6ff';this.style.color='#2563eb';this.style.borderColor='#bfdbfe'"
            onmouseout="this.style.background='#fff';this.style.color='#64748b';this.style.borderColor='#e2e8f0'"
            title="Sửa thông tin"><i class="fas fa-pen"></i></button>
          <button onclick="deleteUser(${uid},'${esc(name)}')"
            style="width:30px;height:30px;border-radius:7px;border:1px solid #fca5a5;background:#fef2f2;color:#b91c1c;font-size:12px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .15s"
            onmouseover="this.style.background='#fee2e2'" onmouseout="this.style.background='#fef2f2'"
            title="Xóa tài khoản"><i class="fas fa-trash"></i></button>
        </div>
      </td>
    </tr>`;
  }).join('');

  // Lazy load perm counts sau khi render xong
  _lazyLoadPermCounts(page.map(u => u.Id));
}

// Chuyển trang: fetch lại từ server
function userPageNext() { userPageIndex++; loadUsers(); }
function userPagePrev() { if (userPageIndex > 0) { userPageIndex--; loadUsers(); } }

function openUserModal(user) {
  editingUserId = user ? user.Id : null;
  document.getElementById('user-modal-title').textContent = user ? 'Sửa người dùng' : 'Thêm người dùng';
  document.getElementById('um-name').value   = user ? (user.FullName || user.HoTen || user.Name || '') : '';
  document.getElementById('um-email').value  = user ? (user.Email || '') : '';
  document.getElementById('um-pass').value   = '';
  document.getElementById('um-phone').value  = user ? (user.Phone  || user.SDT   || '') : '';
  document.getElementById('um-note').value   = user ? (user.Note   || user.GhiChu|| '') : '';
  document.getElementById('um-role').value   = user ? (user.Role   || user.VaiTro   || 'student') : 'student';
  document.getElementById('um-status').value = user ? (user.Status || user.TrangThai|| 'active')  : 'active';
  const hint = document.getElementById('um-pass-hint');
  if (hint) hint.textContent = user ? '(để trống = giữ nguyên)' : '(bắt buộc)';
  document.getElementById('um-msg').innerHTML = '';
  // Reset password strength
  const fill = document.getElementById('pw-strength-fill');
  const hwt  = document.getElementById('pw-hint');
  if (fill) fill.style.width = '0%';
  if (hwt)  hwt.textContent  = '';
  // Ensure password field type = password
  const passInp = document.getElementById('um-pass');
  if (passInp) passInp.type = 'password';
  // Update avatar preview
  updateUMAvatarPreview();
  document.getElementById('user-modal').style.display = 'flex';
}

function closeUserModal() {
  document.getElementById('user-modal').style.display = 'none';
  editingUserId = null;
}

async function saveUser() {
  const name   = document.getElementById('um-name').value.trim();
  const email  = document.getElementById('um-email').value.trim();
  const pass   = document.getElementById('um-pass').value;
  const role   = document.getElementById('um-role').value;
  const status = document.getElementById('um-status').value;
  const phone  = document.getElementById('um-phone').value.trim();
  const note   = document.getElementById('um-note').value.trim();
  const msg    = document.getElementById('um-msg');

  if (!name) { msg.innerHTML = '<span style="color:var(--danger)">Vui lòng nhập họ tên!</span>'; return; }
  if (!email) { msg.innerHTML = '<span style="color:var(--danger)">Vui lòng nhập email!</span>'; return; }
  if (!editingUserId && !pass) { msg.innerHTML = '<span style="color:var(--danger)">Vui lòng nhập mật khẩu!</span>'; return; }
  if (pass && pass.length < 6) { msg.innerHTML = '<span style="color:var(--danger)">Mật khẩu tối thiểu 6 ký tự!</span>'; return; }

  const btn = document.getElementById('um-save-btn');
  btn.disabled = true;
  msg.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Đang lưu...';

  try {
    const payload = {
      Name: name, FullName: name, HoTen: name,
      Email: email, Role: role, VaiTro: role,
      Status: status, TrangThai: status,
      Phone: phone, SDT: phone,
      Note: note, GhiChu: note,
      NgayCapNhat: new Date().toISOString().split('T')[0],
    };
    if (pass) { payload.Password = pass; payload.MatKhau = pass; }

    if (editingUserId) {
      await NOCO.updateUser(editingUserId, payload);
      showToast('✓ Đã cập nhật người dùng!', 'success');
    } else {
      payload.NgayTao = new Date().toISOString().split('T')[0];
      await NOCO.createUser(payload);
      showToast('✓ Đã thêm người dùng!', 'success');
    }
    closeUserModal();
    await loadUsers();
  } catch(e) {
    msg.innerHTML = `<span style="color:var(--danger)">Lỗi: ${e.message}</span>`;
  } finally {
    btn.disabled = false;
  }
}

async function editUser(id) {
  try {
    // Fetch trực tiếp từ server thay vì tìm trong allUsers (đã xóa)
    const user = await NOCO.getUser(id);
    if (user) openUserModal(user);
  } catch(e) {
    showToast('Lỗi tải thông tin user: ' + e.message, 'error');
  }
}

async function deleteUser(id, name) {
  if (!confirm(`Xóa người dùng "${name}"?\nHành động này không thể hoàn tác!`)) return;
  try {
    await NOCO.deleteUser(id);
    showToast(`✓ Đã xóa "${name}"`, 'success');
    await loadUsers();
  } catch(e) {
    showToast('Lỗi xóa: ' + e.message, 'error');
  }
}

function esc(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ── State ──
let nocoFields = [];
let nocoCurrentTab = 'records';
let nocoEditRowId = null;

function updateNocoStatus(connected, label = '') {
  const bar = document.getElementById('noco-status-bar');
  const txt = document.getElementById('noco-status-text');
  if (bar) bar.className = `gh-status ${connected ? 'connected' : 'disconnected'}`;
  if (txt) txt.textContent = connected ? (label || 'NocoDB đã kết nối') : 'Chưa kết nối NocoDB';
}

function setNocoSyncBar(show, text='', time='', err=false) {
  const bar = document.getElementById('noco-sync-bar');
  if (!bar) return;
  bar.style.display = show ? 'flex' : 'none';
  bar.className = 'sync-bar' + (err ? ' error' : show ? ' syncing' : '');
  const st = document.getElementById('noco-sync-text');
  const tm = document.getElementById('noco-sync-time');
  if (st) st.textContent = text;
  if (tm) tm.textContent = time;
}

// ── Test connection button in settings ──
async function nocoTestAndSave() {
  const res = document.getElementById('noco-test-result');
  res.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Đang kiểm tra...';
  try {
    await NOCO.testConnection();
    res.innerHTML = '<i class="fas fa-check-circle" style="color:var(--teal)"></i> Kết nối thành công qua proxy!';
    updateNocoStatus(true, 'api.gds.edu.vn');
    showToast('✓ Kết nối NocoDB thành công!', 'success');
  } catch(e) {
    res.innerHTML = `<i class="fas fa-times-circle" style="color:var(--danger)"></i> ${e.message}`;
    updateNocoStatus(false);
    showToast('Lỗi: ' + e.message, 'error');
  }
}

// ── Load records ──

// ── Load fields ──

function fieldIcon(type) {
  const map = { SingleLineText:'font', LongText:'align-left', Number:'hashtag', Decimal:'hashtag', Checkbox:'check-square', Date:'calendar', DateTime:'clock', Email:'envelope', URL:'link', PhoneNumber:'phone', Attachment:'paperclip', MultiSelect:'tags', SingleSelect:'tag', Rating:'star', Currency:'dollar-sign', Percent:'percent', Formula:'calculator', Lookup:'magnifying-glass', Rollup:'layer-group', LinkToAnotherRecord:'table-columns' };
  return map[type] || 'circle';
}

// ── Edit record (modal) ──

// ── Add record ──

// ── Delete record ──

// ── Filter / query ──

// ── Export CSV ──

// ── Sync all articles to NocoDB ──


function switchNocoTab(tab) {
  nocoCurrentTab = tab;
  ['records','users','fields','query'].forEach(t => {
    document.getElementById(`noco-tab-${t}`).style.display = t === tab ? 'block' : 'none';
    document.getElementById(`ntab-${t}`)?.classList.toggle('active', t === tab);
  });
  if (tab === 'fields') nocoLoadFields();
}

// Preview bài viết trong tab mới
function previewArticle() {
  const item = currentEditPath ? flattenFiles(indexTree).find(f => f.path === currentEditPath) : null;
  const nocoId = item?.nocoId;
  if (nocoId) {
    window.open(`${window.location.origin}/bai/${nocoId}`, '_blank');
  } else if (currentEditPath) {
    showToast('Lưu bài trước để xem trước!', 'warn');
  } else {
    showToast('Chưa chọn bài nào', 'warn');
  }
}

// Hiện/ẩn nút Preview tùy theo bài có nocoId chưa
function _updatePreviewBtn() {
  const btn = document.getElementById('btn-preview');
  if (!btn) return;
  const item = currentEditPath ? flattenFiles(indexTree).find(f => f.path === currentEditPath) : null;
  btn.style.display = (item?.nocoId) ? '' : 'none';
}

// Keyboard shortcuts
document.addEventListener('keydown', e => {
  if ((e.ctrlKey||e.metaKey) && e.key==='s') { e.preventDefault(); saveToNoco(); }
  if ((e.ctrlKey||e.metaKey) && e.key==='p') { e.preventDefault(); previewArticle(); }
  if (e.key === 'Escape') closeModal();
});

// ═══════════════════════════════════════════════════
// UNIFIED TREE — cây thư mục duy nhất cho panel Soạn thảo
// ═══════════════════════════════════════════════════
let _ctxTarget = null; // { type:'file'|'folder', path, name, item }

function renderUnifiedTree(tree, filter) {
  const body = document.getElementById('unified-tree-body');
  if (!body) return;
  if (!tree || !tree.length) {
    body.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-muted);font-size:13px"><i class="fas fa-plug" style="display:block;font-size:20px;margin-bottom:8px"></i>Kết nối NocoDB để tải</div>';
    return;
  }
  body.innerHTML = '';
  _renderUnifiedItems(tree, body, '', filter || '');
}

function _renderUnifiedItems(items, container, parentPath, filter) {
  (items || []).forEach(item => {
    if (item.type === 'folder') {
      const folderPath = parentPath ? parentPath + '/' + item.name : item.name;
      item.folderPath = folderPath;
      const childFiles = (item.children || []).filter(c => c.type === 'file');
      const childFolders = (item.children || []).filter(c => c.type === 'folder');
      const matchFilter = !filter || item.name.toLowerCase().includes(filter) ||
        childFiles.some(f => f.name.toLowerCase().includes(filter)) ||
        childFolders.length > 0;
      if (!matchFilter) return;

      const wrap = document.createElement('div');
      wrap.className = 'utree-folder';
      if (!filter) wrap.classList.add('open');

      const hd = document.createElement('div');
      hd.className = 'utree-folder-hd';
      hd.innerHTML = `
        <i class="fas fa-chevron-right utree-chevron"></i>
        <i class="fas fa-folder" style="color:#60a5fa;font-size:12px;flex-shrink:0"></i>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${item.name}</span>
        ${childFiles.length ? `<span style="font-size:10px;background:#e0e7ff;color:#3730a3;padding:1px 5px;border-radius:8px;flex-shrink:0">${childFiles.length}</span>` : ''}
        <span class="ubadge ${item.access==='private'?'ubadge-priv':'ubadge-pub'}">${item.access==='private'?'prv':'pub'}</span>`;
      hd.onclick = () => { wrap.classList.toggle('open'); selectedFolder = folderPath; };
      hd.oncontextmenu = (e) => { e.preventDefault(); showCtxMenu(e, 'folder', folderPath, item.name, item); };

      const children = document.createElement('div');
      children.className = 'utree-folder-children';
      _renderUnifiedItems(item.children || [], children, folderPath, filter);

      wrap.appendChild(hd);
      wrap.appendChild(children);
      container.appendChild(wrap);
    } else {
      if (!item.path) return;
      if (filter && !item.name.toLowerCase().includes(filter)) return;

      const el = document.createElement('div');
      el.className = 'utree-file';
      if (currentEditPath === item.path) el.classList.add('active');
      el.dataset.path = item.path;
      el.innerHTML = `
        <i class="fas fa-file-lines" style="font-size:11px;flex-shrink:0"></i>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${item.name}">${item.name}</span>
        <span class="ubadge ${item.access==='private'?'ubadge-priv':'ubadge-pub'}">${item.access==='private'?'prv':'pub'}</span>`;
      el.onclick = () => openArticleEditor(item.path);
      el.oncontextmenu = (e) => { e.preventDefault(); showCtxMenu(e, 'file', item.path, item.name, item); };
      container.appendChild(el);
    }
  });
}

function filterTree(q) {
  renderUnifiedTree(indexTree, q.toLowerCase().trim());
}

// ── Context Menu ─────────────────────────────────
function showCtxMenu(e, type, path, name, item) {
  _ctxTarget = { type, path, name, item };
  const menu = document.getElementById('ctx-menu');
  document.getElementById('ctx-edit').style.display = type === 'file' ? '' : 'none';
  // Đặt vị trí
  menu.style.display = 'block';
  const mx = Math.min(e.clientX, window.innerWidth - 170);
  const my = Math.min(e.clientY, window.innerHeight - 160);
  menu.style.left = mx + 'px';
  menu.style.top  = my + 'px';
}

function hideCtxMenu() { document.getElementById('ctx-menu').style.display = 'none'; }
document.addEventListener('click', hideCtxMenu);
document.addEventListener('keydown', e => { if (e.key === 'Escape') hideCtxMenu(); });

function ctxEdit() {
  hideCtxMenu();
  if (_ctxTarget?.type === 'file') openArticleEditor(_ctxTarget.path);
}

function ctxRename() {
  hideCtxMenu();
  if (!_ctxTarget) return;
  const { type, path, name } = _ctxTarget;
  const newName = prompt(`Đổi tên ${type === 'folder' ? 'thư mục' : 'bài'}:`, name);
  if (!newName || !newName.trim() || newName.trim() === name) return;
  if (type === 'folder') doRenameFolder(path, name, newName.trim());
  else doRenameFile(path, name, newName.trim());
}

function ctxDelete() {
  hideCtxMenu();
  if (!_ctxTarget) return;
  if (_ctxTarget.type === 'folder') confirmDeleteFolder(_ctxTarget.path);
  else confirmDeleteFile(_ctxTarget.path);
}

function ctxMove() {
  hideCtxMenu();
  if (!_ctxTarget) return;
  const { type, path, name } = _ctxTarget;
  document.getElementById('move-modal-title').textContent = `Di chuyển ${type === 'folder' ? 'thư mục' : 'bài'}: "${name}"`;
  document.getElementById('move-modal-sub').textContent = type === 'folder' ? 'Chọn thư mục cha mới (không thể chọn chính nó hoặc con cháu)' : 'Chọn thư mục chứa bài mới';
  document.getElementById('move-target-path').value = '';
  document.getElementById('move-selected-path').innerHTML = '<i class="fas fa-folder-open"></i> (gốc)';
  // Render cây loại trừ chính nó và con cháu
  const excludePrefix = type === 'folder' ? path : null;
  renderMoveTree(indexTree, document.getElementById('move-tree-body'), '', excludePrefix);
  document.getElementById('modal-move').classList.add('show');
}

function renderMoveTree(items, container, parentPath, exclude) {
  container.innerHTML = '';
  (items || []).forEach(item => {
    if (item.type !== 'folder') return;
    const fp = parentPath ? parentPath + '/' + item.name : item.name;
    // Loại trừ chính nó và con cháu
    if (exclude && (fp === exclude || fp.startsWith(exclude + '/'))) return;
    const wrap = document.createElement('div');
    wrap.className = 'modal-tree-folder';
    const hd = document.createElement('div');
    hd.className = 'modal-tree-folder-hd';
    const childFolders = (item.children || []).filter(c => c.type === 'folder').filter(c => {
      const cfp = fp + '/' + c.name;
      return !exclude || (cfp !== exclude && !cfp.startsWith(exclude + '/'));
    });
    hd.innerHTML = `
      ${childFolders.length ? '<i class="fas fa-chevron-right" style="font-size:9px;color:#94a3b8;transition:transform .15s;flex-shrink:0"></i>' : '<span style="width:13px;display:inline-block"></span>'}
      <i class="fas fa-folder" style="color:#60a5fa;font-size:13px;flex-shrink:0"></i>
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${item.name}</span>`;
    hd.onclick = () => moveSelectFolder(fp, wrap);
    if (childFolders.length) {
      hd.querySelector('.fa-chevron-right').onclick = (e) => { e.stopPropagation(); wrap.classList.toggle('open'); };
    }
    const children = document.createElement('div');
    children.className = 'modal-tree-folder-children';
    renderMoveTree(item.children || [], children, fp, exclude);
    wrap.appendChild(hd);
    wrap.appendChild(children);
    container.appendChild(wrap);
  });
}

function moveSelectFolder(path, folderEl) {
  document.querySelectorAll('#move-tree-body .modal-tree-folder-hd.selected').forEach(el => el.classList.remove('selected'));
  folderEl.querySelector('.modal-tree-folder-hd').classList.add('selected');
  document.getElementById('move-target-path').value = path;
  document.getElementById('move-selected-path').innerHTML = `<i class="fas fa-folder-open" style="color:#3b82f6"></i> ${path.replace(/\//g,' › ')}`;
}

function moveSelectRoot() {
  document.querySelectorAll('#move-tree-body .modal-tree-folder-hd.selected').forEach(el => el.classList.remove('selected'));
  document.getElementById('move-target-path').value = '';
  document.getElementById('move-selected-path').innerHTML = '<i class="fas fa-folder-open"></i> (gốc)';
}

async function confirmMove() {
  if (!_ctxTarget) return;
  const { type, path, name } = _ctxTarget;
  const dest = document.getElementById('move-target-path').value;
  const newPath = dest ? dest + '/' + name : name;

  // Kiểm tra trùng tại đích
  function findChildren(items, folderPath) {
    if (!folderPath) return items;
    const parts = folderPath.split('/');
    let node = items;
    for (const part of parts) {
      const found = node.find(i => i.type === 'folder' && i.name === part);
      if (!found) return null;
      node = found.children || [];
    }
    return node;
  }
  const destChildren = findChildren(indexTree, dest) || [];
  const sameName = destChildren.find(i => i.name === name);
  if (sameName) { showToast(`Đã có "${name}" tại thư mục đích!`, 'warn'); return; }

  closeModal();
  showLoading('Đang di chuyển...');
  try {
    if (type === 'file') {
      // Cập nhật Article: Path + Folder — dùng nocoId từ _ctxTarget.item
      const rowId = _ctxTarget.item?.nocoId || await _getNocoId(path);
      if (!rowId) throw new Error('Không tìm thấy bài trong NocoDB');
      await NOCO.updateRecord(rowId, { Path: newPath, Folder: dest });
      // Cập nhật indexTree
      function moveFile(items, oldPath, destPath, destFolder) {
        for (let i = 0; i < items.length; i++) {
          if (items[i].type === 'file' && items[i].path === oldPath) {
            const [removed] = items.splice(i, 1);
            removed.path = destPath;
            removed.folder = destFolder;
            return removed;
          }
          if (items[i].children) {
            const found = moveFile(items[i].children, oldPath, destPath, destFolder);
            if (found) return found;
          }
        }
        return null;
      }
      const movedItem = moveFile(indexTree, path, newPath, dest);
      if (movedItem) {
        const destArr = findChildren(indexTree, dest);
        if (destArr) destArr.push(movedItem);
        else indexTree.push(movedItem);
      }
      if (currentEditPath === path) {
        currentEditPath = newPath;
        document.getElementById('e-path-label').innerHTML = `<i class="fas fa-file-lines" style="color:var(--primary)"></i> ${newPath}`;
      }
    } else {
      // Di chuyển thư mục: cập nhật Folder record + tất cả bài con
      const oldPathPrefix = path;
      const newPathPrefix = newPath;
      // Cập nhật folder trong Folders table
      const fData = await NOCO.listFolders();
      for (const f of (fData.list || [])) {
        if (f.Path === oldPathPrefix) {
          await NOCO.call('folders', '', 'PATCH', [{ Id: f.Id, Path: newPathPrefix, Parent: dest }]);
        } else if ((f.Path || '').startsWith(oldPathPrefix + '/')) {
          const newSubPath = newPathPrefix + f.Path.slice(oldPathPrefix.length);
          await NOCO.call('folders', '', 'PATCH', [{ Id: f.Id, Path: newSubPath }]);
        }
      }
      // Cập nhật tất cả bài con trong Articles table — dùng nocoId trực tiếp
      const allFiles = flattenFiles(indexTree).filter(f => f.path && f.path.startsWith(oldPathPrefix + '/'));
      for (const file of allFiles) {
        const rowId = file.nocoId || await _getNocoId(file.path);
        if (rowId) {
          const newFilePath = newPathPrefix + file.path.slice(oldPathPrefix.length);
          const newFolder = dest ? dest + '/' + name + file.folder.slice(oldPathPrefix.length) : name + file.folder.slice(oldPathPrefix.length);
          await NOCO.updateRecord(rowId, { Path: newFilePath, Folder: newFolder });
        }
      }
      // Cập nhật currentEditPath nếu đang mở bài trong folder vừa di chuyển
      if (currentEditPath && currentEditPath.startsWith(oldPathPrefix + '/')) {
        currentEditPath = newPathPrefix + currentEditPath.slice(oldPathPrefix.length);
        const lbl = document.getElementById('e-path-label');
        if (lbl) lbl.innerHTML = `<i class="fas fa-file-lines" style="color:var(--primary)"></i> ${currentEditPath}`;
      }
    }
    // Reload từ NocoDB để đảm bảo toàn vẹn
    await syncFromNoco();
    showToast(`✓ Đã di chuyển "${name}" thành công!`, 'success');
  } catch(e) {
    showToast('Lỗi di chuyển: ' + e.message, 'error');
  } finally { hideLoading(); }
}

// ── Đổi tên bài (Article) ─────────────────────────
async function doRenameFile(oldPath, currentName, newName) {
  showLoading('Đang đổi tên bài...');
  try {
    const rowId = await _getNocoId(oldPath);
    if (!rowId) throw new Error('Không tìm thấy bài trong NocoDB');
    const item = flattenFiles(indexTree).find(f => f.path === oldPath);
    const folder = item?.folder || '';
    const newPath = folder ? folder + '/' + newName : newName;
    await NOCO.updateRecord(rowId, { Title: newName, Path: newPath });
    // Cập nhật indexTree
    function renameFn(items) {
      for (const item of items) {
        if (item.type === 'file' && item.path === oldPath) {
          item.name = newName; item.path = newPath; return true;
        }
        if (item.children && renameFn(item.children)) return true;
      }
      return false;
    }
    renameFn(indexTree);
    if (currentEditPath === oldPath) {
      currentEditPath = newPath;
      document.getElementById('e-title').value = newName;
      document.getElementById('e-path-label').innerHTML = `<i class="fas fa-file-lines" style="color:var(--primary)"></i> ${newPath}`;
    }
    commitIndexTree();
    showToast(`✓ Đã đổi tên thành "${newName}"`, 'success');
  } catch(e) {
    showToast('Lỗi đổi tên: ' + e.message, 'error');
  } finally { hideLoading(); }
}

window.addEventListener('DOMContentLoaded', () => {
  const hasAuth = sessionStorage.getItem('ae_auth') === '1';
  const hasPass = !!sessionStorage.getItem('ae_admin_pass');
  const loginScreen = document.getElementById('login-screen');
  if (hasAuth && hasPass) {
    loginScreen.style.display = 'none';
    initAdmin();
  } else {
    sessionStorage.removeItem('ae_auth');
    loginScreen.style.display = 'flex';
  }
});
// ── CONFIG EXPORT / IMPORT ──────────────────────────────

// ═══════════════════════════════════════════════════
// PHÂN QUYỀN NGƯỜI DÙNG
// ═══════════════════════════════════════════════════
let currentPermissions = [];
let permUserId   = null;
let permUserName = '';
// Cache cây nội dung với TTL 2 phút — tránh stale data khi admin thêm bài mới
const PERM_CACHE_TTL = 2 * 60 * 1000;
let _permTreeCache = { data: [], ts: 0 };

// ── Mở modal phân quyền cho 1 user ──
async function openPermModal(userId, userName) {
  permUserId   = userId;
  permUserName = userName;

  // Cập nhật UI header
  const initials = userName.trim().split(/\s+/).map(w=>w[0]).slice(-2).join('').toUpperCase() || '?';
  document.getElementById('perm-user-avatar').textContent = initials;
  document.getElementById('perm-user-name-badge').textContent = userName;
  document.getElementById('perm-modal-sub').textContent = `Đang cấu hình quyền cho: ${userName}`;
  document.getElementById('perm-count-label').textContent = '0 mục được chọn';
  document.getElementById('perm-tree').innerHTML =
    '<div style="text-align:center;padding:50px;color:var(--text-muted);font-size:13px"><i class="fas fa-spinner fa-spin" style="font-size:20px;display:block;margin-bottom:10px;color:var(--primary)"></i>Đang tải...</div>';
  document.getElementById('perm-modal').style.display = 'flex';
  document.getElementById('perm-only-private').checked = false;

  try {
    // Tải quyền hiện tại của user này
    const existing = await NOCO.getUserPermissions(userId);
    const existingPaths = new Set(existing.map(p => p.TargetPath));

    // Cache cây với TTL: nếu cache cũ hơn 2 phút → lấy lại từ indexTree hiện tại
    if (!_permTreeCache.data.length || (Date.now() - _permTreeCache.ts) > PERM_CACHE_TTL) {
      _permTreeCache = { data: indexTree, ts: Date.now() };
    }

    currentPermissions = existing.map(p => ({
      type: p.Type || 'article',
      targetId: p.TargetId || '',
      targetPath: p.TargetPath || ''
    }));

    renderPermTreeFromCache();
  } catch(e) {
    document.getElementById('perm-tree').innerHTML =
      `<div style="text-align:center;padding:40px;color:var(--danger)"><i class="fas fa-circle-exclamation" style="font-size:20px;display:block;margin-bottom:10px"></i>${e.message}</div>`;
    showToast('Lỗi tải phân quyền: ' + e.message, 'error');
  }
}

// ── Render cây dựa trên cache ──
function renderPermTreeFromCache() {
  const container  = document.getElementById('perm-tree');
  const onlyPriv   = document.getElementById('perm-only-private')?.checked;
  const grantedSet = new Set(currentPermissions.map(p => p.targetPath));

  if (!_permTreeCache.data || !_permTreeCache.data.length) {
    container.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted)"><i class="fas fa-folder-open" style="font-size:24px;display:block;margin-bottom:10px;opacity:.3"></i>Chưa có nội dung nào.<br><small>Tạo thư mục và bài học trước.</small></div>';
    return;
  }

  container.innerHTML = '';
  _renderPermItems(_permTreeCache.data, container, '', grantedSet, onlyPriv, 0);
  updatePermCountLabel();
}

// ── Render đệ quy từng node ──
function _renderPermItems(items, container, parentPath, grantedSet, onlyPriv, depth) {
  (items || []).forEach(item => {
    if (item.type === 'folder') {
      const folderPath    = parentPath ? parentPath + '/' + item.name : item.name;
      const isPrivate     = item.access === 'private';
      const isGranted     = grantedSet.has(folderPath);
      const childFiles    = (item.children || []).filter(c => c.type === 'file');
      const childFolders  = (item.children || []).filter(c => c.type === 'folder');
      const privateFiles  = childFiles.filter(f => f.access === 'private');
      const grantedFiles  = childFiles.filter(f => grantedSet.has(f.path));
      const hasPrivateChild = isPrivate || privateFiles.length > 0 || childFolders.length > 0;
      if (onlyPriv && !hasPrivateChild) return;

      // Folder wrap
      const wrap = document.createElement('div');
      wrap.className = 'pt-folder-wrap';

      // Folder row
      const row = document.createElement('div');
      row.className = `pt-folder-row${isGranted ? ' pt-checked' : ''}`;
      row.style.paddingLeft = `${14 + depth * 20}px`;

      // Toggle expand button
      const toggle = document.createElement('button');
      toggle.className = 'pt-toggle open';
      toggle.innerHTML = '<i class="fas fa-chevron-right"></i>';
      toggle.onclick = (e) => {
        e.preventDefault(); e.stopPropagation();
        toggle.classList.toggle('open');
        childrenDiv.style.display = toggle.classList.contains('open') ? '' : 'none';
      };

      // Checkbox
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.className = 'pt-cb';
      cb.dataset.type = 'folder'; cb.dataset.path = folderPath; cb.dataset.id = item.nocoId || '';
      cb.checked = isGranted;
      cb.onchange = () => {
        row.classList.toggle('pt-checked', cb.checked);
        wrap.querySelectorAll('input[type=checkbox]').forEach(c => {
          c.checked = cb.checked;
          c.closest('.pt-folder-row, .pt-file-row')?.classList.toggle('pt-checked', cb.checked);
        });
        updatePermCountLabel();
      };

      // Folder icon
      const icon = document.createElement('i');
      icon.className = 'pt-folder-icon fas fa-folder' + (childFiles.length || childFolders.length ? '-open' : '');
      icon.style.color = isPrivate ? '#f87171' : '#60a5fa';

      // Label
      const lbl = document.createElement('span');
      lbl.className = 'pt-folder-label'; lbl.textContent = item.name;

      // Meta: badge + progress bar
      const meta = document.createElement('div');
      meta.className = 'pt-folder-meta';

      if (isPrivate) {
        const badge = document.createElement('span');
        badge.className = 'pt-badge pt-badge-priv';
        badge.innerHTML = '<i class="fas fa-lock" style="font-size:8px"></i> Private';
        meta.appendChild(badge);
      }

      if (childFiles.length > 0) {
        const grantCount = grantedFiles.length;
        const prog = document.createElement('div');
        prog.className = 'pt-prog';
        prog.title = `${grantCount}/${childFiles.length} bài được cấp quyền`;
        prog.innerHTML = `
          <div class="pt-prog-bar">
            <div class="pt-prog-fill" style="width:${Math.round(grantCount/childFiles.length*100)}%"></div>
          </div>
          <span class="pt-prog-text">${grantCount}/${childFiles.length}</span>`;
        meta.appendChild(prog);
      }

      row.appendChild(toggle);
      row.appendChild(cb);
      row.appendChild(icon);
      row.appendChild(lbl);
      row.appendChild(meta);

      // Children container
      const childrenDiv = document.createElement('div');
      childrenDiv.className = 'pt-children';
      childrenDiv.style.paddingLeft = `${20 + depth * 20}px`;

      wrap.appendChild(row);
      wrap.appendChild(childrenDiv);
      container.appendChild(wrap);

      // Render children recursively
      if (item.children && item.children.length) {
        _renderPermItems(item.children, childrenDiv, folderPath, grantedSet, onlyPriv, depth + 1);
      }

    } else {
      // ── Article node ──
      const isPrivate = item.access === 'private' || item.folderAccess === 'private';
      if (onlyPriv && !isPrivate) return;
      const isGranted = grantedSet.has(item.path);

      const row = document.createElement('label');
      row.className = `pt-file-row${isGranted ? ' pt-checked' : ''}`;
      row.style.paddingLeft = `${14 + depth * 20}px`;

      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.className = 'pt-cb';
      cb.dataset.type = 'article'; cb.dataset.path = item.path; cb.dataset.id = item.nocoId || '';
      cb.checked = isGranted;
      cb.onchange = () => { row.classList.toggle('pt-checked', cb.checked); updatePermCountLabel(); };

      const icon = document.createElement('i');
      icon.className = 'fas fa-file-lines';
      icon.style.cssText = 'color:#cbd5e1;font-size:12px;flex-shrink:0;margin:0 8px 0 4px';

      const lbl = document.createElement('span');
      lbl.className = 'pt-file-label';
      lbl.style.cssText = 'flex:1;font-size:13px;color:#334155;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      lbl.textContent = item.name;

      const badge = document.createElement('span');
      badge.className = `pt-badge ${isPrivate ? 'pt-badge-priv' : 'pt-badge-pub'}`;
      badge.style.marginLeft = 'auto';
      badge.innerHTML = isPrivate
        ? '<i class="fas fa-lock" style="font-size:8px"></i> Private'
        : '<i class="fas fa-globe" style="font-size:8px"></i> Public';

      row.appendChild(cb);
      row.appendChild(icon);
      row.appendChild(lbl);
      row.appendChild(badge);
      container.appendChild(row);
    }
  });
}

// ── Đồng bộ state từ checkboxes trong DOM ──
function syncPermFromUI() {
  currentPermissions = [];
  document.querySelectorAll('#perm-tree input[type=checkbox]:checked').forEach(cb => {
    currentPermissions.push({
      type:       cb.dataset.type || 'article',
      targetId:   cb.dataset.id   || '',
      targetPath: cb.dataset.path || ''
    });
  });
}

function updatePermCountLabel() {
  syncPermFromUI();
  const label = document.getElementById('perm-count-label');
  if (label) {
    const n = currentPermissions.length;
    label.textContent = n === 0 ? '0 mục' : `${n} mục`;
  }
  updatePermSummaryChips();
}

function permSelectAll() {
  document.querySelectorAll('#perm-tree input[type=checkbox]').forEach(cb => cb.checked = true);
  updatePermCountLabel();
}

function permClearAll() {
  document.querySelectorAll('#perm-tree input[type=checkbox]').forEach(cb => cb.checked = false);
  updatePermCountLabel();
}

function closePermModal() {
  document.getElementById('perm-modal').style.display = 'none';
  permUserId = null;
  permUserName = '';
  currentPermissions = [];
  // Giữ cache lại (có TTL) để mở modal tiếp theo nhanh hơn
  // _permTreeCache không xóa ở đây — sẽ tự hết hạn sau PERM_CACHE_TTL
}

// ── Lưu phân quyền ──
async function savePermissions() {
  if (!permUserId) { showToast('Lỗi: không xác định được user!', 'error'); return; }
  syncPermFromUI();
  const btn = document.getElementById('perm-save-btn');
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Đang lưu...';

  try {
    await NOCO.setPermissions(permUserId, currentPermissions);
    const n = currentPermissions.length;
    showToast(`✓ Đã lưu ${n} quyền cho ${permUserName}!`, 'success');
    closePermModal();
  } catch(e) {
    showToast('Lỗi lưu quyền: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-save"></i> Lưu phân quyền';
  }
}

// ── Cập nhật stats bar khi loadUsers trả về data ──
async function updateUserStats() {
  try {
    // Fetch count theo từng role song song
    const [resAll, resTeacher, resInactive] = await Promise.all([
      NOCO.listUsers({ limit: 1 }),
      NOCO.listUsers({ limit: 1, where: '(Role,eq,teacher)' }),
      NOCO.listUsers({ limit: 1, where: '(Status,eq,inactive)' }),
    ]);
    const total    = resAll.pageInfo?.totalRows ?? 0;
    const teachers = resTeacher.pageInfo?.totalRows ?? 0;
    const inactive = resInactive.pageInfo?.totalRows ?? 0;
    // Học sinh = tổng - giáo viên - admin (ước tính)
    const students = Math.max(0, total - teachers);
    const elTotal    = document.getElementById('stat-total-users');
    const elStudents = document.getElementById('stat-total-students');
    const elTeachers = document.getElementById('stat-total-teachers');
    const elInactive = document.getElementById('stat-total-inactive');
    if (elTotal)    elTotal.textContent    = total;
    if (elStudents) elStudents.textContent = students;
    if (elTeachers) elTeachers.textContent = teachers;
    if (elInactive) elInactive.textContent = inactive;
  } catch(e) { /* stats là optional, lỗi không block UI */ }
}

// Save permissions after saving user


// ══════════════════════════════════════════════════════════════
// USER MANAGEMENT — NEW FUNCTIONS
// ══════════════════════════════════════════════════════════════

// ── Stats card: click to quick-filter ──
function quickFilterStat(type) {
  // Deactivate all cards
  ['ustat-all','ustat-student','ustat-teacher','ustat-inactive'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.remove('ustat-active');
  });
  const roleFilter   = document.getElementById('user-role-filter');
  const statusFilter = document.getElementById('user-status-filter');
  if (type === 'inactive') {
    if (statusFilter) statusFilter.value = 'inactive';
    if (roleFilter)   roleFilter.value   = '';
    document.getElementById('ustat-inactive')?.classList.add('ustat-active');
  } else {
    if (statusFilter) statusFilter.value = '';
    if (roleFilter)   roleFilter.value   = type; // '' | 'student' | 'teacher'
    if (type === '')          document.getElementById('ustat-all')?.classList.add('ustat-active');
    else if (type==='student') document.getElementById('ustat-student')?.classList.add('ustat-active');
    else if (type==='teacher') document.getElementById('ustat-teacher')?.classList.add('ustat-active');
  }
  filterUsers();
  updateClearFilterBtn();
}

// ── Clear filter / search helpers ──
function clearUserSearch() {
  const inp = document.getElementById('user-search');
  if (inp) { inp.value = ''; inp.dispatchEvent(new Event('input')); }
}

function updateClearFilterBtn() {
  const q      = document.getElementById('user-search')?.value || '';
  const role   = document.getElementById('user-role-filter')?.value || '';
  const status = document.getElementById('user-status-filter')?.value || '';
  const hasFilter = q || role || status;
  const clearBtn   = document.getElementById('clear-filter-btn');
  const searchClearBtn = document.getElementById('user-search-clear');
  if (clearBtn)      clearBtn.style.display      = hasFilter ? '' : 'none';
  if (searchClearBtn) searchClearBtn.style.display = q ? '' : 'none';
}

function clearUserFilters() {
  const rf = document.getElementById('user-role-filter');
  const sf = document.getElementById('user-status-filter');
  const s  = document.getElementById('user-search');
  if (rf) rf.value = '';
  if (sf) sf.value = '';
  if (s)  s.value  = '';
  ['ustat-all','ustat-student','ustat-teacher','ustat-inactive']
    .forEach(id => document.getElementById(id)?.classList.remove('ustat-active'));
  filterUsers();
  updateClearFilterBtn();
}

// ── Bulk select ──
function onUserRowCheck(cb, uid) {
  if (cb.checked) _selectedUserIds.add(uid);
  else            _selectedUserIds.delete(uid);
  const row = document.getElementById(`urow-${uid}`);
  if (row) row.classList.toggle('urow-selected', cb.checked);
  updateBulkBar();
}

function toggleSelectAllUsers(masterCb) {
  const cbs = document.querySelectorAll('.user-row-cb');
  cbs.forEach(cb => {
    cb.checked = masterCb.checked;
    const uid = parseInt(cb.dataset.id);
    if (masterCb.checked) _selectedUserIds.add(uid);
    else                  _selectedUserIds.delete(uid);
    const row = document.getElementById(`urow-${uid}`);
    if (row) row.classList.toggle('urow-selected', masterCb.checked);
  });
  updateBulkBar();
}

function updateBulkBar() {
  const bar   = document.getElementById('bulk-bar');
  const label = document.getElementById('bulk-count-label');
  const n = _selectedUserIds.size;
  if (bar)   bar.classList.toggle('show', n > 0);
  if (label) label.textContent = `${n} người dùng đã chọn`;
}

function clearBulkSelect() {
  _selectedUserIds.clear();
  document.querySelectorAll('.user-row-cb').forEach(cb => { cb.checked = false; });
  document.querySelectorAll('.urow.urow-selected').forEach(row => row.classList.remove('urow-selected'));
  const selAll = document.getElementById('select-all-users');
  if (selAll) selAll.checked = false;
  updateBulkBar();
}

async function bulkDeleteUsers() {
  const ids = [..._selectedUserIds];
  if (!ids.length) return;
  if (!confirm(`Xóa ${ids.length} người dùng đã chọn?\nHành động này không thể hoàn tác!`)) return;
  showLoading(`Đang xóa ${ids.length} người dùng...`);
  let ok = 0, fail = 0;
  for (const id of ids) {
    try { await NOCO.deleteUser(id); ok++; }
    catch { fail++; }
  }
  hideLoading();
  clearBulkSelect();
  await loadUsers();
  showToast(`✓ Đã xóa ${ok} người dùng${fail ? ` (${fail} lỗi)` : ''}`, ok > 0 ? 'success' : 'error');
}

async function bulkSetStatus(newStatus) {
  const ids = [..._selectedUserIds];
  if (!ids.length) return;
  const label = newStatus === 'active' ? 'kích hoạt' : 'vô hiệu hóa';
  if (!confirm(`${label.charAt(0).toUpperCase()+label.slice(1)} ${ids.length} người dùng đã chọn?`)) return;
  showLoading(`Đang ${label} ${ids.length} tài khoản...`);
  let ok = 0;
  for (const id of ids) {
    try {
      await NOCO.updateUser(id, { Status: newStatus, TrangThai: newStatus });
      ok++;
    } catch {}
  }
  hideLoading();
  clearBulkSelect();
  await loadUsers();
  showToast(`✓ Đã ${label} ${ok} tài khoản`, 'success');
}

// ── Quick status toggle per row ──
async function quickToggleStatus(uid, name, currentStatus) {
  const newStatus = currentStatus === 'active' ? 'inactive' : 'active';
  const label = newStatus === 'active' ? 'kích hoạt' : 'vô hiệu hóa';
  const chip = document.querySelector(`#urow-${uid} .status-chip`);
  if (chip) { chip.disabled = true; chip.style.opacity = '0.5'; }
  try {
    await NOCO.updateUser(uid, { Status: newStatus, TrangThai: newStatus });
    showToast(`✓ Đã ${label} tài khoản "${name}"`, 'success');
    await loadUsers();
  } catch(e) {
    if (chip) { chip.disabled = false; chip.style.opacity = ''; }
    showToast('Lỗi đổi trạng thái: ' + e.message, 'error');
  }
}

// ── Lazy load permission counts ──
async function _lazyLoadPermCounts(userIds) {
  if (!userIds || !userIds.length) return;
  // Fetch counts in parallel, max 5 at a time
  const BATCH = 5;
  for (let i = 0; i < userIds.length; i += BATCH) {
    const batch = userIds.slice(i, i + BATCH);
    await Promise.all(batch.map(async (uid) => {
      try {
        const data = await NOCO.listPermissions(uid);
        const count = (data.list || []).length;
        const chip  = document.getElementById(`perm-chip-${uid}`);
        const val   = document.getElementById(`perm-chip-val-${uid}`);
        if (!chip || !val) return;
        if (count > 0) {
          chip.className = 'perm-chip has-perms';
          val.textContent = `${count} quyền`;
        } else {
          chip.className = 'perm-chip no-perms';
          val.textContent = 'Chưa cấp';
        }
      } catch { /* optional — không block UI */ }
    }));
  }
}

// ── Export CSV ──
function exportUsersCSV() {
  const rows = document.querySelectorAll('#users-tbody tr.urow');
  if (!rows.length) { showToast('Không có dữ liệu để xuất!', 'warn'); return; }
  const headers = ['Họ tên','Email','Vai trò','Trạng thái','Ngày tạo'];
  const lines = [headers.join(',')];
  rows.forEach(row => {
    const cells = row.querySelectorAll('td');
    if (cells.length < 6) return;
    const nameEl  = cells[1].querySelector('div > div:first-child');
    const emailEl = cells[1].querySelector('div > div:nth-child(2)');
    const roleEl  = cells[2].querySelector('span');
    const statEl  = cells[3].querySelector('button');
    const dateEl  = cells[5];
    const cols = [
      (nameEl?.textContent  || '').trim(),
      (emailEl?.textContent || '').trim(),
      (roleEl?.textContent  || '').trim(),
      (statEl?.textContent  || '').trim(),
      (dateEl?.textContent  || '').trim(),
    ].map(v => `"${v.replace(/"/g,'""')}"`);
    lines.push(cols.join(','));
  });
  const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `users_${new Date().toISOString().split('T')[0]}.csv`;
  a.click(); URL.revokeObjectURL(url);
  showToast(`✓ Đã xuất ${lines.length - 1} người dùng`, 'success');
}

// ── User Modal helpers ──
function updateUMAvatarPreview() {
  const name = (document.getElementById('um-name')?.value || '').trim();
  const role = document.getElementById('um-role')?.value || 'student';
  const colors = { admin:'#ef4444', teacher:'#4338ca', student:'#2563eb' };
  const color  = colors[role] || '#2563eb';
  const initials = name
    ? name.split(/\s+/).map(w=>w[0]).filter(Boolean).slice(-2).join('').toUpperCase()
    : '?';
  const roleLabels = { admin:'⚡ Admin', teacher:'👨‍🏫 Giáo viên', student:'🎓 Học sinh' };
  const preview = document.getElementById('um-avatar-preview');
  const sName   = document.getElementById('um-sidebar-name');
  const sRole   = document.getElementById('um-sidebar-role');
  if (preview) { preview.textContent = initials; preview.style.background = color; }
  if (sName)   sName.textContent = name || 'Người dùng mới';
  if (sRole)   sRole.textContent = roleLabels[role] || role;
}

function togglePwVisibility(inputId, btn) {
  const inp = document.getElementById(inputId);
  if (!inp) return;
  const isText = inp.type === 'text';
  inp.type = isText ? 'password' : 'text';
  btn.innerHTML = isText ? '<i class="fas fa-eye"></i>' : '<i class="fas fa-eye-slash"></i>';
}

function updatePasswordStrength() {
  const pass = document.getElementById('um-pass')?.value || '';
  const fill = document.getElementById('pw-strength-fill');
  const hint = document.getElementById('pw-hint');
  if (!fill) return;
  let score = 0;
  if (pass.length >= 6)  score++;
  if (pass.length >= 10) score++;
  if (/[A-Z]/.test(pass) && /[a-z]/.test(pass)) score++;
  if (/[0-9]/.test(pass) || /[^A-Za-z0-9]/.test(pass)) score++;
  const levels = [
    { w:'0%',   c:'transparent', t:'' },
    { w:'25%',  c:'#ef4444',     t:'Rất yếu' },
    { w:'50%',  c:'#f59e0b',     t:'Yếu' },
    { w:'75%',  c:'#3b82f6',     t:'Trung bình' },
    { w:'100%', c:'#22c55e',     t:'Mạnh' },
  ];
  const lv = levels[pass.length ? score + 1 : 0] || levels[0];
  fill.style.width = lv.w; fill.style.background = lv.c;
  if (hint) { hint.textContent = lv.t; hint.style.color = lv.c; }
}

// ── Permission Modal additions ──

// Chọn tất cả Private items
function permSelectAllPrivate() {
  document.querySelectorAll('#perm-tree input[type=checkbox]').forEach(cb => {
    const row = cb.closest('.pt-folder-row, .pt-file-row');
    const badge = row?.querySelector('.pt-badge-priv');
    if (badge || !row) cb.checked = true; // nếu không có row = folder wrap
  });
  updatePermCountLabel();
}

// Filter perm tree theo search
function filterPermTree(q) {
  q = (q || '').toLowerCase().trim();
  // Re-render nếu query thay đổi
  if (!q) {
    renderPermTreeFromCache();
    return;
  }
  // Filter: show only items matching q
  const container = document.getElementById('perm-tree');
  if (!container) return;
  // Traverse all visible rows and hide/show
  const allWrap = container.querySelectorAll('.pt-folder-wrap, .pt-file-row');
  allWrap.forEach(el => {
    const labelEl = el.querySelector('.pt-folder-label, .pt-file-label');
    const text    = (labelEl?.textContent || '').toLowerCase();
    el.classList.toggle('pt-hidden', !text.includes(q));
  });
  // Show parent folders if any child matches
  container.querySelectorAll('.pt-folder-wrap').forEach(fw => {
    const children = fw.querySelector('.pt-children');
    if (children && children.querySelectorAll('.pt-file-row:not(.pt-hidden)').length > 0) {
      fw.classList.remove('pt-hidden');
    }
  });
}

function clearPermSearch() {
  const inp = document.getElementById('perm-search-input');
  if (inp) { inp.value = ''; filterPermTree(''); }
}

// Update summary chips in footer
function updatePermSummaryChips() {
  const el = document.getElementById('perm-summary-chips');
  if (!el) return;
  syncPermFromUI();
  const folders  = currentPermissions.filter(p => p.type === 'folder').length;
  const articles = currentPermissions.filter(p => p.type === 'article').length;
  if (!folders && !articles) {
    el.innerHTML = '<span style="font-size:12px;color:#94a3b8"><i class="fas fa-info-circle"></i> Không có quyền nào được cấp</span>';
    return;
  }
  let html = '';
  if (folders)  html += `<span class="perm-summary-chip" style="background:#eff6ff;color:#2563eb;border:1px solid #bfdbfe"><i class="fas fa-folder" style="font-size:10px"></i> ${folders} thư mục</span>`;
  if (articles) html += `<span class="perm-summary-chip" style="background:#f0fdf4;color:#15803d;border:1px solid #bbf7d0"><i class="fas fa-file-lines" style="font-size:10px"></i> ${articles} bài học</span>`;
  el.innerHTML = html;
}

// ══════════════════════════════════════════════════════════════
// END NEW FUNCTIONS
// ══════════════════════════════════════════════════════════════

// ── Function aliases (tương thích tên cũ với tên mới) ──
const userLoadRecords  = () => loadUsers();
const userAddRecord    = () => { const p = document.getElementById("user-form-panel"); if(p) p.style.display="block"; else showToast("Dùng nút Thêm user ở trên","info"); };
const userSaveForm     = () => saveUser();
const userCloseForm    = () => { document.getElementById('user-form-panel').style.display='none'; };
const userChangePage   = (dir) => dir > 0 ? userPageNext() : userPagePrev();
const userSearchRecords= (q) => { if(typeof renderUsersTable==="function") renderUsersTable(); };

// ═══════════════════════════════════════════════════
// GLOBAL ERROR HANDLER — bắt tất cả lỗi JS không xử lý
// ═══════════════════════════════════════════════════
window.addEventListener('unhandledrejection', e => {
  const msg = e.reason?.message || String(e.reason) || 'Lỗi không xác định';
  // Bỏ qua lỗi abort (user cancel fetch)
  if (msg.toLowerCase().includes('aborted') || msg.toLowerCase().includes('abort')) return;
  console.error('[AE Admin] Unhandled rejection:', e.reason);
  showToast('⚠️ ' + msg, 'error');
});

window.addEventListener('error', e => {
  if (!e.message) return;
  console.error('[AE Admin] Global error:', e.message, e.filename, e.lineno);
  // Không spam toast cho lỗi resource load (script/img)
  if (e.target && (e.target.tagName === 'SCRIPT' || e.target.tagName === 'LINK')) return;
  showToast('⚠️ JS Error: ' + e.message, 'error');
}, true);

// ═══════════════════════════════════════════════════
// API HEALTH CHECK — kiểm tra Worker còn sống không
// ═══════════════════════════════════════════════════
let _healthBannerShown = false;

async function checkAPIHealth() {
  try {
    const r = await fetch(PROXY + '/admin/articles?limit=1', {
      signal: AbortSignal.timeout(6000),
      headers: adminHeaders()
    });
    if (r.ok || r.status === 401 || r.status === 404) {
      _hideHealthBanner();
    } else {
      _showHealthBanner('Worker phản hồi lỗi ' + r.status);
    }
  } catch(e) {
    _showHealthBanner('Không kết nối được Worker API');
  }
}

function _showHealthBanner(reason) {
  if (_healthBannerShown) return;
  _healthBannerShown = true;
  const banner = document.createElement('div');
  banner.id = 'health-banner';
  banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:#fef2f2;border-bottom:2px solid #fca5a5;padding:10px 20px;display:flex;align-items:center;gap:10px;font-size:13px;color:#b91c1c;font-family:inherit';
  banner.innerHTML = `
    <i class="fas fa-triangle-exclamation" style="font-size:16px;flex-shrink:0"></i>
    <span><strong>Mất kết nối API:</strong> ${reason}. Một số tính năng có thể không hoạt động.</span>
    <button onclick="document.getElementById('health-banner').remove();_healthBannerShown=false;"
      style="margin-left:auto;border:none;background:transparent;cursor:pointer;color:#b91c1c;font-size:18px;padding:0 4px;font-family:inherit" title="Đóng">×</button>
    <button onclick="checkAPIHealth()" style="padding:4px 12px;background:#b91c1c;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;font-family:inherit">Thử lại</button>`;
  document.body.prepend(banner);
}

function _hideHealthBanner() {
  const banner = document.getElementById('health-banner');
  if (banner) { banner.remove(); _healthBannerShown = false; }
}

// Kiểm tra health mỗi 3 phút nếu tab đang focus
setInterval(() => { if (document.visibilityState === 'visible' && sessionStorage.getItem('ae_auth') === '1') checkAPIHealth(); }, 3 * 60 * 1000);

// ── END CONFIG EXPORT / IMPORT ──────────────────────────

// ═══════════════════════════════════════════════════════════════
// QUIZ EDITOR
// ═══════════════════════════════════════════════════════════════

// ── State ──────────────────────────────────────────────────────
let _qmQuestions  = [];   // [{question, options:[{text,correct}], explanation}]
let _qmActiveIdx  = -1;   // index đang chỉnh sửa
let _qmArticleId  = null; // NocoDB article Id
let _qmArticleName = '';

const OPTION_LETTERS = ['A','B','C','D','E','F'];

// ── Open / Close ───────────────────────────────────────────────
async function openQuizEditor() {
  if (!currentEditPath) {
    showToast('Vui lòng mở một bài học trước khi soạn quiz.', 'warn');
    return;
  }
  _qmArticleId   = await _getNocoId(currentEditPath);
  _qmArticleName = document.getElementById('e-title').value || currentEditPath;

  document.getElementById('qm-article-name').textContent = _qmArticleName;
  document.getElementById('quiz-modal-overlay').classList.add('show');

  // Load existing quiz from NocoDB
  await _qmLoadExisting();
}

function closeQuizEditor() {
  document.getElementById('quiz-modal-overlay').classList.remove('show');
}

// ── Load existing quiz ─────────────────────────────────────────
async function _qmLoadExisting() {
  if (!_qmArticleId || !cfg().proxyUrl) return;
  try {
    const adminPass = sessionStorage.getItem('ae_admin_pass') || '';
    const base = (cfg().proxyUrl || 'https://api.gds.edu.vn').replace(/\/$/, '');
    const r = await fetch(
      `${base}/admin/quiz?where=(ArticleId,eq,${_qmArticleId})&limit=1&fields=Id,Questions`,
      { headers: { 'Admin-Password': adminPass } }
    );
    if (!r.ok) { _qmQuestions = []; _qmRender(); return; }
    const data = await r.json();
    const row  = (data.list || [])[0];
    if (row && row.Questions) {
      try { _qmQuestions = JSON.parse(row.Questions); } catch { _qmQuestions = []; }
    } else { _qmQuestions = []; }
  } catch { _qmQuestions = []; }
  _qmActiveIdx = _qmQuestions.length > 0 ? 0 : -1;
  _qmRender();
}

// ── Render list + form ─────────────────────────────────────────
function _qmRender() {
  _qmRenderList();
  _qmRenderForm();
  _qmUpdateFooter();
}

function _qmRenderList() {
  const list = document.getElementById('qm-question-list');
  const countEl = document.getElementById('qm-q-count');
  countEl.textContent = _qmQuestions.length;

  if (!_qmQuestions.length) {
    list.innerHTML = '<div class="qm-list-empty">Chưa có câu hỏi.<br>Nhấn <b>+ Thêm</b> hoặc import file.</div>';
    return;
  }
  list.innerHTML = _qmQuestions.map((q, i) => {
    const hasCorrect = (q.options || []).some(o => o.correct);
    const isActive   = i === _qmActiveIdx;
    const hasError   = !q.question?.trim() || !hasCorrect;
    const preview    = _qmStripLatex(q.question || '(Chưa nhập)').slice(0, 55);
    return `<div class="qm-q-item${isActive ? ' active' : ''}${hasError ? ' has-error' : ''}"
        onclick="_qmSelectQuestion(${i})">
      <span class="qm-q-num">${i + 1}.</span>
      <span class="qm-q-text">${preview}</span>
      ${hasCorrect ? '<i class="fas fa-check-circle qm-q-ok"></i>' : '<i class="fas fa-circle-exclamation" style="color:#f59e0b;font-size:11px;padding-top:2px"></i>'}
    </div>`;
  }).join('');
}

function _qmRenderForm() {
  const emptyState = document.getElementById('qm-empty-state');
  const form       = document.getElementById('qm-form');
  if (_qmActiveIdx < 0 || !_qmQuestions[_qmActiveIdx]) {
    emptyState.style.display = 'flex';
    form.style.display = 'none';
    return;
  }
  emptyState.style.display = 'none';
  form.style.display = 'flex';

  const q = _qmQuestions[_qmActiveIdx];
  document.getElementById('qm-active-num').textContent = `— Câu ${_qmActiveIdx + 1}`;
  document.getElementById('qm-q-text').value = q.question || '';
  document.getElementById('qm-q-expl').value = q.explanation || '';
  qmUpdatePreview('qm-q-text', 'qm-q-preview');
  qmUpdatePreview('qm-q-expl', 'qm-expl-preview');
  _qmRenderOptions();
}

function _qmRenderOptions() {
  const wrap = document.getElementById('qm-options-wrap');
  const q    = _qmQuestions[_qmActiveIdx];
  const opts = q.options || [];
  wrap.innerHTML = opts.map((o, i) => `
    <div class="qm-option-row${o.correct ? ' is-correct' : ''}" id="qm-opt-row-${i}">
      <input type="radio" class="qm-option-radio" name="qm-correct"
        ${o.correct ? 'checked' : ''} onchange="_qmSetCorrect(${i})">
      <span class="qm-option-letter">${OPTION_LETTERS[i] || i + 1}.</span>
      <input class="qm-option-input" type="text" value="${_qmEsc(o.text || '')}"
        placeholder="Nhập lựa chọn... (hỗ trợ $LaTeX$)"
        oninput="_qmOptionInput(this, ${i})">
      ${opts.length > 2 ? `<button class="qm-option-del" onclick="_qmDeleteOption(${i})" title="Xóa lựa chọn này"><i class="fas fa-times"></i></button>` : ''}
    </div>`).join('');
}

// ── CRUD actions ───────────────────────────────────────────────
function qmAddQuestion() {
  _qmSaveFormToState(); // save current before adding
  _qmQuestions.push({ question: '', options: [
    { text: '', correct: false },
    { text: '', correct: false },
    { text: '', correct: false },
    { text: '', correct: false },
  ], explanation: '' });
  _qmActiveIdx = _qmQuestions.length - 1;
  _qmRender();
  // Scroll list to bottom
  const list = document.getElementById('qm-question-list');
  setTimeout(() => { list.scrollTop = list.scrollHeight; }, 50);
  document.getElementById('qm-q-text').focus();
}

function _qmSelectQuestion(idx) {
  _qmSaveFormToState();
  _qmActiveIdx = idx;
  _qmRender();
}

function qmAddOption() {
  if (_qmActiveIdx < 0) return;
  _qmSaveFormToState();
  const q = _qmQuestions[_qmActiveIdx];
  if ((q.options || []).length >= 6) { showToast('Tối đa 6 lựa chọn', 'warn'); return; }
  q.options.push({ text: '', correct: false });
  _qmRenderOptions();
}

function _qmDeleteOption(optIdx) {
  if (_qmActiveIdx < 0) return;
  const q = _qmQuestions[_qmActiveIdx];
  if ((q.options || []).length <= 2) { showToast('Cần ít nhất 2 lựa chọn', 'warn'); return; }
  q.options.splice(optIdx, 1);
  // Ensure at least one correct
  if (!q.options.some(o => o.correct)) q.options[0].correct = true;
  _qmRenderOptions();
}

function _qmSetCorrect(optIdx) {
  if (_qmActiveIdx < 0) return;
  const q = _qmQuestions[_qmActiveIdx];
  (q.options || []).forEach((o, i) => o.correct = i === optIdx);
  // Update row highlight without full re-render
  document.querySelectorAll('.qm-option-row').forEach((row, i) => {
    row.classList.toggle('is-correct', i === optIdx);
  });
}

function _qmOptionInput(el, optIdx) {
  if (_qmActiveIdx < 0) return;
  const q = _qmQuestions[_qmActiveIdx];
  if (q.options[optIdx]) q.options[optIdx].text = el.value;
}

function qmDeleteQuestion() {
  if (_qmActiveIdx < 0) return;
  if (!confirm(`Xóa câu ${_qmActiveIdx + 1}?`)) return;
  _qmQuestions.splice(_qmActiveIdx, 1);
  _qmActiveIdx = Math.min(_qmActiveIdx, _qmQuestions.length - 1);
  _qmRender();
}

// ── Save form state to array ───────────────────────────────────
function _qmSaveFormToState() {
  if (_qmActiveIdx < 0 || !_qmQuestions[_qmActiveIdx]) return;
  const q = _qmQuestions[_qmActiveIdx];
  q.question    = document.getElementById('qm-q-text').value;
  q.explanation = document.getElementById('qm-q-expl').value;
  // Options: already updated in _qmOptionInput / _qmSetCorrect
  // Re-read option text from DOM
  document.querySelectorAll('#qm-options-wrap .qm-option-input').forEach((inp, i) => {
    if (q.options[i]) q.options[i].text = inp.value;
  });
}

function _qmUpdateFooter() {
  const total    = _qmQuestions.length;
  const complete = _qmQuestions.filter(q =>
    q.question?.trim() && (q.options || []).some(o => o.correct) && q.options.every(o => o.text?.trim())
  ).length;
  document.getElementById('qm-footer-stat').textContent =
    total ? `${complete}/${total} câu đầy đủ` : 'Chưa có câu hỏi';
}

// ── Render text + code blocks + LaTeX ──────────────────────────
function _qmRenderContent(text) {
  if (!text || !text.trim()) return '<span style="color:#94a3b8;font-size:13px">Preview sẽ hiển thị ở đây...</span>';
  const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const parts = [];
  const codeRe = /```(\w*)\n?([\s\S]*?)```/g;
  let last = 0, m;
  while ((m = codeRe.exec(text)) !== null) {
    if (m.index > last) parts.push({ type: 'text', content: text.slice(last, m.index) });
    parts.push({ type: 'code', lang: m[1] || '', content: m[2] });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ type: 'text', content: text.slice(last) });

  return parts.map(p => {
    if (p.type === 'code') {
      const lang = p.lang ? `<span style="font-size:10px;color:#94a3b8;float:right">${esc(p.lang)}</span>` : '';
      return `<pre style="background:#1e293b;color:#e2e8f0;padding:10px 14px;border-radius:8px;font-size:12px;font-family:'Courier New',monospace;overflow-x:auto;margin:6px 0;white-space:pre-wrap">${lang}<code>${esc(p.content)}</code></pre>`;
    }
    return `<span class="qm-txt-seg">${esc(p.content).replace(/\n/g,'<br>')}</span>`;
  }).join('');
}

// ── LaTeX preview ──────────────────────────────────────────────
function qmUpdatePreview(srcId, tgtId) {
  const text = document.getElementById(srcId).value;
  const box  = document.getElementById(tgtId);
  box.innerHTML = _qmRenderContent(text);
  if (typeof renderMathInElement !== 'undefined') {
    try {
      box.querySelectorAll('.qm-txt-seg').forEach(el => {
        renderMathInElement(el, {
          delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '$',  right: '$',  display: false },
            { left: '\\[', right: '\\]', display: true },
            { left: '\\(', right: '\\)', display: false },
          ],
          throwOnError: false,
        });
      });
    } catch { /* silent */ }
  }
}

function _qmStripLatex(text) {
  return text.replace(/\$\$[\s\S]*?\$\$/g, '[CT]').replace(/\$[^$]*?\$/g, '[ct]').trim();
}

function _qmEsc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Preview all ────────────────────────────────────────────────
function qmPreviewAll() {
  _qmSaveFormToState();
  const overlay  = document.getElementById('qm-preview-overlay');
  const content  = document.getElementById('qm-preview-content');
  if (!_qmQuestions.length) { showToast('Chưa có câu hỏi để xem trước', 'warn'); return; }

  content.innerHTML = _qmQuestions.map((q, qi) => {
    const opts = (q.options || []).map((o, oi) => `
      <div style="display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:8px;
          background:${o.correct ? '#f0fdf4' : 'transparent'};border:1px solid ${o.correct ? '#86efac' : 'transparent'}">
        <span style="font-weight:700;color:${o.correct ? '#16a34a' : '#64748b'};width:20px">${OPTION_LETTERS[oi]}.</span>
        <span class="qm-latex-render">${_qmEsc(o.text)}</span>
        ${o.correct ? '<span style="margin-left:auto;font-size:11px;color:#16a34a;font-weight:700">✓ Đúng</span>' : ''}
      </div>`).join('');
    return `
      <div style="border:1px solid var(--border);border-radius:12px;padding:16px;background:var(--bg)">
        <div style="font-weight:700;color:var(--primary);font-size:13px;margin-bottom:8px">Câu ${qi + 1}</div>
        <div style="font-size:14.5px;margin-bottom:12px;line-height:1.7">${_qmRenderContent(q.question || '')}</div>
        <div style="display:flex;flex-direction:column;gap:4px">${opts}</div>
        ${q.explanation ? `<div style="margin-top:12px;padding:10px 12px;background:#fffbeb;border-radius:8px;font-size:13px;color:#92400e">
          <i class="fas fa-lightbulb" style="color:#f59e0b;margin-right:5px"></i><span class="qm-latex-render">${_qmEsc(q.explanation)}</span>
        </div>` : ''}
      </div>`;
  }).join('');

  overlay.style.display = 'block';
  if (typeof renderMathInElement !== 'undefined') {
    setTimeout(() => {
      content.querySelectorAll('.qm-latex-render, .qm-txt-seg').forEach(el => {
        try {
          renderMathInElement(el, {
            delimiters: [
              { left: '$$', right: '$$', display: true },
              { left: '$',  right: '$',  display: false },
              { left: '\\[', right: '\\]', display: true },
              { left: '\\(', right: '\\)', display: false },
            ],
            throwOnError: false,
          });
        } catch { /* silent */ }
      });
    }, 50);
  }
}

// ── Save to NocoDB ─────────────────────────────────────────────
async function saveQuiz() {
  _qmSaveFormToState();

  // Validate
  const errors = _qmQuestions.map((q, i) => {
    if (!q.question?.trim()) return `Câu ${i+1}: Thiếu nội dung câu hỏi`;
    if (!(q.options || []).some(o => o.correct)) return `Câu ${i+1}: Chưa chọn đáp án đúng`;
    if (q.options.some(o => !o.text?.trim())) return `Câu ${i+1}: Có lựa chọn bị bỏ trống`;
    return null;
  }).filter(Boolean);

  if (errors.length) {
    showToast(errors[0], 'warn');
    _qmRenderList(); // highlight errors
    return;
  }
  if (!_qmArticleId) { showToast('Không xác định được bài học. Lưu bài vào NocoDB trước.', 'error'); return; }

  const adminPass = sessionStorage.getItem('ae_admin_pass') || '';
  const base      = (cfg().proxyUrl || 'https://api.gds.edu.vn').replace(/\/$/, '');
  const payload   = JSON.stringify(_qmQuestions);

  try {
    // Check if quiz already exists
    const check = await fetch(
      `${base}/admin/quiz?where=(ArticleId,eq,${_qmArticleId})&limit=1&fields=Id`,
      { headers: { 'Admin-Password': adminPass } }
    );
    const checkData = await check.json();
    const existing  = (checkData.list || [])[0];

    if (existing) {
      await fetch(`${base}/admin/quiz`, {
        method: 'PATCH',
        headers: { 'Admin-Password': adminPass, 'Content-Type': 'application/json' },
        body: JSON.stringify([{ Id: existing.Id, Questions: payload }]),
      });
    } else {
      await fetch(`${base}/admin/quiz`, {
        method: 'POST',
        headers: { 'Admin-Password': adminPass, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ArticleId: String(_qmArticleId), Questions: payload, CreatedAt: new Date().toISOString() }),
      });
    }
    showToast(`✓ Đã lưu quiz (${_qmQuestions.length} câu hỏi)`, 'success');
    closeQuizEditor();
  } catch(e) {
    showToast('Lỗi lưu quiz: ' + e.message, 'error');
  }
}

// ═══════════════════════════════════════════════════════════════
// QUIZ IMPORT: PDF / DOCX / TXT → parse → populate editor
// ═══════════════════════════════════════════════════════════════

async function importQuizFile(input, type) {
  const file = input.files[0];
  input.value = ''; // reset so same file can re-import
  if (!file) return;

  _qmShowImportProgress('Đang đọc file...', 10);

  try {
    let rawText = '';
    if (type === 'pdf') {
      rawText = await _extractPDF(file);
    } else if (type === 'docx') {
      rawText = await _extractDOCX(file);
    } else {
      rawText = await file.text();
    }

    _qmShowImportProgress('Đang phân tích đề...', 60);
    const parsed = _parseQuizText(rawText);

    if (!parsed.length) {
      _qmHideImportProgress();
      showToast('Không tìm thấy câu hỏi nào theo định dạng chuẩn.', 'warn');
      _qmShowFormatHelp();
      return;
    }

    _qmShowImportProgress(`Nhập ${parsed.length} câu hỏi...`, 90);
    await new Promise(r => setTimeout(r, 300));

    if (_qmQuestions.length && !confirm(`Tìm thấy ${parsed.length} câu hỏi. Thêm vào ${_qmQuestions.length} câu hiện có? (Hủy để thay thế toàn bộ)`)) {
      _qmQuestions = parsed;
    } else if (!_qmQuestions.length) {
      _qmQuestions = parsed;
    } else {
      _qmQuestions = [..._qmQuestions, ...parsed];
    }

    _qmActiveIdx = 0;
    _qmHideImportProgress();
    _qmRender();
    showToast(`✓ Import thành công ${parsed.length} câu hỏi`, 'success');
  } catch(e) {
    _qmHideImportProgress();
    showToast('Lỗi import: ' + e.message, 'error');
    console.error('Quiz import error:', e);
  }
}

// ── PDF extract via PDF.js ─────────────────────────────────────
async function _extractPDF(file) {
  if (typeof pdfjsLib === 'undefined') throw new Error('PDF.js chưa tải. Tải lại trang và thử lại.');
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    _qmShowImportProgress(`Đọc trang ${i}/${pdf.numPages}...`, 10 + Math.round(i / pdf.numPages * 45));
    const page    = await pdf.getPage(i);
    const content = await page.getTextContent();
    // Reconstruct lines by grouping items with similar Y coordinate
    const items   = content.items;
    const lines   = [];
    let curLine   = [];
    let lastY     = null;
    for (const item of items) {
      const y = Math.round(item.transform[5]);
      if (lastY !== null && Math.abs(y - lastY) > 3) {
        if (curLine.length) lines.push(curLine.map(c => c.str).join(''));
        curLine = [];
      }
      curLine.push(item);
      lastY = y;
    }
    if (curLine.length) lines.push(curLine.map(c => c.str).join(''));
    pages.push(lines.join('\n'));
  }
  return pages.join('\n\n');
}

// ── DOCX extract via mammoth.js ────────────────────────────────
async function _extractDOCX(file) {
  if (typeof mammoth === 'undefined') throw new Error('mammoth.js chưa tải. Tải lại trang và thử lại.');
  const arrayBuffer = await file.arrayBuffer();

  // Dùng convertToHtml để giữ cấu trúc bảng (4-col answer tables)
  const result = await mammoth.convertToHtml({ arrayBuffer });
  return _docxHtmlToText(result.value);
}

// Chuyển HTML của mammoth → text quiz chuẩn
function _docxHtmlToText(html) {
  const div = document.createElement('div');
  div.innerHTML = html;
  const lines = [];

  const esc = s => s; // giữ nguyên text, không encode

  for (const node of div.childNodes) {
    const tag = node.nodeName;

    if (tag === 'TABLE') {
      // Bảng 4 cột = đáp án A B C D trên 1 hàng
      for (const row of node.querySelectorAll('tr')) {
        const cells = [...row.querySelectorAll('td,th')];
        if (cells.length >= 2) {
          // Mỗi cell là 1 đáp án
          for (const cell of cells) {
            const t = cell.textContent.trim();
            if (t) lines.push(t);
          }
        } else if (cells.length === 1) {
          const t = cells[0].textContent.trim();
          if (t) lines.push(t);
        }
      }
    } else if (tag === 'P') {
      const t = node.textContent.trim();
      if (t) lines.push(t);
    } else if (tag === 'PRE' || tag === 'CODE') {
      lines.push('```');
      lines.push(node.textContent);
      lines.push('```');
    } else if (node.nodeType === 1) {
      const t = node.textContent.trim();
      if (t) lines.push(t);
    }
  }
  return lines.join('\n');
}

// ── Detect và wrap code block HTML trong text câu hỏi ──────────
function _wrapInlineCodeBlocks(text) {
  const lines = text.split('\n');
  const out = [];
  let codeLines = [];
  let inCode = false;

  const isHtmlLine = l => /^\s*<[!\/a-zA-Z]/.test(l) || /^\s*<!/.test(l);
  const isKetCau   = l => /^--\s*kết câu\s*--$/i.test(l.trim());

  for (const line of lines) {
    if (isKetCau(line)) {
      if (inCode && codeLines.length) {
        out.push('```html'); out.push(...codeLines); out.push('```');
        inCode = false; codeLines = [];
      }
      out.push(line); continue;
    }
    if (isHtmlLine(line)) {
      if (!inCode) inCode = true;
      codeLines.push(line);
    } else {
      if (inCode) {
        out.push('```html'); out.push(...codeLines); out.push('```');
        inCode = false; codeLines = [];
      }
      out.push(line);
    }
  }
  if (inCode && codeLines.length) {
    out.push('```html'); out.push(...codeLines); out.push('```');
  }
  return out.join('\n');
}

// ── Universal quiz text parser ─────────────────────────────────
function _parseQuizText(text) {
  // Normalize toàn diện
  text = text
    .replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    .replace(/[\u200B\u200C\u200D\uFEFF\u00A0]/g, ' ') // zero-width + non-breaking space
    .replace(/[ \t]+/g, ' ')
    // Normalize dấu gạch nối full-width và dấu câu tương tự
    .replace(/[\uFF0E\u2024]/g, '.').replace(/[\uFF09\u2019]/g, ')')
    .trim();

  // Wrap inline HTML code blocks trước khi parse
  text = _wrapInlineCodeBlocks(text);

  // Nếu có --Kết câu-- thì dùng parser chuyên biệt
  if (/--\s*kết câu\s*--/i.test(text)) {
    return _parseKetCauFormat(text);
  }

  const lines = text.split('\n').map(l => l.trim());
  const questions = [];
  let i = 0;

  // ── Regex patterns ──────────────────────────────────────────
  // Question: "Câu 1:", "Câu 1.", "1.", "1)", "Question 1:", "Bài 1:", "Phần 1."
  const reQuestion = /^(?:(?:câu|bài|phần|question|q)\s*)?(\d+)[.:)\s]\s*(.+)/i;
  // Option: "A.", "A)", "a.", "(A)", "[A.]" (bracket = correct), "A -", "A:"
  const reOption   = /^(?:\[([A-Ea-e])[.\]]\]?|\(?([A-Ea-e])\)?[.):\-]\s*)(.+)/;
  // Answer: "Đáp án: B", "ĐÁP ÁN:B", "Answer: B", "Key: B", "Đáp: B", "DA: B"
  const reAnswer   = /^(?:đáp\s*(?:án|case)?|answer|key|ans|da|correct)[:\s]+([A-Ea-e])/i;
  // Explanation: "Giải:", "Giải thích:", "Explanation:", "HD:", "Hướng dẫn:", "Note:"
  const reExpl     = /^(?:giải(?:\s*thích)?|explanation|hd|hướng\s*dẫn|note|lời\s*giải)[:\s]+(.+)/i;

  // Helper: kiểm tra line có phải là bắt đầu option không
  const isOptionLine  = l => reOption.test(l);
  const isAnswerLine  = l => reAnswer.test(l);
  const isExplLine    = l => reExpl.test(l);
  const isQuestionLine = (l, minOpts = 0) => reQuestion.test(l) && (minOpts === 0 || questions.length > 0 || true);

  while (i < lines.length) {
    const line = lines[i];
    if (!line) { i++; continue; }

    const qMatch = reQuestion.exec(line);
    if (!qMatch) { i++; continue; }

    // Tìm thấy câu hỏi
    let questionText = qMatch[2].trim();

    // Thu thập nội dung câu hỏi multi-line (đến khi gặp option hoặc câu hỏi tiếp theo)
    i++;
    while (i < lines.length) {
      const nl = lines[i];
      if (!nl) { i++; continue; }
      if (isOptionLine(nl) || isAnswerLine(nl) || isExplLine(nl)) break;
      // Dừng nếu câu hỏi tiếp theo và đã có đủ context (số thứ tự lớn hơn)
      const nqm = reQuestion.exec(nl);
      if (nqm && parseInt(nqm[1]) > parseInt(qMatch[1])) break;
      questionText += ' ' + nl;
      i++;
    }

    // Thu thập đáp án
    const options    = [];
    let answerLetter = null;
    let explanation  = '';
    let safetyCount  = 0; // chống vòng lặp vô tận

    while (i < lines.length && safetyCount++ < 200) {
      const l = lines[i];
      if (!l) { i++; continue; }

      // Câu hỏi tiếp theo bắt đầu → dừng
      const nqm = reQuestion.exec(l);
      if (nqm && options.length >= 2 && parseInt(nqm[1]) > parseInt(qMatch[1])) break;

      const oMatch = reOption.exec(l);
      const aMatch = reAnswer.exec(l);
      const eMatch = reExpl.exec(l);

      if (oMatch) {
        const isBracketCorrect = !!oMatch[1];
        const optLetter = (oMatch[1] || oMatch[2]).toUpperCase();
        let optText = oMatch[3].trim();
        i++;
        // Multi-line option text
        while (i < lines.length) {
          const ol = lines[i];
          if (!ol) { i++; continue; }
          if (isOptionLine(ol) || isAnswerLine(ol) || isExplLine(ol)) break;
          if (reQuestion.exec(ol)) break;
          optText += ' ' + ol;
          i++;
        }
        // Detect đáp án đúng qua marker cuối text
        let isMarked = isBracketCorrect;
        optText = optText
          .replace(/\s*[*✓✔√]\s*$/, () => { isMarked = true; return ''; })
          .replace(/\s*\(đúng\)\s*$/i, () => { isMarked = true; return ''; })
          .replace(/\s*\(correct\)\s*$/i, () => { isMarked = true; return ''; })
          .replace(/\s*\[đúng\]\s*$/i, () => { isMarked = true; return ''; });
        // Tránh trùng lặp option cùng chữ cái
        if (!options.find(o => o.letter === optLetter)) {
          options.push({ letter: optLetter, text: optText.trim(), markedCorrect: isMarked });
        }
      } else if (aMatch) {
        answerLetter = aMatch[1].toUpperCase();
        i++;
      } else if (eMatch) {
        explanation = eMatch[1].trim();
        i++;
        while (i < lines.length) {
          const el = lines[i];
          if (!el) { i++; continue; }
          if (reQuestion.exec(el) || isOptionLine(el)) break;
          explanation += ' ' + el;
          i++;
        }
      } else {
        i++;
      }
    }

    // Cần ít nhất 2 đáp án
    if (options.length < 2) continue;

    // Xác định đáp án đúng
    const finalOptions = options.map(o => ({
      text: o.text,
      correct: o.markedCorrect || (answerLetter ? o.letter === answerLetter : false),
    }));

    questions.push({
      question:    questionText.trim(),
      options:     finalOptions,
      explanation: explanation.trim(),
    });
  }

  return questions;
}

// ── Parser cho định dạng --Kết câu-- (chuẩn BGD/HTML quiz) ─────
function _parseKetCauFormat(text) {
  const questions = [];
  const lines = text.split('\n');

  // Regex nhận diện đầu câu hỏi
  const reQStart  = /^(?:câu\s*)?(\d+)[.:)\s]\s*(.+)/i;
  // Regex nhận diện đáp án (hỗ trợ [A.] và A.)
  const reOption  = /^(?:\[([A-Fa-f])[.\]]\]?|\(?([A-Fa-f])\)?[.)]\s*)(.+)/;
  const reKetCau  = /^--\s*kết câu\s*--$/i;
  const reAnswer  = /^(?:đáp\s*án|answer|key|ans|da)[:\s]+([A-Fa-f])/i;
  const reExpl    = /^(?:giải(?:\s*thích)?|explanation|hd|hướng\s*dẫn)[:\s]+(.+)/i;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line) { i++; continue; }

    const qMatch = reQStart.exec(line);
    if (!qMatch) { i++; continue; }

    // Thu thập text câu hỏi (có thể nhiều dòng, kể cả code block)
    let questionText = qMatch[2].trim();
    i++;
    // Đọc tiếp cho đến khi gặp --Kết câu-- hoặc đáp án trực tiếp
    const qExtraLines = [];
    let inCodeBlock = false;
    while (i < lines.length) {
      const l = lines[i].trim();
      if (reKetCau.exec(l)) { i++; break; }      // gặp --Kết câu--
      if (!inCodeBlock && reOption.exec(l)) break; // gặp đáp án trực tiếp
      if (l === '```html' || l === '```') { inCodeBlock = !inCodeBlock; }
      qExtraLines.push(lines[i]);
      i++;
    }
    if (qExtraLines.length) {
      questionText += '\n' + qExtraLines.join('\n');
    }

    // Thu thập đáp án
    const options = [];
    let answerLetter = null;
    let explanation  = '';

    while (i < lines.length) {
      const l = lines[i].trim();
      if (!l) { i++; continue; }
      if (reQStart.exec(l) && options.length >= 2) break; // câu tiếp theo

      const oMatch = reOption.exec(l);
      const aMatch = reAnswer.exec(l);
      const eMatch = reExpl.exec(l);

      if (oMatch) {
        const isBracket = !!oMatch[1];
        const letter = (oMatch[1] || oMatch[2]).toUpperCase();
        let optText = oMatch[3].trim();
        i++;
        // Multi-line option
        while (i < lines.length) {
          const nl = lines[i].trim();
          if (!nl || reOption.exec(nl) || reAnswer.exec(nl) ||
              reKetCau.exec(nl) || reQStart.exec(nl)) break;
          optText += ' ' + nl;
          i++;
        }
        let isMarked = isBracket;
        optText = optText.replace(/\s*[*✓✔]\s*$/, () => { isMarked = true; return ''; });
        optText = optText.replace(/\s*\(đúng\)\s*$/i, () => { isMarked = true; return ''; });
        options.push({ text: optText.trim(), correct: isMarked });
      } else if (aMatch) {
        answerLetter = aMatch[1].toUpperCase();
        i++;
      } else if (eMatch) {
        explanation = eMatch[1].trim();
        i++;
      } else {
        i++;
      }
    }

    if (!options.length) continue;

    // Áp dụng answerLetter nếu không có bracket
    const finalOpts = options.map((o, idx) => ({
      text: o.text,
      correct: o.correct || (answerLetter && String.fromCharCode(65 + idx) === answerLetter),
    }));

    questions.push({
      question:    questionText.trim(),
      options:     finalOpts,
      explanation: explanation.trim(),
    });
  }
  return questions;
}

function _qmShowFormatHelp() {
  showToast(
    'Định dạng: "Câu 1: [câu hỏi]" → "A. [lựa chọn]" → "Đáp án: B"',
    'info'
  );
}

// ── Import progress UI ─────────────────────────────────────────
function _qmShowImportProgress(msg, pct) {
  const el   = document.getElementById('qm-import-progress');
  const fill = document.getElementById('qm-import-bar-fill');
  const stat = document.getElementById('qm-import-status');
  el.classList.add('show');
  if (stat) stat.textContent = msg;
  if (fill) fill.style.width = pct + '%';
}
function _qmHideImportProgress() {
  document.getElementById('qm-import-progress').classList.remove('show');
}

// ═══════════════════════════════════════════════════
// COURSES — Canvas LMS model
// ═══════════════════════════════════════════════════
let _courses = [];       // cache danh sách khoá học
let _activeCourseId = null; // khoá học đang mở module builder

// ── Load danh sách khoá học ──
async function loadCourses() {
  const tbody = document.getElementById('courses-table');
  tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:24px">Đang tải...</td></tr>';
  document.getElementById('module-builder').style.display = 'none';

  try {
    const r = await fetch(`${PROXY}/admin/courses?limit=200&sort=-UpdatedAt`, { headers: adminHeaders() });
    if (!r.ok) throw new Error(await r.text());
    const data = await r.json();
    _courses = data.list || [];

    if (!_courses.length) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:32px">Chưa có khoá học nào. Bấm "+ Tạo khoá học" để bắt đầu.</td></tr>';
      return;
    }

    tbody.innerHTML = _courses.map(c => `
      <tr>
        <td><strong>${_esc(c.Title)}</strong>${c.Description ? `<div style="font-size:12px;color:var(--text-muted);margin-top:2px">${_esc(c.Description.slice(0,80))}${c.Description.length>80?'…':''}</div>` : ''}</td>
        <td><span class="badge ${c.Status==='published'?'badge-green':c.Status==='archived'?'badge-red':'badge-gray'}">${c.Status||'draft'}</span></td>
        <td style="text-align:center">—</td>
        <td style="font-size:12px;color:var(--text-muted)">${c.UpdatedAt ? new Date(c.UpdatedAt).toLocaleDateString('vi') : '—'}</td>
        <td>
          <div style="display:flex;gap:6px">
            <button class="btn btn-outline btn-sm" onclick="openModuleBuilder(${c.Id})"><i class="fas fa-layer-group"></i> Modules</button>
            <button class="btn btn-outline btn-sm" onclick="openCourseModal(${c.Id})"><i class="fas fa-pen"></i></button>
            <button class="btn btn-sm" style="background:#fee2e2;color:#dc2626;border:none" onclick="deleteCourse(${c.Id}, '${_esc(c.Title)}')"><i class="fas fa-trash"></i></button>
          </div>
        </td>
      </tr>`).join('');
  } catch(e) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:#dc2626;padding:24px">Lỗi: ${e.message}</td></tr>`;
  }
}

function _esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ── Course modal ──
function openCourseModal(id) {
  const course = id ? _courses.find(c => c.Id === id) : null;
  document.getElementById('course-modal-title').textContent = course ? 'Sửa khoá học' : 'Tạo khoá học';
  document.getElementById('cm-id').value = course?.Id || '';
  document.getElementById('cm-title').value = course?.Title || '';
  document.getElementById('cm-desc').value = course?.Description || '';
  document.getElementById('cm-status').value = course?.Status || 'draft';
  document.getElementById('course-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('cm-title').focus(), 100);
}
function closeCourseModal() { document.getElementById('course-modal').style.display = 'none'; }

async function saveCourse() {
  const id = document.getElementById('cm-id').value;
  const title = document.getElementById('cm-title').value.trim();
  if (!title) { showToast('Nhập tên khoá học!', 'warn'); return; }

  const payload = {
    Title: title,
    Description: document.getElementById('cm-desc').value.trim(),
    Status: document.getElementById('cm-status').value,
    UpdatedAt: new Date().toISOString(),
  };

  try {
    showLoading(id ? 'Đang cập nhật...' : 'Đang tạo khoá học...');
    const method = id ? 'PATCH' : 'POST';
    const body = id ? [{ Id: parseInt(id), ...payload }] : payload;
    const r = await fetch(`${PROXY}/admin/courses`, {
      method,
      headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(await r.text());
    closeCourseModal();
    showToast(id ? 'Đã cập nhật khoá học!' : 'Đã tạo khoá học!', 'success');
    await loadCourses();
  } catch(e) {
    showToast('Lỗi: ' + e.message, 'error');
  } finally { hideLoading(); }
}

async function deleteCourse(id, title) {
  if (!confirm(`Xoá khoá học "${title}"?\nCác modules trong khoá học này cũng sẽ bị xoá.`)) return;
  try {
    showLoading('Đang xoá...');
    const r = await fetch(`${PROXY}/admin/courses`, {
      method: 'DELETE',
      headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify([{ Id: id }]),
    });
    if (!r.ok) throw new Error(await r.text());
    showToast('Đã xoá khoá học!', 'success');
    await loadCourses();
  } catch(e) {
    showToast('Lỗi: ' + e.message, 'error');
  } finally { hideLoading(); }
}

// ── Module builder ──
let _modules = [];

async function openModuleBuilder(courseId) {
  _activeCourseId = courseId;
  const course = _courses.find(c => c.Id === courseId);
  document.getElementById('module-builder-title').innerHTML = `📦 Modules — <em>${_esc(course?.Title || '')}</em>`;
  document.getElementById('module-builder').style.display = '';

  // Scroll to builder
  document.getElementById('module-builder').scrollIntoView({ behavior: 'smooth' });
  await loadModules(courseId);
}
function closeModuleBuilder() {
  document.getElementById('module-builder').style.display = 'none';
  _activeCourseId = null;
}

async function loadModules(courseId) {
  const container = document.getElementById('modules-list');
  container.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-muted)">Đang tải...</div>';
  try {
    const r = await fetch(`${PROXY}/admin/modules?where=(CourseId,eq,${courseId})&sort=Position&limit=100`, { headers: adminHeaders() });
    if (!r.ok) throw new Error(await r.text());
    const data = await r.json();
    _modules = data.list || [];
    renderModules();
  } catch(e) {
    container.innerHTML = `<div style="color:#dc2626;padding:16px">Lỗi: ${e.message}</div>`;
  }
}

function renderModules() {
  const container = document.getElementById('modules-list');
  if (!_modules.length) {
    container.innerHTML = '<div style="text-align:center;padding:32px;color:var(--text-muted)">Chưa có module nào. Bấm "+ Thêm module".</div>';
    return;
  }
  container.innerHTML = _modules.map((m, i) => `
    <div class="module-item" data-id="${m.Id}">
      <div class="module-item-hd">
        <span class="module-pos">${m.Position || i+1}</span>
        <div class="module-info">
          <strong>${_esc(m.Title)}</strong>
          ${m.UnlockCondition ? `<div class="module-unlock"><i class="fas fa-lock"></i> ${_esc(m.UnlockCondition)}</div>` : ''}
        </div>
        <div style="display:flex;gap:6px;margin-left:auto">
          <button class="btn btn-outline btn-sm" onclick="loadModuleItems(${m.Id})"><i class="fas fa-list"></i> Items</button>
          <button class="btn btn-outline btn-sm" onclick="openModuleModal(${m.Id})"><i class="fas fa-pen"></i></button>
          <button class="btn btn-sm" style="background:#fee2e2;color:#dc2626;border:none" onclick="deleteModule(${m.Id}, '${_esc(m.Title)}')"><i class="fas fa-trash"></i></button>
        </div>
      </div>
      <div id="module-items-${m.Id}" class="module-items-container" style="display:none"></div>
    </div>`).join('');
}

// ── Module items (articles trong module) với publish toggle ──
async function loadModuleItems(moduleId) {
  const container = document.getElementById(`module-items-${moduleId}`);
  if (!container) return;

  // Toggle nếu đang mở
  if (container.style.display !== 'none') { container.style.display = 'none'; return; }
  container.style.display = 'block';
  container.innerHTML = '<div style="padding:12px 16px;color:var(--text-muted);font-size:13px"><i class="fas fa-spinner fa-spin"></i> Đang tải...</div>';

  try {
    const r = await fetch(`${PROXY}/admin/articles?where=(ModuleId,eq,${moduleId})&sort=Position&limit=100&fields=Id,Title,ItemType,Position,Published,Access`, { headers: adminHeaders() });
    if (!r.ok) throw new Error(await r.text());
    const data = await r.json();
    const items = data.list || [];

    if (!items.length) {
      container.innerHTML = '<div style="padding:12px 18px;font-size:13px;color:#94a3b8">Module này chưa có bài học nào. Vào Soạn thảo → đặt ModuleId để gán bài.</div>';
      return;
    }

    const typeIcon = { article: '📄', interactive: '🎮', quiz: '📊' };
    container.innerHTML = `
      <table class="module-items-table">
        <thead><tr><th>#</th><th>Tên bài</th><th>Loại</th><th>Công bố</th></tr></thead>
        <tbody>
          ${items.map(item => `
            <tr>
              <td style="color:var(--text-muted);font-size:12px">${item.Position || '—'}</td>
              <td><span style="font-size:13px">${_esc(item.Title || `Bài ${item.Id}`)}</span></td>
              <td><span style="font-size:11px;background:#f1f5f9;padding:2px 7px;border-radius:100px">${typeIcon[item.ItemType] || '📄'} ${item.ItemType || 'article'}</span></td>
              <td>
                <label class="publish-toggle" title="${item.Published === false ? 'Đang ẩn' : 'Đang hiện'}">
                  <input type="checkbox" ${item.Published !== false ? 'checked' : ''} onchange="toggleItemPublished(${item.Id}, this.checked, this)">
                  <span class="publish-slider"></span>
                </label>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>`;
  } catch(e) {
    container.innerHTML = `<div style="padding:12px 16px;color:#dc2626;font-size:13px">Lỗi: ${e.message}</div>`;
  }
}

async function toggleItemPublished(articleId, published, checkboxEl) {
  try {
    const r = await fetch(`${PROXY}/admin/module-item/${articleId}`, {
      method: 'PATCH',
      headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ published }),
    });
    if (!r.ok) throw new Error(await r.text());
    const label = checkboxEl.closest('.publish-toggle');
    if (label) label.title = published ? 'Đang hiện' : 'Đang ẩn';
    showToast(published ? '✅ Đã công bố bài học' : '🙈 Đã ẩn bài học', 'success');
  } catch(e) {
    checkboxEl.checked = !published; // rollback
    showToast('Lỗi: ' + e.message, 'error');
  }
}

// ── Module modal ──
function openModuleModal(id) {
  const mod = id ? _modules.find(m => m.Id === id) : null;
  document.getElementById('module-modal-title').textContent = mod ? 'Sửa module' : 'Thêm module';
  document.getElementById('mm-id').value = mod?.Id || '';
  document.getElementById('mm-title').value = mod?.Title || '';
  document.getElementById('mm-position').value = mod?.Position || (_modules.length + 1);
  document.getElementById('mm-unlock').value = mod?.UnlockCondition || '';
  document.getElementById('module-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('mm-title').focus(), 100);
}
function closeModuleModal() { document.getElementById('module-modal').style.display = 'none'; }

async function saveModule() {
  if (!_activeCourseId) return;
  const id = document.getElementById('mm-id').value;
  const title = document.getElementById('mm-title').value.trim();
  if (!title) { showToast('Nhập tên module!', 'warn'); return; }

  const payload = {
    CourseId: _activeCourseId,
    Title: title,
    Position: parseInt(document.getElementById('mm-position').value) || 1,
    UnlockCondition: document.getElementById('mm-unlock').value.trim() || null,
  };

  try {
    showLoading(id ? 'Đang cập nhật...' : 'Đang tạo module...');
    const method = id ? 'PATCH' : 'POST';
    const body = id ? [{ Id: parseInt(id), ...payload }] : payload;
    const r = await fetch(`${PROXY}/admin/modules`, {
      method,
      headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(await r.text());
    closeModuleModal();
    showToast(id ? 'Đã cập nhật module!' : 'Đã thêm module!', 'success');
    await loadModules(_activeCourseId);
  } catch(e) {
    showToast('Lỗi: ' + e.message, 'error');
  } finally { hideLoading(); }
}

async function deleteModule(id, title) {
  if (!confirm(`Xoá module "${title}"?`)) return;
  try {
    showLoading('Đang xoá...');
    const r = await fetch(`${PROXY}/admin/modules`, {
      method: 'DELETE',
      headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify([{ Id: id }]),
    });
    if (!r.ok) throw new Error(await r.text());
    showToast('Đã xoá module!', 'success');
    await loadModules(_activeCourseId);
  } catch(e) {
    showToast('Lỗi: ' + e.message, 'error');
  } finally { hideLoading(); }
}


// ═══════════════════════════════════════════════════
// QUESTION BANK
// ═══════════════════════════════════════════════════
let _qbanks = [];
let _activeQBankId = null;
let _qbankQuestions = []; // draft questions đang chỉnh sửa

async function loadQBanks() {
  const tbody = document.getElementById('qbank-table');
  tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:24px;color:var(--text-muted)">Đang tải...</td></tr>';
  document.getElementById('qbank-editor').style.display = 'none';
  try {
    const r = await fetch(`${PROXY}/admin/question-banks?limit=200&sort=-UpdatedAt`, { headers: adminHeaders() });
    if (!r.ok) throw new Error(await r.text());
    const data = await r.json();
    _qbanks = data.list || [];

    if (!_qbanks.length) {
      tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:32px;color:var(--text-muted)">Chưa có ngân hàng nào. Bấm "+ Tạo ngân hàng".</td></tr>';
      return;
    }
    tbody.innerHTML = _qbanks.map(b => {
      let qCount = 0;
      try { qCount = JSON.parse(b.Questions || '[]').length; } catch {}
      return `<tr>
        <td><strong>${_esc(b.Title)}</strong>${b.Description ? `<div style="font-size:12px;color:var(--text-muted)">${_esc(b.Description.slice(0,60))}</div>` : ''}</td>
        <td><span class="badge badge-gray">${_esc(b.GroupName || '—')}</span></td>
        <td style="text-align:center;font-weight:600">${qCount}</td>
        <td><div style="display:flex;gap:6px">
          <button class="btn btn-outline btn-sm" onclick="openQBankEditor(${b.Id})"><i class="fas fa-list-ol"></i> Câu hỏi</button>
          <button class="btn btn-outline btn-sm" onclick="openQBankModal(${b.Id})"><i class="fas fa-pen"></i></button>
          <button class="btn btn-sm" style="background:#fee2e2;color:#dc2626;border:none" onclick="deleteQBank(${b.Id},'${_esc(b.Title)}')"><i class="fas fa-trash"></i></button>
        </div></td>
      </tr>`;
    }).join('');
  } catch(e) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:#dc2626;padding:24px">Lỗi: ${e.message}</td></tr>`;
  }
}

function openQBankModal(id) {
  const b = id ? _qbanks.find(x => x.Id === id) : null;
  document.getElementById('qbank-modal-title').textContent = b ? 'Sửa ngân hàng' : 'Tạo ngân hàng';
  document.getElementById('qbm-id').value = b?.Id || '';
  document.getElementById('qbm-title').value = b?.Title || '';
  document.getElementById('qbm-group').value = b?.GroupName || '';
  document.getElementById('qbm-desc').value = b?.Description || '';
  document.getElementById('qbank-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('qbm-title').focus(), 100);
}
function closeQBankModal() { document.getElementById('qbank-modal').style.display = 'none'; }

async function saveQBank() {
  const id = document.getElementById('qbm-id').value;
  const title = document.getElementById('qbm-title').value.trim();
  if (!title) { showToast('Nhập tên ngân hàng!', 'warn'); return; }
  const payload = {
    Title: title,
    GroupName: document.getElementById('qbm-group').value.trim(),
    Description: document.getElementById('qbm-desc').value.trim(),
    UpdatedAt: new Date().toISOString(),
  };
  try {
    showLoading(id ? 'Đang cập nhật...' : 'Đang tạo...');
    const method = id ? 'PATCH' : 'POST';
    const body = id ? [{ Id: parseInt(id), ...payload }] : payload;
    const r = await fetch(`${PROXY}/admin/question-banks`, {
      method, headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(await r.text());
    closeQBankModal();
    showToast('Đã lưu ngân hàng!', 'success');
    await loadQBanks();
  } catch(e) { showToast('Lỗi: ' + e.message, 'error'); } finally { hideLoading(); }
}

async function deleteQBank(id, title) {
  if (!confirm(`Xoá ngân hàng "${title}"?`)) return;
  try {
    showLoading('Đang xoá...');
    const r = await fetch(`${PROXY}/admin/question-banks`, {
      method: 'DELETE',
      headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify([{ Id: id }]),
    });
    if (!r.ok) throw new Error(await r.text());
    showToast('Đã xoá!', 'success');
    await loadQBanks();
  } catch(e) { showToast('Lỗi: ' + e.message, 'error'); } finally { hideLoading(); }
}

// ── Question editor ──
async function openQBankEditor(bankId) {
  _activeQBankId = bankId;
  const bank = _qbanks.find(b => b.Id === bankId);
  document.getElementById('qbank-editor-title').textContent = `✏️ Câu hỏi — ${bank?.Title || ''}`;
  document.getElementById('qbank-editor').style.display = '';
  document.getElementById('qbank-editor').scrollIntoView({ behavior: 'smooth' });

  // Load questions
  try {
    const r = await fetch(`${PROXY}/admin/question-banks/${bankId}`, { headers: adminHeaders() });
    const data = await r.json();
    _qbankQuestions = JSON.parse(data.Questions || '[]');
  } catch { _qbankQuestions = []; }
  renderQBankQuestions();
}

function closeQBankEditor() {
  document.getElementById('qbank-editor').style.display = 'none';
  _activeQBankId = null;
}

function renderQBankQuestions() {
  const container = document.getElementById('qbank-questions-list');
  if (!_qbankQuestions.length) {
    container.innerHTML = '<div style="text-align:center;padding:32px;color:var(--text-muted)">Chưa có câu hỏi nào. Bấm "+ Thêm câu".</div>';
    return;
  }
  container.innerHTML = _qbankQuestions.map((q, qi) => `
    <div class="qb-question-card" id="qbq-${qi}">
      <div class="qbq-hd">
        <span class="qbq-num">Câu ${qi + 1}</span>
        <select class="inp" style="width:120px;font-size:12px;padding:4px 8px" onchange="_qbankQuestions[${qi}].type=this.value">
          <option value="mcq" ${q.type==='mcq'||!q.type?'selected':''}>Trắc nghiệm</option>
          <option value="truefalse" ${q.type==='truefalse'?'selected':''}>Đúng/Sai</option>
        </select>
        <button class="btn btn-sm" style="background:#fee2e2;color:#dc2626;border:none;margin-left:auto" onclick="removeQBankQuestion(${qi})"><i class="fas fa-trash"></i></button>
      </div>
      <div class="form-group" style="margin-bottom:8px">
        <textarea class="inp" rows="2" placeholder="Nội dung câu hỏi..." onchange="_qbankQuestions[${qi}].question=this.value">${_esc(q.question || '')}</textarea>
      </div>
      <div class="qbq-options">
        ${(q.options || []).map((opt, oi) => {
          const optText = typeof opt === 'string' ? opt : opt.text;
          const isCorrect = typeof opt === 'object' && opt.correct;
          return `<div class="qbq-option">
            <input type="radio" name="qbq-correct-${qi}" value="${oi}" ${isCorrect ? 'checked' : ''} onchange="_setCorrectOption(${qi},${oi})" title="Đánh dấu đáp án đúng">
            <input class="inp" style="flex:1" placeholder="Phương án ${oi+1}" value="${_esc(optText)}" onchange="_updateOptionText(${qi},${oi},this.value)">
            <button onclick="_removeOption(${qi},${oi})" style="background:none;border:none;cursor:pointer;color:#94a3b8;font-size:13px">✕</button>
          </div>`;
        }).join('')}
        <button class="btn btn-outline btn-sm" style="margin-top:4px;width:100%" onclick="_addOption(${qi})"><i class="fas fa-plus"></i> Thêm phương án</button>
      </div>
      <div class="form-group" style="margin-top:8px;margin-bottom:0">
        <input class="inp" style="font-size:12px" placeholder="💡 Giải thích (hiện sau khi nộp bài)..." value="${_esc(q.explanation || '')}" onchange="_qbankQuestions[${qi}].explanation=this.value">
      </div>
    </div>`).join('');
}

function addQBankQuestion() {
  _qbankQuestions.push({
    type: 'mcq',
    question: '',
    options: [
      { text: '', correct: false },
      { text: '', correct: false },
      { text: '', correct: false },
      { text: '', correct: false },
    ],
    explanation: '',
  });
  renderQBankQuestions();
  setTimeout(() => {
    const cards = document.querySelectorAll('.qb-question-card');
    cards[cards.length - 1]?.scrollIntoView({ behavior: 'smooth' });
  }, 100);
}

function removeQBankQuestion(qi) {
  if (!confirm('Xoá câu hỏi này?')) return;
  _qbankQuestions.splice(qi, 1);
  renderQBankQuestions();
}

function _setCorrectOption(qi, oi) {
  (_qbankQuestions[qi]?.options || []).forEach((opt, idx) => {
    if (typeof opt === 'object') opt.correct = (idx === oi);
  });
}
function _updateOptionText(qi, oi, val) {
  const opt = _qbankQuestions[qi]?.options?.[oi];
  if (typeof opt === 'object') opt.text = val;
  else if (opt !== undefined) _qbankQuestions[qi].options[oi] = { text: val, correct: false };
}
function _addOption(qi) {
  if (!_qbankQuestions[qi].options) _qbankQuestions[qi].options = [];
  _qbankQuestions[qi].options.push({ text: '', correct: false });
  renderQBankQuestions();
}
function _removeOption(qi, oi) {
  _qbankQuestions[qi]?.options?.splice(oi, 1);
  renderQBankQuestions();
}

async function saveQBankQuestions() {
  if (!_activeQBankId) return;
  // Sync current textarea values vào _qbankQuestions trước khi lưu
  document.querySelectorAll('.qb-question-card').forEach((card, qi) => {
    const ta = card.querySelector('textarea');
    if (ta && _qbankQuestions[qi]) _qbankQuestions[qi].question = ta.value;
    card.querySelectorAll('.qbq-option input[type="text"], .qbq-option .inp:not([type="radio"])').forEach((inp, oi) => {
      const opt = _qbankQuestions[qi]?.options?.[oi];
      if (opt && typeof opt === 'object') opt.text = inp.value;
    });
    const explInp = card.querySelector('.form-group:last-child .inp');
    if (explInp && _qbankQuestions[qi]) _qbankQuestions[qi].explanation = explInp.value;
  });

  // Validate: mỗi câu cần ≥2 phương án và đúng 1 đáp án đúng
  for (let i = 0; i < _qbankQuestions.length; i++) {
    const q = _qbankQuestions[i];
    if (!q.question?.trim()) { showToast(`Câu ${i+1}: chưa nhập nội dung!`, 'warn'); return; }
    const opts = q.options || [];
    if (opts.length < 2) { showToast(`Câu ${i+1}: cần ít nhất 2 phương án!`, 'warn'); return; }
    const correctCount = opts.filter(o => typeof o === 'object' && o.correct).length;
    if (correctCount !== 1) { showToast(`Câu ${i+1}: phải chọn đúng 1 đáp án đúng!`, 'warn'); return; }
  }

  try {
    showLoading('Đang lưu câu hỏi...');
    const r = await fetch(`${PROXY}/admin/question-banks`, {
      method: 'PATCH',
      headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify([{
        Id: _activeQBankId,
        Questions: JSON.stringify(_qbankQuestions),
        QuestionCount: _qbankQuestions.length,
        UpdatedAt: new Date().toISOString(),
      }]),
    });
    if (!r.ok) throw new Error(await r.text());
    showToast(`Đã lưu ${_qbankQuestions.length} câu hỏi!`, 'success');
    await loadQBanks();
  } catch(e) { showToast('Lỗi: ' + e.message, 'error'); } finally { hideLoading(); }
}

// ═══════════════════════════════════════════════════
// EXAMS (ĐỀ BÀI TẬP)
// ═══════════════════════════════════════════════════
let _exams = [];
let _activeExamId = null;
let _examSections = [];

async function loadExams() {
  const tbody = document.getElementById('exams-table');
  tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:24px;color:var(--text-muted)">Đang tải...</td></tr>';
  document.getElementById('exam-section-builder').style.display = 'none';
  try {
    const r = await fetch(`${PROXY}/admin/exams?limit=200&sort=-UpdatedAt`, { headers: adminHeaders() });
    if (!r.ok) throw new Error(await r.text());
    const data = await r.json();
    _exams = data.list || [];

    if (!_exams.length) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:32px;color:var(--text-muted)">Chưa có đề thi nào. Bấm "+ Tạo đề".</td></tr>';
      return;
    }
    tbody.innerHTML = _exams.map(e => `<tr>
      <td><strong>${_esc(e.Title)}</strong>${e.Description ? `<div style="font-size:12px;color:var(--text-muted)">${_esc(e.Description.slice(0,60))}</div>` : ''}</td>
      <td><span class="badge ${e.Status==='published'?'badge-green':'badge-gray'}">${e.Status||'draft'}</span></td>
      <td style="text-align:center">${e.TotalPoints || '—'}</td>
      <td style="text-align:center">${e.TimeLimit ? e.TimeLimit + ' phút' : '∞'}</td>
      <td><div style="display:flex;gap:6px">
        <button class="btn btn-outline btn-sm" onclick="openExamBuilder(${e.Id})"><i class="fas fa-layer-group"></i> Cấu trúc</button>
        <button class="btn btn-outline btn-sm" onclick="openExamModal(${e.Id})"><i class="fas fa-pen"></i></button>
        <button class="btn btn-sm" style="background:#fee2e2;color:#dc2626;border:none" onclick="deleteExam(${e.Id},'${_esc(e.Title)}')"><i class="fas fa-trash"></i></button>
      </div></td>
    </tr>`).join('');
  } catch(e) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:#dc2626;padding:24px">Lỗi: ${e.message}</td></tr>`;
  }
}

function openExamModal(id) {
  const ex = id ? _exams.find(e => e.Id === id) : null;
  document.getElementById('exam-modal-title').textContent = ex ? 'Sửa đề thi' : 'Tạo đề bài tập';
  document.getElementById('em-id').value = ex?.Id || '';
  document.getElementById('em-title').value = ex?.Title || '';
  document.getElementById('em-desc').value = ex?.Description || '';
  document.getElementById('em-time').value = ex?.TimeLimit || '';
  document.getElementById('em-pass').value = ex?.PassScore || 60;
  document.getElementById('em-status').value = ex?.Status || 'draft';
  document.getElementById('exam-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('em-title').focus(), 100);
}
function closeExamModal() { document.getElementById('exam-modal').style.display = 'none'; }

async function saveExam() {
  const id = document.getElementById('em-id').value;
  const title = document.getElementById('em-title').value.trim();
  if (!title) { showToast('Nhập tên đề!', 'warn'); return; }
  const payload = {
    Title: title,
    Description: document.getElementById('em-desc').value.trim(),
    TimeLimit: parseInt(document.getElementById('em-time').value) || 0,
    PassScore: parseInt(document.getElementById('em-pass').value) || 60,
    Status: document.getElementById('em-status').value,
    UpdatedAt: new Date().toISOString(),
  };
  try {
    showLoading(id ? 'Đang cập nhật...' : 'Đang tạo...');
    const method = id ? 'PATCH' : 'POST';
    const body = id ? [{ Id: parseInt(id), ...payload }] : payload;
    const r = await fetch(`${PROXY}/admin/exams`, {
      method, headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(await r.text());
    closeExamModal();
    showToast(id ? 'Đã cập nhật đề!' : 'Đã tạo đề!', 'success');
    await loadExams();
  } catch(e) { showToast('Lỗi: ' + e.message, 'error'); } finally { hideLoading(); }
}

async function deleteExam(id, title) {
  if (!confirm(`Xoá đề "${title}"?`)) return;
  try {
    showLoading('Đang xoá...');
    const r = await fetch(`${PROXY}/admin/exams`, {
      method: 'DELETE',
      headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify([{ Id: id }]),
    });
    if (!r.ok) throw new Error(await r.text());
    showToast('Đã xoá!', 'success');
    await loadExams();
  } catch(e) { showToast('Lỗi: ' + e.message, 'error'); } finally { hideLoading(); }
}

// ── Exam section builder ──
async function openExamBuilder(examId) {
  _activeExamId = examId;
  const exam = _exams.find(e => e.Id === examId);
  document.getElementById('exam-builder-title').innerHTML = `🔧 Cấu trúc đề — <em>${_esc(exam?.Title || '')}</em>`;
  document.getElementById('exam-section-builder').style.display = '';
  document.getElementById('exam-section-builder').scrollIntoView({ behavior: 'smooth' });
  await loadExamSections(examId);
}
function closeExamBuilder() {
  document.getElementById('exam-section-builder').style.display = 'none';
  _activeExamId = null;
}

async function loadExamSections(examId) {
  const listEl = document.getElementById('exam-sections-list');
  listEl.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-muted)">Đang tải...</div>';
  try {
    const r = await fetch(`${PROXY}/admin/exam-sections?where=(ExamId,eq,${examId})&sort=Position&limit=50`, { headers: adminHeaders() });
    if (!r.ok) throw new Error(await r.text());
    const data = await r.json();
    _examSections = data.list || [];
    renderExamSections();
  } catch(e) {
    listEl.innerHTML = `<div style="padding:16px;color:#dc2626">Lỗi: ${e.message}</div>`;
  }
}

function renderExamSections() {
  const listEl = document.getElementById('exam-sections-list');
  const summaryEl = document.getElementById('exam-summary-bar');

  if (!_examSections.length) {
    listEl.innerHTML = '<div style="text-align:center;padding:32px;color:var(--text-muted)">Chưa có phần nào. Bấm "+ Thêm phần" để lấy câu từ ngân hàng đề.</div>';
    summaryEl.innerHTML = '';
    return;
  }

  const totalQ = _examSections.reduce((s, sec) => s + (sec.QuestionCount || 0), 0);
  const totalPts = _examSections.reduce((s, sec) => s + (sec.QuestionCount || 0) * (sec.PointsPerQuestion || 1), 0);

  summaryEl.innerHTML = `
    <div class="exam-summary-item"><i class="fas fa-list-ol"></i> <strong>${totalQ}</strong> câu</div>
    <div class="exam-summary-item"><i class="fas fa-star"></i> <strong>${totalPts}</strong> điểm tổng</div>
    <div class="exam-summary-item"><i class="fas fa-layer-group"></i> <strong>${_examSections.length}</strong> phần</div>`;

  listEl.innerHTML = _examSections.map((sec, idx) => {
    const bank = _qbanks.find(b => b.Id === sec.BankId);
    const bankQ = bank ? (() => { try { return JSON.parse(bank.Questions || '[]').length; } catch { return '?'; } })() : '?';
    const pts = (sec.QuestionCount || 0) * (sec.PointsPerQuestion || 1);
    return `<div class="exam-section-item">
      <div class="esi-hd">
        <span class="esi-num">Phần ${idx + 1}</span>
        <div class="esi-info">
          <strong>${_esc(sec.BankTitle || bank?.Title || `Ngân hàng #${sec.BankId}`)}</strong>
          <div style="font-size:12px;color:var(--text-muted);margin-top:2px">
            Lấy <strong>${sec.QuestionCount}</strong>/${bankQ} câu &nbsp;·&nbsp;
            <strong>${sec.PointsPerQuestion || 1} điểm</strong>/câu &nbsp;·&nbsp;
            Tổng: <strong>${pts} điểm</strong>
          </div>
        </div>
        <div style="display:flex;gap:6px;margin-left:auto">
          <button class="btn btn-outline btn-sm" onclick="deleteExamSection(${sec.Id})"><i class="fas fa-trash" style="color:#dc2626"></i></button>
        </div>
      </div>
    </div>`;
  }).join('');

  // Cập nhật TotalPoints lên exam record (fire-and-forget)
  fetch(`${PROXY}/admin/exams`, {
    method: 'PATCH',
    headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify([{ Id: _activeExamId, TotalPoints: totalPts }]),
  }).catch(() => {});
  // Cập nhật local cache
  const exam = _exams.find(e => e.Id === _activeExamId);
  if (exam) exam.TotalPoints = totalPts;
}

async function openExamSectionModal() {
  // Load qbanks nếu chưa có
  if (!_qbanks.length) {
    try {
      const r = await fetch(`${PROXY}/admin/question-banks?limit=200`, { headers: adminHeaders() });
      const data = await r.json();
      _qbanks = data.list || [];
    } catch { }
  }

  const bankSel = document.getElementById('esm-bank');
  bankSel.innerHTML = '<option value="">— Chọn ngân hàng —</option>' +
    _qbanks.map(b => {
      let qCount = 0;
      try { qCount = JSON.parse(b.Questions || '[]').length; } catch {}
      return `<option value="${b.Id}" data-count="${qCount}">${_esc(b.Title)} (${qCount} câu)</option>`;
    }).join('');

  bankSel.onchange = () => {
    const opt = bankSel.selectedOptions[0];
    const infoEl = document.getElementById('esm-bank-info');
    const count = opt?.dataset?.count;
    if (count) {
      infoEl.style.display = '';
      infoEl.innerHTML = `<i class="fas fa-info-circle"></i> Ngân hàng này có <strong>${count} câu</strong>. Nhập số câu muốn lấy (tối đa ${count}).`;
      document.getElementById('esm-count').max = count;
    } else { infoEl.style.display = 'none'; }
  };

  document.getElementById('esm-id').value = '';
  document.getElementById('esm-count').value = '';
  document.getElementById('esm-points').value = '1';
  document.getElementById('esm-bank-info').style.display = 'none';
  document.getElementById('exam-section-modal').style.display = 'flex';
}
function closeExamSectionModal() { document.getElementById('exam-section-modal').style.display = 'none'; }

async function saveExamSection() {
  if (!_activeExamId) return;
  const bankId = parseInt(document.getElementById('esm-bank').value);
  if (!bankId) { showToast('Chọn ngân hàng câu hỏi!', 'warn'); return; }
  const count = parseInt(document.getElementById('esm-count').value);
  if (!count || count < 1) { showToast('Nhập số câu hợp lệ!', 'warn'); return; }
  const points = parseFloat(document.getElementById('esm-points').value);
  if (!points || points <= 0) { showToast('Nhập điểm hợp lệ!', 'warn'); return; }

  const bank = _qbanks.find(b => b.Id === bankId);
  const payload = {
    ExamId: _activeExamId,
    BankId: bankId,
    BankTitle: bank?.Title || '',
    QuestionCount: count,
    PointsPerQuestion: points,
    Position: _examSections.length + 1,
  };
  try {
    showLoading('Đang thêm phần...');
    const r = await fetch(`${PROXY}/admin/exam-sections`, {
      method: 'POST',
      headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error(await r.text());
    closeExamSectionModal();
    showToast('Đã thêm phần!', 'success');
    await loadExamSections(_activeExamId);
  } catch(e) { showToast('Lỗi: ' + e.message, 'error'); } finally { hideLoading(); }
}

async function deleteExamSection(id) {
  if (!confirm('Xoá phần này khỏi đề?')) return;
  try {
    showLoading('Đang xoá...');
    const r = await fetch(`${PROXY}/admin/exam-sections`, {
      method: 'DELETE',
      headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify([{ Id: id }]),
    });
    if (!r.ok) throw new Error(await r.text());
    showToast('Đã xoá phần!', 'success');
    await loadExamSections(_activeExamId);
  } catch(e) { showToast('Lỗi: ' + e.message, 'error'); } finally { hideLoading(); }
}
