// ── Google Drive helpers ──────────────────────────────────────

export async function getServiceAccountToken(env) {
  const sa = JSON.parse(env.GDRIVE_SA_JSON || '{}');
  if (!sa.private_key) throw new Error('GDRIVE_SA_JSON chưa được cấu hình');

  const now = Math.floor(Date.now() / 1000);
  const toB64Url = s => btoa(s).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const header = toB64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = toB64Url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/drive.file',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600, iat: now,
  }));

  const sigInput = `${header}.${claim}`;
  const pemBody = sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
  const keyData = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', keyData, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(sigInput));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${sigInput}.${sigB64}`,
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) throw new Error('Drive token error: ' + JSON.stringify(tokenData));
  return tokenData.access_token;
}

export async function uploadToDrive(env, fileName, htmlContent) {
  const token = await getServiceAccountToken(env);
  const folderId = env.GDRIVE_FOLDER_ID || '';
  const metadata = { name: fileName, mimeType: 'text/html' };
  if (folderId) metadata.parents = [folderId];

  const boundary = '-------activeedu314159265';
  const body = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8', '',
    JSON.stringify(metadata),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8', '',
    htmlContent,
    `--${boundary}--`,
  ].join('\r\n');

  const uploadRes = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webContentLink',
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary="${boundary}"`,
      },
      body,
    }
  );
  if (!uploadRes.ok) throw new Error('Drive upload error: ' + await uploadRes.text());
  const file = await uploadRes.json();
  await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}/permissions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'reader', type: 'anyone' }),
  });
  return file;
}

export async function fetchFromDrive(env, fileId) {
  const token = await getServiceAccountToken(env);
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) throw new Error('Drive fetch error: ' + res.status);
  return res.text();
}
