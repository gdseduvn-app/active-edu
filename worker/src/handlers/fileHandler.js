/**
 * File Handler — Course file management via Google Drive
 *
 * GET    /api/files?course_id=X&folder=path    — list files (paginated)
 * POST   /api/files/upload                      — upload file to Drive + save metadata
 * GET    /api/files/:id                         — get file detail + download URL
 * DELETE /api/files/:id                         — soft delete (teacher/admin)
 * GET    /api/files/folders?course_id=X         — list folder tree
 *
 * Reuses: worker/src/drive.js (getServiceAccountToken, uploadToDrive)
 *
 * NocoDB table required:
 *   env.NOCO_FILES — Files
 *     Fields: Id, CourseId, UploadedBy, Name, MimeType, Size,
 *             DriveId, DriveUrl, FolderPath, IsDeleted, CreatedAt
 *
 * Upload flow:
 *   1. Client sends multipart/form-data with file + metadata
 *   2. Worker reads binary, uploads to Google Drive
 *   3. Worker saves metadata to NocoDB
 *   4. Returns DriveUrl for direct download
 *
 * File size limits (Cloudflare Workers):
 *   - Max request body: 100 MB (Worker limit)
 *   - Recommended: enforce 50 MB in handler
 */
import { getTokenSecret, verifyToken } from '../auth.js';
import { nocoFetch } from '../db.js';
import { getServiceAccountToken } from '../drive.js';
import { getSettingValue } from './settingsHandler.js';

// ── Get effective Drive folder ID (dynamic setting > env var) ─
async function getDriveFolderId(env) {
  const dynamic = await getSettingValue(env, 'gdrive_folder_id');
  return dynamic || env.GDRIVE_FOLDER_ID || '';
}

async function getSession(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace('Bearer ', '');
  if (!token) return null;
  return verifyToken(token, getTokenSecret(env));
}

function isTeacherOrAdmin(role) {
  return role === 'admin' || role === 'teacher';
}

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/csv',
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'video/mp4',
  'video/webm',
  'audio/mpeg',
  'audio/ogg',
  'application/zip',
]);

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

// ── GET /api/files?course_id=X ───────────────────────────────
export async function handleListFiles(request, env, { json, url }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  if (!env.NOCO_FILES) return json({ files: [], total: 0 });

  const courseId = url.searchParams.get('course_id');
  const folder = url.searchParams.get('folder') || '';
  const page = parseInt(url.searchParams.get('page') || '1');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '30'), 100);
  const offset = (page - 1) * limit;

  let where = `(IsDeleted,eq,false)`;
  if (courseId) where += `~and(CourseId,eq,${courseId})`;
  if (folder) where += `~and(FolderPath,eq,${folder})`;

  const r = await nocoFetch(env,
    `/api/v2/tables/${env.NOCO_FILES}/records?where=${encodeURIComponent(where)}&limit=${limit}&offset=${offset}&sort=-CreatedAt`
  );
  if (!r.ok) return json({ files: [], total: 0 });

  const data = await r.json();
  return json({
    files: data.list || [],
    total: data.pageInfo?.totalRows ?? (data.list || []).length,
    page,
    limit,
  });
}

// ── GET /api/files/folders?course_id=X ──────────────────────
export async function handleListFolders(request, env, { json, url }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  if (!env.NOCO_FILES) return json({ folders: [] });

  const courseId = url.searchParams.get('course_id');
  if (!courseId) return json({ folders: [] });

  const r = await nocoFetch(env,
    `/api/v2/tables/${env.NOCO_FILES}/records?where=${encodeURIComponent(`(CourseId,eq,${courseId})~and(IsDeleted,eq,false)`)}&fields=FolderPath&limit=500`
  );
  if (!r.ok) return json({ folders: [] });

  const files = (await r.json()).list || [];
  const folderSet = new Set(files.map(f => f.FolderPath || '').filter(Boolean));
  const folders = Array.from(folderSet).sort().map(path => ({
    path,
    name: path.split('/').pop() || path,
  }));

  return json({ folders: [{ path: '', name: 'Tất cả tài liệu' }, ...folders] });
}

// ── GET /api/files/:id ────────────────────────────────────────
export async function handleGetFile(request, env, { json, path }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const id = path.split('/')[3];
  if (!id || !env.NOCO_FILES) return json({ error: 'Not found' }, 404);

  const r = await nocoFetch(env, `/api/v2/tables/${env.NOCO_FILES}/records/${id}`);
  if (!r.ok) return json({ error: 'Không tìm thấy tệp' }, 404);
  const file = await r.json();

  if (file.IsDeleted) return json({ error: 'Tệp đã bị xoá' }, 404);
  return json({ file });
}

// ── POST /api/files/upload ────────────────────────────────────
export async function handleFileUpload(request, env, { json }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  if (!isTeacherOrAdmin(session.role)) return json({ error: 'Chỉ giáo viên/admin có thể tải lên tài liệu' }, 403);

  if (!env.NOCO_FILES) return json({ error: 'Tính năng file chưa được cấu hình' }, 503);

  const contentType = request.headers.get('Content-Type') || '';
  if (!contentType.includes('multipart/form-data')) {
    return json({ error: 'Yêu cầu multipart/form-data' }, 400);
  }

  let formData;
  try {
    formData = await request.formData();
  } catch (e) {
    return json({ error: 'Không thể đọc form data: ' + e.message }, 400);
  }

  const file = formData.get('file');
  const courseId = formData.get('course_id');
  const folderPath = formData.get('folder') || '';

  if (!file || typeof file === 'string') return json({ error: 'Thiếu file' }, 400);
  if (!courseId) return json({ error: 'Thiếu course_id' }, 400);

  const fileName = file.name || 'unnamed';
  const mimeType = file.type || 'application/octet-stream';
  const fileBuffer = await file.arrayBuffer();
  const fileSize = fileBuffer.byteLength;

  if (fileSize > MAX_FILE_SIZE)
    return json({ error: `File quá lớn (${Math.round(fileSize / 1024 / 1024)}MB). Tối đa 50MB.` }, 413);

  if (!ALLOWED_MIME_TYPES.has(mimeType))
    return json({ error: `Định dạng không được hỗ trợ: ${mimeType}` }, 415);

  // Upload to Google Drive
  if (!env.GDRIVE_SA_JSON) return json({ error: 'Google Drive chưa được cấu hình (thiếu GDRIVE_SA_JSON)' }, 503);

  let driveFile;
  try {
    const token = await getServiceAccountToken(env);
    const folderId = await getDriveFolderId(env); // dynamic: NocoDB Settings > env var

    const metadata = {
      name: fileName,
      mimeType,
      ...(folderId ? { parents: [folderId] } : {}),
    };

    const boundary = '-------activeedu-upload-' + Date.now();
    const metaPart = [
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      JSON.stringify(metadata),
      '',
    ].join('\r\n');

    const filePart = [
      `--${boundary}`,
      `Content-Type: ${mimeType}`,
      '',
      '',
    ].join('\r\n');

    const closingBoundary = `\r\n--${boundary}--`;

    // Combine as Uint8Array
    const enc = new TextEncoder();
    const metaBytes = enc.encode(metaPart);
    const filePartBytes = enc.encode(filePart);
    const closingBytes = enc.encode(closingBoundary);
    const fileBytes = new Uint8Array(fileBuffer);

    const combined = new Uint8Array(metaBytes.length + filePartBytes.length + fileBytes.length + closingBytes.length);
    combined.set(metaBytes, 0);
    combined.set(filePartBytes, metaBytes.length);
    combined.set(fileBytes, metaBytes.length + filePartBytes.length);
    combined.set(closingBytes, metaBytes.length + filePartBytes.length + fileBytes.length);

    const uploadRes = await fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webContentLink,webViewLink',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': `multipart/related; boundary="${boundary}"`,
          'Content-Length': String(combined.length),
        },
        body: combined,
      }
    );

    if (!uploadRes.ok) {
      const errText = await uploadRes.text();
      throw new Error('Drive upload error: ' + errText);
    }

    driveFile = await uploadRes.json();

    // Make file publicly readable
    await fetch(`https://www.googleapis.com/drive/v3/files/${driveFile.id}/permissions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'reader', type: 'anyone' }),
    });
  } catch (e) {
    return json({ error: 'Lỗi upload Drive: ' + e.message }, 502);
  }

  // Save metadata to NocoDB
  const now = new Date().toISOString();
  const r = await nocoFetch(env, `/api/v2/tables/${env.NOCO_FILES}/records`, 'POST', {
    CourseId: String(courseId),
    UploadedBy: String(session.userId),
    UploaderEmail: session.email,
    Name: fileName,
    MimeType: mimeType,
    Size: fileSize,
    DriveId: driveFile.id,
    DriveUrl: driveFile.webContentLink || driveFile.webViewLink || '',
    DriveFolderId: folderId || null,
    FolderPath: folderPath,
    IsDeleted: false,
    CreatedAt: now,
  });

  if (!r.ok) {
    return json({
      ok: true,
      warning: 'File đã upload lên Drive nhưng không lưu được metadata',
      drive_id: driveFile.id,
      drive_url: driveFile.webContentLink,
    });
  }

  const saved = await r.json();
  return json({
    ok: true,
    file: {
      id: saved.Id,
      name: fileName,
      mime_type: mimeType,
      size: fileSize,
      drive_id: driveFile.id,
      url: driveFile.webContentLink || driveFile.webViewLink,
      folder_path: folderPath,
      created_at: now,
    }
  }, 201);
}

// ── DELETE /api/files/:id ─────────────────────────────────────
export async function handleDeleteFile(request, env, { json, path }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  if (!isTeacherOrAdmin(session.role)) return json({ error: 'Không có quyền xoá tệp' }, 403);

  const id = path.split('/')[3];
  if (!id || !env.NOCO_FILES) return json({ error: 'Not found' }, 404);

  await nocoFetch(env, `/api/v2/tables/${env.NOCO_FILES}/records/${id}`, 'PATCH', { IsDeleted: true });
  return json({ ok: true });
}
