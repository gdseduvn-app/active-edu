#!/usr/bin/env node
/**
 * ActiveEdu — NocoDB Phase 1 Setup Script
 * Tạo tự động 4 bảng NocoDB + seed 198 Outcomes CT GDPT 2018
 *
 * Cách dùng:
 *   node setup_nocodb.js
 *
 * Yêu cầu:
 *   - NOCO_URL:   URL NocoDB (vd: https://noco.gds.edu.vn)
 *   - NOCO_TOKEN: API token (xc-token) — lấy từ NocoDB UI → Team & Auth → API Tokens
 *   - PROJECT_ID: NocoDB project/base ID (lấy từ URL NocoDB)
 */

const readline = require('readline');
const { execSync } = require('child_process');

// ── Cấu hình ──────────────────────────────────────────────────────────────────
const CONFIG = {
  nocoUrl:    process.env.NOCO_URL    || '',
  nocoToken:  process.env.NOCO_TOKEN  || '',
  projectId:  process.env.NOCO_PROJECT_ID || '',
};

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = q => new Promise(res => rl.question(q, res));

async function setup() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║   ActiveEdu — NocoDB Phase 1 Setup                       ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  // Lấy thông tin kết nối
  if (!CONFIG.nocoUrl)   CONFIG.nocoUrl   = await ask('NocoDB URL (vd: https://noco.gds.edu.vn): ');
  if (!CONFIG.nocoToken) CONFIG.nocoToken = await ask('NocoDB API Token (xc-token): ');
  if (!CONFIG.projectId) CONFIG.projectId = await ask('NocoDB Project/Base ID (lấy từ URL): ');

  CONFIG.nocoUrl = CONFIG.nocoUrl.replace(/\/$/, '');
  rl.close();

  // ── Helper ──────────────────────────────────────────────────────────────────
  async function nocoFetch(path, method = 'GET', body) {
    const res = await fetch(`${CONFIG.nocoUrl}${path}`, {
      method,
      headers: {
        'xc-token': CONFIG.nocoToken,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return res;
  }

  async function createTable(title, columns) {
    console.log(`\n📋 Tạo bảng: ${title}...`);
    const res = await nocoFetch(
      `/api/v1/db/meta/projects/${CONFIG.projectId}/tables`,
      'POST',
      { title, columns }
    );
    if (res.ok) {
      const d = await res.json();
      console.log(`   ✅ Created: ${d.id}`);
      return d.id;
    } else {
      const txt = await res.text().catch(() => '');
      // Table might already exist — try to find it
      if (txt.includes('already') || res.status === 422) {
        console.log(`   ⚠️  Table ${title} already exists, looking up ID...`);
        const listRes = await nocoFetch(`/api/v1/db/meta/projects/${CONFIG.projectId}/tables`);
        if (listRes.ok) {
          const listData = await listRes.json();
          const existing = (listData.list || []).find(t => t.title === title);
          if (existing) {
            console.log(`   ✅ Found existing: ${existing.id}`);
            return existing.id;
          }
        }
      }
      console.error(`   ❌ Error ${res.status}: ${txt.slice(0, 200)}`);
      return null;
    }
  }

  // ── Định nghĩa bảng ─────────────────────────────────────────────────────────
  const tableIds = {};

  // 1. Outcomes
  tableIds.NOCO_OUTCOMES = await createTable('Outcomes', [
    { title: 'Code',           uidt: 'SingleLineText' },
    { title: 'Subject',        uidt: 'SingleLineText' },
    { title: 'Grade',          uidt: 'SingleLineText' },
    { title: 'GradeBand',      uidt: 'SingleLineText' },
    { title: 'Level',          uidt: 'Number',  cdf: '1' },
    { title: 'TitleVi',        uidt: 'SingleLineText' },
    { title: 'Description',    uidt: 'LongText' },
    { title: 'ParentId',       uidt: 'Number' },
    { title: 'EstimatedHours', uidt: 'Decimal', cdf: '0' },
    { title: 'Prerequisites',  uidt: 'LongText' },
  ]);

  // 2. Outcome_Alignments
  tableIds.NOCO_ALIGNMENTS = await createTable('Outcome_Alignments', [
    { title: 'ItemId',             uidt: 'Number' },
    { title: 'CourseId',           uidt: 'Number' },
    { title: 'OutcomeId',          uidt: 'Number' },
    { title: 'OutcomeCode',        uidt: 'SingleLineText' },
    { title: 'AlignmentStrength',  uidt: 'Decimal', cdf: '1.0' },
    { title: 'CreatedBy',          uidt: 'Number' },
  ]);

  // 3. Student_Mastery (NocoDB — for Phase 1; D1 is hot path)
  tableIds.NOCO_STUDENT_MASTERY = await createTable('Student_Mastery', [
    { title: 'StudentId',   uidt: 'Number' },
    { title: 'OutcomeId',   uidt: 'Number' },
    { title: 'OutcomeCode', uidt: 'SingleLineText' },
    { title: 'Subject',     uidt: 'SingleLineText' },
    { title: 'Grade',       uidt: 'SingleLineText' },
    { title: 'Score',       uidt: 'Decimal', cdf: '0' },
    { title: 'Attempts',    uidt: 'Number',  cdf: '0' },
    { title: 'BktState',    uidt: 'Decimal', cdf: '0.3' },
    { title: 'IrtTheta',    uidt: 'Decimal' },
  ]);

  // 4. Assignment_Groups
  tableIds.NOCO_ASSIGNMENT_GROUPS = await createTable('Assignment_Groups', [
    { title: 'CourseId',        uidt: 'Number' },
    { title: 'Name',            uidt: 'SingleLineText' },
    { title: 'Weight',          uidt: 'Decimal', cdf: '0' },
    { title: 'DroppingLowest',  uidt: 'Number',  cdf: '0' },
    { title: 'Position',        uidt: 'Number',  cdf: '0' },
  ]);

  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  Bước tiếp theo: Set Cloudflare Worker secrets');
  console.log('══════════════════════════════════════════════════════════\n');
  console.log('Chạy các lệnh sau trong thư mục worker/:\n');

  const cmds = [];
  for (const [key, id] of Object.entries(tableIds)) {
    if (id) {
      const cmd = `echo "${id}" | npx wrangler secret put ${key}`;
      cmds.push(cmd);
      console.log(`  ${cmd}`);
    } else {
      console.log(`  # ⚠️  ${key} — tạo thủ công trên NocoDB UI`);
    }
  }

  // Seed Outcomes nếu tạo thành công
  if (tableIds.NOCO_OUTCOMES) {
    console.log('\n══════════════════════════════════════════════════════════');
    console.log('  Seeding 198 Outcomes CT GDPT 2018...');
    console.log('══════════════════════════════════════════════════════════\n');

    const outcomes = require('./worker/src/handlers/outcomeHandler_seed.json').catch
      ? null
      : null; // Will load below

    // Load seed data from the outcomeHandler
    const { execSync: exec } = require('child_process');
    try {
      // Extract seed data from handler
      const fs = require('fs');
      const handlerContent = fs.readFileSync('./worker/src/handlers/outcomeHandler.js', 'utf-8');
      const match = handlerContent.match(/const seedData = \[([\s\S]*?)\];/);
      if (match) {
        const seedStr = `[${match[1]}]`;
        const seedData = eval(seedStr); // Safe: our own code

        let created = 0, errors = 0;
        console.log(`  Seeding ${seedData.length} outcomes...`);

        for (const item of seedData) {
          const { ParentCode, GradeBand, ...record } = item;
          const r = await nocoFetch(
            `/api/v2/tables/${tableIds.NOCO_OUTCOMES}/records`,
            'POST',
            record
          );
          if (r.ok) { created++; process.stdout.write('.'); }
          else { errors++; process.stdout.write('x'); }
        }
        console.log(`\n  ✅ Seeded: ${created} outcomes, ${errors} errors`);
      }
    } catch (e) {
      console.error('\n  ⚠️  Auto-seed failed:', e.message);
      console.log('  Dùng API thủ công: POST https://api.gds.edu.vn/admin/setup/seed-outcomes');
    }
  }

  // Save IDs to a config file for reference
  const fs = require('fs');
  const configOut = {
    generated_at: new Date().toISOString(),
    table_ids: tableIds,
    wrangler_commands: cmds,
  };
  fs.writeFileSync('./noco_table_ids.json', JSON.stringify(configOut, null, 2));
  console.log('\n  📄 Đã lưu table IDs vào: noco_table_ids.json');

  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  Sau khi set secrets, chạy: cd worker && npx wrangler deploy --env=""');
  console.log('══════════════════════════════════════════════════════════\n');
}

setup().catch(e => {
  console.error('Setup failed:', e.message);
  process.exit(1);
});
