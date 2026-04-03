import { verifyAdminAuth } from '../auth.js';
import { uploadToDrive, fetchFromDrive } from '../drive.js';

export async function handleDriveUpload(request, env, { json }) {
  if (!await verifyAdminAuth(request, env)) return json({ error: 'Unauthorized' }, 401);
  try {
    const { fileName, content: htmlContent } = await request.json();
    if (!htmlContent) return json({ error: 'Thiếu content' }, 400);
    const file = await uploadToDrive(env, (fileName || 'article') + '.html', htmlContent);
    return json({ fileId: file.id, name: file.name, link: file.webContentLink });
  } catch (e) { return json({ error: e.message }, 500); }
}

export async function handleDriveFetch(request, env, { json, url, cors }) {
  if (!await verifyAdminAuth(request, env)) return json({ error: 'Unauthorized' }, 401);
  try {
    const fileId = url.searchParams.get('fileId');
    if (!fileId) return json({ error: 'Thiếu fileId' }, 400);
    const html = await fetchFromDrive(env, fileId);
    return new Response(html, { status: 200, headers: { ...cors, 'Content-Type': 'text/html; charset=utf-8' } });
  } catch (e) { return json({ error: e.message }, 500); }
}
