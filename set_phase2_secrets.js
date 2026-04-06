#!/usr/bin/env node
/**
 * ActiveEdu — Tự động lấy table IDs từ NocoDB và set Cloudflare Worker secrets
 *
 * Cách dùng:
 *   node set_phase2_secrets.js
 *
 * Script sẽ:
 *  1. Query NocoDB lấy danh sách tất cả bảng
 *  2. Match theo tên bảng
 *  3. Tự động chạy wrangler secret put cho từng bảng tìm thấy
 *  4. Deploy worker
 */

const { execSync, spawnSync } = require('child_process');
const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = q => new Promise(res => rl.question(q, res));

// Map: Wrangler secret name → NocoDB table title (exact match)
const TABLE_MAP = {
  // Sprint 1
  NOCO_DISCUSSIONS:    'Discussions',
  NOCO_DISC_REPLIES:   'DiscussionReplies',
  NOCO_ANNOUNCEMENTS:  'Announcements',
  NOCO_CALENDAR:       'CalendarEvents',
  NOCO_CONVERSATIONS:  'Conversations',
  NOCO_CONV_PARTS:     'ConversationParticipants',
  NOCO_MSG_TABLE:      'Messages',
  // Sprint 2
  NOCO_RUBRICS:           'Rubrics',
  NOCO_RUBRIC_CRITERIA:   'RubricCriteria',
  NOCO_RUBRIC_RATINGS:    'RubricRatings',
  NOCO_GROUP_SETS:        'GroupSets',
  NOCO_GROUPS:            'Groups',
  NOCO_GROUP_MEMBERS:     'GroupMembers',
  NOCO_PEER_REVIEWS:      'PeerReviews',
  // Sprint 3
  NOCO_FILES:             'Files',
  NOCO_OBSERVER_LINKS:    'ObserverLinks',
  // Sprint 4
  NOCO_PORTFOLIO:         'PortfolioEntries',
  NOCO_CONFERENCES:       'Conferences',
};

const WRANGLER = '/usr/local/bin/node /tmp/wrangler-install/node_modules/.bin/wrangler';

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║   ActiveEdu — Set Phase 2 NocoDB Secrets                    ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const nocoUrl   = await ask('NocoDB URL (vd: https://noco.gds.edu.vn): ');
  const nocoToken = await ask('NocoDB API Token (xc-token): ');
  const projectId = await ask('NocoDB Project/Base ID: ');
  rl.close();

  const baseUrl = nocoUrl.replace(/\/$/, '');

  // ── Lấy danh sách tất cả bảng ──────────────────────────────────
  console.log('\n📡 Đang kết nối NocoDB...');
  let res;
  try {
    res = await fetch(`${baseUrl}/api/v1/db/meta/projects/${projectId}/tables?limit=200`, {
      headers: { 'xc-token': nocoToken }
    });
  } catch (e) {
    console.error('❌ Không thể kết nối NocoDB:', e.message);
    process.exit(1);
  }

  if (!res.ok) {
    const txt = await res.text();
    console.error(`❌ NocoDB trả lỗi ${res.status}: ${txt.slice(0, 200)}`);
    process.exit(1);
  }

  const data = await res.json();
  const tables = data.list || [];
  console.log(`✅ Tìm thấy ${tables.length} bảng trong project\n`);

  // ── Match tables ────────────────────────────────────────────────
  const found = {};
  const missing = [];

  for (const [secretKey, tableName] of Object.entries(TABLE_MAP)) {
    const t = tables.find(x => x.title === tableName);
    if (t) {
      found[secretKey] = t.id;
    } else {
      missing.push({ secretKey, tableName });
    }
  }

  console.log(`Kết quả match: ${Object.keys(found).length}/${Object.keys(TABLE_MAP).length} bảng\n`);

  if (missing.length > 0) {
    console.log('⚠️  Không tìm thấy (chưa tạo hoặc tên khác):');
    missing.forEach(({ secretKey, tableName }) =>
      console.log(`   ${secretKey.padEnd(25)} → "${tableName}"`)
    );
    console.log('');
  }

  if (Object.keys(found).length === 0) {
    console.error('❌ Không tìm thấy bảng nào. Kiểm tra lại Project ID và tên bảng.');
    process.exit(1);
  }

  // ── Set wrangler secrets ────────────────────────────────────────
  console.log('🔐 Đang set Cloudflare Worker secrets...\n');
  const workerDir = __dirname + '/worker';
  let successCount = 0, failCount = 0;

  for (const [secretKey, tableId] of Object.entries(found)) {
    process.stdout.write(`  ${secretKey.padEnd(28)} `);
    try {
      const result = spawnSync(
        '/usr/local/bin/node',
        ['/tmp/wrangler-install/node_modules/.bin/wrangler', 'secret', 'put', secretKey, '--env='],
        {
          input: tableId + '\n',
          cwd: workerDir,
          encoding: 'utf8',
          timeout: 30000,
        }
      );
      if (result.status === 0) {
        console.log(`✅ ${tableId}`);
        successCount++;
      } else {
        const errMsg = (result.stderr || result.stdout || '').split('\n').find(l => l.includes('ERROR')) || 'failed';
        console.log(`❌ ${errMsg.slice(0, 60)}`);
        failCount++;
      }
    } catch (e) {
      console.log(`❌ ${e.message.slice(0, 60)}`);
      failCount++;
    }
  }

  console.log(`\n── Kết quả: ${successCount} thành công, ${failCount} thất bại ──\n`);

  if (successCount > 0) {
    console.log('🚀 Đang deploy worker...\n');
    try {
      const deployResult = spawnSync(
        '/usr/local/bin/node',
        ['/tmp/wrangler-install/node_modules/.bin/wrangler', 'deploy', '--env='],
        { cwd: workerDir, encoding: 'utf8', timeout: 120000, stdio: 'inherit' }
      );
      if (deployResult.status === 0) {
        console.log('\n✅ Deploy thành công!');
      } else {
        console.log('\n⚠️  Deploy có lỗi. Chạy thủ công:');
        console.log(`   cd worker && ${WRANGLER} deploy --env=""`);
      }
    } catch (e) {
      console.log('⚠️  Deploy lỗi:', e.message);
    }
  }

  console.log('\nXong! Test bằng lệnh:');
  console.log('  curl https://api.gds.edu.vn/api/discussions?course_id=2 -H "Authorization: Bearer TOKEN"\n');
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
