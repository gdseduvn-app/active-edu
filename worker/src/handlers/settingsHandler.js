/**
 * Settings Handler — Dynamic system configuration via NocoDB
 *
 * GET  /admin/settings              — get all settings
 * GET  /admin/settings/drive        — get Google Drive config
 * PATCH /admin/settings/drive       — update Google Drive folder
 * POST /admin/settings/drive/test   — test Drive connection + folder access
 *
 * NocoDB table: env.NOCO_SETTINGS
 *   Fields: Id, Key (string, unique), Value (text), UpdatedAt
 *
 * Fallback: if NOCO_SETTINGS not configured, reads from env variables.
 *
 * Drive Folder ID sources (priority order):
 *   1. NocoDB Settings table (dynamic, set via admin UI)
 *   2. env.GDRIVE_FOLDER_ID (Cloudflare Worker Secret — static)
 *   3. Empty string (upload to Drive root)
 */
import { verifyAdminAuth } from '../auth.js';
import { nocoFetch } from '../db.js';
import { getServiceAccountToken } from '../drive.js';

// ── Helper: read a single setting from NocoDB ─────────────────
export async function getSettingValue(env, key) {
  if (!env.NOCO_SETTINGS) return null;
  try {
    const r = await nocoFetch(env,
      `/api/v2/tables/${env.NOCO_SETTINGS}/records?where=${encodeURIComponent(`(Key,eq,${key})`)}&limit=1`
    );
    if (!r.ok) return null;
    const d = await r.json();
    return (d.list || [])[0]?.Value ?? null;
  } catch {
    return null;
  }
}

// ── Helper: upsert a setting ──────────────────────────────────
async function upsertSetting(env, key, value) {
  if (!env.NOCO_SETTINGS) throw new Error('NOCO_SETTINGS chưa được cấu hình');

  // Check if exists
  const r = await nocoFetch(env,
    `/api/v2/tables/${env.NOCO_SETTINGS}/records?where=${encodeURIComponent(`(Key,eq,${key})`)}&limit=1`
  );
  const existing = r.ok ? ((await r.json()).list || [])[0] : null;

  const payload = { Key: key, Value: String(value), UpdatedAt: new Date().toISOString() };

  if (existing?.Id) {
    // Update
    const u = await nocoFetch(env, `/api/v2/tables/${env.NOCO_SETTINGS}/records/${existing.Id}`, 'PATCH', payload);
    if (!u.ok) throw new Error('Không thể cập nhật setting');
  } else {
    // Insert
    const i = await nocoFetch(env, `/api/v2/tables/${env.NOCO_SETTINGS}/records`, 'POST', payload);
    if (!i.ok) throw new Error('Không thể tạo setting');
  }
}

// ── Parse folder ID from Drive URL or raw ID ──────────────────
export function parseFolderId(input) {
  if (!input) return '';
  // URL pattern: https://drive.google.com/drive/folders/FOLDER_ID
  // URL pattern: https://drive.google.com/drive/u/0/folders/FOLDER_ID
  const m = input.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  // Already a raw ID (alphanumeric 10-50 chars)
  if (/^[a-zA-Z0-9_-]{10,60}$/.test(input.trim())) return input.trim();
  return '';
}

// ── GET /admin/settings ──────────────────────────���────────────
export async function handleGetSettings(request, env, { json }) {
  const auth = await verifyAdminAuth(request, env);
  if (!auth.ok) return json({ error: 'Unauthorized' }, 401);

  const hasDynamicSettings = !!env.NOCO_SETTINGS;

  // Drive config
  const dynamicFolderId = await getSettingValue(env, 'gdrive_folder_id');
  const folderIdSource = dynamicFolderId
    ? 'noco_settings'
    : (env.GDRIVE_FOLDER_ID ? 'env_variable' : 'none');

  return json({
    drive: {
      folder_id:   dynamicFolderId || env.GDRIVE_FOLDER_ID || '',
      folder_source: folderIdSource,
      has_service_account: !!env.GDRIVE_SA_JSON,
      has_dynamic_settings: hasDynamicSettings,
    },
    system: {
      noco_settings_configured: hasDynamicSettings,
    }
  });
}

// ── GET /admin/settings/drive ─────────────────────────────────
export async function handleGetDriveSettings(request, env, { json }) {
  const auth = await verifyAdminAuth(request, env);
  if (!auth.ok) return json({ error: 'Unauthorized' }, 401);

  const dynamicFolderId = await getSettingValue(env, 'gdrive_folder_id');
  const activeFolderId  = dynamicFolderId || env.GDRIVE_FOLDER_ID || '';
  const source = dynamicFolderId ? 'Cài đặt động (NocoDB)' : env.GDRIVE_FOLDER_ID ? 'Biến môi trường Worker' : 'Chưa cấu hình';

  let folderName = null;
  if (activeFolderId && env.GDRIVE_SA_JSON) {
    try {
      const token = await getServiceAccountToken(env);
      const r = await fetch(`https://www.googleapis.com/drive/v3/files/${activeFolderId}?fields=name,id,webViewLink`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (r.ok) {
        const f = await r.json();
        folderName = f.name || null;
      }
    } catch { /* ignore */ }
  }

  return json({
    folder_id:   activeFolderId,
    folder_name: folderName,
    folder_url:  activeFolderId ? `https://drive.google.com/drive/folders/${activeFolderId}` : null,
    source,
    has_service_account: !!env.GDRIVE_SA_JSON,
    has_dynamic_settings: !!env.NOCO_SETTINGS,
  });
}

// ── PATCH /admin/settings/drive ───────────────────────────────
export async function handleUpdateDriveSettings(request, env, { json }) {
  const auth = await verifyAdminAuth(request, env);
  if (!auth.ok) return json({ error: 'Unauthorized' }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'JSON không hợp lệ' }, 400); }

  const rawInput  = body.folder_id || body.folder_url || '';
  const folderId  = parseFolderId(rawInput);

  if (!folderId) return json({ error: 'Folder ID không hợp lệ. Nhập URL thư mục Drive hoặc ID trực tiếp.' }, 400);

  if (!env.NOCO_SETTINGS) {
    // No dynamic storage — give instructions
    return json({
      ok: false,
      error: 'NOCO_SETTINGS chưa được cấu hình.',
      instructions: [
        '1. Tạo bảng "Settings" trong NocoDB với các cột: Key (Text), Value (Long Text), UpdatedAt (DateTime)',
        '2. Copy Table ID của bảng Settings',
        '3. Vào Cloudflare Dashboard → Workers → activeedu-proxy → Settings → Environment Variables',
        '4. Thêm biến NOCO_SETTINGS = <Table ID>',
        '5. Deploy lại Worker, sau đó thử lại',
        `Tạm thời: Set GDRIVE_FOLDER_ID = ${folderId} trong Worker Secrets để dùng ngay`,
      ]
    }, 503);
  }

  try {
    await upsertSetting(env, 'gdrive_folder_id', folderId);
  } catch (e) {
    return json({ error: e.message }, 500);
  }

  // Resolve folder name
  let folderName = null;
  if (env.GDRIVE_SA_JSON) {
    try {
      const token = await getServiceAccountToken(env);
      const r = await fetch(`https://www.googleapis.com/drive/v3/files/${folderId}?fields=name,id`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (r.ok) folderName = (await r.json()).name || null;
    } catch { /* ignore */ }
  }

  return json({
    ok: true,
    folder_id: folderId,
    folder_name: folderName,
    folder_url: `https://drive.google.com/drive/folders/${folderId}`,
    message: `Đã lưu thư mục Google Drive${folderName ? ': ' + folderName : ''}`,
  });
}

// ── POST /admin/settings/drive/test ──────────────────────────
export async function handleTestDriveSettings(request, env, { json }) {
  const auth = await verifyAdminAuth(request, env);
  if (!auth.ok) return json({ error: 'Unauthorized' }, 401);

  let body = {};
  try { body = await request.json(); } catch {}

  if (!env.GDRIVE_SA_JSON) {
    return json({ ok: false, error: 'Chưa cấu hình GDRIVE_SA_JSON trong Worker Secrets' });
  }

  // Get folder ID to test (from request or from current settings)
  const rawInput = body.folder_id || body.folder_url || '';
  let folderId = rawInput ? parseFolderId(rawInput) : null;
  if (!folderId) folderId = await getSettingValue(env, 'gdrive_folder_id') || env.GDRIVE_FOLDER_ID || '';

  try {
    // 1. Test token generation
    const token = await getServiceAccountToken(env);

    // 2. Test Drive API access — list root or folder
    let folderInfo = null;
    if (folderId) {
      const r = await fetch(
        `https://www.googleapis.com/drive/v3/files/${folderId}?fields=id,name,mimeType,capabilities`,
        { headers: { 'Authorization': `Bearer ${token}` } }
      );
      if (!r.ok) {
        const err = await r.json();
        return json({
          ok: false,
          error: `Không thể truy cập thư mục: ${err.error?.message || r.status}`,
          hint: 'Service account cần được cấp quyền "Editor" trên thư mục Drive này',
        });
      }
      folderInfo = await r.json();

      // 3. Check write permission
      if (folderInfo.capabilities && folderInfo.capabilities.canAddChildren === false) {
        return json({
          ok: false,
          folder_name: folderInfo.name,
          error: 'Service account không có quyền ghi vào thư mục này',
          hint: 'Chia sẻ thư mục Drive với email service account và cấp quyền "Editor"',
        });
      }
    }

    return json({
      ok: true,
      folder_id: folderId || '(root)',
      folder_name: folderInfo?.name || 'Drive root',
      folder_url: folderId ? `https://drive.google.com/drive/folders/${folderId}` : null,
      message: '✅ Kết nối Google Drive thành công' + (folderInfo ? ` — Thư mục: ${folderInfo.name}` : ''),
    });

  } catch (e) {
    return json({ ok: false, error: e.message });
  }
}
