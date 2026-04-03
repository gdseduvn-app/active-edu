/**
 * ActiveEdu Proxy Worker — thin router
 * All business logic lives in src/handlers/*.js and src/*.js
 */

import { getTokenSecret, verifyToken, verifyAdminAuth } from './src/auth.js';
import { nocoFetch, fetchAll } from './src/db.js';
import { checkRateLimit, idempotencyCheck, idempotencyStore, getCors, SEC_HEADERS, makeJson } from './src/middleware.js';
import { _audit } from './src/integrity.js';
import { checkModuleUnlock, checkPrerequisites } from './src/prerequisites.js';

// Handler imports
import { handleAdminAuth, handleLogin, handleChangePassword, handleMe, handleForgotPassword, handleResetPassword } from './src/handlers/authHandler.js';
import { handleProgressGet, handleProgressPost, handleReactions, handleAnalyticsView } from './src/handlers/progressHandler.js';
import { handleQuizGet, handleQuizSubmit } from './src/handlers/quizHandler.js';
import { handleExamList, handleQBankList, handleExamGet, handleExamSubmit } from './src/handlers/examHandler.js';
import { handlePrereqCheck, handleModuleUnlock, handleCourseUnlockStatus } from './src/handlers/courseHandler.js';
import { handleSocratic } from './src/handlers/aiHandler.js';
import { handleDriveUpload, handleDriveFetch } from './src/handlers/driveHandler.js';
import {
  handleAdminUsers,
  handleModuleItemToggle,
  handleSafeModuleCreate,
  handleSafeCourseDelete,
  handleSafeModuleDelete,
  handleSafeExamSectionCreate,
  handleSafeExamDelete,
  handleSafeQuestionBankDelete,
} from './src/handlers/adminHandler.js';

// ── Route tables ──────────────────────────────────────────────

const PUBLIC_ROUTES = {
  '/api/articles':    env => `/api/v2/tables/${env.NOCO_ARTICLE}/records`,
  '/api/folders':     env => `/api/v2/tables/${env.NOCO_FOLDERS}/records`,
  '/api/permissions': env => `/api/v2/tables/${env.NOCO_PERMS}/records`,
  '/api/courses':     env => `/api/v2/tables/${env.NOCO_COURSES}/records`,
  '/api/modules':     env => `/api/v2/tables/${env.NOCO_MODULES}/records`,
};

const ADMIN_PROXY_ROUTES = {
  '/admin/articles':        env => `/api/v2/tables/${env.NOCO_ARTICLE}/records`,
  '/admin/folders':         env => `/api/v2/tables/${env.NOCO_FOLDERS}/records`,
  '/admin/permissions':     env => `/api/v2/tables/${env.NOCO_PERMS}/records`,
  '/admin/progress':        env => `/api/v2/tables/${env.NOCO_PROGRESS}/records`,
  '/admin/quiz':            env => `/api/v2/tables/${env.NOCO_QUIZ}/records`,
  '/admin/analytics':       env => `/api/v2/tables/${env.NOCO_ANALYTICS}/records`,
  '/admin/courses':         env => `/api/v2/tables/${env.NOCO_COURSES}/records`,
  '/admin/modules':         env => `/api/v2/tables/${env.NOCO_MODULES}/records`,
  '/admin/question-banks':  env => `/api/v2/tables/${env.NOCO_QBANK}/records`,
  '/admin/exams':           env => `/api/v2/tables/${env.NOCO_EXAMS}/records`,
  '/admin/exam-sections':   env => `/api/v2/tables/${env.NOCO_EXAM_SECTIONS}/records`,
  '/admin/fields/articles': env => `/api/v2/tables/${env.NOCO_ARTICLE}/fields`,
  '/admin/fields/users':    env => `/api/v2/tables/${env.NOCO_USERS}/fields`,
};

const CACHE_TTL = {
  '/api/articles':       120,
  '/api/folders':        300,
  '/api/permissions':    60,
  '/api/courses':        120,
  '/api/modules':        60,
  '/api/exams':          300,
  '/api/question-banks': 600,
};

// ── Main fetch handler ────────────────────────────────────────

export default {
  async fetch(request, env) {
    const cors = getCors(env);
    const secHeaders = SEC_HEADERS;
    const json = makeJson(cors);

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const url = new URL(request.url);
    const path = url.pathname;
    const clientIP = request.headers.get('CF-Connecting-IP')
      || request.headers.get('X-Forwarded-For')
      || 'unknown';

    // Shared ctx object passed to handlers
    const ctx = { path, url, cors, secHeaders, json, clientIP };

    // ── Health check ────────────────────────────────────────
    if (path === '/api/health') return json({ ok: true, ts: Date.now() });

    // ── Auth endpoints ──────────────────────────────────────
    if (path === '/admin/auth' && request.method === 'POST')
      return handleAdminAuth(request, env, ctx);

    if (path === '/api/auth/login' && request.method === 'POST')
      return handleLogin(request, env, ctx);

    if (path === '/api/auth/change-password' && request.method === 'POST')
      return handleChangePassword(request, env, ctx);

    if (path === '/api/auth/me' && request.method === 'GET')
      return handleMe(request, env, ctx);

    if (path === '/api/auth/forgot-password' && request.method === 'POST')
      return handleForgotPassword(request, env, ctx);

    if (path === '/api/auth/reset-password' && request.method === 'POST')
      return handleResetPassword(request, env, ctx);

    // ── Progress & reactions ────────────────────────────────
    if (path === '/api/progress' && request.method === 'GET')
      return handleProgressGet(request, env, ctx);

    if (path === '/api/progress' && request.method === 'POST')
      return handleProgressPost(request, env, ctx);

    if (path === '/api/reactions' && request.method === 'POST')
      return handleReactions(request, env, ctx);

    if (path === '/api/analytics/view' && request.method === 'POST')
      return handleAnalyticsView(request, env, ctx);

    // ── Quiz ────────────────────────────────────────────────
    if (path.startsWith('/api/quiz/') && path !== '/api/quiz/submit' && request.method === 'GET')
      return handleQuizGet(request, env, ctx);

    if (path === '/api/quiz/submit' && request.method === 'POST')
      return handleQuizSubmit(request, env, ctx);

    // ── Exam ────────────────────────────────────────────────
    if (path === '/api/question-banks' && request.method === 'GET')
      return handleQBankList(request, env, ctx);

    if (path === '/api/exams' && request.method === 'GET')
      return handleExamList(request, env, ctx);

    if (path.startsWith('/api/exam/') && path.endsWith('/submit') && request.method === 'POST')
      return handleExamSubmit(request, env, ctx);

    if (path.startsWith('/api/exam/') && !path.includes('/submit') && request.method === 'GET')
      return handleExamGet(request, env, ctx);

    // ── Course / module unlock ──────────────────────────────
    if (path.startsWith('/api/prereq/') && request.method === 'GET')
      return handlePrereqCheck(request, env, ctx);

    if (path.startsWith('/api/module-unlock/') && request.method === 'GET')
      return handleModuleUnlock(request, env, ctx);

    if (path.match(/^\/api\/course\/\d+\/unlock-status$/) && request.method === 'GET')
      return handleCourseUnlockStatus(request, env, ctx);

    // ── AI tutor ────────────────────────────────────────────
    if (path === '/api/ai/socratic' && request.method === 'POST')
      return handleSocratic(request, env, ctx);

    // ── Admin: Drive ────────────────────────────────────────
    if (path === '/admin/drive-upload' && request.method === 'POST')
      return handleDriveUpload(request, env, ctx);

    if (path === '/admin/drive-fetch' && request.method === 'GET')
      return handleDriveFetch(request, env, ctx);

    // ── Admin: Users ────────────────────────────────────────
    if (path.startsWith('/admin/users'))
      return handleAdminUsers(request, env, ctx);

    // ── Admin: safe constraint-aware endpoints ──────────────
    if (path === '/admin/modules/safe' && request.method === 'POST')
      return handleSafeModuleCreate(request, env, ctx);

    if (path === '/admin/courses/safe' && request.method === 'DELETE')
      return handleSafeCourseDelete(request, env, ctx);

    if (path === '/admin/modules/safe' && request.method === 'DELETE')
      return handleSafeModuleDelete(request, env, ctx);

    if (path === '/admin/exam-sections/safe' && request.method === 'POST')
      return handleSafeExamSectionCreate(request, env, ctx);

    if (path === '/admin/exams/safe' && request.method === 'DELETE')
      return handleSafeExamDelete(request, env, ctx);

    if (path === '/admin/question-banks/safe' && request.method === 'DELETE')
      return handleSafeQuestionBankDelete(request, env, ctx);

    if (path.startsWith('/admin/module-item/') && request.method === 'PATCH')
      return handleModuleItemToggle(request, env, ctx);

    // ── Admin: generic proxy routes ─────────────────────────
    let adminNoco = null;
    for (const [route, resolver] of Object.entries(ADMIN_PROXY_ROUTES)) {
      if (path.startsWith(route)) {
        adminNoco = resolver(env) + path.slice(route.length);
        break;
      }
    }
    if (adminNoco !== null) {
      const country = request.headers.get('CF-IPCountry') || '';
      const allowed = (env.ALLOWED_COUNTRIES || 'VN').split(',').map(c => c.trim());
      if (country && !allowed.includes('*') && !allowed.includes(country))
        return json({ error: 'Access denied from your region' }, 403);

      if (!await verifyAdminAuth(request, env)) {
        const adminRl = await checkRateLimit(clientIP, env, 'admin');
        if (!adminRl.allowed) return json({ error: `Quá nhiều yêu cầu (${adminRl.count}). Thử lại sau 15 phút.` }, 429);
        return json({ error: 'Unauthorized' }, 401);
      }

      const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await request.text();
      const r = await fetch(`${env.NOCO_URL}${adminNoco}${url.search}`, {
        method: request.method,
        headers: { 'xc-token': env.NOCO_TOKEN, 'Content-Type': 'application/json' },
        body,
      });
      const respText = await r.text();

      // Audit log for write operations (fire-and-forget)
      if (env.NOCO_AUDIT && r.ok && ['POST', 'PATCH', 'DELETE'].includes(request.method)) {
        try {
          const tableName = Object.keys(ADMIN_PROXY_ROUTES).find(k => path.startsWith(k)) || path;
          let bodyObj = null;
          try { bodyObj = body ? JSON.parse(body) : null; } catch {}
          _audit(env, request.method.toLowerCase(), tableName, null, { userId: 0, email: 'admin' }, null, bodyObj);
        } catch {}
      }

      return new Response(respText, {
        status: r.status,
        headers: { ...cors, ...secHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── Public routes ─────────────────────────────────────────
    let nocoPath = null, matchedRoute = null;
    for (const [route, resolver] of Object.entries(PUBLIC_ROUTES)) {
      if (path.startsWith(route)) {
        nocoPath = resolver(env) + path.slice(route.length);
        matchedRoute = route;
        break;
      }
    }
    if (!nocoPath) return json({ error: 'Not found' }, 404);

    // Article list: strip Content field (lazy-load)
    const isArticleList = matchedRoute === '/api/articles' && !path.slice('/api/articles'.length).match(/^\/\d+/);
    let finalSearch = url.search;
    if (isArticleList) {
      const sp = new URLSearchParams(url.search);
      if (!sp.has('fields')) {
        sp.set('fields', 'Id,Title,Path,Folder,Access,Updated,Description');
      } else {
        const fields = sp.get('fields').split(',').map(f => f.trim()).filter(f => f !== 'Content');
        sp.set('fields', fields.join(','));
      }
      finalSearch = '?' + sp.toString();
    }

    // Server-side token check for single private article fetches
    const isArticleSingleWhere = matchedRoute === '/api/articles' && url.searchParams.get('where');
    let userSession = null;
    if (isArticleSingleWhere) {
      const authHeader = request.headers.get('Authorization') || '';
      const token = authHeader.replace('Bearer ', '');
      if (token) {
        const secret = getTokenSecret(env);
        userSession = await verifyToken(token, secret);
      }
    }

    // Soft-delete filter: exclude records where DeletedAt is set
    const SOFT_DELETE_PUBLIC = new Set(['/api/courses', '/api/modules', '/api/articles']);
    if (SOFT_DELETE_PUBLIC.has(matchedRoute)) {
      const sp = new URLSearchParams(finalSearch.startsWith('?') ? finalSearch.slice(1) : '');
      const existing = sp.get('where');
      const sdFilter = '(DeletedAt,is,null)';
      sp.set('where', existing ? `(${existing})~and${sdFilter}` : sdFilter);
      finalSearch = '?' + sp.toString();
    }

    const nocoUrl = `${env.NOCO_URL}${nocoPath}${finalSearch}`;
    const isGet = request.method === 'GET';
    const ttl = CACHE_TTL[matchedRoute] || 60;

    // Cache hit check (list requests only)
    if (isGet && !isArticleSingleWhere) {
      const cached = await caches.default.match(nocoUrl);
      if (cached) {
        return new Response(await cached.text(), {
          headers: { ...cors, 'Content-Type': 'application/json', 'X-Cache': 'HIT' },
        });
      }
    }

    const reqBody = isGet ? undefined : await request.text();
    let nocoResp;
    // Retry on 429 from NocoDB (up to 3 attempts)
    for (let i = 0; i < 3; i++) {
      nocoResp = await fetch(nocoUrl, {
        method: request.method,
        headers: { 'xc-token': env.NOCO_TOKEN, 'Content-Type': 'application/json' },
        body: reqBody,
      });
      if (nocoResp.status !== 429) break;
      await new Promise(r => setTimeout(r, 500 * (i + 1)));
    }

    let responseData = await nocoResp.text();

    // Strip Content + enforce prerequisites + module lock for single article fetches
    if (isArticleSingleWhere && nocoResp.ok) {
      try {
        const parsed = JSON.parse(responseData);
        for (const row of (parsed.list || [])) {
          // 1) Access=private → strip content nếu chưa đăng nhập
          if (row.Access === 'private' && !userSession) {
            row.Content = null;
            continue;
          }
          // 2) Module lock check
          if (row.ModuleId && userSession && env.NOCO_MODULES) {
            const modR = await nocoFetch(env,
              `/api/v2/tables/${env.NOCO_MODULES}/records/${row.ModuleId}?fields=Id,UnlockCondition`
            );
            if (modR.ok) {
              const mod = await modR.json();
              if (mod?.UnlockCondition) {
                const lockCheck = await checkModuleUnlock(env, userSession.userId, mod.UnlockCondition);
                if (!lockCheck.ok) {
                  row.Content = null;
                  row._moduleBlocked = true;
                  row._moduleReason = lockCheck.reason;
                }
              }
            }
          }
          // 3) Prerequisites check
          if (row.Prerequisites && userSession && !row._moduleBlocked) {
            const check = await checkPrerequisites(env, userSession.userId, row.Prerequisites);
            if (!check.ok) {
              row.Content = null;
              row._prereqBlocked = true;
              row._prereqReason = check.reason;
            }
          }
        }
        responseData = JSON.stringify(parsed);
      } catch {}
    }

    const cacheControl = isGet && !isArticleSingleWhere ? `public, max-age=${ttl}` : 'no-store';
    const response = new Response(responseData, {
      status: nocoResp.status,
      headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': cacheControl },
    });

    if (isGet && nocoResp.ok && !isArticleSingleWhere) {
      await caches.default.put(nocoUrl, response.clone());
    }
    return response;
  },
};
