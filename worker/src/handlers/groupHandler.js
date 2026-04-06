/**
 * Group Handler — Student groups within courses
 *
 * GET    /api/groups?course_id=X              — list group sets (with member counts)
 * GET    /api/groups/:id                       — group set detail with all groups & members
 * POST   /api/groups                           — create group set (teacher/admin)
 * DELETE /api/groups/:id                       — delete group set
 * POST   /api/groups/:id/auto-assign           — auto-assign students to groups
 * GET    /api/groups/:id/members               — list all members across groups
 * POST   /api/groups/:id/join                  — student self-join a group (if self_enroll=true)
 * POST   /api/groups/:id/leave                 — student leave group
 * POST   /api/groups/:setId/create-group       — manually create a named group within set
 * POST   /api/groups/members/move              — move student between groups (teacher)
 *
 * NocoDB tables required:
 *   env.NOCO_GROUP_SETS    — GroupSets
 *     Fields: Id, CourseId, Name, Description, MaxSize, SelfEnroll (bool), CreatedBy, CreatedAt, IsDeleted
 *   env.NOCO_GROUPS        — Groups
 *     Fields: Id, SetId, Name, IsDeleted
 *   env.NOCO_GROUP_MEMBERS — GroupMembers
 *     Fields: Id, GroupId, SetId, UserId, UserName, UserEmail, JoinedAt
 */
import { getTokenSecret, verifyToken } from '../auth.js';
import { nocoFetch } from '../db.js';

async function getSession(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace('Bearer ', '');
  if (!token) return null;
  return verifyToken(token, getTokenSecret(env));
}

function isTeacherOrAdmin(role) {
  return role === 'admin' || role === 'teacher';
}

function hasGroups(env) {
  return env.NOCO_GROUP_SETS && env.NOCO_GROUPS && env.NOCO_GROUP_MEMBERS;
}

// ── GET /api/groups?course_id=X ──────────────────────────────
export async function handleListGroupSets(request, env, { json, url }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  if (!hasGroups(env)) return json({ group_sets: [] });

  const courseId = url.searchParams.get('course_id');
  let where = `(IsDeleted,eq,false)`;
  if (courseId) where += `~and(CourseId,eq,${courseId})`;

  const r = await nocoFetch(env,
    `/api/v2/tables/${env.NOCO_GROUP_SETS}/records?where=${encodeURIComponent(where)}&limit=50&sort=-CreatedAt`
  );
  if (!r.ok) return json({ group_sets: [] });

  const sets = (await r.json()).list || [];
  if (sets.length === 0) return json({ group_sets: [] });

  // Count members per set
  const countsArr = await Promise.all(sets.map(s =>
    nocoFetch(env,
      `/api/v2/tables/${env.NOCO_GROUP_MEMBERS}/records?where=${encodeURIComponent(`(SetId,eq,${s.Id})`)}&fields=Id&limit=1`
    ).then(r2 => r2.ok ? r2.json().then(d => d.pageInfo?.totalRows ?? 0) : 0)
  ));

  // Count groups per set
  const groupCountsArr = await Promise.all(sets.map(s =>
    nocoFetch(env,
      `/api/v2/tables/${env.NOCO_GROUPS}/records?where=${encodeURIComponent(`(SetId,eq,${s.Id})~and(IsDeleted,eq,false)`)}&fields=Id&limit=1`
    ).then(r2 => r2.ok ? r2.json().then(d => d.pageInfo?.totalRows ?? 0) : 0)
  ));

  return json({
    group_sets: sets.map((s, i) => ({
      ...s,
      member_count: countsArr[i],
      group_count: groupCountsArr[i],
    }))
  });
}

// ── GET /api/groups/:id ───────────────────────────────────────
export async function handleGetGroupSet(request, env, { json, path }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  if (!hasGroups(env)) return json({ error: 'Not found' }, 404);

  const setId = path.split('/')[3];
  if (!setId) return json({ error: 'Not found' }, 404);

  const [setR, groupsR, membersR] = await Promise.all([
    nocoFetch(env, `/api/v2/tables/${env.NOCO_GROUP_SETS}/records/${setId}`),
    nocoFetch(env,
      `/api/v2/tables/${env.NOCO_GROUPS}/records?where=${encodeURIComponent(`(SetId,eq,${setId})~and(IsDeleted,eq,false)`)}&limit=200&sort=Name`
    ),
    nocoFetch(env,
      `/api/v2/tables/${env.NOCO_GROUP_MEMBERS}/records?where=${encodeURIComponent(`(SetId,eq,${setId})`)}&limit=500&sort=GroupId`
    ),
  ]);

  if (!setR.ok) return json({ error: 'Không tìm thấy nhóm' }, 404);
  const set = await setR.json();
  const groups = groupsR.ok ? ((await groupsR.json()).list || []) : [];
  const members = membersR.ok ? ((await membersR.json()).list || []) : [];

  // Build groups with their members
  const membersMap = {};
  for (const m of members) {
    if (!membersMap[m.GroupId]) membersMap[m.GroupId] = [];
    membersMap[m.GroupId].push(m);
  }

  return json({
    set,
    groups: groups.map(g => ({
      ...g,
      members: membersMap[g.Id] || [],
      member_count: (membersMap[g.Id] || []).length,
    })),
    total_members: members.length,
  });
}

// ── POST /api/groups ──────────────────────────────────────────
export async function handleCreateGroupSet(request, env, { json }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  if (!isTeacherOrAdmin(session.role)) return json({ error: 'Chỉ giáo viên/admin có thể tạo nhóm' }, 403);
  if (!hasGroups(env)) return json({ error: 'Tính năng nhóm chưa được cấu hình' }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const { course_id, name, description, max_size = 5, self_enroll = false, group_count } = body;
  if (!course_id) return json({ error: 'Thiếu course_id' }, 400);
  if (!name || name.trim().length < 2) return json({ error: 'Tên nhóm ít nhất 2 ký tự' }, 400);

  const now = new Date().toISOString();
  const r = await nocoFetch(env, `/api/v2/tables/${env.NOCO_GROUP_SETS}/records`, 'POST', {
    CourseId: String(course_id),
    Name: name.trim().slice(0, 255),
    Description: (description || '').trim().slice(0, 1000),
    MaxSize: parseInt(max_size) || 5,
    SelfEnroll: !!self_enroll,
    CreatedBy: String(session.userId),
    CreatedAt: now,
    IsDeleted: false,
  });

  if (!r.ok) return json({ error: 'Không thể tạo tập nhóm' }, 502);
  const set = await r.json();
  const setId = set.Id;

  // Auto-create empty named groups if group_count given
  if (group_count && group_count > 0) {
    const count = Math.min(parseInt(group_count), 50);
    await Promise.all(
      Array.from({ length: count }, (_, i) =>
        nocoFetch(env, `/api/v2/tables/${env.NOCO_GROUPS}/records`, 'POST', {
          SetId: String(setId),
          Name: `Nhóm ${i + 1}`,
          IsDeleted: false,
        })
      )
    );
  }

  return json({ ok: true, set_id: setId, set }, 201);
}

// ── POST /api/groups/:id/auto-assign ─────────────────────────
export async function handleAutoAssign(request, env, { json, path }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  if (!isTeacherOrAdmin(session.role)) return json({ error: 'Không có quyền' }, 403);
  if (!hasGroups(env)) return json({ error: 'Not found' }, 404);

  const setId = path.split('/')[3];

  // Get the set info
  const setR = await nocoFetch(env, `/api/v2/tables/${env.NOCO_GROUP_SETS}/records/${setId}`);
  if (!setR.ok) return json({ error: 'Không tìm thấy tập nhóm' }, 404);
  const set = await setR.json();

  // Get all enrolled students in the course
  if (!env.NOCO_ENROLLMENTS) return json({ error: 'Không tìm thấy danh sách học sinh' }, 503);
  const enrR = await nocoFetch(env,
    `/api/v2/tables/${env.NOCO_ENROLLMENTS}/records?where=${encodeURIComponent(`(CourseId,eq,${set.CourseId})~and(Status,eq,active)`)}&fields=UserId,UserName,UserEmail&limit=500`
  );
  if (!enrR.ok) return json({ error: 'Không lấy được danh sách học sinh' }, 502);
  const students = (await enrR.json()).list || [];
  if (students.length === 0) return json({ error: 'Không có học sinh nào trong khóa học', assigned: 0 });

  // Get existing groups
  const groupsR = await nocoFetch(env,
    `/api/v2/tables/${env.NOCO_GROUPS}/records?where=${encodeURIComponent(`(SetId,eq,${setId})~and(IsDeleted,eq,false)`)}&limit=100&sort=Name`
  );
  let groups = groupsR.ok ? ((await groupsR.json()).list || []) : [];

  // Remove already-assigned students
  const existR = await nocoFetch(env,
    `/api/v2/tables/${env.NOCO_GROUP_MEMBERS}/records?where=${encodeURIComponent(`(SetId,eq,${setId})`)}&fields=UserId&limit=500`
  );
  const assignedIds = new Set(
    existR.ok ? ((await existR.json()).list || []).map(m => String(m.UserId)) : []
  );
  const unassigned = students.filter(s => !assignedIds.has(String(s.UserId)));

  if (unassigned.length === 0) return json({ ok: true, message: 'Tất cả học sinh đã được phân nhóm', assigned: 0 });

  // Create more groups if needed
  const maxSize = set.MaxSize || 5;
  const neededGroups = Math.ceil((unassigned.length + assignedIds.size) / maxSize);
  while (groups.length < neededGroups) {
    const r = await nocoFetch(env, `/api/v2/tables/${env.NOCO_GROUPS}/records`, 'POST', {
      SetId: String(setId),
      Name: `Nhóm ${groups.length + 1}`,
      IsDeleted: false,
    });
    if (r.ok) groups.push(await r.json());
    else break;
  }

  // Shuffle students for random assignment
  const shuffled = [...unassigned].sort(() => Math.random() - 0.5);
  const now = new Date().toISOString();
  let assigned = 0;

  await Promise.all(shuffled.map((s, i) => {
    const groupIdx = i % groups.length;
    const group = groups[groupIdx];
    if (!group) return Promise.resolve();
    assigned++;
    return nocoFetch(env, `/api/v2/tables/${env.NOCO_GROUP_MEMBERS}/records`, 'POST', {
      GroupId: String(group.Id),
      SetId: String(setId),
      UserId: String(s.UserId),
      UserName: s.UserName || '',
      UserEmail: s.UserEmail || '',
      JoinedAt: now,
    });
  }));

  return json({ ok: true, assigned, total_students: students.length, groups_count: groups.length });
}

// ── POST /api/groups/:id/join ─────────────────────────────────
export async function handleJoinGroup(request, env, { json, path }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  if (!hasGroups(env)) return json({ error: 'Not found' }, 404);

  const setId = path.split('/')[3];

  const setR = await nocoFetch(env, `/api/v2/tables/${env.NOCO_GROUP_SETS}/records/${setId}`);
  if (!setR.ok) return json({ error: 'Không tìm thấy tập nhóm' }, 404);
  const set = await setR.json();

  if (!set.SelfEnroll && session.role === 'student')
    return json({ error: 'Nhóm này không cho tự gia nhập' }, 403);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const { group_id } = body;
  if (!group_id) return json({ error: 'Thiếu group_id' }, 400);

  // Check already in a group in this set
  const existR = await nocoFetch(env,
    `/api/v2/tables/${env.NOCO_GROUP_MEMBERS}/records?where=${encodeURIComponent(`(SetId,eq,${setId})~and(UserId,eq,${session.userId})`)}&limit=1`
  );
  if (existR.ok) {
    const existData = await existR.json();
    if (existData.list?.length > 0) {
      return json({ error: 'Bạn đã thuộc một nhóm trong tập này. Rời nhóm cũ trước.' }, 409);
    }
  }

  // Check group size
  const memberCountR = await nocoFetch(env,
    `/api/v2/tables/${env.NOCO_GROUP_MEMBERS}/records?where=${encodeURIComponent(`(GroupId,eq,${group_id})`)}&fields=Id&limit=1`
  );
  const currentSize = memberCountR.ok ? ((await memberCountR.json()).pageInfo?.totalRows ?? 0) : 0;
  if (currentSize >= (set.MaxSize || 999)) return json({ error: 'Nhóm đã đầy' }, 409);

  // Get user info
  const now = new Date().toISOString();
  const r = await nocoFetch(env, `/api/v2/tables/${env.NOCO_GROUP_MEMBERS}/records`, 'POST', {
    GroupId: String(group_id),
    SetId: String(setId),
    UserId: String(session.userId),
    UserName: session.email,
    UserEmail: session.email,
    JoinedAt: now,
  });

  if (!r.ok) return json({ error: 'Không thể gia nhập nhóm' }, 502);
  return json({ ok: true });
}

// ── POST /api/groups/:id/leave ────────────────────────────────
export async function handleLeaveGroup(request, env, { json, path }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  if (!hasGroups(env)) return json({ error: 'Not found' }, 404);

  const setId = path.split('/')[3];

  const existR = await nocoFetch(env,
    `/api/v2/tables/${env.NOCO_GROUP_MEMBERS}/records?where=${encodeURIComponent(`(SetId,eq,${setId})~and(UserId,eq,${session.userId})`)}&limit=1`
  );
  if (!existR.ok) return json({ ok: true });
  const existData = await existR.json();
  const member = existData.list?.[0];
  if (!member) return json({ ok: true }); // not in any group

  // Use NocoDB bulk delete by ID
  await nocoFetch(env, `/api/v2/tables/${env.NOCO_GROUP_MEMBERS}/records`, 'DELETE',
    [{ Id: member.Id }]
  );
  return json({ ok: true });
}

// ── POST /api/groups/:setId/create-group ─────────────────────
export async function handleCreateGroup(request, env, { json, path }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  if (!isTeacherOrAdmin(session.role)) return json({ error: 'Không có quyền' }, 403);
  if (!hasGroups(env)) return json({ error: 'Not found' }, 404);

  const setId = path.split('/')[3];

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const { name } = body;
  if (!name || name.trim().length < 1) return json({ error: 'Thiếu tên nhóm' }, 400);

  const r = await nocoFetch(env, `/api/v2/tables/${env.NOCO_GROUPS}/records`, 'POST', {
    SetId: String(setId),
    Name: name.trim().slice(0, 100),
    IsDeleted: false,
  });
  if (!r.ok) return json({ error: 'Không thể tạo nhóm' }, 502);
  return json({ ok: true, group: await r.json() }, 201);
}

// ── DELETE /api/groups/:id ────────────────────────────────────
export async function handleDeleteGroupSet(request, env, { json, path }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  if (!isTeacherOrAdmin(session.role)) return json({ error: 'Không có quyền xoá' }, 403);
  if (!hasGroups(env)) return json({ error: 'Not found' }, 404);

  const setId = path.split('/')[3];
  await nocoFetch(env, `/api/v2/tables/${env.NOCO_GROUP_SETS}/records/${setId}`, 'PATCH', { IsDeleted: true });
  return json({ ok: true });
}
