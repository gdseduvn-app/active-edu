#!/usr/bin/env node
/**
 * ActiveEdu — NocoDB Phase 2 Setup Script
 * Tạo tự động 19 bảng NocoDB cho Sprint 1-4
 *
 * Sprint 1: Discussions, DiscussionReplies, Announcements,
 *           CalendarEvents, Conversations, ConversationParticipants, Messages
 * Sprint 2: Rubrics, RubricCriteria, RubricRatings,
 *           GroupSets, Groups, GroupMembers, PeerReviews
 * Sprint 3: Files, ObserverLinks
 * Sprint 4: PortfolioEntries, Conferences
 *
 * Cách dùng:
 *   node setup_nocodb_phase2.js
 *
 * Yêu cầu:
 *   NOCO_URL        — URL NocoDB (vd: https://noco.gds.edu.vn)
 *   NOCO_TOKEN      — API token (xc-token)
 *   NOCO_PROJECT_ID — Base/Project ID (lấy từ URL NocoDB)
 */

const readline = require('readline');

const CONFIG = {
  nocoUrl:   process.env.NOCO_URL            || '',
  nocoToken: process.env.NOCO_TOKEN          || '',
  projectId: process.env.NOCO_PROJECT_ID     || '',
};

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = q => new Promise(res => rl.question(q, res));

async function setup() {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║   ActiveEdu — NocoDB Phase 2 Setup (Sprint 1-4)             ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  if (!CONFIG.nocoUrl)   CONFIG.nocoUrl   = await ask('NocoDB URL (vd: https://noco.gds.edu.vn): ');
  if (!CONFIG.nocoToken) CONFIG.nocoToken = await ask('NocoDB API Token (xc-token): ');
  if (!CONFIG.projectId) CONFIG.projectId = await ask('NocoDB Project/Base ID: ');
  CONFIG.nocoUrl = CONFIG.nocoUrl.replace(/\/$/, '');
  rl.close();

  // ── Helpers ────────────────────────────────────────────────────────────────
  async function nocoFetch(path, method = 'GET', body) {
    const res = await fetch(`${CONFIG.nocoUrl}${path}`, {
      method,
      headers: { 'xc-token': CONFIG.nocoToken, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return res;
  }

  async function createTable(title, columns) {
    process.stdout.write(`  📋 ${title.padEnd(28)} `);
    const res = await nocoFetch(
      `/api/v1/db/meta/projects/${CONFIG.projectId}/tables`,
      'POST', { title, columns }
    );
    if (res.ok) {
      const d = await res.json();
      console.log(`✅ ${d.id}`);
      return { id: d.id, title };
    }
    const txt = await res.text().catch(() => '');
    if (txt.includes('already') || res.status === 422) {
      // Look up existing table
      const listRes = await nocoFetch(`/api/v1/db/meta/projects/${CONFIG.projectId}/tables`);
      if (listRes.ok) {
        const listData = await listRes.json();
        const existing = (listData.list || []).find(t => t.title === title);
        if (existing) { console.log(`⚠️  Already exists: ${existing.id}`); return { id: existing.id, title }; }
      }
    }
    console.log(`❌ Error ${res.status}: ${txt.slice(0, 100)}`);
    return { id: null, title };
  }

  const T = {}; // table id map

  // ══════════════════════════════════════════════════════════════════
  console.log('\n── Sprint 1: Communication ─────────────────────────────────────');

  // 1. Discussions
  T.NOCO_DISCUSSIONS = await createTable('Discussions', [
    { title: 'CourseId',    uidt: 'Number' },
    { title: 'AuthorId',    uidt: 'Number' },
    { title: 'AuthorName',  uidt: 'SingleLineText' },
    { title: 'Title',       uidt: 'SingleLineText' },
    { title: 'Body',        uidt: 'LongText' },
    { title: 'Type',        uidt: 'SingleLineText', cdf: 'discussion' }, // discussion|question
    { title: 'IsPinned',    uidt: 'Checkbox',       cdf: 'false' },
    { title: 'IsDeleted',   uidt: 'Checkbox',       cdf: 'false' },
    { title: 'ReplyCount',  uidt: 'Number',         cdf: '0' },
  ]);

  // 2. DiscussionReplies
  T.NOCO_DISC_REPLIES = await createTable('DiscussionReplies', [
    { title: 'DiscussionId',  uidt: 'Number' },
    { title: 'ParentReplyId', uidt: 'Number' },   // null = top-level reply
    { title: 'AuthorId',      uidt: 'Number' },
    { title: 'AuthorEmail',   uidt: 'SingleLineText' },
    { title: 'Body',          uidt: 'LongText' },
    { title: 'Likes',         uidt: 'Number',         cdf: '0' },
    { title: 'IsDeleted',     uidt: 'Checkbox',       cdf: 'false' },
  ]);

  // 3. Announcements
  T.NOCO_ANNOUNCEMENTS = await createTable('Announcements', [
    { title: 'CourseId',    uidt: 'Number' },
    { title: 'AuthorId',    uidt: 'Number' },
    { title: 'AuthorName',  uidt: 'SingleLineText' },
    { title: 'Title',       uidt: 'SingleLineText' },
    { title: 'Body',        uidt: 'LongText' },
    { title: 'PublishedAt', uidt: 'DateTime' },
    { title: 'ExpiredAt',   uidt: 'DateTime' },
    { title: 'IsDeleted',   uidt: 'Checkbox',   cdf: 'false' },
  ]);

  // 4. CalendarEvents
  T.NOCO_CALENDAR = await createTable('CalendarEvents', [
    { title: 'CourseId',    uidt: 'Number' },
    { title: 'Title',       uidt: 'SingleLineText' },
    { title: 'Description', uidt: 'LongText' },
    { title: 'StartAt',     uidt: 'DateTime' },
    { title: 'EndAt',       uidt: 'DateTime' },
    { title: 'Type',        uidt: 'SingleLineText', cdf: 'event' }, // event|assignment|exam|quiz|conference
    { title: 'RefId',       uidt: 'Number' },    // foreign key to source record
    { title: 'CreatedBy',   uidt: 'Number' },
    { title: 'IsDeleted',   uidt: 'Checkbox',   cdf: 'false' },
  ]);

  // 5. Conversations
  T.NOCO_CONVERSATIONS = await createTable('Conversations', [
    { title: 'Subject',     uidt: 'SingleLineText' },
    { title: 'LastMessage', uidt: 'LongText' },
  ]);

  // 6. ConversationParticipants
  T.NOCO_CONV_PARTS = await createTable('ConversationParticipants', [
    { title: 'ConvId',      uidt: 'Number' },
    { title: 'UserId',      uidt: 'Number' },
    { title: 'Email',       uidt: 'SingleLineText' },
    { title: 'LastReadAt',  uidt: 'DateTime' },
    { title: 'IsArchived',  uidt: 'Checkbox', cdf: 'false' },
  ]);

  // 7. Messages
  T.NOCO_MSG_TABLE = await createTable('Messages', [
    { title: 'ConvId',      uidt: 'Number' },
    { title: 'SenderId',    uidt: 'Number' },
    { title: 'SenderEmail', uidt: 'SingleLineText' },
    { title: 'Body',        uidt: 'LongText' },
    { title: 'SentAt',      uidt: 'DateTime' },
  ]);

  // ══════════════════════════════════════════════════════════════════
  console.log('\n── Sprint 2: Assessment Enhancement ────────────────────────────');

  // 8. Rubrics
  T.NOCO_RUBRICS = await createTable('Rubrics', [
    { title: 'CourseId',    uidt: 'Number' },
    { title: 'Title',       uidt: 'SingleLineText' },
    { title: 'Description', uidt: 'LongText' },
    { title: 'TotalPoints', uidt: 'Decimal', cdf: '0' },
    { title: 'CreatedBy',   uidt: 'Number' },
    { title: 'IsDeleted',   uidt: 'Checkbox', cdf: 'false' },
  ]);

  // 9. RubricCriteria
  T.NOCO_RUBRIC_CRITERIA = await createTable('RubricCriteria', [
    { title: 'RubricId',    uidt: 'Number' },
    { title: 'Description', uidt: 'LongText' },
    { title: 'MaxPoints',   uidt: 'Decimal', cdf: '10' },
    { title: 'OrderNum',    uidt: 'Number',  cdf: '0' },
  ]);

  // 10. RubricRatings
  T.NOCO_RUBRIC_RATINGS = await createTable('RubricRatings', [
    { title: 'CriteriaId',  uidt: 'Number' },
    { title: 'Description', uidt: 'LongText' },
    { title: 'Points',      uidt: 'Decimal', cdf: '0' },
  ]);

  // 11. GroupSets
  T.NOCO_GROUP_SETS = await createTable('GroupSets', [
    { title: 'CourseId',    uidt: 'Number' },
    { title: 'Name',        uidt: 'SingleLineText' },
    { title: 'MaxSize',     uidt: 'Number', cdf: '4' },
    { title: 'SelfEnroll',  uidt: 'Checkbox', cdf: 'false' },
    { title: 'IsDeleted',   uidt: 'Checkbox', cdf: 'false' },
  ]);

  // 12. Groups
  T.NOCO_GROUPS = await createTable('Groups', [
    { title: 'SetId',       uidt: 'Number' },
    { title: 'CourseId',    uidt: 'Number' },
    { title: 'Name',        uidt: 'SingleLineText' },
  ]);

  // 13. GroupMembers
  T.NOCO_GROUP_MEMBERS = await createTable('GroupMembers', [
    { title: 'GroupId',     uidt: 'Number' },
    { title: 'SetId',       uidt: 'Number' },
    { title: 'UserId',      uidt: 'Number' },
    { title: 'UserEmail',   uidt: 'SingleLineText' },
  ]);

  // 14. PeerReviews
  T.NOCO_PEER_REVIEWS = await createTable('PeerReviews', [
    { title: 'AssessmentId', uidt: 'Number' },
    { title: 'RevieweeId',   uidt: 'Number' },
    { title: 'ReviewerId',   uidt: 'Number' },
    { title: 'Status',       uidt: 'SingleLineText', cdf: 'pending' }, // pending|completed
    { title: 'Comments',     uidt: 'LongText' },
    { title: 'Score',        uidt: 'Decimal' },
    { title: 'SubmittedAt',  uidt: 'DateTime' },
  ]);

  // ══════════════════════════════════════════════════════════════════
  console.log('\n── Sprint 3: Management ─────────────────────────────────────────');

  // 15. Files
  T.NOCO_FILES = await createTable('Files', [
    { title: 'CourseId',    uidt: 'Number' },
    { title: 'UploadedBy',  uidt: 'Number' },
    { title: 'Name',        uidt: 'SingleLineText' },
    { title: 'MimeType',    uidt: 'SingleLineText' },
    { title: 'Size',        uidt: 'Number' },
    { title: 'DriveId',     uidt: 'SingleLineText' }, // Google Drive file ID
    { title: 'DriveUrl',    uidt: 'SingleLineText' }, // View URL
    { title: 'FolderPath',  uidt: 'SingleLineText' },
    { title: 'IsDeleted',   uidt: 'Checkbox', cdf: 'false' },
  ]);

  // 16. ObserverLinks
  T.NOCO_OBSERVER_LINKS = await createTable('ObserverLinks', [
    { title: 'ObserverId',    uidt: 'Number' },
    { title: 'ObserverEmail', uidt: 'SingleLineText' },
    { title: 'ObserveeId',    uidt: 'Number' },
    { title: 'ObserveeEmail', uidt: 'SingleLineText' },
    { title: 'CourseId',      uidt: 'Number' },  // null = all courses
    { title: 'IsActive',      uidt: 'Checkbox', cdf: 'true' },
  ]);

  // ══════════════════════════════════════════════════════════════════
  console.log('\n── Sprint 4: Advanced ───────────────────────────────────────────');

  // 17. PortfolioEntries
  T.NOCO_PORTFOLIO = await createTable('PortfolioEntries', [
    { title: 'UserId',      uidt: 'Number' },
    { title: 'UserName',    uidt: 'SingleLineText' },
    { title: 'Title',       uidt: 'SingleLineText' },
    { title: 'Body',        uidt: 'LongText' },
    { title: 'Type',        uidt: 'SingleLineText', cdf: 'reflection' }, // reflection|artifact|achievement|external
    { title: 'ArtifactUrl', uidt: 'SingleLineText' },
    { title: 'Visibility',  uidt: 'SingleLineText', cdf: 'private' }, // private|course|public
    { title: 'CourseId',    uidt: 'Number' },
    { title: 'Tags',        uidt: 'SingleLineText' },
    { title: 'IsDeleted',   uidt: 'Checkbox', cdf: 'false' },
  ]);

  // 18. Conferences
  T.NOCO_CONFERENCES = await createTable('Conferences', [
    { title: 'CourseId',        uidt: 'Number' },
    { title: 'HostId',          uidt: 'Number' },
    { title: 'HostName',        uidt: 'SingleLineText' },
    { title: 'Title',           uidt: 'SingleLineText' },
    { title: 'RoomName',        uidt: 'SingleLineText' },
    { title: 'Description',     uidt: 'LongText' },
    { title: 'StartAt',         uidt: 'DateTime' },
    { title: 'EndAt',           uidt: 'DateTime' },
    { title: 'Status',          uidt: 'SingleLineText', cdf: 'scheduled' }, // scheduled|live|ended|cancelled
    { title: 'MaxParticipants', uidt: 'Number',         cdf: '50' },
    { title: 'RecordingUrl',    uidt: 'SingleLineText' },
  ]);

  // ══════════════════════════════════════════════════════════════════
  // Summary & Wrangler commands
  // ══════════════════════════════════════════════════════════════════
  const created = Object.entries(T).filter(([,v]) => v && v.id);
  const failed  = Object.entries(T).filter(([,v]) => !v || !v.id);

  console.log(`\n══════════════════════════════════════════════════════════════`);
  console.log(`  Kết quả: ${created.length}/18 bảng thành công${failed.length > 0 ? `, ${failed.length} thất bại` : ''}`);
  console.log(`══════════════════════════════════════════════════════════════\n`);

  if (failed.length > 0) {
    console.log('❌ Bảng thất bại:', failed.map(([k]) => k).join(', '));
    console.log('   → Tạo thủ công trong NocoDB dashboard, rồi lấy ID và set secret.\n');
  }

  console.log('Bước tiếp theo — chạy trong thư mục worker/ :\n');
  console.log('cd worker\n');

  const secretCmds = created.map(([key, { id }]) =>
    `echo "${id}" | /usr/local/bin/node /tmp/wrangler-install/node_modules/.bin/wrangler secret put ${key} --env=""`
  );
  secretCmds.forEach(cmd => console.log(cmd));

  console.log('\n  Sau đó deploy:\n');
  console.log('  /usr/local/bin/node /tmp/wrangler-install/node_modules/.bin/wrangler deploy --env=""\n');

  // Also write commands to a file for convenience
  const fs = require('fs');
  const cmdFile = __dirname + '/setup_phase2_secrets.sh';
  fs.writeFileSync(cmdFile,
    `#!/bin/bash\n# Chạy file này trong thư mục worker/\ncd "$(dirname "$0")/worker"\n\n` +
    secretCmds.join('\n') +
    `\n\necho "\\n✅ Xong! Deploy..."\n` +
    `/usr/local/bin/node /tmp/wrangler-install/node_modules/.bin/wrangler deploy --env=""\n`
  );
  console.log(`  📄 Script đã được lưu: setup_phase2_secrets.sh`);
  console.log(`     Chạy: bash setup_phase2_secrets.sh\n`);
}

setup().catch(err => {
  console.error('\n❌ Lỗi:', err.message);
  process.exit(1);
});
