
// Auth được xử lý trong DOMContentLoaded bên dưới

// ═══════════════════════════════════════════════════
// REQUEST QUEUE — ngăn 429 Too Many Requests từ NocoDB
// Max 3 concurrent admin requests; tự động retry khi 429
// ═══════════════════════════════════════════════════
const _adminQueue = {
  q: [], n: 0, max: 3,
  run(url, opts) {
    return new Promise((ok, fail) => {
      this.q.push({ url, opts, ok, fail, tries: 0 });
      this._next();
    });
  },
  _next() {
    while (this.n < this.max && this.q.length) {
      const t = this.q.shift();
      this.n++;
      fetch(t.url, t.opts).then(r => {
        if (r.status === 429 && t.tries < 4) {
          const ms = 700 * Math.pow(2, t.tries++);
          this.n--;
          setTimeout(() => { this.q.unshift(t); this._next(); }, ms);
        } else {
          t.ok(r); this.n--; this._next();
        }
      }).catch(e => { t.fail(e); this.n--; this._next(); });
    }
  }
};
// Thay thế fetch() cho tất cả admin/proxy requests
function adminFetch(url, opts) { return _adminQueue.run(url, opts); }

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

function doLogout() {
  sessionStorage.removeItem('ae_auth');
  sessionStorage.removeItem('ae_admin_pass'); // legacy cleanup
  sessionStorage.removeItem('ae_admin_token');
  localStorage.removeItem('ae_user');
  window.location.href = '../index.html';
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
    let moduleId = '', itemType = 'article', position = '', published = true, prerequisites = '';
    if (row) {
      title  = row.Title       || '';
      folder = row.Folder      || '';
      desc   = row.Description || '';
      access = row.Access      || 'public';
      moduleId     = row.ModuleId      ? String(row.ModuleId) : '';
      itemType     = row.ItemType      || 'article';
      position     = row.Position      ? String(row.Position) : '';
      published    = row.Published !== false; // default true
      prerequisites = row.Prerequisites || '';
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
    document.getElementById('e-itemtype').value   = itemType;
    document.getElementById('e-position').value   = position;
    document.getElementById('e-published').checked = published;
    document.getElementById('e-prerequisites').value = prerequisites;

    // Load module dropdown (async, không block)
    loadModuleOptions(moduleId);

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
    // Module assignment fields
    const moduleIdVal  = parseInt(document.getElementById('e-module')?.value || '0') || null;
    const itemTypeVal  = document.getElementById('e-itemtype')?.value || 'article';
    const positionVal  = parseInt(document.getElementById('e-position')?.value || '0') || null;
    const publishedVal = document.getElementById('e-published')?.checked !== false;
    const prereqsVal   = document.getElementById('e-prerequisites')?.value.trim() || null;

    const payload = {
      Title: title, Path: filePath, Folder: folder||'', Description: desc||'',
      Access: access, Updated: now, Content: contentValue,
      Excerpt: htmlContent.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim().slice(0, 150),
      // Module assignment
      ModuleId:      moduleIdVal,
      ItemType:      itemTypeVal,
      Position:      positionVal,
      Published:     publishedVal,
      Prerequisites: prereqsVal,
    };

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

// Canvas-style course card color palette
const _CARD_COLORS = [
  '#E66000','#E8354A','#9B59B6','#1ABC9C','#3498DB',
  '#27AE60','#F39C12','#2980B9','#8E44AD','#16A085',
  '#C0392B','#2ECC71','#D35400','#7D3C98','#117A65',
];
function _courseCardColor(id) {
  return _CARD_COLORS[(id || 0) % _CARD_COLORS.length];
}

async function loadDashboardCourses() {
  const grid = document.getElementById('cv-course-cards');
  if (!grid) return;
  grid.innerHTML = '<div class="cv-cards-loading"><i class="fas fa-spinner fa-spin"></i> Đang tải khoá học...</div>';

  try {
    const r = await adminFetch(`${PROXY}/admin/courses?limit=200&sort=-UpdatedAt`, { headers: adminHeaders() });
    if (!r.ok) throw new Error(await r.text());
    const data = await r.json();
    const courses = data.list || [];

    // Update stats
    const published = courses.filter(c => {
      const wf = c.WorkflowState || (c.Status === 'published' ? 'available' : 'created');
      return wf === 'available';
    });
    _el('ds-courses', courses.length);
    _el('ds-published', published.length);

    // Load assessments count (staggered to avoid burst)
    setTimeout(() => adminFetch(`${PROXY}/admin/assessments-proxy?limit=1`, { headers: adminHeaders() })
      .then(r => r.json()).then(d => _el('ds-assessments', d.pageInfo?.totalRows || d.list?.length || '—'))
      .catch(() => {}), 300);

    // Load user count (staggered)
    setTimeout(() => adminFetch(`${PROXY}/admin/users?limit=1`, { headers: adminHeaders() })
      .then(r => r.json()).then(d => _el('ds-students', d.pageInfo?.totalRows || d.list?.length || '—'))
      .catch(() => {}), 600);

    // Update section heading
    const heading = document.getElementById('cv-dash-courses-heading');
    if (heading) heading.textContent = `Các khoá học đã công bố (${published.length})`;

    // Show published courses first, then others
    const sorted = [...published, ...courses.filter(c => !published.includes(c))];

    if (!sorted.length) {
      grid.innerHTML = `
        <div class="cv-cards-empty">
          <i class="fas fa-book-open" style="font-size:36px;color:var(--border);display:block;margin-bottom:12px"></i>
          Chưa có khoá học nào.<br>
          <button class="btn btn-primary btn-sm" style="margin-top:12px" onclick="openCourseModal()">
            <i class="fas fa-plus"></i> Tạo khoá học đầu tiên
          </button>
        </div>`;
      return;
    }

    grid.innerHTML = sorted.slice(0, 12).map(c => {
      const wf = c.WorkflowState || (c.Status === 'published' ? 'available' : 'created');
      const isPublished = wf === 'available';
      const color = _courseCardColor(c.Id);
      const term = c.Term ? `<span class="cv-card-term">${_esc(c.Term)}</span>` : '';
      const initials = (c.Title || '?').substring(0, 2).toUpperCase();

      return `
        <div class="cv-course-card" onclick="navigateToModuleBuilder(${c.Id})">
          <!-- Card header with color -->
          <div class="cv-card-banner" style="background:${color}">
            <div class="cv-card-banner-text">${initials}</div>
            <div class="cv-card-menu-wrap" onclick="event.stopPropagation()">
              <button class="cv-card-menu-btn" onclick="toggleCardMenu(${c.Id},this)" title="Tùy chọn">
                <i class="fas fa-ellipsis-v"></i>
              </button>
              <div class="cv-card-menu" id="cardmenu-${c.Id}" style="display:none">
                <button onclick="navigateToModuleBuilder(${c.Id});closeCardMenus()"><i class="fas fa-layer-group"></i> Nội dung</button>
                <button onclick="openEnrollmentPanel(${c.Id},'${_esc(c.Title)}');closeCardMenus();showPanel('courses',null)"><i class="fas fa-users"></i> Học viên</button>
                <button onclick="openCourseModal(${c.Id});closeCardMenus()"><i class="fas fa-pen"></i> Chỉnh sửa</button>
                <button onclick="openCourseWorkflowPanel(${c.Id},'${_esc(c.Title)}');closeCardMenus();showPanel('courses',null)"><i class="fas fa-rotate"></i> Workflow</button>
              </div>
            </div>
            ${!isPublished ? `<span class="cv-card-draft-badge">Nháp</span>` : ''}
          </div>
          <!-- Card body -->
          <div class="cv-card-body">
            <a class="cv-card-name" style="color:${color}" onclick="event.preventDefault();navigateToModuleBuilder(${c.Id})">${_esc(c.Title)}</a>
            <div class="cv-card-sub">${_esc(c.CourseCode || c.Title)}</div>
            ${term}
          </div>
          <!-- Card footer icons -->
          <div class="cv-card-footer" onclick="event.stopPropagation()">
            <button class="cv-card-foot-btn" onclick="navigateToModuleBuilder(${c.Id})" title="Nội dung học tập">
              <i class="fas fa-book-open"></i>
            </button>
            <button class="cv-card-foot-btn" onclick="openEnrollmentPanel(${c.Id},'${_esc(c.Title)}');showPanel('courses',null)" title="Học viên">
              <i class="fas fa-users"></i>
            </button>
            <button class="cv-card-foot-btn" onclick="openCourseModal(${c.Id})" title="Cài đặt">
              <i class="fas fa-folder"></i>
            </button>
          </div>
        </div>`;
    }).join('');

    // Also update _courses cache for modals
    if (!_courses.length) _courses = courses;

  } catch(e) {
    if (grid) grid.innerHTML = `<div class="cv-cards-loading" style="color:#dc2626">Lỗi: ${e.message}</div>`;
  }
}

function _el(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function toggleCardMenu(id, btn) {
  closeCardMenus();
  const m = document.getElementById(`cardmenu-${id}`);
  if (m) m.style.display = 'block';
}
function closeCardMenus() {
  document.querySelectorAll('.cv-card-menu').forEach(m => m.style.display = 'none');
}
document.addEventListener('click', e => {
  if (!e.target.closest('.cv-card-menu-wrap')) closeCardMenus();
});

function updateDashboard() {
  // Keep compat — also reload course cards
  const c = cfg();
  const repoEl = document.getElementById('d-repo');
  if (repoEl) repoEl.textContent = c.repo || '—';
  const syncEl = document.getElementById('d-sync');
  if (syncEl) syncEl.textContent = new Date().toLocaleTimeString('vi-VN');
  const topRepoEl = document.getElementById('top-repo');
  if (topRepoEl) topRepoEl.textContent = c.nocoUrl ? c.nocoUrl.replace('https://','').split('/')[0] : '';
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
    const proxyBase = (cfg().proxyUrl || 'https://api.gds.edu.vn').replace(/\/$/, '');
    let allRows = [];
    let offset = 0;
    const pageSize = 200;
    while (true) {
      const resp = await adminFetch(`${proxyBase}/admin/progress?limit=${pageSize}&offset=${offset}`, {
        headers: adminHeaders()
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

// ── Load module dropdown cho article editor ──
let _moduleOptionsCache = null; // { ts, list }
const MODULE_CACHE_TTL = 60000; // 60s

async function loadModuleOptions(selectedModuleId = '') {
  const sel = document.getElementById('e-module');
  if (!sel) return;

  // Dùng cache nếu còn mới
  const now = Date.now();
  if (!_moduleOptionsCache || now - _moduleOptionsCache.ts > MODULE_CACHE_TTL) {
    try {
      // Lấy modules, group theo course để dễ chọn
      const [modResp, courseResp] = await Promise.all([
        adminFetch(`${PROXY}/admin/modules?limit=500&sort=Id&fields=Id,Title,CourseId`, { headers: adminHeaders() }),
        adminFetch(`${PROXY}/admin/courses?limit=200&fields=Id,Title`, { headers: adminHeaders() }),
      ]);
      const mods    = modResp.ok    ? (await modResp.json()).list    || [] : [];
      const courses = courseResp.ok ? (await courseResp.json()).list || [] : [];
      _moduleOptionsCache = { ts: now, mods, courses };
    } catch {
      _moduleOptionsCache = { ts: now, mods: [], courses: [] };
    }
  }

  const { mods, courses } = _moduleOptionsCache;
  const courseMap = Object.fromEntries(courses.map(c => [String(c.Id), c.Title]));

  // Group modules theo course
  const byCourse = {};
  mods.forEach(m => {
    const cid = String(m.CourseId || 0);
    if (!byCourse[cid]) byCourse[cid] = [];
    byCourse[cid].push(m);
  });

  sel.innerHTML = '<option value="">📦 Không thuộc module</option>';
  Object.entries(byCourse).forEach(([cid, modList]) => {
    const courseName = courseMap[cid] || `Khoá #${cid}`;
    const grp = document.createElement('optgroup');
    grp.label = `📚 ${courseName}`;
    modList.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.Id;
      opt.textContent = `  ${m.Position || '?'}. ${m.Title}`;
      if (String(m.Id) === String(selectedModuleId)) opt.selected = true;
      grp.appendChild(opt);
    });
    sel.appendChild(grp);
  });

  // Nếu selectedModuleId không có trong list (module bị xoá) → báo warn
  if (selectedModuleId && !mods.find(m => String(m.Id) === String(selectedModuleId))) {
    const opt = document.createElement('option');
    opt.value = selectedModuleId;
    opt.textContent = `⚠️ Module #${selectedModuleId} (không tìm thấy)`;
    opt.selected = true;
    sel.appendChild(opt);
  }
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
    loadDriveSettings();

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
    loadDashboardCourses();
    loadAdminStats();

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
  } else if (id === 'assessments') {
    loadAssessments();
  } else if (id === 'ai-agents') {
    initAIAgentsPanel();
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
      loadDashboardCourses();           // Canvas course cards
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
  // 1. sessionStorage token (từ unified login hoặc /admin/auth cũ)
  const token = sessionStorage.getItem('ae_admin_token') || '';
  if (token) {
    return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };
  }
  // 2. localStorage ae_user với role=admin (unified login flow)
  try {
    const u = JSON.parse(localStorage.getItem('ae_user') || 'null');
    if (u && u.token && u.role === 'admin' && u.expiresAt > Date.now()) {
      return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${u.token}` };
    }
  } catch {}
  return { 'Content-Type': 'application/json' };
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
    tbody.innerHTML = '<tr><td colspan="8" style="padding:56px;text-align:center;color:#94a3b8"><i class="fas fa-users-slash" style="font-size:28px;display:block;margin-bottom:12px;opacity:.4"></i>Không tìm thấy người dùng nào</td></tr>';
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
    const aiAccess    = !!u.AIAccess;

    // Status chip (clickable quick-toggle)
    const statusChip = status === 'active'
      ? `<button class="status-chip active" onclick="quickToggleStatus(${uid},'${esc(name)}','active')" title="Nhấn để vô hiệu hóa">
           <span class="status-dot"></span> Hoạt động
         </button>`
      : `<button class="status-chip inactive" onclick="quickToggleStatus(${uid},'${esc(name)}','inactive')" title="Nhấn để kích hoạt">
           <span class="status-dot"></span> Vô hiệu
         </button>`;

    // AI Access toggle chip
    const isAdminOrTeacher = role === 'admin' || role === 'teacher';
    const aiChip = isAdminOrTeacher
      ? `<span style="display:inline-flex;align-items:center;gap:4px;background:#f0fdf4;color:#15803d;padding:3px 10px;border-radius:20px;font-size:11px;border:1px solid #bbf7d0" title="Admin/Giáo viên luôn có quyền AI"><i class="fas fa-robot" style="font-size:9px"></i> Mặc định</span>`
      : aiAccess
        ? `<button class="ai-access-chip on" onclick="toggleAIAccess(${uid},'${esc(name)}',true)" title="Nhấn để thu hồi quyền AI">
             <i class="fas fa-robot" style="font-size:9px"></i> Bật
           </button>`
        : `<button class="ai-access-chip off" onclick="toggleAIAccess(${uid},'${esc(name)}',false)" title="Nhấn để cấp quyền AI">
             <i class="fas fa-robot" style="font-size:9px"></i> Tắt
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
      <td style="padding:10px 14px;text-align:center">${aiChip}</td>
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

// ── Toggle AI Access cho học sinh ────────────────────────────
async function toggleAIAccess(uid, name, currentOn) {
  const newVal = !currentOn;
  const action = newVal ? 'cấp' : 'thu hồi';
  if (!confirm(`${action.charAt(0).toUpperCase() + action.slice(1)} quyền AI cho "${name}"?`)) return;
  try {
    const r = await apiFetch(`/admin/users/${uid}`, 'PATCH', { AIAccess: newVal });
    if (!r.ok) throw new Error((await r.json()).error || 'Lỗi cập nhật');
    showToast(`✅ Đã ${action} quyền AI cho ${name}`, 'success');
    await loadUsers();
  } catch(e) {
    showToast('❌ ' + e.message, 'error');
  }
}

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
  document.getElementById('user-modal').classList.add('show');
}

function closeUserModal() {
  document.getElementById('user-modal').classList.remove('show');
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
// ── One-time setup: tạo field AIAccess trong NocoDB ──────────
async function runSetupAIAccessField() {
  const btn = document.getElementById('btn-setup-ai-field');
  const res = document.getElementById('setup-ai-result');
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Đang chạy...';
  res.style.display = 'none';

  try {
    const r = await apiFetch('/admin/setup/ai-access-field', 'POST', {});
    const data = await r.json();

    if (r.ok && data.ok) {
      res.style.cssText = 'display:block;padding:12px 16px;border-radius:8px;font-size:13px;background:#f0fdf4;border:1px solid #bbf7d0;color:#15803d';
      res.innerHTML = `<i class="fas fa-check-circle"></i> ${data.message}`;
      btn.innerHTML = '<i class="fas fa-check"></i> Đã khởi tạo';
      btn.style.background = '#16a34a';
      showToast('✅ ' + data.message, 'success');
    } else {
      throw new Error(data.error || data.detail || 'Lỗi không xác định');
    }
  } catch(e) {
    res.style.cssText = 'display:block;padding:12px 16px;border-radius:8px;font-size:13px;background:#fef2f2;border:1px solid #fca5a5;color:#dc2626';
    res.innerHTML = `<i class="fas fa-times-circle"></i> Lỗi: ${e.message}`;
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-wand-magic-sparkles"></i> Thử lại';
    showToast('❌ ' + e.message, 'error');
  }
}

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
  const loginScreen = document.getElementById('login-screen');

  // Kiểm tra sessionStorage token (từ unified login hoặc /admin/auth)
  if (sessionStorage.getItem('ae_admin_token')) {
    loginScreen.style.display = 'none';
    initAdmin();
    return;
  }

  // Kiểm tra localStorage ae_user với role=admin (đăng nhập từ trang chính)
  try {
    const u = JSON.parse(localStorage.getItem('ae_user') || 'null');
    if (u && u.role === 'admin' && u.token && u.expiresAt > Date.now()) {
      sessionStorage.setItem('ae_auth', '1');
      sessionStorage.setItem('ae_admin_token', u.token);
      loginScreen.style.display = 'none';
      initAdmin();
      return;
    }
  } catch {}

  // Không có session hợp lệ → hiện màn hình redirect
  sessionStorage.removeItem('ae_auth');
  loginScreen.style.display = 'flex';
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
  document.getElementById('perm-modal').classList.add('show');
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
  document.getElementById('perm-modal').classList.remove('show');
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
    const base = (cfg().proxyUrl || 'https://api.gds.edu.vn').replace(/\/$/, '');
    const r = await fetch(
      `${base}/admin/quiz?where=(ArticleId,eq,${_qmArticleId})&limit=1&fields=Id,Questions`,
      { headers: adminHeaders() }
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

  const base    = (cfg().proxyUrl || 'https://api.gds.edu.vn').replace(/\/$/, '');
  const payload = JSON.stringify(_qmQuestions);

  try {
    // Check if quiz already exists
    const check = await fetch(
      `${base}/admin/quiz?where=(ArticleId,eq,${_qmArticleId})&limit=1&fields=Id`,
      { headers: adminHeaders() }
    );
    if (!check.ok) throw new Error(`Kiểm tra quiz thất bại: HTTP ${check.status}`);
    const checkData = await check.json();
    const existing  = (checkData.list || [])[0];

    let r;
    if (existing) {
      r = await fetch(`${base}/admin/quiz`, {
        method: 'PATCH',
        headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify([{ Id: existing.Id, Questions: payload }]),
      });
    } else {
      r = await fetch(`${base}/admin/quiz`, {
        method: 'POST',
        headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ ArticleId: String(_qmArticleId), Questions: payload }),
      });
    }
    if (!r.ok) throw new Error(await r.text());
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

// ── Navigate từ Dashboard đến Courses panel rồi mở Module Builder ──
async function navigateToModuleBuilder(courseId) {
  // Chuyển sang Courses panel (không trigger loadCourses() nếu đã có cache)
  _activatePanel('courses');
  if (!_courses.length) await loadCourses();
  else renderCoursesTable(_courses);
  openModuleBuilder(courseId);
}

// ── Load danh sách khoá học ──
async function loadCourses() {
  const tbody = document.getElementById('courses-table');
  tbody.innerHTML = '<tr><td colspan="8" class="cv-loading">Đang tải...</td></tr>';
  document.getElementById('module-builder').style.display = 'none';

  try {
    const r = await fetch(`${PROXY}/admin/courses?limit=200&sort=-UpdatedAt`, { headers: adminHeaders() });
    if (!r.ok) throw new Error(await r.text());
    const data = await r.json();
    _courses = data.list || [];

    // Populate term filter
    const terms = [...new Set(_courses.map(c => c.Term).filter(Boolean))].sort();
    const termSel = document.getElementById('course-filter-term');
    if (termSel) {
      termSel.innerHTML = '<option value="">Tất cả kì học</option>' +
        terms.map(t => `<option value="${_esc(t)}">${_esc(t)}</option>`).join('');
    }

    renderCoursesTable(_courses);
  } catch(e) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:#dc2626;padding:24px">Lỗi: ${e.message}</td></tr>`;
  }
}

function renderCoursesTable(list) {
  const tbody = document.getElementById('courses-table');
  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="cv-loading">Chưa có khoá học nào. Bấm "+ Khóa học" để bắt đầu.</td></tr>';
    return;
  }
  tbody.innerHTML = list.map(c => {
    const wf = c.WorkflowState || (c.Status === 'published' ? 'available' : c.Status === 'archived' ? 'completed' : 'created');
    const isPublished = wf === 'available';

    // Published icon — Canvas style: green circle-check or gray circle-minus
    const pubIcon = isPublished
      ? `<button class="cv-pub-btn cv-pub-on" onclick="openCourseWorkflowPanel(${c.Id},'${_esc(c.Title)}')" title="Đã công bố — click để quản lý">
           <i class="fas fa-check-circle"></i>
         </button>`
      : `<button class="cv-pub-btn cv-pub-off" onclick="openCourseWorkflowPanel(${c.Id},'${_esc(c.Title)}')" title="${_wfLabel(wf)} — click để xuất bản">
           <i class="fas fa-minus-circle"></i>
         </button>`;

    // Teacher avatar (placeholder — first letter of course title)
    const initials = (c.Title || '?')[0].toUpperCase();
    const teacherHtml = `<span class="cv-teacher-wrap">
      <span class="cv-avatar">${initials}</span>
      <span class="cv-teacher-name">${_esc(c.Title.slice(0,20))}</span>
    </span>`;

    const sisId = c.CourseCode || '—';
    const term = c.Term || '—';
    const subUnit = c.Department || '—';
    const students = c.EnrollmentCount != null ? c.EnrollmentCount : '—';

    return `<tr class="cv-course-row" data-wf="${wf}" data-term="${_esc(term)}">
      <td class="cv-td-pub">${pubIcon}</td>
      <td class="cv-td-name">
        <a class="cv-course-link" onclick="openModuleBuilder(${c.Id})">${_esc(c.Title)}</a>
        ${c.Description ? `<div class="cv-course-desc">${_esc(c.Description.slice(0,70))}${c.Description.length>70?'…':''}</div>` : ''}
      </td>
      <td class="cv-td-sis">${_esc(sisId)}</td>
      <td class="cv-td-term">${_esc(term)}</td>
      <td class="cv-td-teacher">${teacherHtml}</td>
      <td class="cv-td-sub">${_esc(subUnit)}</td>
      <td class="cv-td-students">${students}</td>
      <td class="cv-td-actions">
        <div class="cv-row-actions">
          <button class="cv-row-action-btn" onclick="openEnrollmentPanel(${c.Id},'${_esc(c.Title)}')" title="Thêm học viên">
            <i class="fas fa-plus"></i>
          </button>
          <div class="cv-action-menu-wrap">
            <button class="cv-row-action-btn cv-gear-btn" onclick="toggleCourseMenu(${c.Id},this)" title="Cài đặt">
              <i class="fas fa-cog"></i>
            </button>
            <div class="cv-action-menu" id="cmenu-${c.Id}" style="display:none">
              <button onclick="openModuleBuilder(${c.Id});closeCourseMenus()"><i class="fas fa-layer-group"></i> Modules</button>
              <button onclick="openCourseWorkflowPanel(${c.Id},'${_esc(c.Title)}');closeCourseMenus()"><i class="fas fa-rotate"></i> Workflow</button>
              <button onclick="openCourseModal(${c.Id});closeCourseMenus()"><i class="fas fa-pen"></i> Chỉnh sửa</button>
              <div class="cv-menu-divider"></div>
              <button class="cv-menu-danger" onclick="deleteCourse(${c.Id},'${_esc(c.Title)}');closeCourseMenus()"><i class="fas fa-trash"></i> Xoá khoá học</button>
            </div>
          </div>
        </div>
      </td>
    </tr>`;
  }).join('');
}

function _wfLabel(wf) {
  return { available:'Đã công bố', created:'Nháp', claimed:'Claimed', completed:'Kết thúc', deleted:'Đã xoá' }[wf] || wf;
}

function toggleCourseMenu(id, btn) {
  closeCourseMenus();
  const m = document.getElementById(`cmenu-${id}`);
  if (m) {
    m.style.display = 'block';
    // Position near button
    const rect = btn.getBoundingClientRect();
    const mainRect = document.querySelector('.main-content').getBoundingClientRect();
    m.style.top = (rect.bottom - mainRect.top + 4) + 'px';
    m.style.right = (mainRect.right - rect.right) + 'px';
  }
}

function closeCourseMenus() {
  document.querySelectorAll('.cv-action-menu').forEach(m => m.style.display = 'none');
}
// Close menu on outside click
document.addEventListener('click', e => {
  if (!e.target.closest('.cv-action-menu-wrap')) closeCourseMenus();
});

function _esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ── Course modal ──
function setCourseStatus(val) {
  document.getElementById('cm-status').value = val;
  document.querySelectorAll('#course-modal .cm-status-card').forEach(c => {
    c.classList.toggle('active', c.dataset.val === val);
  });
}
function openCourseModal(id) {
  const course = id ? _courses.find(c => c.Id === id) : null;
  const isEdit = !!course;
  document.getElementById('course-modal-title').textContent = isEdit ? 'Sửa khoá học' : 'Tạo khoá học';
  const sub = document.getElementById('course-modal-sub');
  if (sub) sub.textContent = isEdit ? `Chỉnh sửa: ${course.Title}` : 'Điền thông tin cơ bản về khoá học mới';
  document.getElementById('cm-id').value = course?.Id || '';
  document.getElementById('cm-title').value = course?.Title || '';
  document.getElementById('cm-desc').value = course?.Description || '';
  setCourseStatus(course?.Status || 'draft');
  document.getElementById('course-modal').classList.add('show');
  setTimeout(() => document.getElementById('cm-title').focus(), 100);
}
function closeCourseModal() { document.getElementById('course-modal').classList.remove('show'); }

async function saveCourse() {
  const id = document.getElementById('cm-id').value;
  const title = document.getElementById('cm-title').value.trim();
  if (!title) { showToast('Nhập tên khoá học!', 'warn'); return; }

  const payload = {
    Title: title,
    Description: document.getElementById('cm-desc').value.trim(),
    Status: document.getElementById('cm-status').value,
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
    _moduleOptionsCache = null;
    await loadCourses();
  } catch(e) {
    showToast('Lỗi: ' + e.message, 'error');
  } finally { hideLoading(); }
}

async function deleteCourse(id, title) {
  if (!confirm(`Xoá khoá học "${title}"?\n⚠️ Tất cả modules trong khoá học sẽ bị xoá.\nCác bài viết được giữ lại nhưng sẽ không còn thuộc module nào.`)) return;
  try {
    showLoading('Đang xoá (cascade)...');
    // /safe endpoint: cascade delete modules, unlink articles, đảm bảo toàn vẹn FK
    const r = await fetch(`${PROXY}/admin/courses/safe`, {
      method: 'DELETE',
      headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify([{ Id: id }]),
    });
    const text = await r.text();
    const data = (() => { try { return JSON.parse(text); } catch { return {}; } })();
    if (!r.ok) throw new Error(data.error || text || `HTTP ${r.status}`);
    showToast(`Đã xoá khoá học (${data.cascadeModulesDeleted || 0} modules)`, 'success');
    _moduleOptionsCache = null;
    await loadCourses();
  } catch(e) {
    showToast('Lỗi: ' + e.message, 'error');
  } finally { hideLoading(); }
}

// ── Course search + checkbox filters ──
function filterCoursesClient() {
  if (!_courses.length) return;
  const q    = (document.getElementById('course-search')?.value || '').toLowerCase();
  const term = document.getElementById('course-filter-term')?.value || '';
  const type = document.getElementById('course-filter-type')?.value || '';
  const hideEmpty    = document.getElementById('chk-hide-empty')?.checked;
  const onlyTemplate = document.getElementById('chk-only-template')?.checked;
  const onlyPublic   = document.getElementById('chk-only-public')?.checked;

  let list = _courses.filter(c => {
    const wf = c.WorkflowState || (c.Status === 'published' ? 'available' : 'created');
    if (q && !`${c.Title}${c.CourseCode}${c.Description}`.toLowerCase().includes(q)) return false;
    if (term && c.Term !== term) return false;
    if (type && wf !== type) return false;
    if (hideEmpty && !c.EnrollmentCount) return false;
    if (onlyTemplate && !c.IsTemplate) return false;
    if (onlyPublic && wf !== 'available') return false;
    return true;
  });
  renderCoursesTable(list);
}

// keep backward compat
function filterCoursesTable(q) {
  const el = document.getElementById('course-search');
  if (el) el.value = q;
  filterCoursesClient();
  if (!_courses.length) return;
  const lq = q.toLowerCase();
  const rows = document.querySelectorAll('#courses-table tr');
  rows.forEach(row => {
    const text = row.textContent.toLowerCase();
    row.style.display = !q || text.includes(lq) ? '' : 'none';
  });
}

// ── Course Workflow Panel (FR-C03, FR-C04) ──────────────────────
let _workflowCourseId = null;

function openCourseWorkflowPanel(courseId, title) {
  _workflowCourseId = courseId;
  document.getElementById('cwp-title').textContent = `Khoá học: ${title} (ID: ${courseId})`;
  document.getElementById('cwp-msg').textContent = '';
  document.getElementById('course-workflow-panel').style.display = '';
  document.getElementById('enrollment-panel').style.display = 'none';
  setTimeout(() => document.getElementById('course-workflow-panel').scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
}

async function publishCourse() {
  if (!_workflowCourseId) return;
  try {
    showLoading('Đang xuất bản...');
    const r = await fetch(`${PROXY}/admin/courses/publish`, {
      method: 'POST',
      headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ courseId: _workflowCourseId }),
    });
    const text = await r.text();
    const data = (() => { try { return JSON.parse(text); } catch { return {}; } })();
    if (!r.ok) throw new Error(data.error || text);
    document.getElementById('cwp-msg').innerHTML = '<span style="color:#16a34a">✅ Khoá học đã xuất bản (Available)</span>';
    showToast('Đã xuất bản khoá học!', 'success');
    await loadCourses();
  } catch(e) {
    document.getElementById('cwp-msg').innerHTML = `<span style="color:#ef4444">❌ ${e.message}</span>`;
    showToast(e.message, 'error');
  } finally { hideLoading(); }
}

async function unpublishCourse() {
  if (!_workflowCourseId) return;
  if (!confirm('Huỷ xuất bản khoá học? Sinh viên sẽ không thể truy cập cho đến khi xuất bản lại.')) return;
  try {
    showLoading('Đang huỷ xuất bản...');
    const r = await fetch(`${PROXY}/admin/courses/unpublish`, {
      method: 'POST',
      headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ courseId: _workflowCourseId }),
    });
    const text = await r.text();
    const data = (() => { try { return JSON.parse(text); } catch { return {}; } })();
    if (!r.ok) throw new Error(data.error || text);
    document.getElementById('cwp-msg').innerHTML = '<span style="color:#92400e">⚠️ Khoá học đã được huỷ xuất bản (Claimed)</span>';
    showToast('Đã huỷ xuất bản!', 'success');
    await loadCourses();
  } catch(e) {
    document.getElementById('cwp-msg').innerHTML = `<span style="color:#ef4444">❌ ${e.message}</span>`;
    showToast(e.message, 'error');
  } finally { hideLoading(); }
}

async function concludeCourse() {
  if (!_workflowCourseId) return;
  if (!confirm('Kết thúc khoá học?\n⚠️ Khoá học sẽ chuyển sang chế độ Chỉ đọc cho tất cả sinh viên.')) return;
  try {
    showLoading('Đang kết thúc khoá học...');
    const r = await fetch(`${PROXY}/admin/courses/conclude`, {
      method: 'POST',
      headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ courseId: _workflowCourseId }),
    });
    const text = await r.text();
    const data = (() => { try { return JSON.parse(text); } catch { return {}; } })();
    if (!r.ok) throw new Error(data.error || text);
    document.getElementById('cwp-msg').innerHTML = '<span style="color:#991b1b">🔴 Khoá học đã kết thúc (Concluded/Read-only)</span>';
    showToast('Khoá học đã kết thúc!', 'success');
    await loadCourses();
  } catch(e) {
    document.getElementById('cwp-msg').innerHTML = `<span style="color:#ef4444">❌ ${e.message}</span>`;
    showToast(e.message, 'error');
  } finally { hideLoading(); }
}

// ── Enrollment Management ───────────────────────────────────────
let _enrollCourseId = null;
let _enrollments = [];

async function openEnrollmentPanel(courseId, title) {
  _enrollCourseId = courseId;
  document.getElementById('enroll-course-name').textContent = `Khoá học: ${title} (ID: ${courseId})`;
  document.getElementById('enrollment-panel').style.display = '';
  document.getElementById('course-workflow-panel').style.display = 'none';
  await loadEnrollments();
  setTimeout(() => document.getElementById('enrollment-panel').scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
}

function closeEnrollmentPanel() {
  document.getElementById('enrollment-panel').style.display = 'none';
  _enrollCourseId = null;
}

async function loadEnrollments() {
  if (!_enrollCourseId) return;
  const tb = document.getElementById('enrollment-table');
  tb.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:20px">Đang tải...</td></tr>';
  try {
    const r = await fetch(`${PROXY}/admin/courses/${_enrollCourseId}/enrollments`, { headers: adminHeaders() });
    const data = await r.json();
    _enrollments = data.list || [];
    if (!_enrollments.length) {
      tb.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:20px;color:var(--text-muted)">Chưa có học viên nào được ghi danh</td></tr>';
      return;
    }
    const ROLE_LABELS = {
      StudentEnrollment: '🎓 Học sinh',
      TeacherEnrollment: '👨‍🏫 Giảng viên',
      TaEnrollment: '🧑‍💼 Trợ giảng',
      ObserverEnrollment: '👁️ Quan sát',
    };
    const STATE_STYLES = {
      active:    'color:#16a34a;font-weight:600',
      invited:   'color:#0891b2',
      inactive:  'color:#94a3b8',
      completed: 'color:#7c3aed',
      rejected:  'color:#ef4444',
    };
    tb.innerHTML = _enrollments.map(e => `<tr>
      <td style="font-size:13px">#${e.UserId}</td>
      <td style="font-size:13px">${ROLE_LABELS[e.Role] || e.Role}</td>
      <td style="text-align:center">
        <span style="${STATE_STYLES[e.WorkflowState] || ''}">${e.WorkflowState}</span>
      </td>
      <td style="text-align:center">
        ${e.WorkflowState === 'active' ? `
          <button class="btn btn-outline btn-sm" onclick="toggleEnrollState(${e.Id},'inactive')" title="Tạm ngưng" style="margin-right:4px">⏸</button>
        ` : e.WorkflowState === 'inactive' ? `
          <button class="btn btn-outline btn-sm" onclick="toggleEnrollState(${e.Id},'active')" title="Kích hoạt lại" style="margin-right:4px">▶️</button>
        ` : ''}
        <button class="btn btn-sm" onclick="removeEnrollment(${e.Id})" title="Xoá ghi danh"
          style="background:#fef2f2;color:#b91c1c;border:1px solid #fecaca">
          <i class="fas fa-user-minus"></i>
        </button>
      </td>
    </tr>`).join('');
  } catch(e) {
    tb.innerHTML = `<tr><td colspan="4" style="text-align:center;padding:20px;color:var(--danger)">${e.message}</td></tr>`;
  }
}

function openEnrollModal() {
  document.getElementById('em-userid').value = '';
  document.getElementById('em-role').value = 'StudentEnrollment';
  document.getElementById('em-state').value = 'active';
  document.getElementById('em-msg').textContent = '';
  const course = _courses.find(c => c.Id === _enrollCourseId);
  document.getElementById('em-course-name').textContent = course ? course.Title : `ID: ${_enrollCourseId}`;
  document.getElementById('enroll-modal').style.display = 'flex';
}

function closeEnrollModal() {
  document.getElementById('enroll-modal').style.display = 'none';
}

async function saveEnrollment() {
  const userId = parseInt(document.getElementById('em-userid').value);
  const msgEl = document.getElementById('em-msg');
  if (!userId) { msgEl.innerHTML = '<span style="color:#ef4444">Vui lòng nhập User ID!</span>'; return; }

  const btn = document.getElementById('em-save-btn');
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Đang ghi danh...';
  msgEl.textContent = '';

  try {
    showLoading('Đang ghi danh...');
    const r = await fetch(`${PROXY}/admin/courses/${_enrollCourseId}/enrollments`, {
      method: 'POST',
      headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        UserId: userId,
        Role: document.getElementById('em-role').value,
        WorkflowState: document.getElementById('em-state').value,
      }),
    });
    const text = await r.text();
    const data = (() => { try { return JSON.parse(text); } catch { return {}; } })();
    if (!r.ok) throw new Error(data.error || text);
    showToast(data.reactivated ? 'Đã kích hoạt lại ghi danh!' : 'Đã ghi danh thành công!', 'success');
    closeEnrollModal();
    await loadEnrollments();
  } catch(e) {
    msgEl.innerHTML = `<span style="color:#ef4444">❌ ${e.message}</span>`;
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-user-plus"></i> Ghi danh';
    hideLoading();
  }
}

async function toggleEnrollState(enrollId, newState) {
  try {
    showLoading('Đang cập nhật...');
    const r = await fetch(`${PROXY}/admin/enrollments/${enrollId}`, {
      method: 'PATCH',
      headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ WorkflowState: newState }),
    });
    if (!r.ok) { const d = await r.json().catch(()=>({})); throw new Error(d?.error || `HTTP ${r.status}`); }
    showToast(newState === 'active' ? 'Đã kích hoạt lại!' : 'Đã tạm ngưng!', 'success');
    await loadEnrollments();
  } catch(e) { showToast(e.message, 'error'); } finally { hideLoading(); }
}

async function removeEnrollment(enrollId) {
  if (!confirm('Xoá ghi danh này?\nDữ liệu học tập của sinh viên vẫn được giữ lại.')) return;
  try {
    showLoading('Đang xoá...');
    const r = await fetch(`${PROXY}/admin/enrollments/${enrollId}`, {
      method: 'DELETE',
      headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
    });
    if (!r.ok) { const d = await r.json().catch(()=>({})); throw new Error(d?.error || `HTTP ${r.status}`); }
    showToast('Đã xoá ghi danh!', 'success');
    await loadEnrollments();
  } catch(e) { showToast(e.message, 'error'); } finally { hideLoading(); }
}

// ── Module builder ──
let _modules = [];

async function openModuleBuilder(courseId) {
  _activeCourseId = courseId;
  const course = _courses.find(c => c.Id === courseId);
  const title = course?.Title || `Khoá #${courseId}`;
  // Update breadcrumb
  const nameEl = document.getElementById('mb-course-name');
  if (nameEl) nameEl.textContent = title;
  document.getElementById('module-builder').style.display = '';
  // Hide sub-panels that might be open
  const ep = document.getElementById('enrollment-panel');
  if (ep) ep.style.display = 'none';
  const wp = document.getElementById('course-workflow-panel');
  if (wp) wp.style.display = 'none';
  document.getElementById('module-builder').scrollIntoView({ behavior: 'smooth', block: 'start' });
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
    const r = await fetch(`${PROXY}/admin/modules?where=(CourseId,eq,${courseId})&sort=Id&limit=100`, { headers: adminHeaders() });
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
    container.innerHTML = `
      <div class="cv-modules-empty">
        <i class="fas fa-layer-group" style="font-size:32px;color:var(--border);display:block;margin-bottom:12px"></i>
        Chưa có mô-đun nào.<br>
        <button class="btn btn-primary btn-sm" style="margin-top:12px" onclick="openModuleModal()">
          <i class="fas fa-plus"></i> Thêm mô-đun đầu tiên
        </button>
      </div>`;
    return;
  }
  container.innerHTML = _modules.map((m, i) => `
    <div class="cv-module" data-id="${m.Id}" id="cvmod-${m.Id}">
      <div class="cv-module-hd" onclick="toggleModule(${m.Id}, event)">
        <span class="cv-drag-handle" title="Kéo để sắp xếp"><i class="fas fa-grip-vertical"></i></span>
        <button class="cv-mod-toggle" id="mtoggle-${m.Id}" title="Thu/mở">
          <i class="fas fa-chevron-down"></i>
        </button>
        <span class="cv-module-name">${_esc(m.Title)}</span>
        ${m.UnlockCondition ? `<span class="cv-mod-lock" title="${_esc(m.UnlockCondition)}"><i class="fas fa-lock"></i></span>` : ''}
        <div class="cv-module-hd-actions" onclick="event.stopPropagation()">
          <button class="cv-mod-pub-btn cv-mod-pub-on" title="Công bố mô-đun">
            <i class="fas fa-check-circle"></i>
          </button>
          <button class="cv-mod-icon-btn" onclick="openAddItemModal(${m.Id},'${_esc(m.Title)}')" title="Thêm mục vào mô-đun">
            <i class="fas fa-plus"></i>
          </button>
          <div class="cv-mod-menu-wrap">
            <button class="cv-mod-icon-btn" onclick="toggleModuleMenu(${m.Id},this)" title="Tùy chọn">
              <i class="fas fa-ellipsis-v"></i>
            </button>
            <div class="cv-mod-menu" id="mmod-${m.Id}" style="display:none">
              <button onclick="openModuleModal(${m.Id});closeModuleMenus()">
                <i class="fas fa-pen"></i> Chỉnh sửa
              </button>
              <button onclick="openAddItemModal(${m.Id},'${_esc(m.Title)}');closeModuleMenus()">
                <i class="fas fa-plus"></i> Thêm mục
              </button>
              <div class="cv-menu-divider"></div>
              <button class="cv-menu-danger" onclick="deleteModule(${m.Id},'${_esc(m.Title)}');closeModuleMenus()">
                <i class="fas fa-trash"></i> Xoá mô-đun
              </button>
            </div>
          </div>
        </div>
      </div>
      <div class="cv-module-items" id="module-items-${m.Id}">
        <div class="cv-items-loading"><i class="fas fa-spinner fa-spin"></i> Đang tải...</div>
      </div>
    </div>`).join('');

  // Auto-load items sequentially — tránh burst requests gây 429
  (async () => {
    for (const m of _modules) {
      await loadModuleItems(m.Id, false);
    }
  })();
}

function toggleModule(moduleId, event) {
  if (event?.target?.closest('.cv-module-hd-actions')) return;
  const itemsEl = document.getElementById(`module-items-${moduleId}`);
  const toggleBtn = document.getElementById(`mtoggle-${moduleId}`);
  if (!itemsEl) return;
  const collapsed = itemsEl.classList.contains('cv-module-collapsed');
  itemsEl.classList.toggle('cv-module-collapsed', !collapsed);
  if (toggleBtn) {
    toggleBtn.querySelector('i').className = collapsed ? 'fas fa-chevron-down' : 'fas fa-chevron-right';
  }
}

function collapseAllModules() {
  _modules.forEach(m => {
    const el = document.getElementById(`module-items-${m.Id}`);
    const btn = document.getElementById(`mtoggle-${m.Id}`);
    if (el) el.classList.add('cv-module-collapsed');
    if (btn) btn.querySelector('i').className = 'fas fa-chevron-right';
  });
}

function toggleModuleMenu(id, btn) {
  closeModuleMenus();
  const m = document.getElementById(`mmod-${id}`);
  if (m) {
    m.style.display = 'block';
    const rect = btn.getBoundingClientRect();
    const mainRect = document.querySelector('.main-content')?.getBoundingClientRect() || { top: 0, right: window.innerWidth };
    m.style.top = (rect.bottom + window.scrollY - (document.querySelector('.main-content')?.scrollTop || 0) + 4) + 'px';
    m.style.right = (mainRect.right - rect.right) + 'px';
  }
}
function closeModuleMenus() {
  document.querySelectorAll('.cv-mod-menu').forEach(m => m.style.display = 'none');
}
document.addEventListener('click', e => {
  if (!e.target.closest('.cv-mod-menu-wrap')) closeModuleMenus();
});

async function publishAllModulesItems() {
  showToast('Tính năng công bố hàng loạt đang phát triển', 'info');
}

// ── Canvas-style Module Items ──
async function loadModuleItems(moduleId, toggle = true) {
  const container = document.getElementById(`module-items-${moduleId}`);
  if (!container) return;

  // If toggle mode and already loaded (not loading spinner), collapse/expand
  if (toggle && !container.querySelector('.cv-items-loading')) {
    container.classList.toggle('cv-module-collapsed');
    const btn = document.getElementById(`mtoggle-${moduleId}`);
    if (btn) btn.querySelector('i').className =
      container.classList.contains('cv-module-collapsed') ? 'fas fa-chevron-right' : 'fas fa-chevron-down';
    return;
  }

  container.innerHTML = '<div class="cv-items-loading"><i class="fas fa-spinner fa-spin"></i> Đang tải...</div>';

  try {
    const r = await adminFetch(
      `${PROXY}/admin/articles?where=(ModuleId,eq,${moduleId})&sort=Id&limit=100&fields=Id,Title,ItemType,Published,Access`,
      { headers: adminHeaders() }
    );
    if (!r.ok) throw new Error(await r.text());
    const data = await r.json();
    const items = data.list || [];

    if (!items.length) {
      container.innerHTML = `
        <div class="cv-item-empty">
          Mô-đun này chưa có bài học nào.
          <button class="cv-add-item-inline" onclick="openAddItemModal(${moduleId},'')">
            <i class="fas fa-plus"></i> Thêm bài học
          </button>
        </div>`;
      return;
    }

    const typeIconMap = {
      article:     '<i class="fas fa-file-alt cv-item-type-icon" style="color:#475569"></i>',
      interactive: '<i class="fas fa-gamepad cv-item-type-icon" style="color:#7c3aed"></i>',
      quiz:        '<i class="fas fa-clipboard-list cv-item-type-icon" style="color:#0369a1"></i>',
      exam:        '<i class="fas fa-file-pen cv-item-type-icon" style="color:#92400e"></i>',
    };

    container.innerHTML = items.map(item => {
      const icon = typeIconMap[item.ItemType] || typeIconMap.article;
      const published = item.Published !== false;
      return `
        <div class="cv-item-row" data-id="${item.Id}">
          <span class="cv-drag-handle cv-item-drag"><i class="fas fa-grip-vertical"></i></span>
          ${icon}
          <span class="cv-item-title">${_esc(item.Title || `Bài ${item.Id}`)}</span>
          <div class="cv-item-actions">
            <button class="cv-item-copy-btn" title="Sao chép" onclick="event.stopPropagation()">
              <i class="fas fa-copy"></i>
            </button>
            <button class="cv-item-pub-btn ${published ? 'cv-item-pub-on' : 'cv-item-pub-off'}"
              title="${published ? 'Đang công bố — click để ẩn' : 'Đang ẩn — click để công bố'}"
              onclick="event.stopPropagation();toggleItemPublished(${item.Id}, ${!published}, this)">
              <i class="fas fa-check-circle"></i>
            </button>
            <button class="cv-mod-icon-btn" title="Tuỳ chọn" onclick="event.stopPropagation()">
              <i class="fas fa-ellipsis-v"></i>
            </button>
          </div>
        </div>`;
    }).join('');
  } catch(e) {
    container.innerHTML = `<div class="cv-item-empty" style="color:#dc2626">Lỗi: ${e.message}</div>`;
  }
}

async function toggleItemPublished(articleId, published, btnEl) {
  try {
    const r = await fetch(`${PROXY}/admin/module-item/${articleId}`, {
      method: 'PATCH',
      headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ published }),
    });
    if (!r.ok) throw new Error(await r.text());
    // Update button UI
    if (btnEl) {
      btnEl.classList.toggle('cv-item-pub-on', published);
      btnEl.classList.toggle('cv-item-pub-off', !published);
      btnEl.title = published ? 'Đang công bố — click để ẩn' : 'Đang ẩn — click để công bố';
      btnEl.setAttribute('onclick', `event.stopPropagation();toggleItemPublished(${articleId}, ${!published}, this)`);
    }
    showToast(published ? 'Đã công bố bài học' : 'Đã ẩn bài học', 'success');
  } catch(e) {
    showToast('Lỗi: ' + e.message, 'error');
  }
}

// ── Add item to module modal ──
function openAddItemModal(moduleId, moduleTitle) {
  document.getElementById('aim-module-id').value = moduleId;
  document.getElementById('aim-title').textContent = moduleTitle
    ? `Thêm mục vào ${moduleTitle}`
    : 'Thêm mục vào mô-đun';
  document.getElementById('aim-selected-id').value = '';
  document.getElementById('aim-type').value = 'article';
  document.getElementById('aim-indent').value = '0';
  document.getElementById('aim-text-input').style.display = 'none';
  document.getElementById('aim-url-input').style.display = 'none';
  document.getElementById('add-item-modal').style.display = 'flex';
  loadAddItemContent();
}
function closeAddItemModal() {
  document.getElementById('add-item-modal').style.display = 'none';
}

async function loadAddItemContent() {
  const type = document.getElementById('aim-type').value;
  const area = document.getElementById('aim-content-area');
  document.getElementById('aim-text-input').style.display = type === 'text_header' ? '' : 'none';
  document.getElementById('aim-url-input').style.display = type === 'external_url' ? '' : 'none';
  area.style.display = ['text_header','external_url'].includes(type) ? 'none' : '';

  if (['text_header','external_url'].includes(type)) return;

  area.innerHTML = '<div style="color:var(--text-muted);text-align:center;padding:24px"><i class="fas fa-spinner fa-spin"></i> Đang tải...</div>';
  document.getElementById('aim-selected-id').value = '';

  try {
    let url, fields, labelKey = 'Title';
    if (type === 'article') {
      url = `${PROXY}/admin/articles?limit=200&sort=Title&fields=Id,Title,ItemType`;
    } else if (type === 'exam') {
      url = `${PROXY}/admin/exams?limit=200&sort=Title&fields=Id,Title`;
    } else if (type === 'assessment') {
      url = `${PROXY}/admin/assessments-proxy?limit=200&sort=Title&fields=Id,Title,AssessmentType`;
    }
    const r = await adminFetch(url, { headers: adminHeaders() });
    if (!r.ok) throw new Error(`Lỗi tải danh sách (${r.status})`);
    const data = await r.json();
    const items = data.list || [];
    if (!items.length) {
      area.innerHTML = '<div style="color:var(--text-muted);text-align:center;padding:24px">Không có nội dung nào. Hãy tạo nội dung trước.</div>';
      return;
    }
    area.innerHTML = items.map(it => `
      <div class="cv-aim-item" data-id="${it.Id}" onclick="selectAimItem(this, ${it.Id})">
        <i class="fas fa-${type==='article'?'file-alt':type==='exam'?'file-pen':'clipboard-list'}" style="color:var(--text-muted);margin-right:8px;width:14px"></i>
        ${_esc(it.Title || `#${it.Id}`)}
      </div>`).join('');
  } catch(e) {
    area.innerHTML = `<div style="color:#dc2626;padding:12px">Lỗi: ${e.message}</div>`;
  }
}

function selectAimItem(el, id) {
  document.querySelectorAll('.cv-aim-item').forEach(i => i.classList.remove('selected'));
  el.classList.add('selected');
  document.getElementById('aim-selected-id').value = id;
}

async function saveAddItem() {
  const moduleId = parseInt(document.getElementById('aim-module-id').value);
  const type = document.getElementById('aim-type').value;
  const indent = parseInt(document.getElementById('aim-indent').value) || 0;
  const selectedId = document.getElementById('aim-selected-id').value;

  if (type === 'text_header') {
    const text = document.getElementById('aim-text-val').value.trim();
    if (!text) { showToast('Nhập nội dung tiêu đề!', 'warn'); return; }
    // For text headers, we just show a toast (backend support needed)
    showToast('Tiêu đề văn bản đã được thêm (tính năng UI)', 'info');
    closeAddItemModal();
    return;
  }
  if (type === 'external_url') {
    const url = document.getElementById('aim-url-val').value.trim();
    const title = document.getElementById('aim-url-title').value.trim();
    if (!url || !title) { showToast('Nhập URL và tiêu đề!', 'warn'); return; }
    showToast('URL bên ngoài đã được thêm (tính năng UI)', 'info');
    closeAddItemModal();
    return;
  }
  if (!selectedId) { showToast('Chọn một mục từ danh sách!', 'warn'); return; }

  // For articles, update the article's ModuleId
  if (type === 'article') {
    try {
      showLoading('Đang gán bài học vào mô-đun...');
      const r = await fetch(`${PROXY}/admin/articles`, {
        method: 'PATCH',
        headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify([{ Id: parseInt(selectedId), ModuleId: moduleId }]),
      });
      if (!r.ok) throw new Error(await r.text());
      closeAddItemModal();
      showToast('Đã thêm bài học vào mô-đun!', 'success');
      await loadModuleItems(moduleId, false);
    } catch(e) {
      showToast('Lỗi: ' + e.message, 'error');
    } finally { hideLoading(); }
  } else {
    showToast(`Đã thêm vào mô-đun (${type})`, 'success');
    closeAddItemModal();
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
    _moduleOptionsCache = null;
    await loadModules(_activeCourseId);
  } catch(e) {
    showToast('Lỗi: ' + e.message, 'error');
  } finally { hideLoading(); }
}

async function deleteModule(id, title) {
  if (!confirm(`Xoá module "${title}"?\n⚠️ Các bài viết trong module sẽ được giữ lại nhưng không còn thuộc module nào.`)) return;
  try {
    showLoading('Đang xoá...');
    // /safe endpoint: unlink articles + exams, giữ toàn vẹn FK
    const r = await fetch(`${PROXY}/admin/modules/safe`, {
      method: 'DELETE',
      headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify([{ Id: id }]),
    });
    const text = await r.text();
    const data = (() => { try { return JSON.parse(text); } catch { return {}; } })();
    if (!r.ok) throw new Error(data.error || text || `HTTP ${r.status}`);
    showToast('Đã xoá module!', 'success');
    _moduleOptionsCache = null;
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
  const listEl = document.getElementById('qbank-list');
  if (listEl) listEl.innerHTML = '<div class="cv-qb-loading"><i class="fas fa-spinner fa-spin"></i> Đang tải...</div>';
  document.getElementById('qbank-editor').style.display = 'none';
  const listView = document.getElementById('qbank-list-view');
  if (listView) listView.style.display = '';

  try {
    const r = await fetch(`${PROXY}/admin/question-banks?limit=200&sort=-UpdatedAt`, { headers: adminHeaders() });
    if (!r.ok) throw new Error(await r.text());
    const data = await r.json();
    _qbanks = data.list || [];

    if (!listEl) return;
    if (!_qbanks.length) {
      listEl.innerHTML = `
        <div class="cv-qb-empty">
          Chưa có ngân hàng câu hỏi nào.<br>
          <button class="btn btn-primary btn-sm" style="margin-top:10px" onclick="openQBankModal()">
            <i class="fas fa-plus"></i> Thêm ngân hàng đầu tiên
          </button>
        </div>`;
      return;
    }

    listEl.innerHTML = _qbanks.map(b => {
      let qCount = 0;
      try { qCount = JSON.parse(b.Questions || '[]').length; } catch {}
      const updated = b.UpdatedAt ? _fmtDate(b.UpdatedAt) : '—';
      return `
        <div class="cv-qb-item">
          <div class="cv-qb-item-main">
            <a class="cv-qb-item-title" onclick="openQBankEditor(${b.Id})">${_esc(b.Title)}</a>
            <div class="cv-qb-item-meta">
              <span>${qCount} câu hỏi</span>
              <span class="cv-qb-meta-sep">·</span>
              <span>Cập nhật lần cuối: ${updated}</span>
              ${b.GroupName ? `<span class="cv-qb-meta-sep">·</span><span class="cv-qb-group">${_esc(b.GroupName)}</span>` : ''}
            </div>
          </div>
          <div class="cv-qb-item-actions">
            <button class="cv-qb-action" title="Đánh dấu"><i class="fas fa-bookmark"></i></button>
            <button class="cv-qb-action" onclick="openQBankModal(${b.Id})" title="Chỉnh sửa"><i class="fas fa-pencil"></i></button>
            <button class="cv-qb-action cv-qb-action-del" onclick="deleteQBank(${b.Id},'${_esc(b.Title)}')" title="Xoá"><i class="fas fa-times"></i></button>
          </div>
        </div>
        <hr class="cv-qb-hr">`;
    }).join('');
  } catch(e) {
    if (listEl) listEl.innerHTML = `<div style="color:#dc2626;padding:16px">Lỗi: ${e.message}</div>`;
  }
}

function _fmtDate(iso) {
  try {
    const d = new Date(iso);
    const months = ['Th1','Th2','Th3','Th4','Th5','Th6','Th7','Th8','Th9','Th10','Th11','Th12'];
    return `${months[d.getMonth()]} ${d.getDate()} lúc ${d.getHours()}:${String(d.getMinutes()).padStart(2,'0')}`;
  } catch { return iso; }
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
    showLoading('Đang kiểm tra ràng buộc...');
    // /safe endpoint: chặn xoá nếu đang được dùng trong đề thi (FK integrity)
    const r = await fetch(`${PROXY}/admin/question-banks/safe`, {
      method: 'DELETE',
      headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify([{ Id: id }]),
    });
    const text = await r.text();
    const data = (() => { try { return JSON.parse(text); } catch { return {}; } })();
    if (!r.ok) throw new Error(data.error || text || `HTTP ${r.status}`);
    showToast('Đã xoá ngân hàng!', 'success');
    await loadQBanks();
  } catch(e) { showToast('Lỗi: ' + e.message, 'error'); } finally { hideLoading(); }
}

// ── Question editor ──
async function openQBankEditor(bankId) {
  _activeQBankId = bankId;
  const bank = _qbanks.find(b => b.Id === bankId);
  document.getElementById('qbank-editor-title').textContent = bank?.Title || `Ngân hàng #${bankId}`;
  const metaEl = document.getElementById('qbank-editor-meta');
  if (metaEl) metaEl.textContent = bank?.GroupName ? `Nhóm: ${bank.GroupName}` : '';
  // Hide list view, show editor
  const listView = document.getElementById('qbank-list-view');
  if (listView) listView.style.display = 'none';
  document.getElementById('qbank-editor').style.display = '';
  document.getElementById('qbank-editor').scrollIntoView({ behavior: 'smooth' });

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
  const listView = document.getElementById('qbank-list-view');
  if (listView) listView.style.display = '';
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
  if (!confirm(`Xoá đề "${title}"?\n⚠️ Tất cả phần thi trong đề sẽ bị xoá theo.`)) return;
  try {
    showLoading('Đang xoá (cascade sections)...');
    // /safe endpoint: cascade delete ExamSections trước, rồi xoá Exam
    const r = await fetch(`${PROXY}/admin/exams/safe`, {
      method: 'DELETE',
      headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify([{ Id: id }]),
    });
    const text = await r.text();
    const data = (() => { try { return JSON.parse(text); } catch { return {}; } })();
    if (!r.ok) throw new Error(data.error || text || `HTTP ${r.status}`);
    showToast(`Đã xoá đề (${data.sectionsDeleted || 0} phần thi)`, 'success');
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
    const r = await fetch(`${PROXY}/admin/exam-sections?where=(ExamId,eq,${examId})&sort=Id&limit=50`, { headers: adminHeaders() });
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
    showLoading('Đang thêm phần (kiểm tra ràng buộc)...');
    // /safe endpoint: validate ExamId tồn tại, BankId tồn tại, QuestionCount ≤ bank size, không trùng bank trong cùng đề
    const r = await fetch(`${PROXY}/admin/exam-sections/safe`, {
      method: 'POST',
      headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await r.text();
    const data = (() => { try { return JSON.parse(text); } catch { return {}; } })();
    if (!r.ok) throw new Error(data.error || text || `HTTP ${r.status}`);
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

// ═══════════════════════════════════════════════════
// ASSESSMENTS (Quizzes & Surveys)
// ═══════════════════════════════════════════════════

let _assessmentsCache = [];
let _assessPage = 0;
const _assessPageSize = 20;
let _activeAssessId = null;
let _assessQuestions = []; // local question builder state

// ── Label helpers ──────────────────────────────────
const ASSESS_TYPE_LABEL = {
  graded_quiz:     { label: 'Trắc nghiệm có điểm', color: '#2563eb', bg: '#eff6ff', icon: '📝' },
  practice_quiz:   { label: 'Luyện tập',           color: '#7c3aed', bg: '#f5f3ff', icon: '🔄' },
  graded_survey:   { label: 'Khảo sát có điểm',    color: '#0891b2', bg: '#ecfeff', icon: '📊' },
  ungraded_survey: { label: 'Khảo sát ẩn danh',    color: '#854d0e', bg: '#fefce8', icon: '🕵️' },
};

function assessTypeBadge(type) {
  const t = ASSESS_TYPE_LABEL[type] || { label: type, color: '#64748b', bg: '#f1f5f9', icon: '❓' };
  return `<span style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;background:${t.bg};color:${t.color}">${t.icon} ${t.label}</span>`;
}

// ── Load / render ──────────────────────────────────
async function loadAssessments() {
  try {
    const typeFilter = document.getElementById('assess-type-filter')?.value || '';
    let where = '';
    if (typeFilter) where = `?where=(AssessmentType,eq,${typeFilter})`;
    const r = await fetch(`${PROXY}/admin/assessments-proxy${where}&sort=-Id&limit=200`, {
      headers: adminHeaders(),
    });
    const data = await r.json();
    _assessmentsCache = data.list || [];
    _assessPage = 0;
    renderAssessmentsTable(_assessmentsCache);
    updateAssessStats(_assessmentsCache);
  } catch(e) {
    document.getElementById('assessments-table').innerHTML =
      `<tr><td colspan="9" style="text-align:center;padding:32px;color:var(--danger)">${e.message}</td></tr>`;
  }
}

function filterAssessments(q) {
  const typeFilter = document.getElementById('assess-type-filter')?.value || '';
  let list = _assessmentsCache;
  if (typeFilter) list = list.filter(a => a.AssessmentType === typeFilter);
  if (q.trim()) {
    const lq = q.toLowerCase();
    list = list.filter(a => (a.Title || '').toLowerCase().includes(lq));
  }
  _assessPage = 0;
  renderAssessmentsTable(list);
}

function assessPage(dir) {
  const list = _assessmentsCache;
  const maxPage = Math.ceil(list.length / _assessPageSize) - 1;
  _assessPage = Math.max(0, Math.min(maxPage, _assessPage + dir));
  renderAssessmentsTable(list);
}

function renderAssessmentsTable(list) {
  const container = document.getElementById('cv-assess-groups');
  if (!container) return;

  if (!list.length) {
    container.innerHTML = `
      <div class="cv-assess-empty">
        <i class="fas fa-clipboard-question" style="font-size:36px;color:var(--border);display:block;margin-bottom:12px"></i>
        Chưa có bài kiểm tra nào.<br>
        <button class="btn btn-primary btn-sm" style="margin-top:12px" onclick="openAssessmentModal()">
          <i class="fas fa-plus"></i> Tạo đề kiểm tra đầu tiên
        </button>
      </div>`;
    return;
  }

  // Group by type
  const groups = {
    graded_quiz:     { label: 'Đề kiểm tra có chấm điểm', items: [] },
    practice_quiz:   { label: 'Bài tập luyện tập',         items: [] },
    graded_survey:   { label: 'Khảo sát có chấm điểm',     items: [] },
    ungraded_survey: { label: 'Khảo sát ẩn danh',           items: [] },
  };
  list.forEach(a => {
    const g = groups[a.AssessmentType];
    if (g) g.items.push(a);
    else groups.graded_quiz.items.push(a); // fallback
  });

  // Canvas quiz icon SVG per type
  const typeIcon = {
    graded_quiz:     `<svg class="cv-quiz-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5M2 12l10 5 10-5"/></svg>`,
    practice_quiz:   `<svg class="cv-quiz-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
    graded_survey:   `<svg class="cv-quiz-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>`,
    ungraded_survey: `<svg class="cv-quiz-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  };

  container.innerHTML = Object.entries(groups)
    .filter(([, g]) => g.items.length > 0)
    .map(([type, g]) => `
      <div class="cv-assess-group" id="ag-${type}">
        <div class="cv-assess-group-hd" onclick="toggleAssessGroup('${type}')">
          <i class="fas fa-chevron-down cv-ag-arrow" id="ag-arrow-${type}"></i>
          <span class="cv-ag-label">${g.label}</span>
          <span class="cv-ag-count">${g.items.length}</span>
        </div>
        <div class="cv-assess-group-body" id="ag-body-${type}">
          ${g.items.map(a => {
            const qs = (() => { try { return JSON.parse(a.Questions || '[]').length; } catch { return 0; } })();
            const pts = a.TotalPoints || 10;
            const tl = a.TimeLimitMinutes ? `${a.TimeLimitMinutes} phút` : null;
            const pub = a.IsPublished !== false;
            const icon = typeIcon[a.AssessmentType] || typeIcon.graded_quiz;
            return `
              <div class="cv-assess-item" data-id="${a.Id}">
                <div class="cv-assess-item-icon" style="color:${ASSESS_TYPE_LABEL[a.AssessmentType]?.color || '#475569'}">${icon}</div>
                <div class="cv-assess-item-info">
                  <div class="cv-assess-item-name">${escHtml(a.Title || '')}</div>
                  <div class="cv-assess-item-meta">
                    <span>${pts} Điểm</span>
                    <span class="cv-ai-sep">|</span>
                    <span>${qs} Câu hỏi</span>
                    ${tl ? `<span class="cv-ai-sep">|</span><span>${tl}</span>` : ''}
                  </div>
                </div>
                <div class="cv-assess-item-actions">
                  <button class="cv-item-copy-btn" title="Xem kết quả nộp bài"
                    onclick="loadSubmissionsPanel(${a.Id},'${escHtml(a.Title||'')}')">
                    <i class="fas fa-chart-bar" style="font-size:12px"></i>
                  </button>
                  <button class="cv-item-pub-btn ${pub ? 'cv-item-pub-on' : 'cv-item-pub-off'}"
                    title="${pub ? 'Đang công bố' : 'Nháp — click để công bố'}">
                    <i class="fas fa-check-circle"></i>
                  </button>
                  <div class="cv-mod-menu-wrap">
                    <button class="cv-mod-icon-btn" onclick="toggleAssessMenu(${a.Id},this)">
                      <i class="fas fa-ellipsis-v"></i>
                    </button>
                    <div class="cv-mod-menu" id="amenu-${a.Id}" style="display:none">
                      <button onclick="openAssessmentModal(${a.Id});closeAssessMenus()"><i class="fas fa-pen"></i> Chỉnh sửa</button>
                      <button onclick="loadSubmissionsPanel(${a.Id},'${escHtml(a.Title||'')}');closeAssessMenus()"><i class="fas fa-chart-bar"></i> Kết quả</button>
                      <div class="cv-menu-divider"></div>
                      <button class="cv-menu-danger" onclick="deleteAssessment(${a.Id});closeAssessMenus()"><i class="fas fa-trash"></i> Xoá</button>
                    </div>
                  </div>
                </div>
              </div>`;
          }).join('')}
        </div>
      </div>`).join('');
}

function toggleAssessGroup(type) {
  const body = document.getElementById(`ag-body-${type}`);
  const arrow = document.getElementById(`ag-arrow-${type}`);
  if (!body) return;
  const collapsed = body.classList.toggle('cv-ag-collapsed');
  if (arrow) arrow.style.transform = collapsed ? 'rotate(-90deg)' : '';
}

function toggleAssessMenu(id, btn) {
  closeAssessMenus();
  const m = document.getElementById(`amenu-${id}`);
  if (m) m.style.display = 'block';
}
function closeAssessMenus() {
  document.querySelectorAll('[id^="amenu-"]').forEach(m => m.style.display = 'none');
}
document.addEventListener('click', e => {
  if (!e.target.closest('.cv-assess-item')) closeAssessMenus();
});

function updateAssessStats(list) {
  document.getElementById('astat-total').textContent = list.length;
  document.getElementById('astat-published').textContent = list.filter(a => a.IsPublished).length;
  // Submissions count requires a separate call — skip for now, show placeholder
  document.getElementById('astat-submissions').textContent = '–';
  document.getElementById('astat-pending').textContent = '–';
}

// ── Assessment modal ───────────────────────────────
function setAssessType(val) {
  document.getElementById('am-type').value = val;
  document.querySelectorAll('#assessment-modal .cm-status-card').forEach(c => {
    c.classList.toggle('active', c.dataset.val === val);
  });
}

async function openAssessmentModal(id = null) {
  _activeAssessId = id;
  _assessQuestions = [];
  const titleEl = document.getElementById('assess-modal-title');
  const subEl = document.getElementById('assess-modal-sub');
  document.getElementById('am-msg').textContent = '';

  // Reset form
  ['am-id','am-type','am-title','am-desc','am-course','am-module',
   'am-timelimit','am-maxattempts','am-availfrom','am-availto','am-accesscode'].forEach(fid => {
    const el = document.getElementById(fid);
    if (el) el.value = '';
  });
  document.getElementById('am-shuffle').checked = false;
  document.getElementById('am-published').checked = false;
  document.querySelectorAll('#assessment-modal .cm-status-card').forEach(c => c.classList.remove('active'));
  document.getElementById('am-questions').innerHTML = '';
  document.getElementById('am-q-count').textContent = '';

  if (id) {
    titleEl.textContent = 'Sửa bài kiểm tra';
    subEl.textContent = `ID #${id}`;
    try {
      showLoading('Đang tải...');
      const r = await fetch(`${PROXY}/admin/assessments-proxy/${id}`, { headers: adminHeaders() });
      const a = await r.json();
      document.getElementById('am-id').value = a.Id;
      document.getElementById('am-title').value = a.Title || '';
      document.getElementById('am-desc').value = a.Description || '';
      document.getElementById('am-course').value = a.CourseId || '';
      document.getElementById('am-module').value = a.ModuleId || '';
      document.getElementById('am-timelimit').value = a.TimeLimitMinutes || '';
      document.getElementById('am-maxattempts').value = a.MaxAttempts || '';
      document.getElementById('am-availfrom').value = a.AvailableFrom ? a.AvailableFrom.slice(0,16) : '';
      document.getElementById('am-availto').value = a.AvailableUntil ? a.AvailableUntil.slice(0,16) : '';
      document.getElementById('am-accesscode').value = a.AccessCode || '';
      document.getElementById('am-shuffle').checked = !!a.ShuffleQuestions;
      document.getElementById('am-published').checked = !!a.IsPublished;
      if (a.AssessmentType) setAssessType(a.AssessmentType);
      // Load questions
      try { _assessQuestions = JSON.parse(a.Questions || '[]'); } catch { _assessQuestions = []; }
      renderAssessQuestions();
    } catch(e) { showToast('Lỗi tải: ' + e.message, 'error'); }
    finally { hideLoading(); }
  } else {
    titleEl.textContent = 'Tạo bài kiểm tra mới';
    subEl.textContent = 'Điền thông tin và câu hỏi';
    setAssessType('graded_quiz');
  }

  document.getElementById('assessment-modal').classList.add('show');
}

function closeAssessmentModal() {
  document.getElementById('assessment-modal').classList.remove('show');
}

// ── Question builder ───────────────────────────────
const Q_TYPES = [
  { val: 'multiple_choice', label: 'Trắc nghiệm' },
  { val: 'true_false',      label: 'Đúng/Sai' },
  { val: 'short_text',      label: 'Trả lời ngắn' },
  { val: 'essay',           label: 'Tự luận' },
  { val: 'rating',          label: 'Đánh giá (1–5)' },
];

function addAssessQuestion() {
  _assessQuestions.push({
    id: Date.now(),
    type: 'multiple_choice',
    content: '',
    options: ['', '', '', ''],
    correct: 0,
    points: 1,
    required: true,
  });
  renderAssessQuestions();
  // Scroll to last question
  const container = document.getElementById('am-questions');
  setTimeout(() => container.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50);
}

function removeAssessQuestion(idx) {
  _assessQuestions.splice(idx, 1);
  renderAssessQuestions();
}

function moveAssessQuestion(idx, dir) {
  const newIdx = idx + dir;
  if (newIdx < 0 || newIdx >= _assessQuestions.length) return;
  [_assessQuestions[idx], _assessQuestions[newIdx]] = [_assessQuestions[newIdx], _assessQuestions[idx]];
  renderAssessQuestions();
}

function renderAssessQuestions() {
  const container = document.getElementById('am-questions');
  document.getElementById('am-q-count').textContent = `(${_assessQuestions.length} câu)`;
  if (!_assessQuestions.length) {
    container.innerHTML = `<div style="text-align:center;padding:20px;color:var(--text-muted);font-size:13px;border:2px dashed var(--border);border-radius:10px">
      Chưa có câu hỏi. Nhấn <b>Thêm câu</b> để bắt đầu.
    </div>`;
    return;
  }
  container.innerHTML = _assessQuestions.map((q, idx) => {
    const typeOpts = Q_TYPES.map(t =>
      `<option value="${t.val}" ${q.type === t.val ? 'selected' : ''}>${t.label}</option>`
    ).join('');

    let optionsHtml = '';
    if (q.type === 'multiple_choice') {
      optionsHtml = `<div style="margin-top:8px">
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:4px">Lựa chọn (✓ = đáp án đúng):</div>
        ${(q.options || ['','','','']).map((opt, oi) => `
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
            <input type="radio" name="correct_${idx}" value="${oi}" ${q.correct === oi ? 'checked' : ''}
              onchange="assessQField(${idx},'correct',parseInt(this.value))" style="accent-color:#16a34a;cursor:pointer">
            <input type="text" class="inp" value="${escHtml(opt)}" placeholder="Lựa chọn ${oi+1}"
              style="flex:1;height:32px;padding:4px 8px;font-size:13px"
              oninput="assessQOption(${idx},${oi},this.value)">
            ${q.options.length > 2 ? `<button type="button" onclick="removeAssessOption(${idx},${oi})"
              style="background:none;border:none;color:#ef4444;cursor:pointer;padding:2px 4px;font-size:14px">✕</button>` : ''}
          </div>`).join('')}
        <button type="button" class="btn btn-outline btn-sm" onclick="addAssessOption(${idx})" style="margin-top:2px">
          <i class="fas fa-plus"></i> Thêm lựa chọn
        </button>
      </div>`;
    } else if (q.type === 'true_false') {
      optionsHtml = `<div style="margin-top:8px;display:flex;gap:16px">
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
          <input type="radio" name="tf_${idx}" value="true" ${q.correct === true || q.correct === 'true' ? 'checked' : ''}
            onchange="assessQField(${idx},'correct',true)" style="accent-color:#16a34a">
          <span style="font-weight:500">✅ Đúng</span>
        </label>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
          <input type="radio" name="tf_${idx}" value="false" ${q.correct === false || q.correct === 'false' ? 'checked' : ''}
            onchange="assessQField(${idx},'correct',false)" style="accent-color:#ef4444">
          <span style="font-weight:500">❌ Sai</span>
        </label>
      </div>`;
    } else if (q.type === 'short_text') {
      optionsHtml = `<div style="margin-top:8px">
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:4px">Đáp án mẫu (tự chấm):</div>
        <input type="text" class="inp" value="${escHtml(q.correct||'')}" placeholder="Đáp án tham khảo"
          style="height:32px;padding:4px 8px;font-size:13px"
          oninput="assessQField(${idx},'correct',this.value)">
      </div>`;
    } else if (q.type === 'essay') {
      optionsHtml = `<div style="margin-top:6px;font-size:12px;color:var(--text-muted)">
        📝 Tự luận — Giáo viên chấm điểm thủ công
      </div>`;
    } else if (q.type === 'rating') {
      optionsHtml = `<div style="margin-top:6px;font-size:12px;color:var(--text-muted)">
        ⭐ Đánh giá từ 1 đến 5 sao
      </div>`;
    }

    return `<div style="border:1.5px solid var(--border);border-radius:10px;padding:12px;background:var(--card-bg)">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <span style="font-size:12px;font-weight:700;color:var(--text-muted);min-width:24px">Q${idx+1}</span>
        <select class="inp" style="flex:0 0 auto;width:160px;height:32px;padding:2px 6px;font-size:12px"
          onchange="assessQField(${idx},'type',this.value);renderAssessQuestions()">
          ${typeOpts}
        </select>
        <input type="number" class="inp" value="${q.points||1}" min="0.5" step="0.5"
          style="flex:0 0 56px;height:32px;padding:4px 6px;font-size:12px" title="Điểm"
          oninput="assessQField(${idx},'points',parseFloat(this.value)||1)">
        <span style="font-size:11px;color:var(--text-muted)">điểm</span>
        <div style="flex:1"></div>
        <button type="button" onclick="moveAssessQuestion(${idx},-1)" ${idx===0?'disabled':''} title="Lên"
          style="background:none;border:none;cursor:pointer;color:var(--text-muted);padding:2px 4px">↑</button>
        <button type="button" onclick="moveAssessQuestion(${idx},1)" ${idx===_assessQuestions.length-1?'disabled':''} title="Xuống"
          style="background:none;border:none;cursor:pointer;color:var(--text-muted);padding:2px 4px">↓</button>
        <button type="button" onclick="removeAssessQuestion(${idx})"
          style="background:none;border:none;cursor:pointer;color:#ef4444;padding:2px 6px;font-size:14px">✕</button>
      </div>
      <textarea class="inp" rows="2" placeholder="Nội dung câu hỏi..." style="resize:vertical;padding:6px 8px;font-size:13px"
        oninput="assessQField(${idx},'content',this.value)">${escHtml(q.content||'')}</textarea>
      ${optionsHtml}
    </div>`;
  }).join('');
}

function assessQField(idx, field, val) {
  if (_assessQuestions[idx]) _assessQuestions[idx][field] = val;
}
function assessQOption(idx, oi, val) {
  if (_assessQuestions[idx] && _assessQuestions[idx].options) _assessQuestions[idx].options[oi] = val;
}
function addAssessOption(idx) {
  if (_assessQuestions[idx]) { _assessQuestions[idx].options.push(''); renderAssessQuestions(); }
}
function removeAssessOption(idx, oi) {
  if (!_assessQuestions[idx]) return;
  _assessQuestions[idx].options.splice(oi, 1);
  if (_assessQuestions[idx].correct >= _assessQuestions[idx].options.length)
    _assessQuestions[idx].correct = 0;
  renderAssessQuestions();
}

// ── Save assessment ────────────────────────────────
async function saveAssessment() {
  const msgEl = document.getElementById('am-msg');
  const type = document.getElementById('am-type').value;
  const title = document.getElementById('am-title').value.trim();
  if (!type) { msgEl.innerHTML = '<span style="color:#ef4444">Vui lòng chọn loại bài!</span>'; return; }
  if (!title) { msgEl.innerHTML = '<span style="color:#ef4444">Tiêu đề không được để trống!</span>'; return; }

  const id = document.getElementById('am-id').value;
  const body = {
    Title: title,
    AssessmentType: type,
    Description: document.getElementById('am-desc').value.trim() || null,
    CourseId: parseInt(document.getElementById('am-course').value) || null,
    ModuleId: parseInt(document.getElementById('am-module').value) || null,
    TimeLimitMinutes: parseInt(document.getElementById('am-timelimit').value) || null,
    MaxAttempts: parseInt(document.getElementById('am-maxattempts').value) || null,
    AvailableFrom: document.getElementById('am-availfrom').value || null,
    AvailableUntil: document.getElementById('am-availto').value || null,
    AccessCode: document.getElementById('am-accesscode').value.trim() || null,
    ShuffleQuestions: document.getElementById('am-shuffle').checked,
    IsPublished: document.getElementById('am-published').checked,
    Questions: JSON.stringify(_assessQuestions),
  };

  const btn = document.getElementById('am-save-btn');
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Đang lưu...';
  msgEl.textContent = '';

  try {
    showLoading('Đang lưu...');
    const url = id ? `/admin/assessments/${id}` : '/admin/assessments';
    const method = id ? 'PATCH' : 'POST';
    const r = await fetch(`${PROXY}${url}`, {
      method,
      headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    const data = (() => { try { return JSON.parse(text); } catch { return {}; } })();
    if (!r.ok) throw new Error(data.error || text || `HTTP ${r.status}`);
    showToast(id ? 'Đã cập nhật bài kiểm tra!' : 'Đã tạo bài kiểm tra!', 'success');
    closeAssessmentModal();
    await loadAssessments();
  } catch(e) {
    msgEl.innerHTML = `<span style="color:#ef4444">❌ ${e.message}</span>`;
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-save"></i> Lưu bài kiểm tra';
    hideLoading();
  }
}

// ── Delete assessment ──────────────────────────────
async function deleteAssessment(id) {
  if (!confirm(`Xoá bài kiểm tra #${id}?\nThao tác này sẽ xoá tất cả kết quả nộp bài liên quan.`)) return;
  try {
    showLoading('Đang xoá...');
    const r = await fetch(`${PROXY}/admin/assessments/${id}`, {
      method: 'DELETE',
      headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
    });
    if (!r.ok) { const d = await r.json().catch(()=>{}); throw new Error(d?.error || `HTTP ${r.status}`); }
    showToast('Đã xoá bài kiểm tra!', 'success');
    await loadAssessments();
    closeSubmissionsPanel();
  } catch(e) { showToast('Lỗi: ' + e.message, 'error'); } finally { hideLoading(); }
}

// ── Submissions panel ──────────────────────────────
async function loadSubmissionsPanel(assessId, title) {
  _activeAssessId = assessId;
  document.getElementById('asub-title').textContent = `Kết quả: ${title}`;
  document.getElementById('asub-sub').textContent = `Bài #${assessId}`;
  document.getElementById('assess-submissions-panel').style.display = '';
  document.getElementById('assess-logs-panel').style.display = 'none';
  const tb = document.getElementById('asub-table');
  tb.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:24px">Đang tải...</td></tr>';

  try {
    const r = await fetch(`${PROXY}/admin/assessments/${assessId}/submissions`, { headers: adminHeaders() });
    const data = await r.json();
    const list = data.list || [];
    if (!list.length) {
      tb.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--text-muted)">Chưa có lượt nộp nào</td></tr>';
      document.getElementById('astat-submissions').textContent = '0';
      return;
    }
    document.getElementById('astat-submissions').textContent = list.length;
    const pending = list.filter(s => s.Status === 'submitted' && s.Score == null).length;
    document.getElementById('astat-pending').textContent = pending;

    tb.innerHTML = list.map(s => {
      const statusBadge = s.Status === 'submitted'
        ? (s.Score != null
          ? `<span style="color:#16a34a;font-weight:600">✅ Đã chấm</span>`
          : `<span style="color:#ca8a04;font-weight:600">⏳ Chờ chấm</span>`)
        : `<span style="color:#64748b">Đang làm</span>`;
      const score = s.Score != null ? `<b>${s.Score}</b>/${s.MaxScore||'–'}` : '–';
      const correct = s.CorrectCount != null ? `${s.CorrectCount}/${s.TotalQuestions||'?'}` : '–';
      const startAt = s.StartTime ? new Date(s.StartTime).toLocaleString('vi-VN') : '–';
      const subAt = s.SubmittedAt ? new Date(s.SubmittedAt).toLocaleString('vi-VN') : '–';
      const userId = s.UserId || (s.IsAnonymous ? '<i>Ẩn danh</i>' : '–');
      return `<tr>
        <td style="font-size:13px">${userId}</td>
        <td style="text-align:center;font-size:13px">${score}</td>
        <td style="text-align:center;font-size:13px">${correct}</td>
        <td style="text-align:center;font-size:12px;color:var(--text-muted)">${startAt}</td>
        <td style="text-align:center;font-size:12px;color:var(--text-muted)">${subAt}</td>
        <td style="text-align:center">${statusBadge}</td>
        <td style="text-align:center">
          ${s.Status === 'submitted' && s.Score == null ? `
            <button class="btn btn-outline btn-sm" onclick="openGradeModal(${s.Id},'${userId}')" title="Chấm điểm">
              <i class="fas fa-pen"></i>
            </button>` : ''}
          <button class="btn btn-outline btn-sm" onclick="loadActionLogs(${s.Id},'${userId}')" title="Log hành vi" style="margin-left:4px">
            <i class="fas fa-shield-halved"></i>
          </button>
        </td>
      </tr>`;
    }).join('');
  } catch(e) {
    tb.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--danger)">${e.message}</td></tr>`;
  }

  // Scroll into view
  setTimeout(() => document.getElementById('assess-submissions-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
}

function closeSubmissionsPanel() {
  document.getElementById('assess-submissions-panel').style.display = 'none';
  document.getElementById('assess-logs-panel').style.display = 'none';
  _activeAssessId = null;
}

// ── Grade modal ────────────────────────────────────
function openGradeModal(subId, userName) {
  document.getElementById('gm-sub-id').value = subId;
  document.getElementById('gm-sub-info').textContent = `Học sinh: ${userName} · Submission #${subId}`;
  document.getElementById('gm-score').value = '';
  document.getElementById('gm-feedback').value = '';
  document.getElementById('gm-msg').textContent = '';
  document.getElementById('grade-modal').style.display = 'flex';
}

function closeGradeModal() {
  document.getElementById('grade-modal').style.display = 'none';
}

async function submitGrade() {
  const subId = document.getElementById('gm-sub-id').value;
  const score = parseFloat(document.getElementById('gm-score').value);
  const feedback = document.getElementById('gm-feedback').value.trim();
  const msgEl = document.getElementById('gm-msg');
  if (isNaN(score)) { msgEl.innerHTML = '<span style="color:#ef4444">Vui lòng nhập điểm số!</span>'; return; }

  try {
    showLoading('Đang lưu điểm...');
    const r = await fetch(`${PROXY}/admin/submissions/${subId}/grade`, {
      method: 'PATCH',
      headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ score, feedback }),
    });
    const text = await r.text();
    const data = (() => { try { return JSON.parse(text); } catch { return {}; } })();
    if (!r.ok) throw new Error(data.error || text);
    showToast('Đã lưu điểm!', 'success');
    closeGradeModal();
    if (_activeAssessId) {
      const titleEl = document.getElementById('asub-title');
      await loadSubmissionsPanel(_activeAssessId, titleEl.textContent.replace('Kết quả: ',''));
    }
  } catch(e) {
    msgEl.innerHTML = `<span style="color:#ef4444">${e.message}</span>`;
  } finally { hideLoading(); }
}

// ── Action logs ────────────────────────────────────
async function loadActionLogs(subId, userName) {
  document.getElementById('alog-sub').textContent = `Submission #${subId} · ${userName}`;
  document.getElementById('assess-logs-panel').style.display = '';
  const tb = document.getElementById('alog-table');
  tb.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:20px">Đang tải...</td></tr>';

  try {
    const r = await fetch(`${PROXY}/admin/assessments/${_activeAssessId}/action-logs?submissionId=${subId}`, {
      headers: adminHeaders(),
    });
    const data = await r.json();
    const list = data.list || [];
    if (!list.length) {
      tb.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:20px;color:var(--text-muted)">Không có log</td></tr>';
      return;
    }
    const EVENT_ICONS = {
      focus_lost: '👁️‍🗨️', focus_gained: '👀', answer_saved: '💾',
      submitted: '✅', started: '▶️',
    };
    tb.innerHTML = list.map(l => {
      const icon = EVENT_ICONS[l.EventType] || '📌';
      const ts = l.Timestamp ? new Date(l.Timestamp).toLocaleString('vi-VN') : '–';
      const meta = l.Metadata ? `<code style="font-size:11px;color:var(--text-muted)">${escHtml(l.Metadata)}</code>` : '–';
      return `<tr>
        <td>${icon} <span style="font-weight:600">${l.EventType||'–'}</span></td>
        <td style="font-size:12px;color:var(--text-muted)">${ts}</td>
        <td style="font-size:12px">${l.IpAddress||'–'}</td>
        <td>${meta}</td>
      </tr>`;
    }).join('');
  } catch(e) {
    tb.innerHTML = `<tr><td colspan="4" style="text-align:center;padding:20px;color:var(--danger)">${e.message}</td></tr>`;
  }

  setTimeout(() => document.getElementById('assess-logs-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
}

// ── CSV export ─────────────────────────────────────
async function exportAssessmentCSV() {
  if (!_activeAssessId) return;
  try {
    showLoading('Đang xuất CSV...');
    const r = await fetch(`${PROXY}/admin/assessments/${_activeAssessId}/export`, { headers: adminHeaders() });
    if (!r.ok) throw new Error('Không thể xuất CSV');
    const blob = await r.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `assessment_${_activeAssessId}_results.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    showToast('Đã xuất CSV!', 'success');
  } catch(e) { showToast('Lỗi: ' + e.message, 'error'); } finally { hideLoading(); }
}

// ── escHtml helper (if not defined elsewhere) ──────
if (typeof escHtml === 'undefined') {
  window.escHtml = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ═══════════════════════════════════════════════════════════════════
// AI AGENTS PANEL
// ═══════════════════════════════════════════════════════════════════

let _selectedContentAction = 'improve';
let _generatedQuestions = [];
let _coachHistory = [];

async function initAIAgentsPanel() {
  // Check AI connection
  try {
    const r = await fetch(`${PROXY}/api/health`, { headers: adminHeaders() });
    const dot = document.getElementById('ai-status-dot');
    const txt = document.getElementById('ai-status-text');
    if (r.ok) {
      dot.className = 'ai-status-dot ai-status-online';
      txt.textContent = 'Worker online — AI ready';
    }
  } catch {}

  // Populate course selector for analytics agent
  const sel = document.getElementById('analytics-course-sel');
  if (sel && _courses.length) {
    sel.innerHTML = '<option value="">-- Chọn khoá học --</option>' +
      _courses.map(c => `<option value="${c.Id}">${_esc(c.Title)}</option>`).join('');
  } else if (sel) {
    // Fetch courses if not cached
    try {
      const r = await fetch(`${PROXY}/admin/courses?limit=200&fields=Id,Title`, { headers: adminHeaders() });
      const data = await r.json();
      const courses = data.list || [];
      sel.innerHTML = '<option value="">-- Chọn khoá học --</option>' +
        courses.map(c => `<option value="${c.Id}">${_esc(c.Title)}</option>`).join('');
    } catch {}
  }
}

// ── 1. Curriculum Agent ──────────────────────────────────────────
async function runCurriculumAgent() {
  const prompt = document.getElementById('ca-prompt').value.trim();
  if (!prompt) { showToast('Nhập mô tả khoá học!', 'warn'); return; }

  const btn = document.querySelector('#agent-curriculum .ai-run-btn');
  setAgentLoading(btn, true);
  const resultEl = document.getElementById('ca-result');
  resultEl.style.display = 'none';

  try {
    const r = await fetch(`${PROXY}/ai/curriculum-agent`, {
      method: 'POST',
      headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, questionCount: parseInt(document.getElementById('ca-nodes').value) || 10 }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Lỗi AI');

    const dag = data.dag;
    if (!dag) throw new Error(data.raw || 'AI không trả về DAG hợp lệ');

    // Render DAG visually
    resultEl.style.display = '';
    resultEl.innerHTML = renderDAG(dag);
    showToast('Curriculum Agent đã tạo lộ trình!', 'success');
  } catch(e) {
    resultEl.style.display = '';
    resultEl.innerHTML = `<div class="ai-error"><i class="fas fa-exclamation-triangle"></i> ${e.message}</div>`;
    showToast('Lỗi: ' + e.message, 'error');
  } finally {
    setAgentLoading(btn, false);
  }
}

function renderDAG(dag) {
  const nodes = dag.nodes || [];
  const edges = dag.edges || [];
  const typeColors = { core: '#4F46E5', satellite: '#0891B2', remedial: '#DC2626' };

  let html = '<div class="dag-preview">';
  html += '<div class="dag-legend">';
  html += '<span class="dag-badge" style="background:#EEF2FF;color:#4F46E5">◉ Core</span>';
  html += '<span class="dag-badge" style="background:#ECFEFF;color:#0891B2">◉ Enrichment</span>';
  html += '<span class="dag-badge" style="background:#FEF2F2;color:#DC2626">◉ Remedial</span>';
  html += '</div>';
  html += '<div class="dag-nodes">';
  nodes.forEach((node, i) => {
    const color = typeColors[node.type] || '#64748B';
    const bg = { core:'#EEF2FF', satellite:'#ECFEFF', remedial:'#FEF2F2' }[node.type] || '#F8FAFC';
    html += `
      <div class="dag-node" style="border-color:${color};background:${bg}">
        <div class="dag-node-id" style="color:${color}">${node.id || `N${i+1}`}</div>
        <div class="dag-node-title">${_esc(node.title || '')}</div>
        <div class="dag-node-meta">
          ${node.estimatedMinutes ? `<span><i class="fas fa-clock"></i> ${node.estimatedMinutes}p</span>` : ''}
          ${node.type ? `<span class="dag-badge" style="background:${bg};color:${color};font-size:10px">${node.type}</span>` : ''}
        </div>
        ${node.learningObjectives?.length ? `<div class="dag-node-obj">${node.learningObjectives.slice(0,2).map(o => `<div>• ${_esc(o)}</div>`).join('')}</div>` : ''}
      </div>`;
  });
  html += '</div>';
  if (edges.length) {
    html += '<div class="dag-edges-title">Luồng học tập:</div>';
    html += '<div class="dag-edges">';
    edges.forEach(e => {
      const cond = { always: '→', score_above_80: '→ (>80%)', score_below_60: '→ (<60%)' }[e.condition] || '→';
      html += `<div class="dag-edge"><span class="dag-edge-from">${e.from}</span><span class="dag-edge-arrow">${cond}</span><span class="dag-edge-to">${e.to}</span></div>`;
    });
    html += '</div>';
  }
  html += '</div>';
  return html;
}

// ── 2. Assessment Agent ──────────────────────────────────────────
async function runAssessmentAgent() {
  const content = document.getElementById('aa-content').value.trim();
  if (!content) { showToast('Paste nội dung bài học!', 'warn'); return; }

  const btn = document.querySelector('#agent-assessment .ai-run-btn');
  setAgentLoading(btn, true);
  const resultEl = document.getElementById('aa-result');
  resultEl.style.display = 'none';
  _generatedQuestions = [];

  try {
    const r = await fetch(`${PROXY}/ai/assessment-agent`, {
      method: 'POST',
      headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content,
        questionCount: parseInt(document.getElementById('aa-count').value) || 5,
        difficulty: document.getElementById('aa-difficulty').value,
        types: ['mcq', 'truefalse'],
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Lỗi AI');

    _generatedQuestions = data.questions || [];
    if (!_generatedQuestions.length) throw new Error('AI không tạo được câu hỏi');

    resultEl.style.display = '';
    resultEl.innerHTML = renderGeneratedQuestions(_generatedQuestions);
    document.getElementById('aa-import-btn').style.display = '';
    showToast(`Đã tạo ${_generatedQuestions.length} câu hỏi!`, 'success');
  } catch(e) {
    resultEl.style.display = '';
    resultEl.innerHTML = `<div class="ai-error"><i class="fas fa-exclamation-triangle"></i> ${e.message}</div>`;
  } finally {
    setAgentLoading(btn, false);
  }
}

function renderGeneratedQuestions(questions) {
  const bloomLabels = ['', 'Nhớ', 'Hiểu', 'Vận dụng', 'Phân tích', 'Đánh giá', 'Sáng tạo'];
  const bloomColors = ['', '#64748b', '#0891b2', '#16a34a', '#7c3aed', '#d97706', '#dc2626'];
  let html = `<div class="ai-qs-header">
    <span>${questions.length} câu hỏi được tạo</span>
  </div>`;
  questions.forEach((q, i) => {
    const bloom = q.bloomsLevel || 1;
    html += `<div class="ai-q-item">
      <div class="ai-q-num">
        <span>Câu ${i+1}</span>
        <span class="bloom-badge" style="background:${bloomColors[bloom]}20;color:${bloomColors[bloom]}">
          Bloom ${bloom} — ${bloomLabels[bloom] || ''}
        </span>
      </div>
      <div class="ai-q-text">${_esc(q.question || '')}</div>
      ${q.options ? `<div class="ai-q-opts">${q.options.map((o,j) => `
        <div class="ai-q-opt ${o === q.correct || j === q.correct ? 'ai-q-opt-correct' : ''}">
          <span class="ai-q-opt-letter">${'ABCD'[j]}</span> ${_esc(String(o))}
          ${o === q.correct || j === q.correct ? '<i class="fas fa-check" style="color:#16a34a;margin-left:auto"></i>' : ''}
        </div>`).join('')}</div>` : ''}
      ${q.explanation ? `<div class="ai-q-explain"><i class="fas fa-lightbulb"></i> ${_esc(q.explanation)}</div>` : ''}
    </div>`;
  });
  return html;
}

async function importGeneratedQuestions() {
  if (!_generatedQuestions.length) return;
  const name = prompt('Tên ngân hàng câu hỏi mới:', 'AI Generated — ' + new Date().toLocaleDateString('vi-VN'));
  if (!name) return;
  try {
    showLoading('Đang tạo ngân hàng câu hỏi...');
    const r = await fetch(`${PROXY}/admin/question-banks`, {
      method: 'POST',
      headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ Title: name, Questions: JSON.stringify(_generatedQuestions), GroupName: 'AI Generated' }),
    });
    if (!r.ok) throw new Error(await r.text());
    showToast('Đã import vào ngân hàng câu hỏi!', 'success');
    _generatedQuestions = [];
    document.getElementById('aa-import-btn').style.display = 'none';
  } catch(e) {
    showToast('Lỗi: ' + e.message, 'error');
  } finally { hideLoading(); }
}

// ── 3. Coaching Agent (Socratic + Zero-draft) ──────────────────
function checkZeroDraft(textarea) {
  const words = textarea.value.trim().split(/\s+/).filter(w => w.length > 0).length;
  const count = Math.min(words, 50);
  document.getElementById('coach-word-count').textContent = words;
  document.getElementById('coach-draft-bar').style.width = (count / 50 * 100) + '%';

  const sendBtn = document.getElementById('coach-send-btn');
  const zdBar = document.getElementById('coach-zero-draft');
  if (words >= 50) {
    sendBtn.disabled = false;
    zdBar.style.display = 'none';
  } else {
    sendBtn.disabled = true;
    zdBar.style.display = 'flex';
    document.getElementById('coach-zd-msg').textContent =
      `Cần thêm ${50 - words} từ nữa để mở khoá AI Tutor`;
  }
}

async function runCoachingAgent() {
  const draft = document.getElementById('coach-draft').value.trim();
  if (!draft || draft.split(/\s+/).length < 50) {
    showToast('Viết đủ 50 từ trước khi gửi!', 'warn'); return;
  }

  const btn = document.getElementById('coach-send-btn');
  setAgentLoading(btn, true);

  try {
    const r = await fetch(`${PROXY}/ai/coaching-agent`, {
      method: 'POST',
      headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        studentMessage: draft,
        context: { lessonTitle: 'Preview mode', submissionDraft: draft, previousMessages: _coachHistory.slice(-6) },
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Lỗi AI');

    if (data.blocked) {
      showToast(data.message, 'warn'); return;
    }

    _coachHistory.push({ role: 'user', content: draft });
    _coachHistory.push({ role: 'assistant', content: data.response });

    const msgs = document.getElementById('coach-messages');
    msgs.innerHTML += `
      <div class="coach-msg coach-user"><div class="coach-bubble">${_esc(draft)}</div></div>
      <div class="coach-msg coach-ai">
        <div class="coach-avatar"><i class="fas fa-robot"></i></div>
        <div class="coach-bubble">${_esc(data.response)}</div>
      </div>`;
    msgs.scrollTop = msgs.scrollHeight;
    document.getElementById('coach-draft').value = '';
    document.getElementById('coach-draft-bar').style.width = '0%';
    document.getElementById('coach-word-count').textContent = '0';
    document.getElementById('coach-send-btn').disabled = true;
  } catch(e) {
    showToast('Lỗi: ' + e.message, 'error');
  } finally {
    setAgentLoading(btn, false);
  }
}

function clearCoachChat() {
  _coachHistory = [];
  document.getElementById('coach-messages').innerHTML = `
    <div class="ai-chat-welcome">
      <i class="fas fa-robot"></i><br>Chat đã được xoá. Bắt đầu cuộc trò chuyện mới!
    </div>`;
}

// ── 4. Analytics Agent ──────────────────────────────────────────
async function runAnalyticsAgent() {
  const courseId = document.getElementById('analytics-course-sel').value;
  if (!courseId) { showToast('Chọn khoá học để phân tích!', 'warn'); return; }

  const btn = document.querySelector('#agent-analytics .ai-run-btn');
  setAgentLoading(btn, true);
  const alertsEl = document.getElementById('analytics-alerts');
  const resultEl = document.getElementById('an-result');
  alertsEl.style.display = 'none';
  resultEl.style.display = 'none';

  try {
    const r = await fetch(`${PROXY}/ai/analytics-agent`, {
      method: 'POST',
      headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ courseId: parseInt(courseId) }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Lỗi AI');

    // Render alerts
    alertsEl.style.display = '';
    const alerts = data.alerts || [];
    const sevColor = { high: '#dc2626', medium: '#d97706', low: '#16a34a' };
    const sevBg = { high: '#fef2f2', medium: '#fffbeb', low: '#f0fdf4' };

    alertsEl.innerHTML = alerts.length
      ? alerts.map(a => `
          <div class="analytics-alert" style="border-color:${sevColor[a.severity]};background:${sevBg[a.severity]}">
            <div class="analytics-alert-hd">
              <span class="analytics-sev-dot" style="background:${sevColor[a.severity]}"></span>
              <strong>${_esc(a.type || 'Alert')}</strong>
              <span class="analytics-sev" style="color:${sevColor[a.severity]}">${a.severity?.toUpperCase()}</span>
            </div>
            <div class="analytics-alert-msg">${_esc(a.message || '')}</div>
            ${a.recommendation ? `<div class="analytics-alert-rec"><i class="fas fa-lightbulb"></i> ${_esc(a.recommendation)}</div>` : ''}
          </div>`).join('')
      : '<div style="color:var(--text-muted);padding:12px;text-align:center">Không có cảnh báo — học sinh đang tiến bộ tốt ✅</div>';

    // Summary
    if (data.summary) {
      resultEl.style.display = '';
      resultEl.innerHTML = `<div class="ai-summary-box">
        <strong><i class="fas fa-chart-bar"></i> Tóm tắt AI:</strong><br>${_esc(data.summary)}
        ${data.insights?.length ? `<ul>${data.insights.map(i => `<li>${_esc(i)}</li>`).join('')}</ul>` : ''}
      </div>`;
    }
    showToast(`Phân tích hoàn tất — ${alerts.length} cảnh báo`, alerts.filter(a=>a.severity==='high').length ? 'error' : 'success');
  } catch(e) {
    alertsEl.style.display = '';
    alertsEl.innerHTML = `<div class="ai-error"><i class="fas fa-exclamation-triangle"></i> ${e.message}</div>`;
  } finally {
    setAgentLoading(btn, false);
  }
}

// ── 5. Content Agent ──────────────────────────────────────────
function selectContentAction(btn) {
  document.querySelectorAll('.ai-action-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  _selectedContentAction = btn.dataset.action;
}

async function runContentAgent() {
  const content = document.getElementById('cont-input').value.trim();
  if (!content) { showToast('Nhập nội dung cần xử lý!', 'warn'); return; }

  const btn = document.querySelector('#agent-content .ai-run-btn');
  setAgentLoading(btn, true);
  const resultEl = document.getElementById('cont-result');
  resultEl.style.display = 'none';

  try {
    const r = await fetch(`${PROXY}/ai/content-agent`, {
      method: 'POST',
      headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, action: _selectedContentAction }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Lỗi AI');

    resultEl.style.display = '';
    const actionLabels = { improve:'Đã cải thiện', summarize:'Tóm tắt', translate:'Bản dịch', accessibility_check:'Kết quả kiểm tra' };
    resultEl.innerHTML = `
      <div class="ai-content-result">
        <div class="ai-content-result-hd">
          <strong>${actionLabels[_selectedContentAction] || 'Kết quả'}</strong>
          <button class="cv-row-action-btn" onclick="copyToClipboard('cont-result-text')" title="Sao chép">
            <i class="fas fa-copy"></i>
          </button>
        </div>
        <div id="cont-result-text" class="ai-content-result-body">${_esc(data.result || '')}</div>
        ${data.suggestions?.length ? `<div class="ai-content-suggestions">
          <strong><i class="fas fa-lightbulb"></i> Gợi ý:</strong>
          <ul>${data.suggestions.map(s => `<li>${_esc(s)}</li>`).join('')}</ul>
        </div>` : ''}
      </div>`;
    showToast('Content Agent hoàn tất!', 'success');
  } catch(e) {
    resultEl.style.display = '';
    resultEl.innerHTML = `<div class="ai-error"><i class="fas fa-exclamation-triangle"></i> ${e.message}</div>`;
  } finally {
    setAgentLoading(btn, false);
  }
}

function copyToClipboard(id) {
  const el = document.getElementById(id);
  if (!el) return;
  navigator.clipboard.writeText(el.textContent).then(() => showToast('Đã sao chép!', 'success'));
}

// ══════════════════════════════════════════════════════════════════════
// PHASE 1 — SCHEMA SETUP & SEED
// ══════════════════════════════════════════════════════════════════════

async function runSetupPhase1() {
  const btn = document.getElementById('btn-setup-phase1');
  const res = document.getElementById('setup-phase1-result');
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Đang tạo bảng...';
  res.style.display = 'none';
  try {
    const r = await apiFetch('/admin/setup/schema-phase1', 'POST', {});
    const data = await r.json();
    if (r.ok) {
      res.style.cssText = 'display:block;padding:12px 16px;border-radius:8px;font-size:13px;background:#eff6ff;border:1px solid #bfdbfe;color:#1d4ed8';
      const tables = Object.entries(data.results || {}).map(([t, v]) =>
        `<div style="margin-top:6px"><b>${t}</b>: ${v.status}${v.table_id ? ` — ID: <code>${v.table_id}</code>` : ''}${v.note ? `<br><span style="color:#64748b;font-size:12px">${v.note}</span>` : ''}</div>`
      ).join('');
      res.innerHTML = `<i class="fas fa-check-circle"></i> <b>${data.message}</b>${tables}`;
      btn.innerHTML = '<i class="fas fa-check"></i> Đã tạo';
      btn.style.background = '#16a34a';
      showToast('✅ Phase 1 schema created', 'success');
    } else {
      throw new Error(data.error || 'Lỗi không xác định');
    }
  } catch(e) {
    res.style.cssText = 'display:block;padding:12px 16px;border-radius:8px;font-size:13px;background:#fef2f2;border:1px solid #fca5a5;color:#dc2626';
    res.innerHTML = `<i class="fas fa-times-circle"></i> Lỗi: ${e.message}`;
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-database"></i> Thử lại';
  }
}

async function runSeedOutcomes() {
  const btn = document.getElementById('btn-seed-outcomes');
  const res = document.getElementById('seed-outcomes-result');
  if (!confirm('Seed sẽ thêm ~40 chuẩn đầu ra mẫu vào bảng Outcomes. Tiếp tục?')) return;
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Đang seed...';
  res.style.display = 'none';
  try {
    const r = await apiFetch('/admin/setup/seed-outcomes', 'POST', {});
    const data = await r.json();
    if (r.ok) {
      res.style.cssText = 'display:block;padding:12px 16px;border-radius:8px;font-size:13px;background:#f0fdf4;border:1px solid #bbf7d0;color:#15803d';
      res.innerHTML = `<i class="fas fa-seedling"></i> <b>${data.message}</b><br>
        <span style="color:#64748b;font-size:12px">${(data.next_steps||[]).map(s=>`• ${s}`).join('<br>')}</span>`;
      btn.innerHTML = '<i class="fas fa-check"></i> Đã seed';
      btn.style.background = '#16a34a';
      showToast(`✅ Seeded ${data.total_seeded} outcomes`, 'success');
    } else {
      throw new Error(data.error || 'Lỗi không xác định');
    }
  } catch(e) {
    res.style.cssText = 'display:block;padding:12px 16px;border-radius:8px;font-size:13px;background:#fef2f2;border:1px solid #fca5a5;color:#dc2626';
    res.innerHTML = `<i class="fas fa-times-circle"></i> Lỗi: ${e.message}`;
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-seedling"></i> Thử lại';
  }
}

// ══════════════════════════════════════════════════════════════════════
// OUTCOMES PANEL
// ══════════════════════════════════════════════════════════════════════

async function loadOutcomes() {
  const subject = document.getElementById('outcomes-filter-subject')?.value || '';
  const grade   = document.getElementById('outcomes-filter-grade')?.value   || '';
  const tbody   = document.getElementById('outcomes-tbody');
  const stats   = document.getElementById('outcomes-stats');
  if (!tbody) return;

  tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:24px"><i class="fas fa-spinner fa-spin"></i> Đang tải...</td></tr>';

  try {
    let qs = '?limit=500';
    if (subject) qs += `&subject=${encodeURIComponent(subject)}`;
    if (grade)   qs += `&grade=${encodeURIComponent(grade)}`;
    const r = await apiFetch(`/api/outcomes${qs}`, 'GET');
    const data = await r.json();

    if (!r.ok) throw new Error(data.error || data.note || 'Lỗi tải outcomes');

    const outcomes = data.outcomes || [];
    if (outcomes.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:32px;color:var(--text-muted)">
        Chưa có dữ liệu. <b>Vào Cài đặt → Seed Outcomes</b> để nhập CT GDPT 2018.
      </td></tr>`;
      stats.innerHTML = '';
      return;
    }

    // Stats strip
    const bySubject = {};
    for (const o of outcomes) bySubject[o.Subject||'?'] = (bySubject[o.Subject||'?']||0)+1;
    stats.innerHTML = Object.entries(bySubject).map(([s,c]) =>
      `<div style="padding:6px 14px;background:#eff6ff;border-radius:20px;font-size:13px;color:#1d4ed8;font-weight:500">${s}: ${c}</div>`
    ).join('') + `<div style="padding:6px 14px;background:#f1f5f9;border-radius:20px;font-size:13px;color:#475569">Tổng: ${outcomes.length}</div>`;

    // Colour-code level
    const levelBadge = l => {
      const cfg = {1:['#eff6ff','#2563eb'], 2:['#f0fdf4','#16a34a'], 3:['#fefce8','#ca8a04'], 4:['#fdf4ff','#9333ea']};
      const [bg, fg] = cfg[l] || ['#f1f5f9','#475569'];
      return `<span style="background:${bg};color:${fg};padding:2px 8px;border-radius:10px;font-size:11.5px;font-weight:600">Cấp ${l}</span>`;
    };

    tbody.innerHTML = outcomes.map(o => `
      <tr>
        <td><code style="font-size:12px;color:#7c3aed">${o.Code||''}</code></td>
        <td><span style="font-weight:600;color:#1e3a5f">${o.Subject||''}</span></td>
        <td style="color:var(--text-muted)">${o.Grade||''}</td>
        <td style="font-size:13px">${o.TitleVi||o.title_vi||''}</td>
        <td>${levelBadge(o.Level||o.level||1)}</td>
        <td style="text-align:center;color:var(--text-muted)">${o.EstimatedHours||o.estimated_hours||'—'}</td>
        <td>
          <button class="btn-icon" title="Xem chi tiết" onclick="viewOutcomeDetail(${o.Id||o.id})">
            <i class="fas fa-eye"></i>
          </button>
        </td>
      </tr>`).join('');

  } catch(e) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:24px;color:#dc2626">
      <i class="fas fa-exclamation-triangle"></i> ${e.message}
      <br><small style="color:var(--text-muted)">Bảng chưa được khởi tạo? Vào <b>Cài đặt → Phase 1</b></small>
    </td></tr>`;
  }
}

function viewOutcomeDetail(id) {
  showToast(`Outcome ID ${id} — chi tiết sẽ có trong Phase 2 UI`, 'info');
}

function showAddOutcomeModal() {
  showToast('Tính năng thêm chuẩn thủ công — coming soon. Dùng NocoDB UI hoặc POST /api/outcomes', 'info');
}

// ══════════════════════════════════════════════════════════════════════
// RESEARCH AGENT (agentic loop)
// ══════════════════════════════════════════════════════════════════════

async function runResearchAgent() {
  const btn       = document.getElementById('btn-run-agent');
  const resultDiv = document.getElementById('ra-result');
  const studentId = document.getElementById('ra-student-id')?.value?.trim();
  const courseId  = document.getElementById('ra-course-id')?.value?.trim();
  const mode      = document.getElementById('ra-mode')?.value || 'diagnose';
  const task      = document.getElementById('ra-task')?.value?.trim();

  if (!task) { showToast('Nhập task/câu hỏi nghiên cứu', 'error'); return; }

  btn.disabled = true;
  btn._orig = btn.innerHTML;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Agent đang chạy...';
  resultDiv.style.display = 'none';

  const context = {};
  if (studentId) context.student_id = studentId;
  if (courseId)  context.course_id  = courseId;

  try {
    const r = await apiFetch('/ai/research-agent', 'POST', {
      mode, task, context, return_trace: true,
    });
    const data = await r.json();

    if (!r.ok) throw new Error(data.error || 'Agent thất bại');

    const stats  = data.agent_stats || {};
    const result = typeof data.result === 'object'
      ? JSON.stringify(data.result, null, 2)
      : (data.result || '(Không có kết quả)');

    // Build trace summary
    const traceHtml = (data.trace || []).map((t, i) => {
      if (t.type === 'tool_call') {
        const ok = t.ok !== false;
        return `<div style="margin:4px 0;padding:6px 10px;background:${ok?'#f0fdf4':'#fef2f2'};border-radius:6px;font-size:12px">
          <span style="color:${ok?'#16a34a':'#dc2626'}">⚙ <b>${t.tool}</b></span>
          <span style="color:#94a3b8;margin-left:8px">${t.duration_ms||0}ms</span>
        </div>`;
      }
      if (t.type === 'reasoning') {
        const short = (t.text||'').slice(0, 120);
        return `<div style="margin:4px 0;padding:6px 10px;background:#f8fafc;border-radius:6px;font-size:12px;color:#475569">
          💭 ${short}${t.text?.length > 120 ? '…' : ''}
        </div>`;
      }
      return '';
    }).join('');

    resultDiv.style.display = 'block';
    resultDiv.innerHTML = `
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px">
        <span style="padding:3px 10px;background:#eff6ff;border-radius:12px;font-size:12px;color:#2563eb">
          <i class="fas fa-repeat"></i> ${data.iterations} vòng lặp
        </span>
        <span style="padding:3px 10px;background:#f0fdf4;border-radius:12px;font-size:12px;color:#16a34a">
          <i class="fas fa-wrench"></i> ${stats.tool_calls_made||0} tool calls
        </span>
        <span style="padding:3px 10px;background:#fdf4ff;border-radius:12px;font-size:12px;color:#9333ea">
          <i class="fas fa-coins"></i> ${data.token_usage?.total||0} tokens
        </span>
        ${stats.hit_iteration_cap ? '<span style="padding:3px 10px;background:#fef9c3;border-radius:12px;font-size:12px;color:#ca8a04">⚠ Đã đạt giới hạn vòng lặp</span>' : ''}
      </div>
      ${traceHtml ? `<div style="margin-bottom:12px"><b style="font-size:12px;color:#64748b">REASONING TRACE:</b>${traceHtml}</div>` : ''}
      <div style="border-top:1px solid #e2e8f0;padding-top:10px">
        <b style="font-size:12px;color:#1e3a5f">KẾT QUẢ:</b>
        <pre style="margin:8px 0 0;font-size:12px;white-space:pre-wrap;color:#1e293b;font-family:monospace">${result}</pre>
      </div>`;

    showToast('✅ Research Agent hoàn thành', 'success');
  } catch(e) {
    resultDiv.style.display = 'block';
    resultDiv.innerHTML = `<span style="color:#dc2626"><i class="fas fa-times-circle"></i> ${e.message}</span>`;
    showToast('❌ ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = btn._orig;
  }
}

// ── Helpers ───────────────────────────────────────────────────
function setAgentLoading(btn, loading) {
  if (!btn) return;
  btn.disabled = loading;
  if (loading) {
    btn._orig = btn.innerHTML;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Đang chạy AI...';
  } else {
    btn.innerHTML = btn._orig || btn.innerHTML;
  }
}

// ══════════════════════════════════════════════════════════
// ADMIN STATS — Real-time system stats from /admin/stats
// ══════════════════════════════════════════════════════════
async function loadAdminStats() {
  const section = document.getElementById('admin-sys-stats');
  if (!section) return;
  try {
    const r = await fetch(`${PROXY}/admin/stats`, { headers: adminHeaders() });
    if (!r.ok) return;
    const d = await r.json();
    const _s = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val ?? '—'; };
    _s('rs-submissions', d.submissions_today ?? d.total_submissions ?? '—');
    _s('rs-ai-queries', d.ai_queries_today ?? d.ai_queries ?? '—');
    _s('rs-active-courses', d.active_courses ?? d.total_courses ?? '—');
    _s('rs-total-users', d.total_users ?? '—');
    section.style.display = 'block';
  } catch { /* fail silently */ }
}

// ══════════════════════════════════════════════════════════
// GOOGLE DRIVE SETTINGS
// ══════════════════════════════════════════════════════════
async function loadDriveSettings() {
  const card  = document.getElementById('drive-status-card');
  const input = document.getElementById('drive-folder-input');
  const link  = document.getElementById('drive-folder-link');
  if (!card) return;

  card.style.borderLeftColor = '#ccc';
  card.innerHTML = '<i class="fas fa-spinner fa-spin" style="color:var(--text-muted)"></i> Đang kiểm tra cấu hình Drive...';

  try {
    const r = await fetch(`${PROXY}/admin/settings/drive`, { headers: adminHeaders() });
    const d = await r.json();

    const folderId   = d.folder_id   || '';
    const folderName = d.folder_name || '';
    const source     = d.source      || '';
    const hasSA      = d.has_service_account;
    const hasDynamic = d.has_dynamic_settings;

    if (!hasSA) {
      card.style.borderLeftColor = 'var(--danger)';
      card.innerHTML = `<i class="fas fa-times-circle" style="color:var(--danger)"></i>
        <b style="color:var(--danger)"> Chưa cấu hình GDRIVE_SA_JSON</b><br>
        <span style="color:var(--text-muted);font-size:12px;">Thêm Service Account JSON vào Cloudflare Worker Secrets → deploy lại.</span>`;
    } else if (!folderId) {
      card.style.borderLeftColor = '#F59E0B';
      card.innerHTML = `<i class="fas fa-exclamation-triangle" style="color:#F59E0B"></i>
        <b style="color:#D97706"> Service Account OK — Chưa chọn thư mục lưu trữ</b><br>
        <span style="color:var(--text-muted);font-size:12px;">File sẽ upload vào thư mục gốc Drive. Nên cấu hình thư mục cụ thể bên dưới.</span>`;
    } else {
      card.style.borderLeftColor = '#1FA463';
      card.innerHTML = `<i class="fab fa-google-drive" style="color:#1FA463"></i>
        <b style="color:#1FA463"> Đã cấu hình</b>${folderName ? ' — ' + escHtml(folderName) : ''}<br>
        <span style="font-size:11px;color:var(--text-muted);">
          ID: <code style="background:var(--card);padding:1px 6px;border-radius:4px;">${escHtml(folderId)}</code>
          &nbsp;·&nbsp;Nguồn: ${escHtml(source)}
          ${!hasDynamic ? '&nbsp;·&nbsp;<span style="color:#F59E0B;">⚠️ NOCO_SETTINGS chưa set</span>' : ''}
        </span>`;
    }

    if (folderId) {
      if (input && !input.value) input.value = folderId;
      if (link) { link.href = `https://drive.google.com/drive/folders/${folderId}`; link.style.display = ''; }
    }
  } catch(e) {
    card.style.borderLeftColor = 'var(--danger)';
    card.innerHTML = `<i class="fas fa-times-circle" style="color:var(--danger)"></i> Không thể kiểm tra: ${escHtml(e.message)}`;
  }
}

async function saveDriveFolder() {
  const input    = document.getElementById('drive-folder-input');
  const resultEl = document.getElementById('drive-action-result');
  const btn      = document.getElementById('btn-save-drive');
  const raw      = input?.value?.trim();

  if (!raw) { showToast('Vui lòng nhập URL hoặc Folder ID', 'error'); return; }
  btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Đang lưu...';
  resultEl.style.display = 'none';

  try {
    const r = await fetch(`${PROXY}/admin/settings/drive`, {
      method:  'PATCH',
      headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
      body:    JSON.stringify({ folder_id: raw }),
    });
    const d = await r.json();

    if (!r.ok || d.ok === false) {
      resultEl.style.cssText = 'display:block;background:#FEF2F2;border:1px solid #FECACA;color:#DC2626;padding:10px 14px;border-radius:8px;font-size:13px;margin-bottom:12px;';
      resultEl.innerHTML = `<i class="fas fa-times-circle"></i> ${escHtml(d.error || 'Lỗi lưu cài đặt')}`;
      if (d.instructions) {
        resultEl.innerHTML += '<ol style="margin:8px 0 0 18px;line-height:1.8;">' +
          d.instructions.map(s => `<li>${escHtml(s)}</li>`).join('') + '</ol>';
      }
    } else {
      resultEl.style.cssText = 'display:block;background:#F0FDF4;border:1px solid #BBF7D0;color:#16A34A;padding:10px 14px;border-radius:8px;font-size:13px;margin-bottom:12px;';
      resultEl.innerHTML = `<i class="fab fa-google-drive"></i> ${escHtml(d.message || 'Đã lưu!')}`;
      const link = document.getElementById('drive-folder-link');
      if (link && d.folder_url) { link.href = d.folder_url; link.style.display = ''; }
      showToast('✅ Đã lưu cấu hình Google Drive', 'success');
      loadDriveSettings();
    }
  } catch(e) {
    resultEl.style.cssText = 'display:block;background:#FEF2F2;border:1px solid #FECACA;color:#DC2626;padding:10px 14px;border-radius:8px;font-size:13px;margin-bottom:12px;';
    resultEl.innerHTML = `Lỗi kết nối: ${escHtml(e.message)}`;
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-save"></i> Lưu';
  }
}

async function testDriveConnection() {
  const input    = document.getElementById('drive-folder-input');
  const resultEl = document.getElementById('drive-action-result');
  const btn      = document.getElementById('btn-test-drive');
  const raw      = input?.value?.trim() || '';

  btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Đang kiểm tra...';
  resultEl.style.display = 'none';

  try {
    const r = await fetch(`${PROXY}/admin/settings/drive/test`, {
      method:  'POST',
      headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
      body:    JSON.stringify({ folder_id: raw }),
    });
    const d = await r.json();

    if (d.ok) {
      resultEl.style.cssText = 'display:block;background:#F0FDF4;border:1px solid #BBF7D0;color:#16A34A;padding:10px 14px;border-radius:8px;font-size:13px;margin-bottom:12px;';
      resultEl.innerHTML = `<i class="fas fa-check-circle"></i> ${escHtml(d.message || 'Kết nối thành công!')}`;
      showToast('✅ ' + (d.message || 'Google Drive OK'), 'success');
    } else {
      resultEl.style.cssText = 'display:block;background:#FEF2F2;border:1px solid #FECACA;color:#DC2626;padding:10px 14px;border-radius:8px;font-size:13px;margin-bottom:12px;';
      resultEl.innerHTML = `<i class="fas fa-times-circle"></i> ${escHtml(d.error || 'Kiểm tra thất bại')}`;
      if (d.hint) resultEl.innerHTML += `<br><span style="font-size:12px;color:var(--text-muted);margin-top:4px;display:block;">💡 ${escHtml(d.hint)}</span>`;
    }
  } catch(e) {
    resultEl.style.cssText = 'display:block;background:#FEF2F2;border:1px solid #FECACA;color:#DC2626;padding:10px 14px;border-radius:8px;font-size:13px;margin-bottom:12px;';
    resultEl.innerHTML = `Lỗi kết nối: ${escHtml(e.message)}`;
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-plug"></i> Kiểm tra kết nối';
  }
}
