import { getPool } from '../config-sql/database.js';
import { getPool as getSecondaryPool } from '../config-sql/database-secondary.js';
import { v4 as uuidv4 } from 'uuid';
import { buildHrmsEmployeeMetaByReferenceKeys } from './user.controller.js';
import { successResponse, errorResponse } from '../utils/response.util.js';
import { decryptSensitiveValue } from '../utils/encryption.util.js';
import { syncToSecondaryDatabase, warnIfSecondaryStudentSyncMissed } from '../utils/studentSync.util.js';
import { buildJoiningReservationMeta } from '../utils/casteCatalog.util.js';
import { updatePerformanceMetric } from '../services/userPerformance.service.js';
import smsService from '../services/sms.service.js';
import {
  normalizeMobileDigits,
  suggestPreferredMobileDigits,
} from '../utils/parentPhone.util.js';
import ExcelJS from 'exceljs';
import {
  FATHER_PHOTO_REG_KEYS,
  MOTHER_PHOTO_REG_KEYS,
  STUDENT_PHOTO_REG_KEYS,
  extractPortraitPhotosFromRegistrationFormData,
  preferIntactPortraitPhoto,
} from '../utils/joiningParentPhotos.util.js';
import {
  formatBtechCourseDisplayName,
  isBtechCourseName,
  resolveBtechCourseDisplayName,
  SQL_A_BTECH_LATERAL_TRACK,
  SQL_BTECH_LATERAL_TRACK,
  SQL_COURSE_DISPLAY_NAME,
} from '../utils/lateralBatch.util.js';
import { resolveSecondaryManagedIds, pickSecondaryBranchDisplayLabel } from '../data/admissionsCourseBranchMap2026.js';
import {
  readReference1FromDynamicFields,
  resolveAdmissionReference1,
  renameReferenceNameGlobally,
  hideReferenceNameFromPicker,
  clearReferenceNameGlobally,
  getReferenceNameUsage,
} from '../utils/joiningReference.util.js';
import {
  communicationAddressFromSqlRow,
  normalizeCommunicationAddress,
  relativeAddressFromSqlRow,
} from '../utils/joiningAddress.util.js';
import {
  buildTuitionAndOtherFeeSummariesForAdmissionRows,
  fetchPaidByAdmissionRowsForDesk,
  fetchTuitionPaidByAdmissionNumbers,
} from '../utils/tuitionPaid.util.js';
import {
  applyMinimumFeeAmountsToPendingRow,
  FEE_UNPAID_TOLERANCE,
  isFeeStillPending,
  loadMinimumFeeConfigs,
  resolveMinimumFeeAmount,
} from '../utils/minimumFee.util.js';
import { buildHasStepFourRevisedFeeEntriesByAdmissionRows } from '../utils/overallConcessions.util.js';
import {
  SQL_IS_CONV_QUOTA,
  SQL_IS_MANG_QUOTA,
  SQL_IS_SPOT_QUOTA,
  SQL_IS_LATER_QUOTA,
  SQL_IS_LSPOT_QUOTA,
} from '../utils/quotaClassification.util.js';
import {
  isDirectReference,
  JOINING_FORM_DIRECT_SOURCE,
  JOINING_FORM_DEFAULT_SOURCE,
} from '../utils/joiningFormSource.util.js';
import {
  getCertificateItemsForLevel,
  loadCertificateConfigRoot,
  pendingImportantDocumentLabels,
} from '../utils/certificateConfig.util.js';

const normCourseBranchLabel = (value) =>
  String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/[\s._\-/&,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const ensureLeadId = (leadId) => {
  if (!leadId || typeof leadId !== 'string' || leadId.length !== 36) {
    const error = new Error('Invalid lead identifier');
    error.statusCode = 400;
    throw error;
  }
};

const ensureAdmissionId = (admissionId) => {
  if (!admissionId || typeof admissionId !== 'string' || admissionId.length !== 36) {
    const error = new Error('Invalid admission identifier');
    error.statusCode = 400;
    throw error;
  }
};

const ADMISSION_CANCELLED_STATUS = 'Admission Cancelled';

/** In-memory caches for admission desk reads (stats labels, intake map, list counts). */
const admissionQueryCache = new Map();
const ADMISSION_CACHE_TTL = {
  statsAuxMs: Number(process.env.ADMISSION_STATS_AUX_CACHE_MS || 120000),
  collegeCoursesMs: Number(process.env.ADMISSION_COLLEGE_COURSES_CACHE_MS || 300000),
  listCountMs: Number(process.env.ADMISSION_LIST_COUNT_CACHE_MS || 15000),
};

const stableStringify = (value) => {
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${k}:${stableStringify(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
};

const getAdmissionCached = (key) => {
  const entry = admissionQueryCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    admissionQueryCache.delete(key);
    return null;
  }
  return entry.value;
};

const setAdmissionCached = (key, value, ttlMs) => {
  admissionQueryCache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
  });
};

const clearAdmissionQueryCache = () => {
  admissionQueryCache.clear();
};

/** Persist DOB as DD-MM-YYYY (same as joinings) whether the client sends YYYY-MM-DD or DD-MM-YYYY. */
const normalizeStudentDobForStorage = (value) => {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [year, month, day] = raw.split('-');
    return `${day}-${month}-${year}`;
  }
  const dmy = raw.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (dmy) {
    return `${dmy[1].padStart(2, '0')}-${dmy[2].padStart(2, '0')}-${dmy[3]}`;
  }
  return raw;
};

const getAdmissionCachedCount = async (pool, sql, params, ttlMs, scopeKey) => {
  const key = `admission-count:${scopeKey}:${sql}:${stableStringify(params)}`;
  const cached = getAdmissionCached(key);
  if (cached !== null) return cached;
  const [rows] = await pool.execute(sql, params);
  const raw = rows?.[0]?.total ?? 0;
  const count = typeof raw === 'bigint' ? Number(raw) : Number(raw || 0);
  setAdmissionCached(key, count, ttlMs);
  return count;
};

/** Abstract sheet "Active" column — only enrolled students, not withdrawn. */
const SQL_IS_ACTIVE_ADMISSION = `status = 'active'`;
const SQL_IS_CANCELLED_ADMISSION = `status = '${ADMISSION_CANCELLED_STATUS}'`;
/** Qualification Merit Yes/No from joining form (`qualification_merit`: 1 = Yes, 0 = No). */
const SQL_IS_MERIT_YES = 'qualification_merit = 1';
const SQL_IS_MERIT_NO = 'qualification_merit = 0';
/** Abstract Merit column — active admissions only (excludes withdrawn and cancelled). */
const SQL_ABSTRACT_MERIT_YES = `${SQL_IS_MERIT_YES} AND ${SQL_IS_ACTIVE_ADMISSION}`;
const SQL_ABSTRACT_MERIT_NO = `${SQL_IS_MERIT_NO} AND ${SQL_IS_ACTIVE_ADMISSION}`;
/** Abstract display only: lateral entry → Convenor; lateral spot → Management (no DB / quota changes). */
const SQL_ABSTRACT_CQ_ADMITTED = `(${SQL_IS_CONV_QUOTA} OR ${SQL_IS_LATER_QUOTA})`;
const SQL_ABSTRACT_MQ_ADMITTED = `(${SQL_IS_MANG_QUOTA} OR ${SQL_IS_LSPOT_QUOTA})`;

const parseBranchMetadataObject = (metadata) => {
  if (!metadata) return null;
  if (typeof metadata === 'string') {
    try {
      const parsed = JSON.parse(metadata);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }
  return typeof metadata === 'object' ? metadata : null;
};

const readIntakeFromMetadata = (metadata, kind) => {
  const meta = parseBranchMetadataObject(metadata);
  if (!meta) return null;
  const keys =
    kind === 'cq'
      ? ['cq_intake', 'cqIntake', 'convenor_intake', 'conv_intake', 'CONV_intake']
      : ['mq_intake', 'mqIntake', 'management_intake', 'mang_intake', 'MANG_intake'];
  for (const key of keys) {
    const raw = meta[key];
    if (raw === undefined || raw === null || raw === '') continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
};

const normalizeLateralTrack = (value) => (Number(value) === 1 ? 1 : 0);

const branchIntakeMapKey = (courseId, branchId, lateralTrack = 0) =>
  `${String(courseId ?? '').trim()}::${String(branchId ?? '').trim()}::${normalizeLateralTrack(lateralTrack)}`;

const parseIntakeInput = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return null;
  return n;
};

let admissionBranchIntakeTableReady = false;

const ensureAdmissionBranchIntakeTable = async (pool) => {
  if (admissionBranchIntakeTableReady) return;
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS admission_branch_intake (
      id CHAR(36) PRIMARY KEY,
      course_id VARCHAR(64) NOT NULL DEFAULT '',
      branch_id VARCHAR(64) NOT NULL DEFAULT '',
      lateral_track TINYINT UNSIGNED NOT NULL DEFAULT 0,
      course_name VARCHAR(255) NOT NULL DEFAULT '',
      branch_name VARCHAR(255) NOT NULL DEFAULT '',
      cq_intake INT UNSIGNED NULL DEFAULT NULL,
      mq_intake INT UNSIGNED NULL DEFAULT NULL,
      updated_by CHAR(36) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_admission_branch_intake_ids (course_id, branch_id, lateral_track)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  try {
    await pool.execute(`
      ALTER TABLE admission_branch_intake
      ADD COLUMN lateral_track TINYINT UNSIGNED NOT NULL DEFAULT 0 AFTER branch_id
    `);
  } catch (err) {
    if (!/duplicate column/i.test(String(err?.message || err))) throw err;
  }
  try {
    await pool.execute(
      'ALTER TABLE admission_branch_intake DROP INDEX uq_admission_branch_intake_ids'
    );
  } catch (err) {
    if (!/check that it exists|can't drop|1091/i.test(String(err?.message || err))) throw err;
  }
  try {
    await pool.execute(`
      ALTER TABLE admission_branch_intake
      ADD UNIQUE KEY uq_admission_branch_intake_ids (course_id, branch_id, lateral_track)
    `);
  } catch (err) {
    if (!/duplicate key name|1061/i.test(String(err?.message || err))) throw err;
  }
  admissionBranchIntakeTableReady = true;
};

const loadBranchIntakeMap = async () => {
  const cacheKey = 'admission:branch-intake-map:v2';
  const cached = getAdmissionCached(cacheKey);
  if (cached) return cached;

  const map = new Map();
  const pool = getPool();
  try {
    await ensureAdmissionBranchIntakeTable(pool);
    const [crmRows] = await pool.execute(
      'SELECT course_id, branch_id, lateral_track, cq_intake, mq_intake FROM admission_branch_intake'
    );
    for (const row of crmRows || []) {
      map.set(branchIntakeMapKey(row.course_id, row.branch_id, row.lateral_track), {
        cqIntake: row.cq_intake != null ? Number(row.cq_intake) : null,
        mqIntake: row.mq_intake != null ? Number(row.mq_intake) : null,
      });
    }
  } catch (err) {
    console.error('loadBranchIntakeMap: CRM intake table failed:', err?.message || err);
  }
  try {
    const secondaryPool = getSecondaryPool();
    const [rows] = await secondaryPool.execute('SELECT id, metadata FROM course_branches');
    for (const row of rows || []) {
      const branchOnlyKey = String(row.id);
      if (map.has(branchOnlyKey)) continue;
      map.set(branchOnlyKey, {
        cqIntake: readIntakeFromMetadata(row.metadata, 'cq'),
        mqIntake: readIntakeFromMetadata(row.metadata, 'mq'),
      });
    }
  } catch (err) {
    console.error('loadBranchIntakeMap: secondary course_branches query failed:', err?.message || err);
  }
  setAdmissionCached(cacheKey, map, ADMISSION_CACHE_TTL.statsAuxMs);
  return map;
};

const resolveBranchIntakeFromMap = (map, courseId, branchId, lateralTrack = 0) => {
  const track = normalizeLateralTrack(lateralTrack);
  const byCourseBranch = map.get(branchIntakeMapKey(courseId, branchId, track));
  if (byCourseBranch) return byCourseBranch;
  if (track !== 0) return {};
  const branchOnly = map.get(String(branchId ?? '').trim());
  return branchOnly || {};
};

/** Managed (secondary student-DB) ids win over legacy primary FK columns — matches joining form + catalog. */
const SQL_A_EFF_COURSE_ID = `COALESCE(NULLIF(TRIM(CAST(a.managed_course_id AS CHAR)), ''), NULLIF(TRIM(CAST(a.course_id AS CHAR)), ''))`;
const SQL_A_EFF_BRANCH_ID = `COALESCE(NULLIF(TRIM(CAST(a.managed_branch_id AS CHAR)), ''), NULLIF(TRIM(CAST(a.branch_id AS CHAR)), ''))`;
const SQL_EFF_COURSE_ID = `COALESCE(NULLIF(TRIM(CAST(managed_course_id AS CHAR)), ''), NULLIF(TRIM(CAST(course_id AS CHAR)), ''))`;
const SQL_EFF_BRANCH_ID = `COALESCE(NULLIF(TRIM(CAST(managed_branch_id AS CHAR)), ''), NULLIF(TRIM(CAST(branch_id AS CHAR)), ''))`;

const effectiveAdmissionCourseBranchIds = (row) => {
  const managedCourse = normalizeManagedIdForDb(row?.managed_course_id);
  const managedBranch = normalizeManagedIdForDb(row?.managed_branch_id);
  const primaryCourse =
    row?.course_id != null && String(row.course_id).trim() !== ''
      ? String(row.course_id).trim()
      : null;
  const primaryBranch =
    row?.branch_id != null && String(row.branch_id).trim() !== ''
      ? String(row.branch_id).trim()
      : null;
  return {
    courseId: managedCourse ?? primaryCourse,
    branchId: managedBranch ?? primaryBranch,
  };
};

/** FK columns only when managed id exists in primary `courses` / `branches` (same as joining save). */
const resolvePrimaryCourseBranchFkIds = async (pool, courseId, branchId) => {
  let fkCourseId = null;
  let fkBranchId = null;
  if (courseId != null && String(courseId).trim() !== '') {
    const [pc] = await pool.execute('SELECT id FROM courses WHERE id = ?', [courseId]);
    if (pc.length > 0) fkCourseId = pc[0].id;
  }
  if (branchId != null && String(branchId).trim() !== '') {
    const [pb] = await pool.execute('SELECT id FROM branches WHERE id = ?', [branchId]);
    if (pb.length > 0) fkBranchId = pb[0].id;
  }
  return { fkCourseId, fkBranchId };
};

/** Validate managed ids against secondary DB; fill `admissions.course` / `admissions.branch` labels from catalog. */
const enrichAdmissionCourseInfoFromSecondary = async (courseInfo) => {
  if (!courseInfo || typeof courseInfo !== 'object') return courseInfo;
  const info = { ...courseInfo };
  const lockManagedIds =
    String(info.courseId ?? '').trim() !== '' || String(info.branchId ?? '').trim() !== '';
  let secondaryPool;
  try {
    secondaryPool = getSecondaryPool();
  } catch (err) {
    console.error('enrichAdmissionCourseInfoFromSecondary: secondary pool unavailable:', err?.message || err);
    return info;
  }
  let courseDoc = null;
  let branchDoc = null;

  try {
    if (info.branchId && !info.courseId) {
      const [branches] = await secondaryPool.execute(
        'SELECT id, course_id, name FROM course_branches WHERE id = ? LIMIT 1',
        [info.branchId]
      );
      if (branches.length > 0) {
        branchDoc = branches[0];
        info.courseId = branchDoc.course_id;
      }
    }

    if (info.courseId) {
      const [courses] = await secondaryPool.execute(
        'SELECT id, name FROM courses WHERE id = ? LIMIT 1',
        [info.courseId]
      );
      if (courses.length > 0) {
        courseDoc = courses[0];
        info.courseId = String(courseDoc.id);
        if (!String(info.course || '').trim()) {
          info.course = courseDoc.name || '';
        }
      }
    }

    if (info.branchId) {
      if (!branchDoc) {
        const params = [info.branchId];
        let sql = 'SELECT id, course_id, name, code FROM course_branches WHERE id = ?';
        if (info.courseId) {
          sql += ' AND course_id = ?';
          params.push(info.courseId);
        }
        sql += ' LIMIT 1';
        const [branches] = await secondaryPool.execute(sql, params);
        if (branches.length > 0) branchDoc = branches[0];
      }
      if (branchDoc) {
        info.branchId = String(branchDoc.id);
        // Prefer catalog display name (CSE) over roll/internal code (BCSE).
        const catalogBranch = pickSecondaryBranchDisplayLabel(branchDoc, info.branch);
        if (catalogBranch) {
          info.branch = catalogBranch;
        }
        if (!info.courseId && branchDoc.course_id != null) {
          info.courseId = String(branchDoc.course_id);
        }
      }
    }

    if (courseDoc) {
      const catalogCourse = String(courseDoc.name || '').trim();
      if (catalogCourse) {
        info.course = catalogCourse;
      }
    }

    // Backfill managed ids from labels only when ids are missing (imports / legacy rows).
    // Never remap from lead `course_interested` or stale branch text when managed ids are set.
    const storedCourse = String(info.course || '').trim();
    const storedBranch = String(info.branch || '').trim();
    if (!lockManagedIds && !info.branchId && storedCourse && storedBranch) {
      const mapped = resolveSecondaryManagedIds(storedCourse, storedBranch);
      if (mapped.managedCourseId && mapped.managedBranchId) {
        info.courseId = mapped.managedCourseId;
        info.branchId = mapped.managedBranchId;
        info.course = mapped.course;
        info.branch = mapped.branch;
      } else if (info.courseId) {
        const label = normCourseBranchLabel(storedBranch);
        const [byLabel] = await secondaryPool.execute(
          `SELECT id, course_id, name, code FROM course_branches
           WHERE course_id = ?
             AND (
               UPPER(TRIM(code)) = ?
               OR UPPER(TRIM(name)) = ?
               OR UPPER(TRIM(code)) LIKE CONCAT('%', ?, '%')
             )
           ORDER BY is_active DESC, id ASC
           LIMIT 1`,
          [info.courseId, label, label, label]
        );
        if (byLabel.length > 0) {
          info.branchId = String(byLabel[0].id);
          info.branch =
            pickSecondaryBranchDisplayLabel(byLabel[0], storedBranch) || storedBranch;
        }
      }
    }
  } catch (err) {
    console.error('enrichAdmissionCourseInfoFromSecondary: lookup failed:', err?.message || err);
  }

  return info;
};

/** Sync display labels from managed ids; stale `branch` / `course` text must not override branchId. */
const reconcileAdmissionCourseInfoFromRow = async (row) => {
  const { courseId, branchId } = effectiveAdmissionCourseBranchIds(row);
  const course = String(row.course || '').trim();
  const branch = String(row.branch || '').trim();
  const base = {
    courseId,
    branchId,
    course,
    branch,
    quota: row.quota || '',
  };
  if (!course && !branch) return base;
  return enrichAdmissionCourseInfoFromSecondary(base);
};

/** Managed course ids under a secondary `colleges.id` (for admission filters). */
const loadManagedCourseIdsForCollege = async (collegeId) => {
  const id = String(collegeId ?? '').trim();
  if (!id) return null;

  const cacheKey = `admission:college-courses:${id}`;
  const cached = getAdmissionCached(cacheKey);
  if (cached) return cached;

  try {
    const secondaryPool = getSecondaryPool();
    const [rows] = await secondaryPool.execute(
      'SELECT id FROM courses WHERE college_id = ?',
      [id]
    );
    const courseIds = (rows || []).map((r) => String(r.id ?? '').trim()).filter(Boolean);
    setAdmissionCached(cacheKey, courseIds, ADMISSION_CACHE_TTL.collegeCoursesMs);
    return courseIds;
  } catch (err) {
    console.error('loadManagedCourseIdsForCollege failed:', err?.message || err);
    return [];
  }
};

const appendManagedCollegeCourseFilter = (conditions, params, courseIdExpr, managedCourseIds) => {
  if (managedCourseIds === null) return;
  if (managedCourseIds.length === 0) {
    conditions.push('1 = 0');
    return;
  }
  const placeholders = managedCourseIds.map(() => '?').join(', ');
  conditions.push(`${courseIdExpr} IN (${placeholders})`);
  params.push(...managedCourseIds);
};

const loadSecondaryCourseBranchLabelMaps = async () => {
  const cacheKey = 'admission:secondary-label-maps:v1';
  const cached = getAdmissionCached(cacheKey);
  if (cached) return cached;

  const courses = new Map();
  const branches = new Map();
  try {
    const secondaryPool = getSecondaryPool();
    const [courseRows] = await secondaryPool.execute('SELECT id, name FROM courses');
    for (const row of courseRows || []) {
      const id = String(row.id ?? '').trim();
      const name = String(row.name ?? '').trim();
      if (id && name) courses.set(id, name);
    }
    const [branchRows] = await secondaryPool.execute(
      'SELECT id, name, code FROM course_branches'
    );
    for (const row of branchRows || []) {
      const id = String(row.id ?? '').trim();
      const label = String(row.name || row.code || '').trim();
      if (id && label) branches.set(id, label);
    }
  } catch (err) {
    console.error(
      'loadSecondaryCourseBranchLabelMaps failed:',
      err?.message || err
    );
  }
  const payload = { courses, branches };
  setAdmissionCached(cacheKey, payload, ADMISSION_CACHE_TTL.statsAuxMs);
  return payload;
};

const loadAdmissionBranchIntakeLabelMap = async (pool) => {
  const cacheKey = 'admission:intake-branch-labels:v1';
  const cached = getAdmissionCached(cacheKey);
  if (cached) return cached;

  const map = new Map();
  try {
    await ensureAdmissionBranchIntakeTable(pool);
    const [rows] = await pool.execute(
      'SELECT branch_id, branch_name FROM admission_branch_intake WHERE TRIM(branch_name) != ""'
    );
    for (const row of rows || []) {
      const id = String(row.branch_id ?? '').trim();
      const name = String(row.branch_name ?? '').trim();
      if (id && name) map.set(id, name);
    }
  } catch (err) {
    console.error('loadAdmissionBranchIntakeLabelMap failed:', err?.message || err);
  }
  setAdmissionCached(cacheKey, map, ADMISSION_CACHE_TTL.statsAuxMs);
  return map;
};

const resolveStatsBranchDisplayName = (row, secondaryLabels, intakeBranchLabels) => {
  const branchId = String(row.branchId || '').trim();
  if (branchId) {
    const fromCatalog =
      secondaryLabels.branches.get(branchId) || intakeBranchLabels.get(branchId);
    if (fromCatalog) return fromCatalog;
  }
  return String(row.branchName || '').trim();
};

/** Lead-group / 2026 import labels — not secondary catalog course names. */
const GENERIC_IMPORT_COURSE_LABELS = new Set([
  'degree',
  'diploma',
  'inter',
  '10th',
  '10+2',
  'others',
  'dap-ptv',
]);

const isGenericImportCourseLabel = (name) => {
  const n = String(name || '').trim().toLowerCase();
  return !n || GENERIC_IMPORT_COURSE_LABELS.has(n);
};

/** Managed branch id → Fee Portal / UI display name (CSE), never roll code (BCSE). */
const loadManagedBranchDisplayLabels = async (managedBranchIds) => {
  const ids = [
    ...new Set(
      (Array.isArray(managedBranchIds) ? managedBranchIds : [])
        .map((id) => String(id ?? '').trim())
        .filter(Boolean)
    ),
  ];
  const map = new Map();
  if (!ids.length) return map;
  try {
    const secondaryPool = getSecondaryPool();
    const marks = ids.map(() => '?').join(',');
    const [rows] = await secondaryPool.execute(
      `SELECT id, name, code FROM course_branches WHERE id IN (${marks})`,
      ids
    );
    for (const row of rows || []) {
      const label = pickSecondaryBranchDisplayLabel(row);
      if (label) map.set(String(row.id), label);
    }
  } catch (err) {
    console.warn('[loadManagedBranchDisplayLabels]', err?.message || err);
  }
  return map;
};

/** Prefer catalog branch name on admission/joining rows that still store the code. */
const applyManagedBranchDisplayLabels = (rows, labelByManagedId) => {
  if (!labelByManagedId?.size) return rows;
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const managedId = String(row?.managed_branch_id ?? '').trim();
    const label = managedId ? labelByManagedId.get(managedId) : '';
    if (!label) return row;
    const current = String(row?.branch ?? '').trim();
    if (!current || current.toUpperCase() === label.toUpperCase()) {
      return current ? row : { ...row, branch: label };
    }
    // Replace roll/internal code with catalog name when they differ.
    return { ...row, branch: label };
  });
};

/** Prefer secondary `courses.name` when admission text is a generic import label (e.g. "Degree"). */
const resolveStatsCourseDisplayName = (row, secondaryLabels) => {
  const courseId = String(row.courseId || '').trim();
  const fromStored = String(row.courseName || '').trim();
  let label = fromStored;
  if (courseId) {
    const fromCatalog = secondaryLabels.courses.get(courseId);
    if (!fromCatalog) {
      label = fromStored;
    } else if (!fromStored || isGenericImportCourseLabel(fromStored)) {
      label = fromCatalog;
    } else if (/\(lateral\)/i.test(fromStored) && !/\(lateral\)/i.test(fromCatalog)) {
      label = fromStored;
    } else {
      label = fromCatalog;
    }
  }
  const lateral = Number(row.lateralTrack) === 1;
  if (isBtechCourseName(label)) {
    const base = label.replace(/\s*\(lateral\)\s*/gi, '').trim() || label;
    return formatBtechCourseDisplayName(base, lateral) || base;
  }
  return label;
};

const syncLinkedJoiningCourseInfo = async (pool, joiningId, courseInfo, userId) => {
  if (!joiningId || !courseInfo || typeof courseInfo !== 'object') return;
  const { fkCourseId, fkBranchId } = await resolvePrimaryCourseBranchFkIds(
    pool,
    courseInfo.courseId,
    courseInfo.branchId
  );
  const managedCourseId = normalizeManagedIdForDb(courseInfo.courseId);
  const managedBranchId = normalizeManagedIdForDb(courseInfo.branchId);
  await pool.execute(
    `UPDATE joinings SET
      course_id = ?,
      branch_id = ?,
      managed_course_id = ?,
      managed_branch_id = ?,
      course = ?,
      branch = ?,
      quota = COALESCE(?, quota),
      lead_data = JSON_SET(
        COALESCE(CASE WHEN JSON_VALID(lead_data) THEN lead_data ELSE JSON_OBJECT() END, JSON_OBJECT()),
        '$._joiningManagedCourseId', ?,
        '$._joiningManagedBranchId', ?
      ),
      updated_by = ?,
      updated_at = NOW()
    WHERE id = ?`,
    [
      fkCourseId,
      fkBranchId,
      managedCourseId,
      managedBranchId,
      courseInfo.course || '',
      courseInfo.branch || '',
      courseInfo.quota !== undefined ? courseInfo.quota || '' : null,
      managedCourseId,
      managedBranchId,
      userId || null,
      joiningId,
    ]
  );
};

/**
 * Keep registration college fields in sync with the managed course's secondary college.
 * Without this, Update Admission can change course/branch while college_id in
 * `_joiningRegistrationExtras` stays on the previous campus — Edit Application then shows the old college.
 */
const persistCollegeExtrasFromManagedCourse = async (
  pool,
  admissionId,
  joiningId,
  managedCourseId,
  userId
) => {
  const courseKey = normalizeManagedIdForDb(managedCourseId);
  if (!courseKey) return;

  let collegeId = null;
  let collegeName = '';
  try {
    const secondaryPool = getSecondaryPool();
    const [courseRows] = await secondaryPool.execute(
      'SELECT college_id FROM courses WHERE id = ? LIMIT 1',
      [courseKey]
    );
    if (!courseRows.length || courseRows[0].college_id == null) return;
    collegeId = String(courseRows[0].college_id).trim();
    if (!collegeId) return;
    const [collegeRows] = await secondaryPool.execute(
      'SELECT name FROM colleges WHERE id = ? LIMIT 1',
      [collegeId]
    );
    collegeName = String(collegeRows[0]?.name || '').trim();
  } catch (err) {
    console.warn(
      'persistCollegeExtrasFromManagedCourse: secondary lookup failed:',
      err?.message || err
    );
    return;
  }

  const patchExtras = (prevExtras) => ({
    ...(prevExtras && typeof prevExtras === 'object' ? prevExtras : {}),
    college_id: collegeId,
    collegeId,
    school_or_college_id: collegeId,
    schoolOrCollegeId: collegeId,
    school_or_college_name: collegeName,
    college: collegeName,
  });

  const [admRows] = await pool.execute(
    'SELECT id, lead_data FROM admissions WHERE id = ? LIMIT 1',
    [admissionId]
  );
  if (admRows.length) {
    let admLd =
      typeof admRows[0].lead_data === 'string'
        ? JSON.parse(admRows[0].lead_data || '{}')
        : admRows[0].lead_data || {};
    if (!admLd || typeof admLd !== 'object') admLd = {};
    const nextLd = {
      ...admLd,
      _joiningRegistrationExtras: patchExtras(admLd._joiningRegistrationExtras),
    };
    await pool.execute(
      `UPDATE admissions SET lead_data = ?, updated_by = ?, updated_at = NOW() WHERE id = ?`,
      [JSON.stringify(nextLd), userId || null, admissionId]
    );
  }

  if (!joiningId) return;
  const [joiningRows] = await pool.execute(
    'SELECT id, lead_data, managed_course_id, managed_branch_id FROM joinings WHERE id = ? LIMIT 1',
    [joiningId]
  );
  if (!joiningRows.length) return;
  let jLd =
    typeof joiningRows[0].lead_data === 'string'
      ? JSON.parse(joiningRows[0].lead_data || '{}')
      : joiningRows[0].lead_data || {};
  if (!jLd || typeof jLd !== 'object') jLd = {};
  const jNextLd = {
    ...jLd,
    _joiningManagedCourseId:
      normalizeManagedIdForDb(joiningRows[0].managed_course_id) || courseKey,
    _joiningManagedBranchId: normalizeManagedIdForDb(joiningRows[0].managed_branch_id),
    _joiningRegistrationExtras: patchExtras(jLd._joiningRegistrationExtras),
  };
  await pool.execute(
    `UPDATE joinings SET lead_data = ?, updated_by = ?, updated_at = NOW() WHERE id = ?`,
    [JSON.stringify(jNextLd), userId || null, joiningId]
  );
};

/** Dedicated UPDATE for managed course/branch — never skipped by the generic dynamic UPDATE guard. */
export const persistAdmissionCourseBranchUpdate = async (
  pool,
  admissionId,
  courseInfo,
  userId,
  joiningId = null
) => {
  const courseFields = [];
  const courseParams = [];
  await applyAdmissionCourseInfoUpdates(pool, courseInfo, courseFields, courseParams);
  if (courseFields.length === 0) return;
  courseFields.push('updated_by = ?', 'updated_at = NOW()');
  courseParams.push(userId || null, admissionId);
  await pool.execute(
    `UPDATE admissions SET ${courseFields.join(', ')} WHERE id = ?`,
    courseParams
  );
  await persistAdmissionManagedIdsInLeadData(pool, admissionId, courseInfo);
  if (joiningId) {
    await syncLinkedJoiningCourseInfo(pool, joiningId, courseInfo, userId);
  }
  await persistCollegeExtrasFromManagedCourse(
    pool,
    admissionId,
    joiningId,
    courseInfo.courseId,
    userId
  );

  // Keep CRM lead interest in sync so lists / edit-application fallbacks are not stale.
  const [admLead] = await pool.execute(
    'SELECT lead_id FROM admissions WHERE id = ? LIMIT 1',
    [admissionId]
  );
  const leadId = admLead[0]?.lead_id;
  if (leadId) {
    const courseName = String(courseInfo.course || '').trim();
    const branchName = String(courseInfo.branch || '').trim();
    const courseInterested =
      courseName && branchName
        ? `${courseName} - ${branchName}`
        : courseName || branchName || null;
    if (courseInterested) {
      await pool.execute(
        `UPDATE leads SET course_interested = ?, updated_at = NOW() WHERE id = ?`,
        [courseInterested, leadId]
      );
    }
  }
};

const resolveAdmissionRowByRouteParam = async (pool, paramId) => {
  const [byLead] = await pool.execute('SELECT * FROM admissions WHERE lead_id = ? LIMIT 1', [paramId]);
  if (byLead.length > 0) return byLead[0];
  const [byJoining] = await pool.execute(
    'SELECT * FROM admissions WHERE joining_id = ? ORDER BY updated_at DESC LIMIT 1',
    [paramId]
  );
  if (byJoining.length > 0) return byJoining[0];
  const [byId] = await pool.execute('SELECT * FROM admissions WHERE id = ? LIMIT 1', [paramId]);
  return byId[0] || null;
};

/** Valid JSON object for lead_data on admissions (alias `a`). */
const SQL_A_LEAD_DATA_JSON = `COALESCE(CASE WHEN JSON_VALID(a.lead_data) THEN a.lead_data ELSE JSON_OBJECT() END, JSON_OBJECT())`;
/** Excel / student Reference 1 from lead_data. */
const SQL_A_REFERENCE1 = `NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(${SQL_A_LEAD_DATA_JSON}, '$.reference1'))), '')`;
/** Joining / lead fallbacks for reports (requires LEFT JOIN j, l on admissions queries). */
const SQL_J_LEAD_DATA_JSON = `COALESCE(CASE WHEN JSON_VALID(j.lead_data) THEN j.lead_data ELSE JSON_OBJECT() END, JSON_OBJECT())`;
const SQL_J_REFERENCE1 = `NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(${SQL_J_LEAD_DATA_JSON}, '$.reference1'))), '')`;
const SQL_L_DYNAMIC_JSON = `COALESCE(CASE WHEN JSON_VALID(l.dynamic_fields) THEN l.dynamic_fields ELSE JSON_OBJECT() END, JSON_OBJECT())`;
const SQL_L_REFERENCE1 = `NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(${SQL_L_DYNAMIC_JSON}, '$.reference1'))), '')`;
/** Resolved Reference 1 for an admission row (admission → joining → CRM lead). */
const SQL_A_EFFECTIVE_REFERENCE1 = `COALESCE(${SQL_A_REFERENCE1}, ${SQL_J_REFERENCE1}, ${SQL_L_REFERENCE1})`;
const SQL_ADMISSION_PIVOT_JOINS = `LEFT JOIN joinings j ON j.id = a.joining_id LEFT JOIN leads l ON l.id = a.lead_id`;
/** Business admission date; falls back to record created_at when not set. */
const SQL_A_EFFECTIVE_ADMISSION_DATE = `COALESCE(a.admission_date, a.created_at)`;

const normalizeManagedIdForDb = (value) => {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
};

const parseAdmissionLeadData = (value) => {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' ? value : {};
};

const APPLICATION_EDIT_HISTORY_KEY = '_applicationEditHistory';
const APPLICATION_EDIT_HISTORY_MAX = 200;

const normalizeHistoryActorName = (name, fallbackId) => {
  const named = String(name || '').trim();
  if (named) return named;
  const id = String(fallbackId || '').trim();
  if (!id || /^[0-9a-f-]{36}$/i.test(id)) return '';
  return id;
};

const readApplicationEditHistory = (leadData) => {
  const raw = leadData?.[APPLICATION_EDIT_HISTORY_KEY];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => ({
      id: String(entry.id || '').trim() || uuidv4(),
      kind: String(entry.kind || 'update').trim() || 'update',
      title: String(entry.title || 'Application updated').trim() || 'Application updated',
      description: String(entry.description || '').trim(),
      performedById: entry.performedById ? String(entry.performedById) : null,
      performedByName: String(entry.performedByName || '').trim(),
      at: entry.at ? String(entry.at) : null,
      statusFrom: entry.statusFrom != null ? String(entry.statusFrom) : null,
      statusTo: entry.statusTo != null ? String(entry.statusTo) : null,
      referenceFrom:
        Object.prototype.hasOwnProperty.call(entry, 'referenceFrom')
          ? String(entry.referenceFrom ?? '').trim()
          : null,
      referenceTo:
        Object.prototype.hasOwnProperty.call(entry, 'referenceTo')
          ? String(entry.referenceTo ?? '').trim()
          : null,
      source: String(entry.source || 'admission').trim() || 'admission',
    }))
    .filter((entry) => entry.at);
};

const isReferenceHistoryEvent = (event) => {
  if (!event) return false;
  const kind = String(event.kind || '').toLowerCase();
  if (kind === 'reference_change' || kind === 'reference') return true;
  if (event.referenceFrom != null || event.referenceTo != null) return true;
  const title = String(event.title || '').toLowerCase();
  if (title.includes('reference updated') || title.includes('reference changed')) return true;
  const description = String(event.description || '').toLowerCase();
  return description.includes('admission reference changed');
};

/** Append an application edit event onto admissions.lead_data (and activity_logs when lead exists). */
const appendAdmissionApplicationEditHistory = async (
  pool,
  {
    admissionId,
    leadId,
    userId,
    userName,
    title,
    description = '',
    kind = 'update',
    statusFrom = null,
    statusTo = null,
    referenceFrom = null,
    referenceTo = null,
  }
) => {
  if (!admissionId || !userId) return;
  try {
    const [rows] = await pool.execute(
      'SELECT id, lead_id, lead_data FROM admissions WHERE id = ? LIMIT 1',
      [admissionId]
    );
    if (!rows.length) return;
    const row = rows[0];
    const resolvedLeadId = leadId || row.lead_id || null;
    let resolvedName = normalizeHistoryActorName(userName, userId);
    if (!resolvedName) {
      const [users] = await pool.execute('SELECT name FROM users WHERE id = ? LIMIT 1', [userId]);
      resolvedName = String(users?.[0]?.name || '').trim();
    }

    const normalizedReferenceFrom =
      referenceFrom === undefined || referenceFrom === null
        ? null
        : String(referenceFrom).trim();
    const normalizedReferenceTo =
      referenceTo === undefined || referenceTo === null
        ? null
        : String(referenceTo).trim();

    const entry = {
      id: uuidv4(),
      kind,
      title: String(title || 'Application updated').trim(),
      description: String(description || '').trim(),
      performedById: userId,
      performedByName: resolvedName,
      at: new Date().toISOString(),
      statusFrom: statusFrom || null,
      statusTo: statusTo || null,
      ...(normalizedReferenceFrom !== null || normalizedReferenceTo !== null || kind === 'reference_change'
        ? {
            referenceFrom: normalizedReferenceFrom ?? '',
            referenceTo: normalizedReferenceTo ?? '',
          }
        : {}),
      source: 'admission',
    };

    const leadData = parseAdmissionLeadData(row.lead_data);
    const history = readApplicationEditHistory(leadData);
    history.push(entry);
    const nextLeadData = {
      ...leadData,
      [APPLICATION_EDIT_HISTORY_KEY]: history.slice(-APPLICATION_EDIT_HISTORY_MAX),
    };

    await pool.execute(
      `UPDATE admissions SET lead_data = ?, updated_by = ?, updated_at = NOW() WHERE id = ?`,
      [JSON.stringify(nextLeadData), userId, admissionId]
    );

    if (resolvedLeadId) {
      try {
        await pool.execute(
          `INSERT INTO activity_logs (id, lead_id, type, performed_by, comment, metadata, created_at, updated_at)
           VALUES (?, ?, 'joining_update', ?, ?, ?, NOW(), NOW())`,
          [
            uuidv4(),
            resolvedLeadId,
            userId,
            entry.title,
            JSON.stringify({
              admissionId,
              kind: entry.kind,
              description: entry.description || null,
              statusFrom: entry.statusFrom,
              statusTo: entry.statusTo,
              referenceFrom: entry.referenceFrom,
              referenceTo: entry.referenceTo,
              source: 'admission_application_history',
            }),
          ]
        );
      } catch (activityError) {
        console.error('Failed to append admission activity log:', activityError);
      }
    }
  } catch (error) {
    console.error('Failed to append admission application edit history:', error);
  }
};

const resolveUserNamesByIds = async (pool, ids) => {
  const unique = [
    ...new Set(
      (ids || [])
        .map((id) => (id == null ? '' : String(id).trim()))
        .filter(Boolean)
    ),
  ];
  if (!unique.length) return {};
  const [rows] = await pool.execute(
    `SELECT id, name FROM users WHERE id IN (${unique.map(() => '?').join(',')})`,
    unique
  );
  return Object.fromEntries(
    (rows || []).map((row) => [String(row.id), String(row.name || '').trim()])
  );
};

const pushTimelineEvent = (events, event) => {
  if (!event?.at) return;
  events.push({
    id: String(event.id || uuidv4()),
    kind: String(event.kind || 'update'),
    title: String(event.title || 'Application update'),
    description: String(event.description || '').trim(),
    performedById: event.performedById || null,
    performedByName: String(event.performedByName || '').trim() || '—',
    at: event.at,
    statusFrom: event.statusFrom || null,
    statusTo: event.statusTo || null,
    referenceFrom: Object.prototype.hasOwnProperty.call(event, 'referenceFrom')
      ? String(event.referenceFrom ?? '').trim()
      : event.referenceFrom != null && String(event.referenceFrom).trim() !== ''
        ? String(event.referenceFrom).trim()
        : null,
    referenceTo: Object.prototype.hasOwnProperty.call(event, 'referenceTo')
      ? String(event.referenceTo ?? '').trim()
      : event.referenceTo != null && String(event.referenceTo).trim() !== ''
        ? String(event.referenceTo).trim()
        : null,
    source: String(event.source || 'system'),
  });
};

/**
 * Timeline of application changes from initial entry through latest updates.
 * Combines joining milestones, admission milestones, stored edit history, and joining_update activity logs.
 * Optional query: ?scope=reference — only reference change events.
 */
export const getAdmissionApplicationHistory = async (req, res) => {
  try {
    const { admissionId } = req.params;
    ensureAdmissionId(admissionId);
    const scope = String(req.query?.scope || '').trim().toLowerCase();
    const referenceOnly = scope === 'reference' || scope === 'references';

    const pool = getPool();
    const [admissions] = await pool.execute(
      'SELECT * FROM admissions WHERE id = ? LIMIT 1',
      [admissionId]
    );
    if (!admissions.length) {
      return errorResponse(res, 'Admission record not found', 404);
    }

    const admission = admissions[0];
    const leadData = parseAdmissionLeadData(admission.lead_data);
    let joining = null;
    if (admission.joining_id) {
      const [joiningRows] = await pool.execute(
        'SELECT * FROM joinings WHERE id = ? LIMIT 1',
        [admission.joining_id]
      );
      joining = joiningRows[0] || null;
    }

    const actorIds = [
      admission.created_by,
      admission.updated_by,
      joining?.created_by,
      joining?.updated_by,
      joining?.submitted_by,
      joining?.approved_by,
      leadData?._admissionCancellation?.cancelledBy,
    ];
    const storedHistory = readApplicationEditHistory(leadData);
    for (const entry of storedHistory) {
      if (entry.performedById) actorIds.push(entry.performedById);
    }

    let activityRows = [];
    if (admission.lead_id) {
      const [logs] = await pool.execute(
        `SELECT a.id, a.type, a.comment, a.metadata, a.created_at, a.old_status, a.new_status,
                a.performed_by, u.name AS performed_by_name
         FROM activity_logs a
         LEFT JOIN users u ON a.performed_by = u.id
         WHERE a.lead_id = ?
           AND a.type IN ('joining_update', 'field_update', 'status_change')
         ORDER BY a.created_at ASC
         LIMIT 500`,
        [admission.lead_id]
      );
      activityRows = logs || [];
      for (const log of activityRows) {
        if (log.performed_by) actorIds.push(log.performed_by);
      }
    }

    const nameById = await resolveUserNamesByIds(pool, actorIds);
    const events = [];

    if (!referenceOnly) {
      if (joining?.created_at) {
        pushTimelineEvent(events, {
          id: `joining-created-${joining.id}`,
          kind: 'initial',
          title: 'Initial application entry',
          description: 'Joining application first created',
          performedById: joining.created_by || null,
          performedByName:
            nameById[String(joining.created_by || '')] ||
            normalizeHistoryActorName('', joining.created_by),
          at: joining.created_at,
          source: 'joining',
        });
      }

      if (joining?.submitted_at) {
        pushTimelineEvent(events, {
          id: `joining-submitted-${joining.id}`,
          kind: 'submitted',
          title: 'Application submitted for approval',
          performedById: joining.submitted_by || null,
          performedByName:
            nameById[String(joining.submitted_by || '')] ||
            normalizeHistoryActorName('', joining.submitted_by),
          at: joining.submitted_at,
          statusTo: 'pending_approval',
          source: 'joining',
        });
      }

      if (joining?.approved_at) {
        pushTimelineEvent(events, {
          id: `joining-approved-${joining.id}`,
          kind: 'approved',
          title: 'Application approved',
          description: 'Joining approved and admission created',
          performedById: joining.approved_by || null,
          performedByName:
            nameById[String(joining.approved_by || '')] ||
            normalizeHistoryActorName('', joining.approved_by),
          at: joining.approved_at,
          statusTo: 'approved',
          source: 'joining',
        });
      }

      if (admission.created_at) {
        const alreadyHaveJoiningCreated =
          joining?.created_at &&
          Math.abs(new Date(admission.created_at).getTime() - new Date(joining.created_at).getTime()) <
            2000;
        if (!alreadyHaveJoiningCreated || !joining?.created_at) {
          pushTimelineEvent(events, {
            id: `admission-created-${admission.id}`,
            kind: joining?.created_at ? 'approved' : 'initial',
            title: joining?.created_at ? 'Admission record created' : 'Initial admission entry',
            performedById: admission.created_by || null,
            performedByName:
              nameById[String(admission.created_by || '')] ||
              normalizeHistoryActorName('', admission.created_by),
            at: admission.created_at,
            source: 'admission',
          });
        }
      }
    }

    for (const entry of storedHistory) {
      if (referenceOnly && !isReferenceHistoryEvent(entry)) continue;
      pushTimelineEvent(events, {
        ...entry,
        performedByName:
          entry.performedByName ||
          nameById[String(entry.performedById || '')] ||
          '—',
      });
    }

    for (const log of activityRows) {
      let metadata = {};
      if (log.metadata) {
        try {
          metadata =
            typeof log.metadata === 'string' ? JSON.parse(log.metadata) : log.metadata || {};
        } catch {
          metadata = {};
        }
      }
      // Skip duplicates already recorded into admission edit history.
      if (metadata?.source === 'admission_application_history') continue;

      const activityEvent = {
        id: `activity-${log.id}`,
        kind: log.type === 'status_change' ? 'status_change' : 'update',
        title: String(log.comment || 'Application updated').trim() || 'Application updated',
        description:
          metadata?.description ||
          (metadata?.statusFrom || metadata?.statusTo
            ? `Status ${metadata.statusFrom || log.old_status || '—'} → ${
                metadata.statusTo || log.new_status || '—'
              }`
            : ''),
        performedById: log.performed_by || null,
        performedByName:
          String(log.performed_by_name || '').trim() ||
          nameById[String(log.performed_by || '')] ||
          '—',
        at: log.created_at,
        statusFrom: metadata.statusFrom || log.old_status || null,
        statusTo: metadata.statusTo || log.new_status || null,
        referenceFrom: metadata.referenceFrom || null,
        referenceTo: metadata.referenceTo || null,
        source: 'activity_log',
      };
      if (referenceOnly && !isReferenceHistoryEvent(activityEvent)) continue;
      pushTimelineEvent(events, activityEvent);
    }

    if (!referenceOnly) {
      const cancellation = leadData?._admissionCancellation;
      if (cancellation?.cancelledAt) {
        pushTimelineEvent(events, {
          id: `admission-cancelled-${admission.id}`,
          kind: 'cancelled',
          title: 'Admission cancelled',
          description: String(cancellation.reason || '').trim(),
          performedById: cancellation.cancelledBy || null,
          performedByName:
            String(cancellation.approvedBy || '').trim() ||
            nameById[String(cancellation.cancelledBy || '')] ||
            '—',
          at: cancellation.cancelledAt,
          statusTo: ADMISSION_CANCELLED_STATUS,
          source: 'admission',
        });
      }

      if (
        admission.updated_at &&
        admission.created_at &&
        new Date(admission.updated_at).getTime() - new Date(admission.created_at).getTime() > 2000
      ) {
        const updatedMs = new Date(admission.updated_at).getTime();
        const hasNearbyEvent = events.some(
          (event) => Math.abs(new Date(event.at).getTime() - updatedMs) < 5000
        );
        if (!hasNearbyEvent) {
          pushTimelineEvent(events, {
            id: `admission-updated-${admission.id}-${updatedMs}`,
            kind: 'update',
            title: 'Last admission update',
            performedById: admission.updated_by || null,
            performedByName:
              nameById[String(admission.updated_by || '')] ||
              normalizeHistoryActorName('', admission.updated_by),
            at: admission.updated_at,
            source: 'admission',
          });
        }
      }
    }

    events.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

    // Light de-dupe: same title + actor within 3s.
    const deduped = [];
    for (const event of events) {
      const prev = deduped[deduped.length - 1];
      if (
        prev &&
        prev.title === event.title &&
        prev.performedByName === event.performedByName &&
        Math.abs(new Date(prev.at).getTime() - new Date(event.at).getTime()) < 3000
      ) {
        continue;
      }
      deduped.push(event);
    }

    return successResponse(
      res,
      {
        admissionId: admission.id,
        joiningId: admission.joining_id || null,
        leadId: admission.lead_id || null,
        scope: referenceOnly ? 'reference' : 'all',
        events: deduped,
      },
      referenceOnly
        ? 'Admission reference history retrieved successfully'
        : 'Admission application history retrieved successfully',
      200
    );
  } catch (error) {
    console.error('Error fetching admission application history:', error);
    return errorResponse(
      res,
      error.message || 'Failed to fetch admission application history',
      error.statusCode || 500
    );
  }
};

/**
 * Persist Excel "Reference 1" on admission + linked joining + CRM lead (same as import script).
 * Stored at lead_data.reference1 (admissions/joinings) and dynamic_fields.reference1 (leads).
 * @returns {{ previous: string, next: string, changed: boolean, admissionId: string, leadId: string|null, joiningId: string|null }}
 */
export const persistAdmissionReference1 = async (pool, admissionId, reference1, userId) => {
  const ref = String(reference1 ?? '').trim();
  const [admRows] = await pool.execute(
    'SELECT id, lead_id, joining_id, lead_data FROM admissions WHERE id = ? LIMIT 1',
    [admissionId]
  );
  if (!admRows.length) {
    const err = new Error('Admission record not found');
    err.statusCode = 404;
    throw err;
  }
  const row = admRows[0];
  const previousLeadData = parseAdmissionLeadData(row.lead_data);
  const previous = String(previousLeadData.reference1 ?? previousLeadData.referenceName ?? '').trim();

  await pool.execute(
    `UPDATE admissions SET
       lead_data = JSON_SET(
         COALESCE(CASE WHEN JSON_VALID(lead_data) THEN lead_data ELSE JSON_OBJECT() END, JSON_OBJECT()),
         '$.reference1', ?
       ),
       updated_by = ?,
       updated_at = NOW()
     WHERE id = ?`,
    [ref, userId, admissionId]
  );

  if (row.joining_id) {
    await pool.execute(
      `UPDATE joinings SET
         lead_data = JSON_SET(
           COALESCE(CASE WHEN JSON_VALID(lead_data) THEN lead_data ELSE JSON_OBJECT() END, JSON_OBJECT()),
           '$.reference1', ?
         ),
         updated_by = ?,
         updated_at = NOW()
       WHERE id = ?`,
      [ref, userId, row.joining_id]
    );
  }

  if (row.lead_id) {
    await pool.execute(
      `UPDATE leads SET
         dynamic_fields = JSON_SET(
           COALESCE(CASE WHEN JSON_VALID(dynamic_fields) THEN dynamic_fields ELSE JSON_OBJECT() END, JSON_OBJECT()),
           '$.reference1', ?
         ),
         updated_at = NOW()
       WHERE id = ?`,
      [ref, row.lead_id]
    );
  }

  return {
    previous,
    next: ref,
    changed: previous !== ref,
    admissionId,
    leadId: row.lead_id || null,
    joiningId: row.joining_id || null,
  };
};

/**
 * Persist reference1 and append reference-change history when the value actually changes.
 */
export const persistAdmissionReference1WithHistory = async (
  pool,
  admissionId,
  reference1,
  user,
) => {
  const userId = user?.id;
  if (!admissionId || !userId) {
    return persistAdmissionReference1(pool, admissionId, reference1, userId);
  }
  const result = await persistAdmissionReference1(pool, admissionId, reference1, userId);
  if (result.changed) {
    await appendAdmissionApplicationEditHistory(pool, {
      admissionId,
      leadId: result.leadId,
      userId,
      userName: user?.name,
      kind: 'reference_change',
      title: 'Reference updated',
      description: 'Admission reference changed',
    });
  }
  return result;
};

export const persistAdmissionRemarks = async (pool, admissionId, remarks, userId) => {
  const [admRows] = await pool.execute(
    'SELECT id FROM admissions WHERE id = ? LIMIT 1',
    [admissionId]
  );
  if (!admRows.length) {
    const err = new Error('Admission record not found');
    err.statusCode = 404;
    throw err;
  }

  await pool.execute(
    `UPDATE admissions SET
       remarks = ?,
       updated_by = ?,
       updated_at = NOW()
     WHERE id = ?`,
    [String(remarks ?? ''), userId || null, admissionId]
  );
};

/**
 * Normalize admission phase to "1"…"5", or empty string when unset/invalid.
 */
export const normalizeAdmissionPhase = (value) => {
  if (value === undefined || value === null) return '';
  const raw = String(value).trim();
  if (!raw) return '';
  const match = raw.match(/^phase\s*([1-5])$/i) || raw.match(/^([1-5])$/);
  return match ? match[1] : '';
};

/**
 * Persist admission phase on admissions (+ linked joining) lead_data.admissionPhase.
 * @returns {{ previous: string, next: string, changed: boolean }}
 */
export const persistAdmissionPhase = async (pool, admissionId, admissionPhase, userId) => {
  const next = normalizeAdmissionPhase(admissionPhase);
  const [admRows] = await pool.execute(
    'SELECT id, joining_id, lead_data FROM admissions WHERE id = ? LIMIT 1',
    [admissionId]
  );
  if (!admRows.length) {
    const err = new Error('Admission record not found');
    err.statusCode = 404;
    throw err;
  }
  const row = admRows[0];
  const previousLeadData = parseAdmissionLeadData(row.lead_data);
  const previous = normalizeAdmissionPhase(
    previousLeadData.admissionPhase ?? previousLeadData.admission_phase
  );

  await pool.execute(
    `UPDATE admissions SET
       lead_data = JSON_SET(
         COALESCE(CASE WHEN JSON_VALID(lead_data) THEN lead_data ELSE JSON_OBJECT() END, JSON_OBJECT()),
         '$.admissionPhase', ?
       ),
       updated_by = ?,
       updated_at = NOW()
     WHERE id = ?`,
    [next, userId || null, admissionId]
  );

  if (row.joining_id) {
    await pool.execute(
      `UPDATE joinings SET
         lead_data = JSON_SET(
           COALESCE(CASE WHEN JSON_VALID(lead_data) THEN lead_data ELSE JSON_OBJECT() END, JSON_OBJECT()),
           '$.admissionPhase', ?
         ),
         updated_by = ?,
         updated_at = NOW()
       WHERE id = ?`,
      [next, userId || null, row.joining_id]
    );
  }

  return { previous, next, changed: previous !== next };
};

/**
 * Persist category_id / nested caste_id on admissions (+ linked joining) lead_data
 * for secondary student sync (students.category_id / students.caste_id).
 */
export const persistAdmissionReservationMeta = async (pool, admissionId, reservation, userId) => {
  if (!reservation || typeof reservation !== 'object') return;

  const [admRows] = await pool.execute(
    'SELECT id, lead_data, joining_id FROM admissions WHERE id = ? LIMIT 1',
    [admissionId]
  );
  if (!admRows.length) return;

  const adm = admRows[0];
  let admLd =
    typeof adm.lead_data === 'string' ? JSON.parse(adm.lead_data) : adm.lead_data || {};
  if (!admLd || typeof admLd !== 'object') admLd = {};

  const meta = buildJoiningReservationMeta(reservation);
  const admNextLd = { ...admLd };
  if (meta) {
    admNextLd._joiningReservation = meta;
  } else {
    delete admNextLd._joiningReservation;
  }

  await pool.execute(
    `UPDATE admissions SET lead_data = ?, updated_by = ?, updated_at = NOW() WHERE id = ?`,
    [JSON.stringify(admNextLd), userId || null, admissionId]
  );

  if (!adm.joining_id) return;

  const [joiningRows] = await pool.execute('SELECT id, lead_data FROM joinings WHERE id = ? LIMIT 1', [
    adm.joining_id,
  ]);
  if (!joiningRows.length) return;

  let jLd =
    typeof joiningRows[0].lead_data === 'string'
      ? JSON.parse(joiningRows[0].lead_data)
      : joiningRows[0].lead_data || {};
  if (!jLd || typeof jLd !== 'object') jLd = {};
  const jNextLd = { ...jLd };
  if (meta) {
    jNextLd._joiningReservation = meta;
  } else {
    delete jNextLd._joiningReservation;
  }
  await pool.execute(`UPDATE joinings SET lead_data = ?, updated_at = NOW() WHERE id = ?`, [
    JSON.stringify(jNextLd),
    adm.joining_id,
  ]);
};

/**
 * Merge registration extras (and optional fee sidecar) on admissions + linked joinings,
 * and sync dedicated portrait columns from merged extras.
 */
export const persistAdmissionRegistrationSidecar = async (pool, admissionId, payload, userId) => {
  const hasReg =
    payload.registrationFormData !== undefined && payload.registrationFormData !== null;
  const hasFees = Object.prototype.hasOwnProperty.call(payload, 'studentFeeDetails');
  if (!hasReg && !hasFees) return;

  const [admRows] = await pool.execute(
    'SELECT id, lead_data, joining_id FROM admissions WHERE id = ? LIMIT 1',
    [admissionId]
  );
  if (!admRows.length) return;

  const adm = admRows[0];
  let admLd =
    typeof adm.lead_data === 'string' ? JSON.parse(adm.lead_data) : adm.lead_data || {};
  if (!admLd || typeof admLd !== 'object') admLd = {};

  const prevExtras =
    admLd._joiningRegistrationExtras && typeof admLd._joiningRegistrationExtras === 'object'
      ? { ...admLd._joiningRegistrationExtras }
      : {};

  let mergedExtras = prevExtras;
  if (hasReg && typeof payload.registrationFormData === 'object') {
    mergedExtras = { ...prevExtras, ...payload.registrationFormData };
  }

  const admNextLd = { ...admLd };
  if (Object.keys(mergedExtras).length > 0) {
    admNextLd._joiningRegistrationExtras = mergedExtras;
  }

  const portraits = extractPortraitPhotosFromRegistrationFormData(mergedExtras);
  const admPortraitFields = [];
  const admPortraitParams = [];
  if (portraits.studentPhoto) {
    admPortraitFields.push('student_photo = ?');
    admPortraitParams.push(portraits.studentPhoto);
  }
  if (portraits.fatherPhoto) {
    admPortraitFields.push('father_photo = ?');
    admPortraitParams.push(portraits.fatherPhoto);
  }
  if (portraits.motherPhoto) {
    admPortraitFields.push('mother_photo = ?');
    admPortraitParams.push(portraits.motherPhoto);
  }

  await pool.execute(
    `UPDATE admissions SET lead_data = ?${
      admPortraitFields.length ? `, ${admPortraitFields.join(', ')}` : ''
    }, updated_by = ?, updated_at = NOW() WHERE id = ?`,
    [JSON.stringify(admNextLd), ...admPortraitParams, userId, admissionId]
  );

  if (!adm.joining_id) return;

  const [joiningRows] = await pool.execute('SELECT id, lead_data FROM joinings WHERE id = ? LIMIT 1', [
    adm.joining_id,
  ]);
  if (!joiningRows.length) return;

  const joining = joiningRows[0];
  let jLd =
    typeof joining.lead_data === 'string' ? JSON.parse(joining.lead_data) : joining.lead_data || {};
  if (!jLd || typeof jLd !== 'object') jLd = {};

  const jPrevExtras =
    jLd._joiningRegistrationExtras && typeof jLd._joiningRegistrationExtras === 'object'
      ? { ...jLd._joiningRegistrationExtras }
      : {};
  const jMergedExtras = hasReg && typeof payload.registrationFormData === 'object'
    ? { ...jPrevExtras, ...payload.registrationFormData }
    : { ...jPrevExtras, ...mergedExtras };

  const jNextLd = {
    ...jLd,
    ...(Object.keys(jMergedExtras).length > 0 ? { _joiningRegistrationExtras: jMergedExtras } : {}),
  };

  const jPortraits = extractPortraitPhotosFromRegistrationFormData(jMergedExtras);
  const jPortraitFields = [];
  const jPortraitParams = [];
  if (jPortraits.studentPhoto) {
    jPortraitFields.push('student_photo = ?');
    jPortraitParams.push(jPortraits.studentPhoto);
  }
  if (jPortraits.fatherPhoto) {
    jPortraitFields.push('father_photo = ?');
    jPortraitParams.push(jPortraits.fatherPhoto);
  }
  if (jPortraits.motherPhoto) {
    jPortraitFields.push('mother_photo = ?');
    jPortraitParams.push(jPortraits.motherPhoto);
  }

  await pool.execute(
    `UPDATE joinings SET lead_data = ?${
      jPortraitFields.length ? `, ${jPortraitFields.join(', ')}` : ''
    }, updated_by = ?, updated_at = NOW() WHERE id = ?`,
    [JSON.stringify(jNextLd), ...jPortraitParams, userId, joining.id]
  );
};

const qualificationMeritFromSql = (value) => {
  if (value === 1 || value === true) return true;
  return false;
};

const qualificationMeritToSql = (merit) => {
  if (merit === true) return 1;
  return 0;
};

/** AC = 1, Non-AC = 0 (same Yes/No persistence pattern as merit). */
const qualificationAcFromSql = (value) => {
  if (value === 1 || value === true) return true;
  return false;
};

const qualificationAcToSql = (ac) => {
  if (ac === true) return 1;
  return 0;
};

function pickFromRegistrationFormData(registrationFormData, keys) {
  if (!registrationFormData || typeof registrationFormData !== 'object') return '';
  const want = new Set(keys.map((k) => String(k).toLowerCase()));
  for (const [k, v] of Object.entries(registrationFormData)) {
    if (!want.has(String(k).toLowerCase())) continue;
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return '';
}

const parseLeadDynamicFieldsColumn = (raw) => {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return raw && typeof raw === 'object' ? raw : {};
};

// Helper function to format lead data from SQL
const formatLead = (leadData) => {
  if (!leadData) return null;
  const dynamicFields = parseLeadDynamicFieldsColumn(leadData.dynamic_fields);
  const reference1 = readReference1FromDynamicFields(dynamicFields);
  return {
    _id: leadData.id,
    id: leadData.id,
    enquiryNumber: leadData.enquiry_number,
    name: leadData.name,
    phone: leadData.phone,
    fatherName: leadData.father_name,
    fatherPhone: leadData.father_phone,
    leadStatus: leadData.lead_status,
    admissionNumber: leadData.admission_number,
    dynamicFields,
    ...(reference1 ? { reference1 } : {}),
  };
};

// Helper function to format admission data from SQL (exported for one-off resync scripts)
export const formatAdmission = async (admissionData, pool) => {
  if (!admissionData) return null;

  const admissionId = admissionData.id;

  // Fetch related data in parallel (detail view).
  const [relativesResult, educationHistoryResult, siblingsResult, actorNamesResult] = await Promise.all([
    pool.execute('SELECT * FROM admission_relatives WHERE admission_id = ?', [admissionId]),
    pool.execute(
      'SELECT * FROM admission_education_history WHERE admission_id = ? ORDER BY created_at ASC',
      [admissionId]
    ),
    pool.execute(
      'SELECT * FROM admission_siblings WHERE admission_id = ? ORDER BY created_at ASC',
      [admissionId]
    ),
    (async () => {
      const ids = [
        ...new Set(
          [admissionData.created_by, admissionData.updated_by]
            .map((id) => (id == null ? '' : String(id).trim()))
            .filter(Boolean)
        ),
      ];
      if (ids.length === 0) return { createdByName: '', updatedByName: '' };
      const [rows] = await pool.execute(
        `SELECT id, name FROM users WHERE id IN (${ids.map(() => '?').join(',')})`,
        ids
      );
      const nameById = Object.fromEntries(
        (rows || []).map((row) => [String(row.id), String(row.name || '').trim()])
      );
      return {
        createdByName: nameById[String(admissionData.created_by || '').trim()] || '',
        updatedByName: nameById[String(admissionData.updated_by || '').trim()] || '',
      };
    })(),
  ]);
  const relatives = relativesResult[0];
  const educationHistory = educationHistoryResult[0];
  const siblings = siblingsResult[0];
  const { createdByName, updatedByName } = actorNamesResult;

  // Parse JSON fields
  const leadDataRaw = typeof admissionData.lead_data === 'string'
    ? JSON.parse(admissionData.lead_data)
    : admissionData.lead_data || {};
  let registrationFormData =
    leadDataRaw &&
    typeof leadDataRaw === 'object' &&
    leadDataRaw._joiningRegistrationExtras &&
    typeof leadDataRaw._joiningRegistrationExtras === 'object'
      ? { ...leadDataRaw._joiningRegistrationExtras }
      : {};
  const reservationMeta =
    leadDataRaw &&
    typeof leadDataRaw === 'object' &&
    leadDataRaw._joiningReservation &&
    typeof leadDataRaw._joiningReservation === 'object'
      ? leadDataRaw._joiningReservation
      : null;
  const leadData =
    leadDataRaw && typeof leadDataRaw === 'object'
      ? (() => {
          const {
            _joiningRegistrationExtras,
            _joiningProgramLevel,
            _joiningManagedCourseId,
            _joiningManagedBranchId,
            _joiningReservation,
            _applicationEditHistory,
            ...rest
          } = leadDataRaw;
          return rest;
        })()
      : leadDataRaw;

  const fromRegFatherPhoto = pickFromRegistrationFormData(
    registrationFormData,
    FATHER_PHOTO_REG_KEYS
  );
  const fromRegMotherPhoto = pickFromRegistrationFormData(
    registrationFormData,
    MOTHER_PHOTO_REG_KEYS
  );
  const fromRegStudentPhoto = pickFromRegistrationFormData(
    registrationFormData,
    STUDENT_PHOTO_REG_KEYS
  );
  const colFatherPhoto = String(admissionData.father_photo || '').trim();
  const colMotherPhoto = String(admissionData.mother_photo || '').trim();
  const colStudentPhoto = String(admissionData.student_photo || '').trim();
  // Prefer intact column/data-url copies over uppercased-corrupt extras.
  const fatherPortrait = preferIntactPortraitPhoto(colFatherPhoto, fromRegFatherPhoto);
  const motherPortrait = preferIntactPortraitPhoto(colMotherPhoto, fromRegMotherPhoto);
  const studentPortrait = preferIntactPortraitPhoto(colStudentPhoto, fromRegStudentPhoto);
  if (fatherPortrait && fatherPortrait !== fromRegFatherPhoto) {
    registrationFormData = { ...registrationFormData, father_photo: fatherPortrait };
  }
  if (motherPortrait && motherPortrait !== fromRegMotherPhoto) {
    registrationFormData = { ...registrationFormData, mother_photo: motherPortrait };
  }
  if (studentPortrait && studentPortrait !== fromRegStudentPhoto) {
    registrationFormData = { ...registrationFormData, student_photo: studentPortrait };
  }

  const reservationOther = typeof admissionData.reservation_other === 'string'
    ? JSON.parse(admissionData.reservation_other)
    : admissionData.reservation_other || [];

  const qualificationMediums = typeof admissionData.qualification_mediums === 'string'
    ? JSON.parse(admissionData.qualification_mediums)
    : admissionData.qualification_mediums || [];

  const referenceName = await resolveAdmissionReference1(pool, {
    leadDataRaw,
    joiningId: admissionData.joining_id,
    leadId: admissionData.lead_id,
  });
  const leadDataWithReference =
    referenceName && leadData && typeof leadData === 'object' && !String(leadData.reference1 ?? '').trim()
      ? { ...leadData, reference1: referenceName }
      : leadData;

  if (leadDataWithReference && leadDataWithReference._joiningStudentFeeDetails && Array.isArray(leadDataWithReference._joiningStudentFeeDetails.lines)) {
    try {
      const { connectFeeManagement } = await import('../config-mongo/feeManagement.js');
      const conn = await connectFeeManagement();
      const feeHeads = await conn.db.collection('feeheads').find({}).toArray();
      const { normalizeFeeHeadInEntries } = await import('../utils/overallConcessions.util.js');
      leadDataWithReference._joiningStudentFeeDetails.lines = normalizeFeeHeadInEntries(
        leadDataWithReference._joiningStudentFeeDetails.lines,
        feeHeads
      );
    } catch (e) {
      console.warn('[formatAdmission] Failed to normalize fee heads in _joiningStudentFeeDetails:', e.message);
    }
  }

  return {
    _id: admissionData.id,
    id: admissionData.id,
    leadId: admissionData.lead_id,
    enquiryNumber: admissionData.enquiry_number,
    referenceName,
    leadData: leadDataWithReference,
    registrationFormData,
    joiningId: admissionData.joining_id,
    admissionNumber: admissionData.admission_number,
    status: admissionData.status,
    admissionDate: admissionData.admission_date,
    courseInfo: await (async () => {
      const reconciled = await reconcileAdmissionCourseInfoFromRow(admissionData);
      return {
        courseId: reconciled.courseId,
        branchId: reconciled.branchId,
        course: resolveBtechCourseDisplayName(
          reconciled.course || admissionData.course || '',
          registrationFormData,
          admissionData.admission_number
        ),
        branch: reconciled.branch || admissionData.branch || '',
        quota: reconciled.quota || admissionData.quota || '',
      };
    })(),
    paymentSummary: {
      totalFee: Number(admissionData.payment_total_fee) || 0,
      totalPaid: Number(admissionData.payment_total_paid) || 0,
      balance: Number(admissionData.payment_balance) || 0,
      currency: admissionData.payment_currency || 'INR',
      status: admissionData.payment_status || 'not_started',
      lastPaymentAt: admissionData.payment_last_payment_at,
    },
    studentInfo: {
      name: admissionData.student_name || '',
      phone: admissionData.student_phone || '',
      preferredMobileNumber: admissionData.preferred_mobile_number || '',
      gender: admissionData.student_gender || '',
      dateOfBirth: admissionData.student_date_of_birth || '',
      notes: admissionData.student_notes || '',
      aadhaarNumber: admissionData.student_aadhaar_number || '',
      photo: studentPortrait,
    },
    parents: {
      father: {
        name: admissionData.father_name || '',
        phone: admissionData.father_phone || '',
        aadhaarNumber: admissionData.father_aadhaar_number || '',
        photo: fatherPortrait,
        occupation: admissionData.father_occupation || '',
      },
      mother: {
        name: admissionData.mother_name || '',
        phone: admissionData.mother_phone || '',
        aadhaarNumber: admissionData.mother_aadhaar_number || '',
        photo: motherPortrait,
        occupation: admissionData.mother_occupation || '',
      },
    },
    reservation: {
      general: admissionData.reservation_general || '',
      categoryId:
        reservationMeta?.categoryId != null && String(reservationMeta.categoryId).trim() !== ''
          ? String(reservationMeta.categoryId).trim()
          : undefined,
      casteId:
        reservationMeta?.casteId != null && String(reservationMeta.casteId).trim() !== ''
          ? String(reservationMeta.casteId).trim()
          : undefined,
      isEws: admissionData.reservation_is_ews === 1 || admissionData.reservation_is_ews === true,
      other: reservationOther,
    },
    address: {
      communication: communicationAddressFromSqlRow(admissionData, registrationFormData),
      relatives: relatives.map(relativeAddressFromSqlRow),
    },
    qualifications: {
      ssc: admissionData.qualification_ssc === 1 || admissionData.qualification_ssc === true,
      interOrDiploma: admissionData.qualification_inter_diploma === 1 || admissionData.qualification_inter_diploma === true,
      ug: admissionData.qualification_ug === 1 || admissionData.qualification_ug === true,
      merit: qualificationMeritFromSql(admissionData.qualification_merit),
      ac: qualificationAcFromSql(admissionData.qualification_ac),
      mediums: qualificationMediums,
      otherMediumLabel: admissionData.qualification_other_medium_label || '',
    },
    educationHistory: educationHistory.map((edu) => ({
      level: edu.level,
      otherLevelLabel: edu.other_level_label || '',
      courseOrBranch: edu.course_or_branch || '',
      yearOfPassing: edu.year_of_passing || '',
      institutionName: edu.institution_name || '',
      institutionAddress: edu.institution_address || '',
      hallTicketNumber: edu.hall_ticket_number || '',
      totalMarksOrGrade: edu.total_marks_or_grade || '',
      cetRank: edu.cet_rank || '',
    })),
    siblings: siblings.map((sib) => ({
      name: sib.name || '',
      relation: sib.relation || '',
      studyingStandard: sib.studying_standard || '',
      institutionName: sib.institution_name || '',
    })),
    documents: {
      ssc: admissionData.document_ssc || 'pending',
      inter: admissionData.document_inter || 'pending',
      ugPgCmm: admissionData.document_ug_pg_cmm || 'pending',
      transferCertificate: admissionData.document_transfer_certificate || 'pending',
      studyCertificate: admissionData.document_study_certificate || 'pending',
      aadhaarCard: admissionData.document_aadhaar_card || 'pending',
      photos: admissionData.document_photos || 'pending',
      incomeCertificate: admissionData.document_income_certificate || 'pending',
      casteCertificate: admissionData.document_caste_certificate || 'pending',
      cetRankCard: admissionData.document_cet_rank_card || 'pending',
      cetHallTicket: admissionData.document_cet_hall_ticket || 'pending',
      allotmentLetter: admissionData.document_allotment_letter || 'pending',
      joiningReport: admissionData.document_joining_report || 'pending',
      bankPassbook: admissionData.document_bank_passbook || 'pending',
      rationCard: admissionData.document_ration_card || 'pending',
    },
    createdBy: admissionData.created_by,
    updatedBy: admissionData.updated_by,
    createdByName,
    updatedByName,
    createdAt: admissionData.created_at,
    updatedAt: admissionData.updated_at,
    remarks: admissionData.remarks || '',
    admissionPhase: normalizeAdmissionPhase(
      leadDataRaw?.admissionPhase ?? leadDataRaw?.admission_phase
    ),
  };
};

const validateAdmissionPayload = (payload = {}) => {
  const errors = [];
  if (!payload.studentInfo?.name) {
    errors.push('Student name is required');
  }
  const reservation = payload.reservation;
  if (reservation !== undefined && reservation !== null) {
    const hasCategory =
      Boolean(String(reservation.categoryId ?? '').trim()) ||
      Boolean(String(reservation.general ?? '').trim());
    if (!hasCategory) {
      errors.push('Reservation category is required');
    }
  }
  if (payload.courseInfo !== undefined && payload.courseInfo !== null && typeof payload.courseInfo === 'object') {
    const cid = String(payload.courseInfo.courseId ?? '').trim();
    const bid = String(payload.courseInfo.branchId ?? '').trim();
    if (!cid) {
      errors.push('Managed course selection is required');
    }
    if (!bid) {
      errors.push('Managed branch selection is required');
    }
  }
  return errors;
};

async function applyAdmissionCourseInfoUpdates(pool, courseInfo, updateFields, updateParams) {
  if (!courseInfo || typeof courseInfo !== 'object') return;

  const managedCourseId = String(courseInfo.courseId ?? '').trim();
  const managedBranchId = String(courseInfo.branchId ?? '').trim();
  if (!managedCourseId || !managedBranchId) {
    const err = new Error('Managed course and branch selection are required for admission update');
    err.statusCode = 400;
    throw err;
  }

  const enriched = await enrichAdmissionCourseInfoFromSecondary({
    courseId: managedCourseId,
    branchId: managedBranchId,
    course: courseInfo.course,
    branch: courseInfo.branch,
    quota: courseInfo.quota,
  });

  const { fkCourseId, fkBranchId } = await resolvePrimaryCourseBranchFkIds(
    pool,
    enriched.courseId,
    enriched.branchId
  );

  updateFields.push('course_id = ?');
  updateParams.push(fkCourseId);
  updateFields.push('managed_course_id = ?');
  updateParams.push(normalizeManagedIdForDb(enriched.courseId));
  updateFields.push('course = ?');
  updateParams.push(enriched.course || '');

  updateFields.push('branch_id = ?');
  updateParams.push(fkBranchId);
  updateFields.push('managed_branch_id = ?');
  updateParams.push(normalizeManagedIdForDb(enriched.branchId));
  updateFields.push('branch = ?');
  updateParams.push(enriched.branch || '');

  if (enriched.quota !== undefined) {
    updateFields.push('quota = ?');
    updateParams.push(enriched.quota || '');
  }
  Object.assign(courseInfo, enriched);
}

const persistAdmissionManagedIdsInLeadData = async (pool, admissionId, courseInfo) => {
  const mc = normalizeManagedIdForDb(courseInfo?.courseId);
  const mb = normalizeManagedIdForDb(courseInfo?.branchId);
  await pool.execute(
    `UPDATE admissions SET lead_data = JSON_SET(
      COALESCE(CASE WHEN JSON_VALID(lead_data) THEN lead_data ELSE JSON_OBJECT() END, JSON_OBJECT()),
      '$._joiningManagedCourseId', ?,
      '$._joiningManagedBranchId', ?
    ), updated_at = NOW() WHERE id = ?`,
    [mc, mb, admissionId]
  );
};

const parseReferenceFromJsonBlob = (raw) => {
  try {
    const text =
      Buffer.isBuffer(raw) ? raw.toString('utf8') : typeof raw === 'string' ? raw : null;
    const ld =
      text != null
        ? JSON.parse(text || '{}')
        : raw && typeof raw === 'object'
          ? raw
          : {};
    return String(ld.reference1 ?? ld.referenceName ?? '').trim();
  } catch {
    return '';
  }
};

const parseReferenceNameFromRow = (row) => {
  const direct = String(row.reference_name ?? '').trim();
  if (direct) return direct;

  const fromAdmExtracted = String(
    row.lead_data_reference1 ?? row.lead_data_reference_name ?? ''
  ).trim();
  if (fromAdmExtracted) return fromAdmExtracted;

  const fromAdm = parseReferenceFromJsonBlob(row.lead_data);
  if (fromAdm) return fromAdm;

  const fromJoinExtracted = String(
    row.joining_lead_reference1 ?? row.joining_lead_reference_name ?? ''
  ).trim();
  if (fromJoinExtracted) return fromJoinExtracted;

  const fromJoin = parseReferenceFromJsonBlob(row.joining_lead_data);
  if (fromJoin) return fromJoin;
  try {
    const rawDyn = row.lead_dynamic_fields;
    if (rawDyn != null && (typeof rawDyn === 'string' || Buffer.isBuffer(rawDyn) || typeof rawDyn === 'object')) {
      const dyn =
        Buffer.isBuffer(rawDyn)
          ? JSON.parse(rawDyn.toString('utf8') || '{}')
          : typeof rawDyn === 'string'
            ? JSON.parse(rawDyn || '{}')
            : rawDyn && typeof rawDyn === 'object'
              ? rawDyn
              : {};
      const fromDynObj = readReference1FromDynamicFields(dyn);
      if (fromDynObj) return fromDynObj;
    }
  } catch {
    // fall through to extracted column
  }
  return String(row.lead_dyn_reference1 || '').trim();
};

const registrationExtrasFromLeadDataRaw = (leadDataRaw) => {
  if (!leadDataRaw || typeof leadDataRaw !== 'object') return {};
  const ex = leadDataRaw._joiningRegistrationExtras;
  return ex && typeof ex === 'object' ? ex : {};
};

const registrationExtrasFromListRow = (row) => {
  const studentStatus = String(row.list_student_status || row.list_student_status_alt || '').trim();
  if (studentStatus) return { student_status: studentStatus };
  const raw = row.lead_data_registration_extras;
  if (!raw) return registrationExtrasFromLeadDataRaw(parseListRowLeadDataRaw(row));
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return raw && typeof raw === 'object' ? raw : {};
};

const parseListRowLeadDataRaw = (row) => {
  if (!row?.lead_data) return {};
  try {
    const raw = row.lead_data;
    const text =
      Buffer.isBuffer(raw) ? raw.toString('utf8') : typeof raw === 'string' ? raw : null;
    return text != null
      ? JSON.parse(text || '{}')
      : raw && typeof raw === 'object'
        ? raw
        : {};
  } catch {
    return {};
  }
};

const leadDataStubFromListRow = (row) => {
  const fromExtract =
    row.lead_data_source != null ||
    row.lead_data_utm_source != null ||
    row.lead_data_lead_source != null;
  if (fromExtract) {
    return {
      source: row.lead_data_source,
      utmSource: row.lead_data_utm_source,
      leadSource: row.lead_data_lead_source,
    };
  }
  return parseListRowLeadDataRaw(row);
};

const isQuotaLikeLeadSource = (value) => {
  const s = String(value ?? '').trim().toLowerCase();
  if (!s) return false;
  return (
    s === 'conv' ||
    s === 'convenor' ||
    s === 'convener' ||
    s === 'cq' ||
    s === 'mq' ||
    s === 'management' ||
    s === 'mang' ||
    s.includes('management quota') ||
    s.includes('convenor quota') ||
    s.includes('spot') ||
    s === 'lateral entry' ||
    s.includes('lateral')
  );
};

/** Stored lead.source / pipeline values that all roll up to Joining Form (desk + SMS token link). */
const JOINING_FORM_SOURCE_ALIASES = new Set([
  'direct admission',
  'joining form',
  'joining form (existing lead)',
  'joining form link',
]);

/** createdFrom markers for staff desk and token-based public joining (same source bucket). */
const JOINING_FORM_CREATED_FROM = new Set([
  'add_joining_form',
  'send_joining_form',
  'joining_form_link',
]);

const readCreatedFromFromRow = (row) => {
  const dynamicFields = parseLeadDynamicFieldsColumn(row.lead_dynamic_fields);
  const fromLead = String(dynamicFields?.createdFrom ?? '').trim();
  if (fromLead) return fromLead;

  const leadDataRaw = leadDataStubFromListRow(row);
  return String(leadDataRaw?.createdFrom ?? '').trim();
};

const resolveStoredLeadSourceLabel = (row) => {
  const leadDataRaw = leadDataStubFromListRow(row);
  const raw = String(row.lead_source ?? '').trim();
  if (raw && !isQuotaLikeLeadSource(raw)) {
    return raw;
  }
  const fromLeadData = String(
    leadDataRaw?.source ?? leadDataRaw?.utmSource ?? leadDataRaw?.leadSource ?? ''
  ).trim();
  if (fromLeadData && !isQuotaLikeLeadSource(fromLeadData)) {
    return fromLeadData;
  }
  return '';
};

/** Resolved lead source for list rows and source-wise pivot (matches admissions UI). */
const normalizeAdmissionLeadSource = (row) => {
  const reference1 =
    String(row.effective_reference1 ?? '').trim() || parseReferenceNameFromRow(row);

  if (isDirectReference(reference1)) {
    return JOINING_FORM_DIRECT_SOURCE;
  }

  const createdFrom = readCreatedFromFromRow(row);
  if (createdFrom === 'self_registration') {
    return 'Self Registration';
  }
  if (JOINING_FORM_CREATED_FROM.has(createdFrom)) {
    return JOINING_FORM_DEFAULT_SOURCE;
  }

  const storedSource = resolveStoredLeadSourceLabel(row);
  if (storedSource) {
    const lower = storedSource.toLowerCase();
    if (lower === JOINING_FORM_DIRECT_SOURCE.toLowerCase() || JOINING_FORM_SOURCE_ALIASES.has(lower)) {
      return JOINING_FORM_DEFAULT_SOURCE;
    }
    return storedSource;
  }

  const uploadBatchId = String(row.upload_batch_id ?? '').trim();
  if (uploadBatchId) {
    return 'Bulk Upload';
  }

  return 'Manual Form';
};

const formatAdmissionListItem = (row) => {
  const effectiveIds = effectiveAdmissionCourseBranchIds(row);
  const courseLabel = resolveBtechCourseDisplayName(
    row.course || '',
    registrationExtrasFromListRow(row),
    row.admission_number
  );
  return {
  _id: row.id,
  id: row.id,
  leadId: row.lead_id,
  joiningId: row.joining_id,
  admissionNumber: row.admission_number,
  status: row.status,
  courseInfo: {
    ...effectiveIds,
    course: courseLabel,
    branch: row.branch || '',
    quota: row.quota || '',
  },
  studentInfo: {
    name: row.student_name || row.lead_name || '',
    phone: row.student_phone || row.lead_phone || '',
  },
  reservation: {
    general: row.reservation_general || '',
    isEws: row.reservation_is_ews === 1 || row.reservation_is_ews === true,
    other: row.reservation_other ? (typeof row.reservation_other === 'string' ? JSON.parse(row.reservation_other) : row.reservation_other) : [],
  },
  qualifications: {
    merit:
      row.qualification_merit === 1 || row.qualification_merit === true
        ? true
        : row.qualification_merit === 0 || row.qualification_merit === false
          ? false
          : null,
    ac:
      row.qualification_ac === 1 || row.qualification_ac === true
        ? true
        : row.qualification_ac === 0 || row.qualification_ac === false
          ? false
          : null,
  },
  paymentSummary: {
    totalPaid: Number(row.payment_total_paid) || 0,
  },
  documents: {
    ssc: row.document_ssc,
    inter: row.document_inter,
    ugPgCmm: row.document_ug_pg_cmm,
    transferCertificate: row.document_transfer_certificate,
    studyCertificate: row.document_study_certificate,
    aadhaarCard: row.document_aadhaar_card,
    photos: row.document_photos,
    incomeCertificate: row.document_income_certificate,
    casteCertificate: row.document_caste_certificate,
    cetRankCard: row.document_cet_rank_card,
    cetHallTicket: row.document_cet_hall_ticket,
    allotmentLetter: row.document_allotment_letter,
    joiningReport: row.document_joining_report,
    bankPassbook: row.document_bank_passbook,
    rationCard: row.document_ration_card,
  },
  leadSource: normalizeAdmissionLeadSource(row),
  referenceName: parseReferenceNameFromRow(row),
  updatedAt: row.updated_at,
  createdAt: row.created_at,
  };
};

// Helper function to save admission related tables
const saveAdmissionRelatedTables = async (pool, admissionId, payload) => {

  // Delete existing related records
  await pool.execute('DELETE FROM admission_relatives WHERE admission_id = ?', [admissionId]);
  await pool.execute('DELETE FROM admission_education_history WHERE admission_id = ?', [admissionId]);
  await pool.execute('DELETE FROM admission_siblings WHERE admission_id = ?', [admissionId]);

  // Insert relatives
  if (Array.isArray(payload.address?.relatives)) {
    for (const relative of payload.address.relatives) {
      const relativeId = uuidv4();
      await pool.execute(
        `INSERT INTO admission_relatives (id, admission_id, name, relationship, phone, is_guardian, state, door_street, landmark,
         village_city, mandal, district, pin_code, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [
          relativeId,
          admissionId,
          relative.name || '',
          relative.relationship || '',
          relative.phone || '',
          relative.isGuardian ? 1 : 0,
          relative.state || '',
          relative.doorOrStreet || '',
          relative.landmark || '',
          relative.villageOrCity || '',
          relative.mandal || '',
          relative.district || '',
          relative.pinCode || '',
        ]
      );
    }
  }

  // Insert education history
  if (Array.isArray(payload.educationHistory)) {
    for (const edu of payload.educationHistory) {
      const eduId = uuidv4();
      await pool.execute(
        `INSERT INTO admission_education_history (id, admission_id, level, other_level_label,
         course_or_branch, year_of_passing, institution_name, institution_address,
         hall_ticket_number, total_marks_or_grade, cet_rank, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [
          eduId,
          admissionId,
          edu.level,
          edu.otherLevelLabel || '',
          edu.courseOrBranch || '',
          edu.yearOfPassing || '',
          edu.institutionName || '',
          edu.institutionAddress || '',
          edu.hallTicketNumber || '',
          edu.totalMarksOrGrade || '',
          edu.cetRank || '',
        ]
      );
    }
  }

  // Insert siblings
  if (Array.isArray(payload.siblings)) {
    for (const sib of payload.siblings) {
      const sibId = uuidv4();
      await pool.execute(
        `INSERT INTO admission_siblings (id, admission_id, name, relation, studying_standard,
         institution_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, NOW())`,
        [
          sibId,
          admissionId,
          sib.name || '',
          sib.relation || '',
          sib.studyingStandard || '',
          sib.institutionName || '',
        ]
      );
    }
  }
};

/**
 * Index-friendly admission list search. Uses EXISTS on leads instead of JOIN + JSON_EXTRACT
 * (the previous pattern caused ER_OUT_OF_SORTMEMORY on large admission tables).
 * @returns {boolean} whether a search predicate was added
 */
const appendAdmissionListSearchCondition = (conditions, params, rawSearch) => {
  const t = String(rawSearch || '').trim();
  if (!t) return false;

  const isEnq = t.toUpperCase().startsWith('ENQ');
  const isAdm = t.toUpperCase().startsWith('ADM');
  const isPhone = /^\d{5,}$/.test(t);

  if (isEnq) {
    const enqPattern = `${t}%`;
    conditions.push(`(
      COALESCE(a.enquiry_number, '') LIKE ?
      OR EXISTS (
        SELECT 1 FROM leads l WHERE l.id = a.lead_id AND l.enquiry_number LIKE ?
      )
    )`);
    params.push(enqPattern, enqPattern);
    return true;
  }

  if (isAdm) {
    const admPattern = `${t}%`;
    conditions.push(`(
      a.admission_number LIKE ?
    )`);
    params.push(admPattern);
    return true;
  }

  if (isPhone) {
    const phonePattern = `${t}%`;
    conditions.push(`(
      a.admission_number LIKE ?
      OR a.student_phone LIKE ?
      OR EXISTS (
        SELECT 1 FROM leads l
        WHERE l.id = a.lead_id AND (l.phone LIKE ? OR l.father_phone LIKE ?)
      )
    )`);
    params.push(phonePattern, phonePattern, phonePattern, phonePattern);
    return true;
  }

  if (t.length < 2) return false;

  const like = `%${t}%`;
  conditions.push(`(
    a.admission_number LIKE ?
    OR a.student_name LIKE ?
    OR COALESCE(a.enquiry_number, '') LIKE ?
    OR EXISTS (
      SELECT 1 FROM leads l
      WHERE l.id = a.lead_id AND (
        l.name LIKE ?
        OR l.enquiry_number LIKE ?
        OR l.hall_ticket_number LIKE ?
        OR l.phone LIKE ?
        OR l.father_phone LIKE ?
      )
    )
  )`);
  params.push(like, like, like, like, like, like, like, like);
  return true;
};

export const listAdmissions = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      search = '',
      status,
      startDate,
      endDate,
      collegeId,
      courseId,
      branchId,
      courseName,
      branchName,
      source,
      feeEntry,
      quota,
      merit,
    } = req.query;

    const pool = getPool();
    const paginationLimit = Math.min(Number(limit) || 20, 100);
    const offset = (Number(page) - 1) * paginationLimit;
    const feeEntryFilter = String(feeEntry || '')
      .trim()
      .toLowerCase();
    const filterNoFeeEntry = feeEntryFilter === 'no_entry' || feeEntryFilter === 'no-entry';
    const filterHasFeeEntry = feeEntryFilter === 'has_entry' || feeEntryFilter === 'has-entry';
    const applyFeeEntryFilter = filterNoFeeEntry || filterHasFeeEntry;

    // Build WHERE conditions
    const conditions = [];
    const params = [];

    // Status filtering
    if (status) {
      conditions.push('a.status = ?');
      params.push(status);
    }
    const quotaFilter = String(quota ?? '').trim();
    if (quotaFilter) {
      conditions.push(`LOWER(TRIM(COALESCE(a.quota, ''))) = LOWER(?)`);
      params.push(quotaFilter);
    }
    
    const meritFilter = String(merit ?? '').trim().toLowerCase();
    if (meritFilter === 'yes' || meritFilter === '1' || meritFilter === 'true') {
      conditions.push('a.qualification_merit = 1');
    } else if (meritFilter === 'no' || meritFilter === '0' || meritFilter === 'false') {
      conditions.push('a.qualification_merit = 0');
    }

    const collegeCourseIds = await loadManagedCourseIdsForCollege(collegeId);
    appendManagedCollegeCourseFilter(
      conditions,
      params,
      SQL_A_EFF_COURSE_ID,
      collegeCourseIds
    );
    if (courseId || courseName) {
      if (courseId && courseName) {
        conditions.push(`(${SQL_A_EFF_COURSE_ID} = ? OR a.course = ?)`);
        params.push(courseId, courseName);
      } else {
        conditions.push(`(${SQL_A_EFF_COURSE_ID} = ? OR a.course = ?)`);
        const val = courseId || courseName;
        params.push(val, val);
      }
    }
    if (branchId || branchName) {
      if (branchId && branchName) {
        conditions.push(`(${SQL_A_EFF_BRANCH_ID} = ? OR a.branch = ?)`);
        params.push(branchId, branchName);
      } else {
        conditions.push(`(${SQL_A_EFF_BRANCH_ID} = ? OR a.branch = ?)`);
        const val = branchId || branchName;
        params.push(val, val);
      }
    }

    if (startDate) {
      conditions.push(`DATE(${SQL_A_EFFECTIVE_ADMISSION_DATE}) >= ?`);
      params.push(String(startDate).slice(0, 10));
    }
    if (endDate) {
      conditions.push(`DATE(${SQL_A_EFFECTIVE_ADMISSION_DATE}) <= ?`);
      params.push(String(endDate).slice(0, 10));
    }

    // Lead source filtering — matches stored lead source (leads row or admission snapshot).
    // Uses EXISTS instead of a JOIN so the ORDER BY only sorts slim admissions rows
    // (joining leads pulls large JSON columns into the filesort → ER_OUT_OF_SORTMEMORY).
    const sourceFilter = String(source ?? '').trim();
    if (sourceFilter) {
      const isSelfRegistrationSource = sourceFilter.toLowerCase() === 'self registration';
      const leadMatchers = [`TRIM(COALESCE(l.source, '')) = ?`];
      const snapshotMatchers = [
        `TRIM(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(a.lead_data, '$.source')), '')) = ?`,
        `TRIM(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(a.lead_data, '$.utmSource')), '')) = ?`,
        `TRIM(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(a.lead_data, '$.leadSource')), '')) = ?`,
      ];
      if (isSelfRegistrationSource) {
        leadMatchers.push(
          `TRIM(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(l.dynamic_fields, '$.createdFrom')), '')) = 'self_registration'`
        );
        snapshotMatchers.push(
          `TRIM(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(a.lead_data, '$.createdFrom')), '')) = 'self_registration'`
        );
      }
      conditions.push(`(
        EXISTS (
          SELECT 1 FROM leads l
          WHERE l.id = a.lead_id AND (${leadMatchers.join(' OR ')})
        )
        OR ${snapshotMatchers.join(' OR ')}
      )`);
      params.push(sourceFilter, sourceFilter, sourceFilter, sourceFilter);
    }

    const hasSearch = appendAdmissionListSearchCondition(conditions, params, search);

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const fromClause = 'FROM admissions a';

    if (hasSearch || sourceFilter) {
      await pool.execute('SET SESSION sort_buffer_size = 4194304');
    }

    let total = 0;
    let pageIds = [];

    if (applyFeeEntryFilter) {
      // Student Info Fee Entry filter:
      // No Fee Entry = no Step 4 revised/concession fee amounts saved for the student.
      // Detect joining builder lines in SQL (JSON path only — never load full lead_data).
      const allIdQuery = sourceFilter
        ? `SELECT /*+ NO_MERGE(src) */ a.id, a.admission_number, a.joining_id,
             CASE
               WHEN COALESCE(
                 JSON_LENGTH(JSON_EXTRACT(j.lead_data, '$._joiningStudentFeeDetails.lines')),
                 0
               ) > 0 THEN 1 ELSE 0
             END AS has_joining_revised_fee
           FROM admissions a
           LEFT JOIN joinings j ON j.id = a.joining_id
           JOIN (SELECT a.id ${fromClause} ${whereClause}) src ON src.id = a.id
           ORDER BY a.admission_number DESC, a.updated_at DESC`
        : `SELECT a.id, a.admission_number, a.joining_id,
             CASE
               WHEN COALESCE(
                 JSON_LENGTH(JSON_EXTRACT(j.lead_data, '$._joiningStudentFeeDetails.lines')),
                 0
               ) > 0 THEN 1 ELSE 0
             END AS has_joining_revised_fee
           ${fromClause}
           LEFT JOIN joinings j ON j.id = a.joining_id
           ${whereClause}
           ORDER BY a.admission_number DESC, a.updated_at DESC`;
      const [allIdRows] = await pool.execute(allIdQuery, params);

      const hasRevisedFeeByAdmission = new Map();
      const missingForSecondary = [];
      for (const row of allIdRows || []) {
        const admissionNumber = String(row.admission_number || '').trim();
        if (!admissionNumber) continue;
        const hasJoiningRevised = Number(row.has_joining_revised_fee) === 1;
        hasRevisedFeeByAdmission.set(admissionNumber, hasJoiningRevised);
        if (!hasJoiningRevised) missingForSecondary.push(admissionNumber);
      }

      // One secondary scan for concession rows (cheaper than IN-chunking every no-builder admission).
      if (missingForSecondary.length > 0) {
        try {
          const secondaryPool = getSecondaryPool();
          const missingSet = new Set(missingForSecondary);
          const [ocRows] = await secondaryPool.execute(
            `SELECT admission_number
             FROM overall_concessions
             WHERE revised_fees IS NOT NULL
               AND TRIM(CAST(revised_fees AS CHAR)) NOT IN ('', 'null', 'NULL', '[]')
               AND LENGTH(TRIM(CAST(revised_fees AS CHAR))) > 2`
          );
          for (const oc of ocRows || []) {
            const admissionNumber = String(oc.admission_number || '').trim();
            if (admissionNumber && missingSet.has(admissionNumber)) {
              hasRevisedFeeByAdmission.set(admissionNumber, true);
            }
          }
        } catch (error) {
          console.warn(
            'Student Info fee-entry overall_concessions lookup failed:',
            error?.message || error
          );
        }
      }

      const filteredIds = (allIdRows || [])
        .filter((row) => {
          const admissionNumber = String(row.admission_number || '').trim();
          const hasRevisedFeeEntry = Boolean(hasRevisedFeeByAdmission.get(admissionNumber));
          return filterNoFeeEntry ? !hasRevisedFeeEntry : hasRevisedFeeEntry;
        })
        .map((row) => row.id);

      total = filteredIds.length;
      pageIds = filteredIds.slice(offset, offset + paginationLimit);
    } else {
      total = await getAdmissionCachedCount(
        pool,
        `SELECT COUNT(*) as total ${fromClause} ${whereClause}`,
        params,
        ADMISSION_CACHE_TTL.listCountMs,
        'list-admissions'
      );

      const idQuery = sourceFilter
        ? `SELECT /*+ NO_MERGE(src) */ a.id
           FROM admissions a
           JOIN (SELECT a.id ${fromClause} ${whereClause}) src ON src.id = a.id
           ORDER BY a.admission_number DESC, a.updated_at DESC
           LIMIT ${Number(paginationLimit)} OFFSET ${Number(offset)}`
        : `SELECT a.id ${fromClause} ${whereClause}
           ORDER BY a.admission_number DESC, a.updated_at DESC
           LIMIT ${Number(paginationLimit)} OFFSET ${Number(offset)}`;
      const [idRowsResult] = await pool.execute(idQuery, params);
      pageIds = (idRowsResult || []).map((row) => row.id);
    }

    let admissions = [];
    if (pageIds.length > 0) {
      const inMarks = pageIds.map(() => '?').join(',');
      const orderIndex = new Map(pageIds.map((id, index) => [String(id), index]));

      // Phase 2: fetch page rows by primary key (no ORDER BY — reorder in app to avoid sort buffer).
      const [pageRows] = await pool.execute(
        `SELECT a.id, a.lead_id, a.joining_id, a.admission_number, a.status,
                a.course_id, a.branch_id, a.managed_course_id, a.managed_branch_id, a.course, a.branch, a.quota,
                a.student_name, a.student_phone, a.created_at, a.updated_at,
                a.reservation_general, a.reservation_is_ews, a.reservation_other, a.payment_total_paid,
                a.qualification_merit, a.qualification_ac,
                a.document_ssc, a.document_inter, a.document_ug_pg_cmm, a.document_transfer_certificate,
                a.document_study_certificate, a.document_aadhaar_card, a.document_photos,
                a.document_income_certificate, a.document_caste_certificate, a.document_cet_rank_card,
                a.document_cet_hall_ticket, a.document_allotment_letter, a.document_joining_report,
                a.document_bank_passbook, a.document_ration_card,
                JSON_UNQUOTE(JSON_EXTRACT(a.lead_data, '$.reference1')) AS lead_data_reference1,
                JSON_UNQUOTE(JSON_EXTRACT(a.lead_data, '$.referenceName')) AS lead_data_reference_name,
                JSON_UNQUOTE(JSON_EXTRACT(a.lead_data, '$.source')) AS lead_data_source,
                JSON_UNQUOTE(JSON_EXTRACT(a.lead_data, '$.utmSource')) AS lead_data_utm_source,
                JSON_UNQUOTE(JSON_EXTRACT(a.lead_data, '$.leadSource')) AS lead_data_lead_source,
                JSON_UNQUOTE(JSON_EXTRACT(a.lead_data, '$._joiningRegistrationExtras.student_status')) AS list_student_status,
                JSON_UNQUOTE(JSON_EXTRACT(a.lead_data, '$._joiningRegistrationExtras.studentStatus')) AS list_student_status_alt,
                JSON_UNQUOTE(JSON_EXTRACT(j.lead_data, '$.reference1')) AS joining_lead_reference1,
                JSON_UNQUOTE(JSON_EXTRACT(j.lead_data, '$.referenceName')) AS joining_lead_reference_name,
                l.name as lead_name, l.phone as lead_phone, l.source as lead_source,
                l.upload_batch_id as upload_batch_id,
                JSON_UNQUOTE(JSON_EXTRACT(l.dynamic_fields, '$.reference1')) AS lead_dyn_reference1
         FROM admissions a
         LEFT JOIN joinings j ON j.id = a.joining_id
         LEFT JOIN leads l ON a.lead_id = l.id
         WHERE a.id IN (${inMarks})`,
        pageIds
      );
      admissions = pageRows.sort(
        (a, b) => (orderIndex.get(String(a.id)) ?? 0) - (orderIndex.get(String(b.id)) ?? 0)
      );
    }

    // Show catalog branch name (CSE), not roll code (BCSE), matching Fee Management / Step 4.
    const branchLabelById = await loadManagedBranchDisplayLabels(
      admissions.map((row) => row.managed_branch_id)
    );
    admissions = applyManagedBranchDisplayLabels(admissions, branchLabelById);

    const deskFeeRows = admissions.map((row) => ({
      admission_number: row.admission_number,
      quota: row.quota,
      course: row.course,
      branch: row.branch,
      joining_id: row.joining_id,
      id: row.id,
    }));
    // List needs year-1 paid + revised-fee flag only (paid/unpaid tuition summary is unused by the table).
    const [yearOnePaidByAdmissionNumber, hasRevisedFeeByAdmission] = await Promise.all([
      fetchPaidByAdmissionRowsForDesk(deskFeeRows),
      buildHasStepFourRevisedFeeEntriesByAdmissionRows(pool, deskFeeRows, {
        getSecondaryPool,
      }),
    ]);
    const formattedAdmissions = admissions.map((row) => {
      const item = formatAdmissionListItem(row);
      const admissionNumber = String(row.admission_number || '').trim();
      const yearOnePaid = yearOnePaidByAdmissionNumber.get(admissionNumber) ?? 0;
      // Student Info: No Fee Entry = no Step 4 revised/concession fee amounts.
      const hasRevisedFeeEntry = Boolean(hasRevisedFeeByAdmission.get(admissionNumber));
      const isNoFeeEntry = !hasRevisedFeeEntry;
      const hasFeeEntry = hasRevisedFeeEntry;
      const feeStatus = isNoFeeEntry ? 'no_entry' : 'unpaid';
      return {
        ...item,
        hasFeeEntry,
        feeStatus,
        paymentSummary: {
          ...item.paymentSummary,
          yearOnePaid,
          hasFeeEntry,
          feeStatus,
        },
      };
    });

    return successResponse(
      res,
      {
        admissions: formattedAdmissions,
        pagination: {
          page: Number(page),
          limit: paginationLimit,
          total,
          pages: Math.ceil(total / paginationLimit) || 1,
        },
      },
      'Admissions retrieved successfully',
      200
    );
  } catch (error) {
    console.error('Error listing admissions:', error);
    return errorResponse(
      res,
      error.message || 'Failed to list admissions',
      error.statusCode || 500
    );
  }
};

export const getAdmissionById = async (req, res) => {
  try {
    const { admissionId } = req.params;
    ensureAdmissionId(admissionId);

    const pool = getPool();

    // Fetch admission
    const [admissions] = await pool.execute(
      'SELECT * FROM admissions WHERE id = ?',
      [admissionId]
    );

    if (admissions.length === 0) {
      return errorResponse(res, 'Admission record not found', 404);
    }

    const admissionData = admissions[0];
    const formattedAdmission = await formatAdmission(admissionData, pool);

    // Fetch lead if exists
    let lead = null;
    if (admissionData.lead_id) {
      const [leads] = await pool.execute(
        `SELECT id, name, phone, father_name, father_phone, lead_status, admission_number, enquiry_number, dynamic_fields
         FROM leads WHERE id = ?`,
        [admissionData.lead_id]
      );
      if (leads.length > 0) {
        lead = formatLead(leads[0]);
      }
    }

    return successResponse(
      res,
      {
        admission: formattedAdmission,
        lead: lead || (formattedAdmission.leadData || {}),
      },
      'Admission record retrieved successfully',
      200
    );
  } catch (error) {
    console.error('Error fetching admission record:', error);
    return errorResponse(
      res,
      error.message || 'Failed to fetch admission record',
      error.statusCode || 500
    );
  }
};

export const getAdmissionByJoiningId = async (req, res) => {
  try {
    const { joiningId } = req.params;
    if (!joiningId || typeof joiningId !== 'string' || joiningId.length !== 36) {
      return errorResponse(res, 'Invalid joining identifier', 400);
    }

    const pool = getPool();

    // Fetch admission by joining_id
    const [admissions] = await pool.execute(
      'SELECT * FROM admissions WHERE joining_id = ?',
      [joiningId]
    );

    if (admissions.length === 0) {
      return errorResponse(res, 'Admission record not found for this joining', 404);
    }

    const admissionData = admissions[0];
    const formattedAdmission = await formatAdmission(admissionData, pool);

    // Fetch lead if exists
    let lead = null;
    if (admissionData.lead_id) {
      const [leads] = await pool.execute(
        `SELECT id, name, phone, father_name, father_phone, lead_status, admission_number, enquiry_number, dynamic_fields
         FROM leads WHERE id = ?`,
        [admissionData.lead_id]
      );
      if (leads.length > 0) {
        lead = formatLead(leads[0]);
      }
    }

    return successResponse(
      res,
      {
        admission: formattedAdmission,
        lead: lead || (formattedAdmission.leadData || {}),
      },
      'Admission record retrieved successfully',
      200
    );
  } catch (error) {
    console.error('Error fetching admission record:', error);
    return errorResponse(
      res,
      error.message || 'Failed to fetch admission record',
      error.statusCode || 500
    );
  }
};

export const getAdmissionByLead = async (req, res) => {
  try {
    const { leadId } = req.params;
    ensureLeadId(leadId);

    const pool = getPool();

    // Fetch admission by lead_id
    const [admissions] = await pool.execute(
      'SELECT * FROM admissions WHERE lead_id = ?',
      [leadId]
    );

    if (admissions.length === 0) {
      return errorResponse(res, 'Admission record not found for this lead', 404);
    }

    const admissionData = admissions[0];
    const formattedAdmission = await formatAdmission(admissionData, pool);

    // Fetch lead
    const [leads] = await pool.execute(
      `SELECT id, name, phone, father_name, father_phone, lead_status, admission_number, enquiry_number, dynamic_fields
       FROM leads WHERE id = ?`,
      [leadId]
    );

    const lead = leads.length > 0 ? formatLead(leads[0]) : null;

    return successResponse(
      res,
      {
        admission: formattedAdmission,
        lead: lead || (formattedAdmission.leadData || {}),
      },
      'Admission record retrieved successfully',
      200
    );
  } catch (error) {
    console.error('Error fetching admission record:', error);
    return errorResponse(
      res,
      error.message || 'Failed to fetch admission record',
      error.statusCode || 500
    );
  }
};

export const cancelAdmissionById = async (req, res) => {
  try {
    const { admissionId } = req.params;
    ensureAdmissionId(admissionId);

    const reason = String(req.body?.reason || '').trim();
    const approvedBy = String(req.body?.approvedBy || '').trim();

    if (!reason) {
      return errorResponse(res, 'Reason for cancellation is required', 400);
    }

    if (!approvedBy) {
      return errorResponse(res, 'Approved by is required', 400);
    }

    const pool = getPool();
    const [admissions] = await pool.execute(
      'SELECT * FROM admissions WHERE id = ?',
      [admissionId]
    );

    if (admissions.length === 0) {
      return errorResponse(res, 'Admission record not found', 404);
    }

    const admissionData = admissions[0];
    const existingLeadData = parseAdmissionLeadData(admissionData.lead_data);
    const cancellation = {
      reason,
      approvedBy,
      cancelledAt: new Date().toISOString(),
      cancelledBy: req.user.id,
    };
    const nextLeadData = {
      ...existingLeadData,
      _admissionCancellation: cancellation,
    };

    await pool.execute(
      `UPDATE admissions
       SET status = ?, lead_data = ?, updated_by = ?, updated_at = NOW()
       WHERE id = ?`,
      [ADMISSION_CANCELLED_STATUS, JSON.stringify(nextLeadData), req.user.id, admissionId]
    );

    if (admissionData.lead_id) {
      await pool.execute(
        `UPDATE leads
         SET application_status = ?, updated_at = NOW()
         WHERE id = ?`,
        [ADMISSION_CANCELLED_STATUS, admissionData.lead_id]
      );
    }

    const [updated] = await pool.execute(
      'SELECT * FROM admissions WHERE id = ?',
      [admissionId]
    );
    const formattedAdmission = await formatAdmission(updated[0], pool);

    warnIfSecondaryStudentSyncMissed(
      'cancelAdmissionById',
      { admissionId, admissionNumber: formattedAdmission.admissionNumber },
      await syncToSecondaryDatabase(formattedAdmission, formattedAdmission.admissionNumber, {
        leadId: formattedAdmission.leadId,
        joiningId: formattedAdmission.joiningId,
        email: formattedAdmission.leadData?.email || ''
      })
    );

    await appendAdmissionApplicationEditHistory(pool, {
      admissionId,
      leadId: admissionData.lead_id,
      userId: req.user.id,
      userName: req.user.name,
      kind: 'cancelled',
      title: 'Admission cancelled',
      description: reason,
      statusTo: ADMISSION_CANCELLED_STATUS,
    });

    clearAdmissionQueryCache();

    return successResponse(
      res,
      formattedAdmission,
      'Admission cancelled successfully',
      200
    );
  } catch (error) {
    console.error('Error cancelling admission:', error);
    return errorResponse(
      res,
      error.message || 'Failed to cancel admission',
      error.statusCode || 500
    );
  }
};

/**
 * Send the DLT-approved admission confirmation SMS to the student on demand.
 *
 * Wired to "Send Admission SMS" on the admission detail page so staff can
 * (re)trigger the message for any admission that already exists in the DB —
 * including ones approved before the auto-send was wired into `approveJoining`.
 *
 * The send is fully synchronous so the UI can surface success / failure /
 * skip reasons via toast. We never throw on gateway errors; instead we return
 * a structured payload that the frontend can show to the user.
 */
export const sendAdmissionConfirmationSmsById = async (req, res) => {
  try {
    const { admissionId } = req.params;
    ensureAdmissionId(admissionId);

    const pool = getPool();
    const [rows] = await pool.execute(
      `SELECT id, status, admission_number, student_name, student_phone, lead_id, lead_data
       FROM admissions WHERE id = ?`,
      [admissionId]
    );

    if (rows.length === 0) {
      return errorResponse(res, 'Admission record not found', 404);
    }

    const admission = rows[0];
    if (admission.status === ADMISSION_CANCELLED_STATUS) {
      return errorResponse(
        res,
        'Cannot send confirmation SMS — admission is cancelled.',
        400
      );
    }

    const admissionNumber = String(admission.admission_number || '').trim();
    if (!admissionNumber) {
      return errorResponse(
        res,
        'Cannot send confirmation SMS — admission number is missing on this record.',
        400
      );
    }

    // Fall back to the lead row if studentInfo on the admission is sparse.
    let studentName = String(admission.student_name || '').trim();
    let studentPhone = String(admission.student_phone || '').trim();
    if ((!studentName || !studentPhone) && admission.lead_id) {
      const [leadRows] = await pool.execute(
        'SELECT name, phone FROM leads WHERE id = ? LIMIT 1',
        [admission.lead_id]
      );
      if (leadRows.length > 0) {
        if (!studentName) studentName = String(leadRows[0].name || '').trim();
        if (!studentPhone) studentPhone = String(leadRows[0].phone || '').trim();
      }
    }

    if (!studentPhone) {
      return errorResponse(
        res,
        'Cannot send confirmation SMS — student phone is not on file for this admission.',
        400
      );
    }

    const result = await smsService.sendAdmissionConfirmation(
      studentPhone,
      studentName || 'Student',
      admissionNumber
    );

    if (!result?.success) {
      const reasonMap = {
        template_not_found:
          'Confirmation SMS template is not registered. Run `npm run migrate:admission-confirmation-sms-template` and try again.',
        invalid_mobile_number: 'Cannot send confirmation SMS — student phone is not a valid 10-digit number.',
        missing_admission_number: 'Cannot send confirmation SMS — admission number is missing.',
        gateway_rejected:
          `SMS gateway rejected the request${result?.gatewayMessage ? `: ${result.gatewayMessage}` : ''}. ` +
          'Verify that DLT template id is whitelisted on the BulkSMSApps account and that sender id matches.',
      };
      const message =
        reasonMap[result?.error] ||
        `Failed to send confirmation SMS${result?.error ? `: ${result.error}` : ''}.`;
      return errorResponse(res, message, 502);
    }

    return successResponse(
      res,
      {
        sentTo: studentPhone.replace(/\D/g, '').slice(-10),
        admissionNumber,
        gateway: result.data ?? null,
      },
      'Admission confirmation SMS sent.',
      200
    );
  } catch (error) {
    console.error('Error sending admission confirmation SMS:', error);
    return errorResponse(
      res,
      error.message || 'Failed to send admission confirmation SMS',
      error.statusCode || 500
    );
  }
};

/** Flat paper columns that belong to Important Documents (certificate checklist). */
const IMPORTANT_FLAT_DOCUMENT_LABELS = {
  document_ssc: 'SSC',
  document_inter: 'Intermediate',
  document_transfer_certificate: 'Transfer Certificate',
  document_study_certificate: 'Study Certificate',
};

const DOCUMENT_SMS_COLLEGE_PHONE = '+91 73823 15999';

const documentSmsFailureMessage = (result) => {
  const reasonMap = {
    invalid_mobile_number:
      'Cannot send document notification SMS — student phone is not a valid 10-digit number.',
    gateway_rejected:
      `SMS gateway rejected the request${result?.gatewayMessage ? `: ${result.gatewayMessage}` : ''}. ` +
      'Verify that DLT template id is whitelisted on the BulkSMSApps account and that sender id matches.',
  };
  return (
    reasonMap[result?.error] ||
    `Failed to send document notification SMS${result?.error ? `: ${result.error}` : ''}.`
  );
};

/**
 * Resolve pending Important Documents labels for an admission row.
 * Prefers Step 2 certificate_checklist + certificate_config; falls back to flat paper columns.
 */
const resolveImportantPendingDocumentsForRow = (admission, certRoot) => {
  const leadDataRaw =
    typeof admission.lead_data === 'string'
      ? (() => {
          try {
            return JSON.parse(admission.lead_data || '{}');
          } catch {
            return {};
          }
        })()
      : admission.lead_data && typeof admission.lead_data === 'object'
        ? admission.lead_data
        : {};
  const extras =
    leadDataRaw?._joiningRegistrationExtras &&
    typeof leadDataRaw._joiningRegistrationExtras === 'object'
      ? leadDataRaw._joiningRegistrationExtras
      : {};
  const checklistRaw =
    admission.certificate_checklist !== undefined && admission.certificate_checklist !== null
      ? parseJsonMaybe(admission.certificate_checklist)
      : extras.certificate_checklist;
  const programLevel = resolveProgramLevelFromAdmissionRow({
    program_level: admission.program_level ?? leadDataRaw?._joiningProgramLevel,
    extras_program_level: admission.extras_program_level ?? extras.program_level,
    extras_programLevel: admission.extras_programLevel ?? extras.programLevel,
    extras_course_level: admission.extras_course_level ?? extras.course_level,
  });
  const items = getCertificateItemsForLevel(certRoot, programLevel);
  const fromChecklist = pendingImportantDocumentLabels({
    checklistRaw,
    items,
  });
  if (fromChecklist.length > 0) return fromChecklist;

  // No checklist entries — fall back to flat Important Documents columns.
  const fallback = [];
  for (const [colKey, label] of Object.entries(IMPORTANT_FLAT_DOCUMENT_LABELS)) {
    const status = String(admission[colKey] || '').trim().toLowerCase();
    if (status !== 'received') {
      fallback.push(label);
    }
  }
  return fallback;
};

const loadAdmissionForDocumentSms = async (pool, admissionId) => {
  const [rows] = await pool.execute(
    `SELECT id, status, student_name, student_phone, preferred_mobile_number,
            father_phone, mother_phone, lead_id, lead_data, qualification_merit,
            document_ssc, document_inter, document_ug_pg_cmm,
            document_transfer_certificate, document_study_certificate,
            JSON_UNQUOTE(JSON_EXTRACT(lead_data, '$._joiningProgramLevel')) AS program_level,
            JSON_UNQUOTE(JSON_EXTRACT(lead_data, '$._joiningRegistrationExtras.program_level')) AS extras_program_level,
            JSON_UNQUOTE(JSON_EXTRACT(lead_data, '$._joiningRegistrationExtras.programLevel')) AS extras_programLevel,
            JSON_UNQUOTE(JSON_EXTRACT(lead_data, '$._joiningRegistrationExtras.course_level')) AS extras_course_level,
            JSON_EXTRACT(lead_data, '$._joiningRegistrationExtras.certificate_checklist') AS certificate_checklist
     FROM admissions WHERE id = ?`,
    [admissionId]
  );
  return rows[0] || null;
};

/**
 * Recipient for document + pending-fee SMS: preferred mobile (usually parent),
 * then suggested parent line, then student phone, then lead phone.
 */
const resolveStudentContactForDocumentSms = async (pool, admission) => {
  let studentName = String(admission.student_name || '').trim();
  let studentPhone = String(admission.student_phone || '').trim();
  let fatherPhone = String(admission.father_phone || '').trim();
  let motherPhone = String(admission.mother_phone || '').trim();
  let preferredMobile = String(admission.preferred_mobile_number || '').trim();

  if (
    (!studentName || !studentPhone || !fatherPhone || !preferredMobile) &&
    admission.lead_id
  ) {
    const [leadRows] = await pool.execute(
      'SELECT name, phone, father_phone FROM leads WHERE id = ? LIMIT 1',
      [admission.lead_id]
    );
    if (leadRows.length > 0) {
      if (!studentName) studentName = String(leadRows[0].name || '').trim();
      if (!studentPhone) studentPhone = String(leadRows[0].phone || '').trim();
      if (!fatherPhone) fatherPhone = String(leadRows[0].father_phone || '').trim();
    }
  }

  const preferredDigits = normalizeMobileDigits(preferredMobile);
  const suggestedDigits = suggestPreferredMobileDigits(studentPhone, fatherPhone, motherPhone);
  const studentDigits = normalizeMobileDigits(studentPhone);

  let smsPhone = '';
  if (preferredDigits.length === 10) smsPhone = preferredDigits;
  else if (suggestedDigits.length === 10) smsPhone = suggestedDigits;
  else if (studentDigits.length === 10) smsPhone = studentDigits;

  return { studentName, studentPhone: smsPhone };
};

/**
 * Send Important Documents pending SMS for one admission.
 * selectedDocuments (optional) must be a subset of pending important labels.
 */
const sendImportantDocumentsSmsForAdmission = async ({
  pool,
  admission,
  certRoot,
  selectedDocuments,
}) => {
  if (admission.status === ADMISSION_CANCELLED_STATUS) {
    return {
      success: false,
      skipped: true,
      admissionId: admission.id,
      error: 'cancelled',
      message: 'Admission is cancelled.',
    };
  }

  const { studentName, studentPhone } = await resolveStudentContactForDocumentSms(
    pool,
    admission
  );
  if (!studentPhone) {
    return {
      success: false,
      skipped: true,
      admissionId: admission.id,
      error: 'missing_phone',
      message: 'Preferred / parent mobile number is not on file.',
    };
  }

  const importantPending = resolveImportantPendingDocumentsForRow(admission, certRoot);
  let pendingDocuments = importantPending;
  if (selectedDocuments && Array.isArray(selectedDocuments) && selectedDocuments.length > 0) {
    const allowed = new Set(importantPending.map((label) => String(label).trim().toLowerCase()));
    pendingDocuments = selectedDocuments
      .map((label) => String(label || '').trim())
      .filter((label) => label && allowed.has(label.toLowerCase()));
    // If the client sent labels that don't match (stale UI), fall back to all important pending.
    if (pendingDocuments.length === 0) {
      pendingDocuments = importantPending;
    }
  }

  if (pendingDocuments.length === 0) {
    return {
      success: false,
      skipped: true,
      admissionId: admission.id,
      error: 'no_important_pending',
      message: 'No pending Important Documents to notify.',
      studentName: studentName || 'Student',
    };
  }

  const result = await smsService.sendDocumentNotification(
    studentPhone,
    studentName || 'Student',
    pendingDocuments,
    DOCUMENT_SMS_COLLEGE_PHONE
  );

  if (!result?.success) {
    return {
      success: false,
      admissionId: admission.id,
      error: result?.error || 'sms_send_failed',
      message: documentSmsFailureMessage(result),
      pendingDocuments,
      studentName: studentName || 'Student',
    };
  }

  return {
    success: true,
    admissionId: admission.id,
    sentTo: studentPhone.replace(/\D/g, '').slice(-10),
    pendingDocuments,
    studentName: studentName || 'Student',
    gateway: result.data ?? null,
  };
};

export const sendDocumentNotificationSmsById = async (req, res) => {
  try {
    const { admissionId } = req.params;
    const { selectedDocuments } = req.body || {};
    ensureAdmissionId(admissionId);

    const pool = getPool();
    const admission = await loadAdmissionForDocumentSms(pool, admissionId);
    if (!admission) {
      return errorResponse(res, 'Admission record not found', 404);
    }

    const certRoot = await loadCertificateConfigRoot();
    const sendResult = await sendImportantDocumentsSmsForAdmission({
      pool,
      admission,
      certRoot,
      selectedDocuments,
    });

    if (sendResult.skipped) {
      return errorResponse(
        res,
        `Cannot send document notification SMS — ${sendResult.message}`,
        400
      );
    }

    if (!sendResult.success) {
      return errorResponse(res, sendResult.message, 502);
    }

    return successResponse(
      res,
      {
        sentTo: sendResult.sentTo,
        pendingDocuments: sendResult.pendingDocuments,
        importantDocumentsOnly: true,
        gateway: sendResult.gateway,
      },
      'Document notification SMS sent (Important Documents).',
      200
    );
  } catch (error) {
    console.error('Error sending document notification SMS:', error);
    return errorResponse(
      res,
      error.message || 'Failed to send document notification SMS',
      error.statusCode || 500
    );
  }
};

/**
 * Bulk-send Important Documents pending SMS for selected admissions.
 * Body: { admissionIds: string[] }
 */
export const sendDocumentNotificationSmsBulk = async (req, res) => {
  try {
    const rawIds = req.body?.admissionIds;
    const pendingFeeAmountsByAdmissionIdRaw = req.body?.pendingFeeAmountsByAdmissionId;
    const pendingFeeAmountsByAdmissionId =
      pendingFeeAmountsByAdmissionIdRaw && typeof pendingFeeAmountsByAdmissionIdRaw === 'object'
        ? pendingFeeAmountsByAdmissionIdRaw
        : {};
    if (!Array.isArray(rawIds) || rawIds.length === 0) {
      return errorResponse(res, 'admissionIds array is required', 400);
    }

    const admissionIds = [
      ...new Set(
        rawIds
          .map((id) => String(id || '').trim())
          .filter((id) => id.length === 36)
      ),
    ];
    if (admissionIds.length === 0) {
      return errorResponse(res, 'No valid admission ids provided', 400);
    }
    if (admissionIds.length > 500) {
      return errorResponse(res, 'Cannot send to more than 500 admissions at once', 400);
    }

    const pool = getPool();
    const certRoot = await loadCertificateConfigRoot();

    const normalizeMinimumFeeMatchKey = (value) =>
      String(value ?? '')
        .trim()
        .toLowerCase();
    const resolveMinimumFeeAmountForSms = (configs, match) => {
      if (!Array.isArray(configs) || configs.length === 0) return 0;
      const quota = normalizeMinimumFeeMatchKey(match?.quota);
      const courseId = String(match?.courseId ?? '').trim();
      const courseName = normalizeMinimumFeeMatchKey(match?.courseName);
      const branchId = String(match?.branchId ?? '').trim();
      const branchName = normalizeMinimumFeeMatchKey(match?.branchName);
      if (courseId && branchId && quota) {
        const byCourseId = configs.find(
          (c) =>
            String(c.courseId ?? '').trim() === courseId &&
            String(c.branchId ?? '').trim() === branchId &&
            normalizeMinimumFeeMatchKey(c.quota) === quota
        );
        if (byCourseId) return Number(byCourseId.amount) || 0;
      }
      if (courseName && branchName && quota) {
        const byCourseName = configs.find(
          (c) =>
            normalizeMinimumFeeMatchKey(c.courseName) === courseName &&
            normalizeMinimumFeeMatchKey(c.branchName) === branchName &&
            normalizeMinimumFeeMatchKey(c.quota) === quota
        );
        if (byCourseName) return Number(byCourseName.amount) || 0;
      }
      if (branchId && quota) {
        const byQuota = configs.filter(
          (c) =>
            String(c.branchId ?? '').trim() === branchId &&
            normalizeMinimumFeeMatchKey(c.quota) === quota
        );
        if (byQuota.length === 1) return Number(byQuota[0].amount) || 0;
      }
      if (courseId && quota) {
        const courseLevel = configs.find(
          (c) =>
            String(c.courseId ?? '').trim() === courseId &&
            String(c.branchId ?? '').trim() === '' &&
            normalizeMinimumFeeMatchKey(c.quota) === quota
        );
        if (courseLevel) return Number(courseLevel.amount) || 0;
      }
      if (courseName && quota) {
        const byCourseName = configs.find(
          (c) =>
            normalizeMinimumFeeMatchKey(c.courseName) === courseName &&
            String(c.branchId ?? '').trim() === '' &&
            normalizeMinimumFeeMatchKey(c.quota) === quota
        );
        if (byCourseName) return Number(byCourseName.amount) || 0;
      }
      return 0;
    };

    // Pre-compute pending fee amounts for the same admission ids (Year-1 tuition + other / Special)
    // so we can send "Admission Confirmation Pending" SMS alongside certificate SMS.
    const pendingAmountByAdmissionId = new Map();
    const hasMatchingMinimumFeeConfigByAdmissionId = new Map();
    try {
      if (admissionIds.length > 0) {
        const inMarks = admissionIds.map(() => '?').join(',');
        const [detailRows] = await pool.execute(
          `SELECT a.id, a.admission_number, a.student_name, a.student_phone, a.father_phone,
                  a.quota, a.course, a.branch, a.managed_course_id, a.course_id, a.managed_branch_id, a.branch_id
           FROM admissions a
           WHERE a.id IN (${inMarks})`,
          admissionIds
        );

        const [minimumFeeConfigRows] = await pool.execute(
          `SELECT college_id, course_id, course_name, branch_id, branch_name, quota, amount
           FROM admission_minimum_fee_configs`
        );
        const minimumFeeConfigs = (minimumFeeConfigRows || []).map((row) => ({
          collegeId: String(row.college_id ?? ''),
          courseId: String(row.course_id ?? ''),
          courseName: String(row.course_name ?? ''),
          branchId: String(row.branch_id ?? ''),
          branchName: String(row.branch_name ?? ''),
          quota: String(row.quota ?? ''),
          amount: Number(row.amount) || 0,
        }));

        const feeSummaries = await buildTuitionAndOtherFeeSummariesForAdmissionRows(detailRows);
        for (const row of detailRows || []) {
          const admissionNumber = String(row.admission_number || '').trim();
          const summary = feeSummaries.get(admissionNumber);
          const formatted = formatPendingFeeRow(row, summary);
          pendingAmountByAdmissionId.set(String(row.id), Number(formatted.totalPending || 0));
          const minimumFeeAmount = resolveMinimumFeeAmountForSms(minimumFeeConfigs, {
            courseId: row.managed_course_id || row.course_id,
            courseName: row.course,
            branchId: row.managed_branch_id || row.branch_id,
            branchName: row.branch,
            quota: row.quota,
          });
          hasMatchingMinimumFeeConfigByAdmissionId.set(
            String(row.id),
            minimumFeeAmount > 0
          );
        }
      }
    } catch (feeErr) {
      // SMS should still send for documents even if fee computation fails.
      console.warn('Failed to precompute pending fee amounts for pending confirmation SMS:', feeErr?.message || feeErr);
    }

    const results = [];
    let sent = 0;
    let skipped = 0;
    let failed = 0;

    let confirmationSent = 0;
    let confirmationSkipped = 0;
    let confirmationFailed = 0;

    for (const admissionId of admissionIds) {
      const admission = await loadAdmissionForDocumentSms(pool, admissionId);
      if (!admission) {
        failed += 1;
        results.push({
          success: false,
          admissionId,
          error: 'not_found',
          message: 'Admission record not found.',
        });
        continue;
      }

      const sendResult = await sendImportantDocumentsSmsForAdmission({
        pool,
        admission,
        certRoot,
      });

      // Send Admission Confirmation Pending SMS when there is a pending fee amount.
      // Uses template id + message defined in sms.service.js.
      // Same preferred-mobile recipient as document SMS (parent line when set).
      let confirmationResult = null;
      const pendingAmountFromClient = Number(pendingFeeAmountsByAdmissionId?.[String(admission.id)] ?? 0);
      const pendingAmountFromServer = Number(pendingAmountByAdmissionId.get(String(admission.id)) || 0);
      const pendingAmount = pendingAmountFromClient > 0 ? pendingAmountFromClient : pendingAmountFromServer;
      const hasMatchingMinimumFeeConfig =
        hasMatchingMinimumFeeConfigByAdmissionId.size === 0
          ? pendingAmountFromClient > 0
          : hasMatchingMinimumFeeConfigByAdmissionId.get(String(admission.id)) === true;
      if (
        pendingAmount > 0 &&
        hasMatchingMinimumFeeConfig &&
        admission.status !== ADMISSION_CANCELLED_STATUS
      ) {
        const { studentName: feeSmsName, studentPhone: feeSmsPhone } =
          await resolveStudentContactForDocumentSms(pool, admission);
        if (!feeSmsPhone) {
          confirmationResult = {
            success: false,
            skipped: true,
            error: 'missing_phone',
          };
          confirmationSkipped += 1;
        } else {
          confirmationResult = await smsService.sendAdmissionConfirmationPending(
            feeSmsPhone,
            feeSmsName || admission.student_name,
            pendingAmount,
            DOCUMENT_SMS_COLLEGE_PHONE,
            {
              meritYes:
                admission.qualification_merit === 1 || admission.qualification_merit === true,
            }
          );
          if (confirmationResult?.success) confirmationSent += 1;
          else if (confirmationResult?.skipped) confirmationSkipped += 1;
          else confirmationFailed += 1;
        }
      } else {
        confirmationSkipped += 1;
      }

      if (sendResult && typeof sendResult === 'object') {
        sendResult.confirmationPendingSms = {
          pendingAmount,
          ...((confirmationResult && typeof confirmationResult === 'object') ? confirmationResult : {}),
        };
      }

      results.push(sendResult);
      if (sendResult.success) sent += 1;
      else if (sendResult.skipped) skipped += 1;
      else failed += 1;
    }

    return successResponse(
      res,
      {
        importantDocumentsOnly: true,
        requested: admissionIds.length,
        sent,
        skipped,
        failed,
        confirmationPendingSms: {
          sent: confirmationSent,
          skipped: confirmationSkipped,
          failed: confirmationFailed,
        },
        results,
      },
      `Document notification SMS finished — sent ${sent}, skipped ${skipped}, failed ${failed}.`,
      200
    );
  } catch (error) {
    console.error('Error sending bulk document notification SMS:', error);
    return errorResponse(
      res,
      error.message || 'Failed to send bulk document notification SMS',
      error.statusCode || 500
    );
  }
};

export const updateAdmissionById = async (req, res) => {
  try {
    const { admissionId } = req.params;
    ensureAdmissionId(admissionId);

    const pool = getPool();

    // Fetch admission
    const [admissions] = await pool.execute(
      'SELECT * FROM admissions WHERE id = ?',
      [admissionId]
    );

    if (admissions.length === 0) {
      return errorResponse(res, 'Admission record not found', 404);
    }

    const validationErrors = validateAdmissionPayload(req.body);
    if (validationErrors.length > 0) {
      return errorResponse(res, validationErrors.join(', '), 400);
    }

    const payload = { ...req.body };
    const linkedJoiningId = admissions[0].joining_id || null;

    if (payload.courseInfo !== undefined) {
      await persistAdmissionCourseBranchUpdate(
        pool,
        admissionId,
        payload.courseInfo,
        req.user?.id,
        linkedJoiningId
      );
      delete payload.courseInfo;
    }

    // Build dynamic UPDATE query
    const updateFields = [];
    const updateParams = [];

    if (payload.studentInfo !== undefined) {
      if (payload.studentInfo.name !== undefined) {
        updateFields.push('student_name = ?');
        updateParams.push(payload.studentInfo.name || '');
      }
      if (payload.studentInfo.phone !== undefined) {
        updateFields.push('student_phone = ?');
        updateParams.push(payload.studentInfo.phone || '');
      }
      if (payload.studentInfo.gender !== undefined) {
        updateFields.push('student_gender = ?');
        updateParams.push(payload.studentInfo.gender || '');
      }
      if (payload.studentInfo.dateOfBirth !== undefined) {
        updateFields.push('student_date_of_birth = ?');
        updateParams.push(normalizeStudentDobForStorage(payload.studentInfo.dateOfBirth));
      }
      if (payload.studentInfo.notes !== undefined) {
        updateFields.push('student_notes = ?');
        updateParams.push(payload.studentInfo.notes || '');
      }
      if (payload.studentInfo.aadhaarNumber !== undefined) {
        updateFields.push('student_aadhaar_number = ?');
        updateParams.push(payload.studentInfo.aadhaarNumber || null);
      }
      if (payload.studentInfo.preferredMobileNumber !== undefined) {
        updateFields.push('preferred_mobile_number = ?');
        const preferred = String(payload.studentInfo.preferredMobileNumber || '')
          .replace(/\D/g, '')
          .slice(-10);
        updateParams.push(preferred.length === 10 ? preferred : '');
      }
      if (payload.studentInfo.photo !== undefined) {
        updateFields.push('student_photo = ?');
        const p = String(payload.studentInfo.photo || '').trim();
        updateParams.push(p || null);
      }
    }

    if (payload.parents !== undefined) {
      if (payload.parents.father !== undefined) {
        if (payload.parents.father.name !== undefined) {
          updateFields.push('father_name = ?');
          updateParams.push(payload.parents.father.name || '');
        }
        if (payload.parents.father.phone !== undefined) {
          updateFields.push('father_phone = ?');
          updateParams.push(payload.parents.father.phone || '');
        }
        if (payload.parents.father.aadhaarNumber !== undefined) {
          updateFields.push('father_aadhaar_number = ?');
          updateParams.push(payload.parents.father.aadhaarNumber || null);
        }
        if (payload.parents.father.photo !== undefined) {
          updateFields.push('father_photo = ?');
          const p = String(payload.parents.father.photo || '').trim();
          updateParams.push(p || null);
        }
        if (payload.parents.father.occupation !== undefined) {
          updateFields.push('father_occupation = ?');
          updateParams.push(payload.parents.father.occupation || '');
        }
      }
      if (payload.parents.mother !== undefined) {
        if (payload.parents.mother.name !== undefined) {
          updateFields.push('mother_name = ?');
          updateParams.push(payload.parents.mother.name || '');
        }
        if (payload.parents.mother.phone !== undefined) {
          updateFields.push('mother_phone = ?');
          updateParams.push(payload.parents.mother.phone || '');
        }
        if (payload.parents.mother.aadhaarNumber !== undefined) {
          updateFields.push('mother_aadhaar_number = ?');
          updateParams.push(payload.parents.mother.aadhaarNumber || null);
        }
        if (payload.parents.mother.photo !== undefined) {
          updateFields.push('mother_photo = ?');
          const p = String(payload.parents.mother.photo || '').trim();
          updateParams.push(p || null);
        }
        if (payload.parents.mother.occupation !== undefined) {
          updateFields.push('mother_occupation = ?');
          updateParams.push(payload.parents.mother.occupation || '');
        }
      }
    }

    if (payload.reservation !== undefined) {
      if (payload.reservation.general !== undefined) {
        updateFields.push('reservation_general = ?');
        updateParams.push(payload.reservation.general || '');
      }
      if (payload.reservation.other !== undefined) {
        updateFields.push('reservation_other = ?');
        updateParams.push(JSON.stringify(payload.reservation.other || []));
      }
      if (payload.reservation.isEws !== undefined) {
        updateFields.push('reservation_is_ews = ?');
        updateParams.push(payload.reservation.isEws === true ? 1 : 0);
      }
      await persistAdmissionReservationMeta(pool, admissionId, payload.reservation, req.user?.id);
    }

    if (payload.address?.communication !== undefined) {
      const comm = normalizeCommunicationAddress(payload.address.communication);
      if (payload.address.communication.doorOrStreet !== undefined) {
        updateFields.push('address_door_street = ?');
        updateParams.push(comm.doorOrStreet || '');
      }
      if (payload.address.communication.landmark !== undefined) {
        updateFields.push('address_landmark = ?');
        updateParams.push(comm.landmark || '');
      }
      if (payload.address.communication.villageOrCity !== undefined) {
        updateFields.push('address_village_city = ?');
        updateParams.push(comm.villageOrCity || '');
      }
      if (payload.address.communication.mandal !== undefined) {
        updateFields.push('address_mandal = ?');
        updateParams.push(comm.mandal || '');
      }
      if (payload.address.communication.district !== undefined) {
        updateFields.push('address_district = ?');
        updateParams.push(comm.district || '');
      }
      if (payload.address.communication.pinCode !== undefined) {
        updateFields.push('address_pin_code = ?');
        updateParams.push(comm.pinCode || '');
      }
      if (payload.address.communication.state !== undefined) {
        updateFields.push('address_state = ?');
        updateParams.push(comm.state || '');
      }
    }

    if (payload.qualifications !== undefined) {
      if (payload.qualifications.ssc !== undefined) {
        updateFields.push('qualification_ssc = ?');
        updateParams.push(payload.qualifications.ssc === true ? 1 : 0);
      }
      if (payload.qualifications.interOrDiploma !== undefined) {
        updateFields.push('qualification_inter_diploma = ?');
        updateParams.push(payload.qualifications.interOrDiploma === true ? 1 : 0);
      }
      if (payload.qualifications.ug !== undefined) {
        updateFields.push('qualification_ug = ?');
        updateParams.push(payload.qualifications.ug === true ? 1 : 0);
      }
      if (payload.qualifications.merit !== undefined) {
        updateFields.push('qualification_merit = ?');
        updateParams.push(qualificationMeritToSql(payload.qualifications.merit));
      }
      if (payload.qualifications.ac !== undefined) {
        updateFields.push('qualification_ac = ?');
        updateParams.push(qualificationAcToSql(payload.qualifications.ac));
      }
      if (payload.qualifications.mediums !== undefined) {
        updateFields.push('qualification_mediums = ?');
        updateParams.push(JSON.stringify(payload.qualifications.mediums || []));
      }
      if (payload.qualifications.otherMediumLabel !== undefined) {
        updateFields.push('qualification_other_medium_label = ?');
        updateParams.push(payload.qualifications.otherMediumLabel || '');
      }
    }

    if (payload.documents !== undefined) {
      const docs = payload.documents;
      const docFields = [
        'ssc', 'inter', 'ugPgCmm', 'transferCertificate', 'studyCertificate',
        'aadhaarCard', 'photos', 'incomeCertificate', 'casteCertificate',
        'cetRankCard', 'cetHallTicket', 'allotmentLetter', 'joiningReport',
        'bankPassbook', 'rationCard',
      ];
      const sqlDocFields = [
        'document_ssc', 'document_inter', 'document_ug_pg_cmm', 'document_transfer_certificate',
        'document_study_certificate', 'document_aadhaar_card', 'document_photos',
        'document_income_certificate', 'document_caste_certificate', 'document_cet_rank_card',
        'document_cet_hall_ticket', 'document_allotment_letter', 'document_joining_report',
        'document_bank_passbook', 'document_ration_card',
      ];
      docFields.forEach((field, idx) => {
        if (docs[field] !== undefined) {
          updateFields.push(`${sqlDocFields[idx]} = ?`);
          updateParams.push(docs[field] || 'pending');
        }
      });
    }

    if (payload.status !== undefined) {
      updateFields.push('status = ?');
      updateParams.push(payload.status);
    }

    if (payload.remarks !== undefined) {
      updateFields.push('remarks = ?');
      updateParams.push(payload.remarks || '');
    }

    // Always update updated_by and updated_at
    updateFields.push('updated_by = ?');
    updateFields.push('updated_at = NOW()');
    updateParams.push(req.user.id);

    // Add admissionId to params
    updateParams.push(admissionId);

    // Execute update
    if (updateFields.length > 2) { // More than just updated_by and updated_at
      await pool.execute(
        `UPDATE admissions SET ${updateFields.join(', ')} WHERE id = ?`,
        updateParams
      );
    }

    // Update related tables if provided
    if (payload.address?.relatives !== undefined || payload.educationHistory !== undefined || payload.siblings !== undefined) {
      await saveAdmissionRelatedTables(pool, admissionId, payload);
    }

    if (payload.reference1 !== undefined) {
      await persistAdmissionReference1WithHistory(
        pool,
        admissionId,
        payload.reference1,
        req.user
      );
    }

    if (payload.admissionPhase !== undefined || payload.phase !== undefined) {
      const rawPhase =
        payload.admissionPhase !== undefined ? payload.admissionPhase : payload.phase;
      const normalized = normalizeAdmissionPhase(rawPhase);
      if (String(rawPhase ?? '').trim() !== '' && !normalized) {
        return errorResponse(res, 'admissionPhase must be 1, 2, 3, 4, or 5', 400);
      }
      await persistAdmissionPhase(pool, admissionId, normalized, req.user.id);
    }

    if (payload.registrationFormData !== undefined || Object.prototype.hasOwnProperty.call(payload, 'studentFeeDetails')) {
      await persistAdmissionRegistrationSidecar(pool, admissionId, payload, req.user.id);
    }

    // Fetch and return updated admission
    const [updated] = await pool.execute(
      'SELECT * FROM admissions WHERE id = ?',
      [admissionId]
    );
    const formattedAdmission = await formatAdmission(updated[0], pool);

    warnIfSecondaryStudentSyncMissed(
      'updateAdmissionById',
      { admissionId, admissionNumber: formattedAdmission.admissionNumber },
      await syncToSecondaryDatabase(formattedAdmission, formattedAdmission.admissionNumber, {
        leadId: formattedAdmission.leadId,
        joiningId: formattedAdmission.joiningId,
        email: formattedAdmission.leadData?.email || ''
      })
    );

    await appendAdmissionApplicationEditHistory(pool, {
      admissionId,
      leadId: formattedAdmission.leadId,
      userId: req.user.id,
      userName: req.user.name,
      kind: 'update',
      title: 'Admission application updated',
      description: 'Admission record saved',
    });

    return successResponse(
      res,
      formattedAdmission,
      'Admission record updated successfully',
      200
    );
  } catch (error) {
    console.error('Error updating admission record:', error);
    return errorResponse(
      res,
      error.message || 'Failed to update admission record',
      error.statusCode || 500
    );
  }
};

export const updateAdmissionByLead = async (req, res) => {
  try {
    const { leadId } = req.params;
    ensureLeadId(leadId);

    const pool = getPool();

    const admissionRow = await resolveAdmissionRowByRouteParam(pool, leadId);
    if (!admissionRow) {
      return errorResponse(res, 'Admission record not found for this lead or joining', 404);
    }

    const admissionId = admissionRow.id;
    const linkedJoiningId = admissionRow.joining_id || null;

    const validationErrors = validateAdmissionPayload(req.body);
    if (validationErrors.length > 0) {
      return errorResponse(res, validationErrors.join(', '), 400);
    }

    const payload = { ...req.body };

    if (payload.courseInfo !== undefined) {
      await persistAdmissionCourseBranchUpdate(
        pool,
        admissionId,
        payload.courseInfo,
        req.user?.id,
        linkedJoiningId
      );
      delete payload.courseInfo;
    }

    // Build dynamic UPDATE query (same as updateAdmissionById)
    const updateFields = [];
    const updateParams = [];

    if (payload.studentInfo !== undefined) {
      if (payload.studentInfo.name !== undefined) {
        updateFields.push('student_name = ?');
        updateParams.push(payload.studentInfo.name || '');
      }
      if (payload.studentInfo.phone !== undefined) {
        updateFields.push('student_phone = ?');
        updateParams.push(payload.studentInfo.phone || '');
      }
      if (payload.studentInfo.gender !== undefined) {
        updateFields.push('student_gender = ?');
        updateParams.push(payload.studentInfo.gender || '');
      }
      if (payload.studentInfo.dateOfBirth !== undefined) {
        updateFields.push('student_date_of_birth = ?');
        updateParams.push(normalizeStudentDobForStorage(payload.studentInfo.dateOfBirth));
      }
      if (payload.studentInfo.notes !== undefined) {
        updateFields.push('student_notes = ?');
        updateParams.push(payload.studentInfo.notes || '');
      }
      if (payload.studentInfo.aadhaarNumber !== undefined) {
        updateFields.push('student_aadhaar_number = ?');
        updateParams.push(payload.studentInfo.aadhaarNumber || null);
      }
      if (payload.studentInfo.preferredMobileNumber !== undefined) {
        updateFields.push('preferred_mobile_number = ?');
        const preferred = String(payload.studentInfo.preferredMobileNumber || '')
          .replace(/\D/g, '')
          .slice(-10);
        updateParams.push(preferred.length === 10 ? preferred : '');
      }
      if (payload.studentInfo.photo !== undefined) {
        updateFields.push('student_photo = ?');
        const p = String(payload.studentInfo.photo || '').trim();
        updateParams.push(p || null);
      }
    }

    if (payload.parents !== undefined) {
      if (payload.parents.father !== undefined) {
        if (payload.parents.father.name !== undefined) {
          updateFields.push('father_name = ?');
          updateParams.push(payload.parents.father.name || '');
        }
        if (payload.parents.father.phone !== undefined) {
          updateFields.push('father_phone = ?');
          updateParams.push(payload.parents.father.phone || '');
        }
        if (payload.parents.father.aadhaarNumber !== undefined) {
          updateFields.push('father_aadhaar_number = ?');
          updateParams.push(payload.parents.father.aadhaarNumber || null);
        }
        if (payload.parents.father.photo !== undefined) {
          updateFields.push('father_photo = ?');
          const p = String(payload.parents.father.photo || '').trim();
          updateParams.push(p || null);
        }
        if (payload.parents.father.occupation !== undefined) {
          updateFields.push('father_occupation = ?');
          updateParams.push(payload.parents.father.occupation || '');
        }
      }
      if (payload.parents.mother !== undefined) {
        if (payload.parents.mother.name !== undefined) {
          updateFields.push('mother_name = ?');
          updateParams.push(payload.parents.mother.name || '');
        }
        if (payload.parents.mother.phone !== undefined) {
          updateFields.push('mother_phone = ?');
          updateParams.push(payload.parents.mother.phone || '');
        }
        if (payload.parents.mother.aadhaarNumber !== undefined) {
          updateFields.push('mother_aadhaar_number = ?');
          updateParams.push(payload.parents.mother.aadhaarNumber || null);
        }
        if (payload.parents.mother.photo !== undefined) {
          updateFields.push('mother_photo = ?');
          const p = String(payload.parents.mother.photo || '').trim();
          updateParams.push(p || null);
        }
        if (payload.parents.mother.occupation !== undefined) {
          updateFields.push('mother_occupation = ?');
          updateParams.push(payload.parents.mother.occupation || '');
        }
      }
    }

    if (payload.reservation !== undefined) {
      if (payload.reservation.general !== undefined) {
        updateFields.push('reservation_general = ?');
        updateParams.push(payload.reservation.general || '');
      }
      if (payload.reservation.other !== undefined) {
        updateFields.push('reservation_other = ?');
        updateParams.push(JSON.stringify(payload.reservation.other || []));
      }
      if (payload.reservation.isEws !== undefined) {
        updateFields.push('reservation_is_ews = ?');
        updateParams.push(payload.reservation.isEws === true ? 1 : 0);
      }
      await persistAdmissionReservationMeta(pool, admissionId, payload.reservation, req.user?.id);
    }

    if (payload.address?.communication !== undefined) {
      const comm = normalizeCommunicationAddress(payload.address.communication);
      if (payload.address.communication.doorOrStreet !== undefined) {
        updateFields.push('address_door_street = ?');
        updateParams.push(comm.doorOrStreet || '');
      }
      if (payload.address.communication.landmark !== undefined) {
        updateFields.push('address_landmark = ?');
        updateParams.push(comm.landmark || '');
      }
      if (payload.address.communication.villageOrCity !== undefined) {
        updateFields.push('address_village_city = ?');
        updateParams.push(comm.villageOrCity || '');
      }
      if (payload.address.communication.mandal !== undefined) {
        updateFields.push('address_mandal = ?');
        updateParams.push(comm.mandal || '');
      }
      if (payload.address.communication.district !== undefined) {
        updateFields.push('address_district = ?');
        updateParams.push(comm.district || '');
      }
      if (payload.address.communication.pinCode !== undefined) {
        updateFields.push('address_pin_code = ?');
        updateParams.push(comm.pinCode || '');
      }
      if (payload.address.communication.state !== undefined) {
        updateFields.push('address_state = ?');
        updateParams.push(comm.state || '');
      }
    }

    if (payload.qualifications !== undefined) {
      if (payload.qualifications.ssc !== undefined) {
        updateFields.push('qualification_ssc = ?');
        updateParams.push(payload.qualifications.ssc === true ? 1 : 0);
      }
      if (payload.qualifications.interOrDiploma !== undefined) {
        updateFields.push('qualification_inter_diploma = ?');
        updateParams.push(payload.qualifications.interOrDiploma === true ? 1 : 0);
      }
      if (payload.qualifications.ug !== undefined) {
        updateFields.push('qualification_ug = ?');
        updateParams.push(payload.qualifications.ug === true ? 1 : 0);
      }
      if (payload.qualifications.merit !== undefined) {
        updateFields.push('qualification_merit = ?');
        updateParams.push(qualificationMeritToSql(payload.qualifications.merit));
      }
      if (payload.qualifications.ac !== undefined) {
        updateFields.push('qualification_ac = ?');
        updateParams.push(qualificationAcToSql(payload.qualifications.ac));
      }
      if (payload.qualifications.mediums !== undefined) {
        updateFields.push('qualification_mediums = ?');
        updateParams.push(JSON.stringify(payload.qualifications.mediums || []));
      }
      if (payload.qualifications.otherMediumLabel !== undefined) {
        updateFields.push('qualification_other_medium_label = ?');
        updateParams.push(payload.qualifications.otherMediumLabel || '');
      }
    }

    if (payload.documents !== undefined) {
      const docs = payload.documents;
      const docFields = [
        'ssc', 'inter', 'ugPgCmm', 'transferCertificate', 'studyCertificate',
        'aadhaarCard', 'photos', 'incomeCertificate', 'casteCertificate',
        'cetRankCard', 'cetHallTicket', 'allotmentLetter', 'joiningReport',
        'bankPassbook', 'rationCard',
      ];
      const sqlDocFields = [
        'document_ssc', 'document_inter', 'document_ug_pg_cmm', 'document_transfer_certificate',
        'document_study_certificate', 'document_aadhaar_card', 'document_photos',
        'document_income_certificate', 'document_caste_certificate', 'document_cet_rank_card',
        'document_cet_hall_ticket', 'document_allotment_letter', 'document_joining_report',
        'document_bank_passbook', 'document_ration_card',
      ];
      docFields.forEach((field, idx) => {
        if (docs[field] !== undefined) {
          updateFields.push(`${sqlDocFields[idx]} = ?`);
          updateParams.push(docs[field] || 'pending');
        }
      });
    }

    if (payload.status !== undefined) {
      updateFields.push('status = ?');
      updateParams.push(payload.status);
    }

    if (payload.remarks !== undefined) {
      updateFields.push('remarks = ?');
      updateParams.push(payload.remarks || '');
    }

    // Always update updated_by and updated_at
    updateFields.push('updated_by = ?');
    updateFields.push('updated_at = NOW()');
    updateParams.push(req.user.id);

    // Add admissionId to params
    updateParams.push(admissionId);

    // Execute update
    if (updateFields.length > 2) { // More than just updated_by and updated_at
      await pool.execute(
        `UPDATE admissions SET ${updateFields.join(', ')} WHERE id = ?`,
        updateParams
      );
    }

    // Update related tables if provided
    if (payload.address?.relatives !== undefined || payload.educationHistory !== undefined || payload.siblings !== undefined) {
      await saveAdmissionRelatedTables(pool, admissionId, payload);
    }

    if (payload.reference1 !== undefined) {
      await persistAdmissionReference1WithHistory(
        pool,
        admissionId,
        payload.reference1,
        req.user
      );
    }

    if (payload.admissionPhase !== undefined || payload.phase !== undefined) {
      const rawPhase =
        payload.admissionPhase !== undefined ? payload.admissionPhase : payload.phase;
      const normalized = normalizeAdmissionPhase(rawPhase);
      if (String(rawPhase ?? '').trim() !== '' && !normalized) {
        return errorResponse(res, 'admissionPhase must be 1, 2, 3, 4, or 5', 400);
      }
      await persistAdmissionPhase(pool, admissionId, normalized, req.user.id);
    }

    if (payload.registrationFormData !== undefined || Object.prototype.hasOwnProperty.call(payload, 'studentFeeDetails')) {
      await persistAdmissionRegistrationSidecar(pool, admissionId, payload, req.user.id);
    }

    // Fetch and return updated admission
    const [updated] = await pool.execute(
      'SELECT * FROM admissions WHERE id = ?',
      [admissionId]
    );
    const formattedAdmission = await formatAdmission(updated[0], pool);

    warnIfSecondaryStudentSyncMissed(
      'updateAdmissionByLead',
      { leadId, admissionId, admissionNumber: formattedAdmission.admissionNumber },
      await syncToSecondaryDatabase(formattedAdmission, formattedAdmission.admissionNumber, {
        leadId: formattedAdmission.leadId,
        joiningId: formattedAdmission.joiningId,
        email: formattedAdmission.leadData?.email || ''
      })
    );

    await appendAdmissionApplicationEditHistory(pool, {
      admissionId,
      leadId: formattedAdmission.leadId,
      userId: req.user.id,
      userName: req.user.name,
      kind: 'update',
      title: 'Admission application updated',
      description: 'Admission record saved',
    });

    return successResponse(
      res,
      formattedAdmission,
      'Admission record updated successfully',
      200
    );
  } catch (error) {
    console.error('Error updating admission record:', error);
    return errorResponse(
      res,
      error.message || 'Failed to update admission record',
      error.statusCode || 500
    );
  }
};

/**
 * @desc    Update Reference 1 only (admissions.lead_data.reference1 + joining + lead mirrors)
 * @route   PATCH /api/admissions/id/:admissionId/reference
 */
export const patchAdmissionReferenceById = async (req, res) => {
  try {
    const { admissionId } = req.params;
    ensureAdmissionId(admissionId);

    if (req.body?.reference1 === undefined) {
      return errorResponse(res, 'reference1 is required', 400);
    }

    const pool = getPool();
    await persistAdmissionReference1WithHistory(
      pool,
      admissionId,
      req.body.reference1,
      req.user
    );

    const [updated] = await pool.execute('SELECT * FROM admissions WHERE id = ?', [admissionId]);
    const formattedAdmission = await formatAdmission(updated[0], pool);

    return successResponse(res, formattedAdmission, 'Reference updated successfully', 200);
  } catch (error) {
    console.error('Error updating admission reference:', error);
    return errorResponse(
      res,
      error.message || 'Failed to update reference',
      error.statusCode || 500
    );
  }
};

/**
 * @desc    Update admission remarks only
 * @route   PATCH /api/admissions/id/:admissionId/remarks
 */
export const patchAdmissionRemarksById = async (req, res) => {
  try {
    const { admissionId } = req.params;
    ensureAdmissionId(admissionId);

    if (req.body?.remarks === undefined) {
      return errorResponse(res, 'remarks is required', 400);
    }

    const pool = getPool();
    await persistAdmissionRemarks(pool, admissionId, req.body.remarks, req.user?.id);

    const [updated] = await pool.execute('SELECT * FROM admissions WHERE id = ?', [admissionId]);
    const formattedAdmission = await formatAdmission(updated[0], pool);

    // Sync to secondary database if needed
    const syncResult = await syncToSecondaryDatabase(
      formattedAdmission,
      formattedAdmission.admissionNumber
    );
    warnIfSecondaryStudentSyncMissed('patchAdmissionRemarksById', { admissionId }, syncResult);

    await appendAdmissionApplicationEditHistory(pool, {
      admissionId,
      leadId: formattedAdmission.leadId,
      userId: req.user.id,
      userName: req.user.name,
      kind: 'update',
      title: 'Remarks updated',
      description: 'Admission remarks changed',
    });

    return successResponse(res, formattedAdmission, 'Admission remarks updated successfully', 200);
  } catch (error) {
    console.error('Error updating admission remarks:', error);
    return errorResponse(
      res,
      error.message || 'Failed to update admission remarks',
      error.statusCode || 500
    );
  }
};

/**
 * @desc    Update admission phase only (lead_data.admissionPhase = 1…5)
 * @route   PATCH /api/admissions/id/:admissionId/phase
 */
export const patchAdmissionPhaseById = async (req, res) => {
  try {
    const { admissionId } = req.params;
    ensureAdmissionId(admissionId);

    if (req.body?.admissionPhase === undefined && req.body?.phase === undefined) {
      return errorResponse(res, 'admissionPhase is required', 400);
    }

    const rawPhase = req.body?.admissionPhase !== undefined ? req.body.admissionPhase : req.body.phase;
    const normalized = normalizeAdmissionPhase(rawPhase);
    // Allow clearing (empty) or Phase 1–5 only.
    if (String(rawPhase ?? '').trim() !== '' && !normalized) {
      return errorResponse(res, 'admissionPhase must be 1, 2, 3, 4, or 5', 400);
    }

    const pool = getPool();
    const result = await persistAdmissionPhase(
      pool,
      admissionId,
      normalized,
      req.user?.id
    );

    const [updated] = await pool.execute('SELECT * FROM admissions WHERE id = ?', [admissionId]);
    const formattedAdmission = await formatAdmission(updated[0], pool);

    if (result.changed) {
      const fromLabel = result.previous ? `Phase ${result.previous}` : '(empty)';
      const toLabel = result.next ? `Phase ${result.next}` : '(empty)';
      await appendAdmissionApplicationEditHistory(pool, {
        admissionId,
        leadId: formattedAdmission.leadId,
        userId: req.user.id,
        userName: req.user.name,
        kind: 'update',
        title: 'Admission phase updated',
        description: `${fromLabel} → ${toLabel}`,
      });
    }

    return successResponse(res, formattedAdmission, 'Admission phase updated successfully', 200);
  } catch (error) {
    console.error('Error updating admission phase:', error);
    return errorResponse(
      res,
      error.message || 'Failed to update admission phase',
      error.statusCode || 500
    );
  }
};

export const getAdmissionStats = async (req, res) => {
  try {
    const { startDate, endDate, collegeId, courseId, branchId, courseName, branchName } =
      req.query;
    const pool = getPool();
    const conditions = [];
    const params = [];
    const collegeCourseIds = await loadManagedCourseIdsForCollege(collegeId);
    appendManagedCollegeCourseFilter(
      conditions,
      params,
      SQL_EFF_COURSE_ID,
      collegeCourseIds
    );
    if (startDate) {
      conditions.push('DATE(COALESCE(admission_date, created_at)) >= ?');
      params.push(String(startDate).slice(0, 10));
    }
    if (endDate) {
      conditions.push('DATE(COALESCE(admission_date, created_at)) <= ?');
      params.push(String(endDate).slice(0, 10));
    }
    if (courseId || courseName) {
      if (courseId && courseName) {
        conditions.push(`(${SQL_EFF_COURSE_ID} = ? OR course = ?)`);
        params.push(courseId, courseName);
      } else {
        conditions.push(`(${SQL_EFF_COURSE_ID} = ? OR course = ?)`);
        const val = courseId || courseName;
        params.push(val, val);
      }
    }
    if (branchId || branchName) {
      if (branchId && branchName) {
        conditions.push(`(${SQL_EFF_BRANCH_ID} = ? OR branch = ?)`);
        params.push(branchId, branchName);
      } else {
        conditions.push(`(${SQL_EFF_BRANCH_ID} = ? OR branch = ?)`);
        const val = branchId || branchName;
        params.push(val, val);
      }
    }
    const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    const query = `
      SELECT 
        ${SQL_EFF_COURSE_ID} as courseId, 
        ${SQL_BTECH_LATERAL_TRACK} as lateralTrack,
        ${SQL_COURSE_DISPLAY_NAME} as courseName,
        COUNT(CASE WHEN ${SQL_IS_ACTIVE_ADMISSION} THEN 1 END) as totalAdmissions,
        COUNT(CASE WHEN ${SQL_IS_CANCELLED_ADMISSION} THEN 1 END) as totalCancelled
      FROM admissions
      ${whereClause}
      GROUP BY ${SQL_EFF_COURSE_ID}, ${SQL_BTECH_LATERAL_TRACK}
      ORDER BY totalAdmissions DESC
    `;
    const queryBranches = `
      SELECT 
        ${SQL_EFF_COURSE_ID} as courseId,
        ${SQL_EFF_BRANCH_ID} as branchId,
        ${SQL_BTECH_LATERAL_TRACK} as lateralTrack,
        ${SQL_COURSE_DISPLAY_NAME} as courseName,
        MAX(branch) as branchName,
        COUNT(CASE WHEN ${SQL_IS_ACTIVE_ADMISSION} THEN 1 END) as totalAdmissions,
        COUNT(CASE WHEN ${SQL_IS_CANCELLED_ADMISSION} THEN 1 END) as totalCancelled,
        COUNT(CASE WHEN ${SQL_ABSTRACT_CQ_ADMITTED} AND ${SQL_IS_ACTIVE_ADMISSION} THEN 1 END) as cqAdmitted,
        COUNT(CASE WHEN ${SQL_ABSTRACT_CQ_ADMITTED} AND ${SQL_IS_CANCELLED_ADMISSION} THEN 1 END) as cqCancelled,
        COUNT(CASE WHEN ${SQL_ABSTRACT_MQ_ADMITTED} AND ${SQL_IS_ACTIVE_ADMISSION} THEN 1 END) as mqAdmitted,
        COUNT(CASE WHEN ${SQL_ABSTRACT_MQ_ADMITTED} AND ${SQL_IS_CANCELLED_ADMISSION} THEN 1 END) as mqCancelled,
        COUNT(CASE WHEN ${SQL_IS_SPOT_QUOTA} AND ${SQL_IS_ACTIVE_ADMISSION} THEN 1 END) as spotAdmitted,
        COUNT(CASE WHEN ${SQL_IS_SPOT_QUOTA} AND ${SQL_IS_CANCELLED_ADMISSION} THEN 1 END) as spotCancelled,
        COUNT(CASE WHEN ${SQL_ABSTRACT_MERIT_YES} THEN 1 END) as meritYes,
        COUNT(CASE WHEN ${SQL_ABSTRACT_MERIT_NO} THEN 1 END) as meritNo
      FROM admissions
      ${whereClause}
      GROUP BY ${SQL_EFF_COURSE_ID}, ${SQL_EFF_BRANCH_ID}, ${SQL_BTECH_LATERAL_TRACK}
      ORDER BY courseName, branchName
    `;

    const [statsResult, branchStatsResult, branchIntakeMap, secondaryLabels, intakeBranchLabels] =
      await Promise.all([
        pool.execute(query, params),
        pool.execute(queryBranches, params),
        loadBranchIntakeMap(),
        loadSecondaryCourseBranchLabelMaps(),
        loadAdmissionBranchIntakeLabelMap(pool),
      ]);
    const stats = statsResult[0];
    const branchStats = branchStatsResult[0];
    const courseStats = stats.map((course) => {
      const courseName = resolveStatsCourseDisplayName(course, secondaryLabels);
      return {
      ...course,
      courseName: courseName || course.courseName,
      branches: branchStats
        .filter(
          (b) =>
            b.courseId === course.courseId &&
            Number(b.lateralTrack) === Number(course.lateralTrack)
        )
        .map((b) => {
          const intake = resolveBranchIntakeFromMap(
            branchIntakeMap,
            b.courseId,
            b.branchId,
            b.lateralTrack
          );
          const branchName = resolveStatsBranchDisplayName(
            b,
            secondaryLabels,
            intakeBranchLabels
          );
          const branchCourseName = resolveStatsCourseDisplayName(b, secondaryLabels);
          return {
            ...b,
            courseName: branchCourseName || courseName || b.courseName,
            branchName: branchName || b.branchName,
            cqIntake: intake.cqIntake ?? null,
            mqIntake: intake.mqIntake ?? null,
            cqAdmitted: Number(b.cqAdmitted) || 0,
            cqCancelled: Number(b.cqCancelled) || 0,
            mqAdmitted: Number(b.mqAdmitted) || 0,
            mqCancelled: Number(b.mqCancelled) || 0,
            spotAdmitted: Number(b.spotAdmitted) || 0,
            spotCancelled: Number(b.spotCancelled) || 0,
            meritYes: Number(b.meritYes) || 0,
            meritNo: Number(b.meritNo) || 0,
          };
        }),
    };
    });
    return successResponse(res, { stats: courseStats }, 'Admission stats retrieved successfully', 200);
  } catch (error) {
    console.error('Error getting admission stats:', error);
    return errorResponse(res, error.message || 'Failed to get admission stats', 500);
  }
};

/** Save CQ / MQ intake seats for a course + branch row on the admissions abstract. */
export const upsertAdmissionBranchIntake = async (req, res) => {
  try {
    const courseId = String(req.body?.courseId ?? '').trim();
    const branchId = String(req.body?.branchId ?? '').trim();
    if (!courseId || !branchId) {
      return errorResponse(res, 'courseId and branchId are required', 400);
    }
    const lateralTrack = normalizeLateralTrack(req.body?.lateralTrack);
    const cqIntake = parseIntakeInput(req.body?.cqIntake);
    const mqIntake = parseIntakeInput(req.body?.mqIntake);
    if (req.body?.cqIntake != null && req.body?.cqIntake !== '' && cqIntake === null) {
      return errorResponse(res, 'cqIntake must be a whole number ≥ 0', 400);
    }
    if (req.body?.mqIntake != null && req.body?.mqIntake !== '' && mqIntake === null) {
      return errorResponse(res, 'mqIntake must be a whole number ≥ 0', 400);
    }

    const pool = getPool();
    await ensureAdmissionBranchIntakeTable(pool);
    await pool.execute(
      `INSERT INTO admission_branch_intake (
        id, course_id, branch_id, lateral_track, course_name, branch_name, cq_intake, mq_intake, updated_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        course_name = VALUES(course_name),
        branch_name = VALUES(branch_name),
        cq_intake = VALUES(cq_intake),
        mq_intake = VALUES(mq_intake),
        updated_by = VALUES(updated_by)`,
      [
        uuidv4(),
        courseId,
        branchId,
        lateralTrack,
        String(req.body?.courseName ?? '').trim(),
        String(req.body?.branchName ?? '').trim(),
        cqIntake,
        mqIntake,
        req.user?.id || null,
      ]
    );

    clearAdmissionQueryCache();

    return successResponse(
      res,
      { courseId, branchId, lateralTrack, cqIntake, mqIntake },
      'Branch intake saved successfully',
      200
    );
  } catch (error) {
    console.error('Error saving branch intake:', error);
    return errorResponse(res, error.message || 'Failed to save branch intake', 500);
  }
};

/**
 * Shared filters for admission pivot reports (alias `a`).
 * When status is omitted or `all`, excludes "Admission Cancelled" to match course-wise stats.
 */
const buildAdmissionPivotFilters = async (query) => {
  const {
    startDate,
    endDate,
    collegeId,
    courseId,
    branchId,
    courseName,
    branchName,
    status,
  } = query;
  const conditions = [];
  const params = [];
  const c = (field) => `a.${field}`;

  const collegeCourseIds = await loadManagedCourseIdsForCollege(collegeId);
  appendManagedCollegeCourseFilter(
    conditions,
    params,
    SQL_A_EFF_COURSE_ID,
    collegeCourseIds
  );

  if (startDate) {
    conditions.push(`DATE(${SQL_A_EFFECTIVE_ADMISSION_DATE}) >= ?`);
    params.push(String(startDate).slice(0, 10));
  }
  if (endDate) {
    conditions.push(`DATE(${SQL_A_EFFECTIVE_ADMISSION_DATE}) <= ?`);
    params.push(String(endDate).slice(0, 10));
  }
  if (courseId || courseName) {
    if (courseId && courseName) {
      conditions.push(`(${SQL_A_EFF_COURSE_ID} = ? OR ${c('course')} = ?)`);
      params.push(courseId, courseName);
    } else {
      conditions.push(`(${SQL_A_EFF_COURSE_ID} = ? OR ${c('course')} = ?)`);
      const val = courseId || courseName;
      params.push(val, val);
    }
  }
  if (branchId || branchName) {
    if (branchId && branchName) {
      conditions.push(`(${SQL_A_EFF_BRANCH_ID} = ? OR ${c('branch')} = ?)`);
      params.push(branchId, branchName);
    } else {
      conditions.push(`(${SQL_A_EFF_BRANCH_ID} = ? OR ${c('branch')} = ?)`);
      const val = branchId || branchName;
      params.push(val, val);
    }
  }
  if (status && status !== 'all') {
    conditions.push(`${c('status')} = ?`);
    params.push(status);
  } else {
    conditions.push(`${c('status')} != ?`);
    params.push(ADMISSION_CANCELLED_STATUS);
  }
  return { conditions, params };
};

/** Normalize course header text so "B.Tech", "B.TECH", "b.tech " map to one bucket. */
const normalizeAdmissionCourseColumnName = (name) =>
  String(name ?? '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ');

const stripLateralCourseSuffix = (name) =>
  String(name ?? '')
    .replace(/\s*\(lateral\)\s*/gi, '')
    .trim();

/** Pivot count key: course id(s) + B.Tech lateral track (0 = regular, 1 = lateral entry). */
const admissionPivotCountKey = (courseId, lateralTrack = 0) => {
  if (courseId === undefined || courseId === null) return '__none__';
  const s = String(courseId).trim();
  if (s === '' || s === '__none__') return '__none__';
  const lat = Number(lateralTrack) === 1 ? 1 : 0;
  return `${s}::${lat}`;
};

const admissionPivotBucketKey = (label, catalogName, idStr, lateralTrack = 0) => {
  if (idStr === '__none__') return '__none__';
  const base = stripLateralCourseSuffix(label || catalogName);
  const norm = normalizeAdmissionCourseColumnName(base);
  if (isBtechCourseName(base) || isBtechCourseName(catalogName) || isBtechCourseName(label)) {
    return `${norm}::${Number(lateralTrack) === 1 ? 1 : 0}`;
  }
  return norm;
};

const parsePivotBucketLateral = (bucketKey) => {
  const m = String(bucketKey).match(/::([01])$/);
  return m ? Number(m[1]) : 0;
};

const admissionPivotColumnKey = (col) => {
  const ids = col.courseIds?.length
    ? col.courseIds
    : String(col.courseId || '')
        .split('|')
        .map((id) => id.trim())
        .filter(Boolean);
  const idPart = ids.length > 0 ? ids.join('|') : '__none__';
  return admissionPivotCountKey(idPart, col.lateralTrack ?? 0);
};

const sumCountsForCourseColumn = (countsRaw, col) => {
  const lateral = Number(col.lateralTrack) || 0;
  const ids = col.courseIds || [col.courseId];
  let sum = 0;
  for (const rawId of ids) {
    const id = String(rawId).trim();
    if (!id || id === '__none__') continue;
    const keys = [admissionPivotCountKey(id, lateral), id];
    for (const key of keys) {
      let v = countsRaw[key];
      if (v === undefined && /^\d+$/.test(key)) {
        const n = Number(key);
        if (Number.isSafeInteger(n)) v = countsRaw[n];
      }
      if (v !== undefined && v !== null) {
        sum += Number(v) || 0;
        break;
      }
    }
  }
  return sum;
};

/**
 * Build pivot columns aligned with how admissions store data:
 * - `admissions.course_id` (primary catalog FK when present) or `admissions.managed_course_id`
 *   (student DB id, no FK) plus denormalized `admissions.course` text.
 * - Secondary `courses` may list multiple ids or different ids than stored on older rows.
 *
 * We bucket by **normalized label** derived from admission `MAX(course)` when present, else
 * secondary name for that id. All ids that share the same bucket get merged so counts sum
 * into one column (fixes duplicate "DIPLOMA" / B.TECH showing 0).
 */
const getAdmissionReportCourses = async (primaryPool, whereClause, params) => {
  let activeCourses = [];
  try {
    const secondaryPool = getSecondaryPool();
    const [rows] = await secondaryPool.execute(
      'SELECT id, name FROM courses WHERE is_active = 1 ORDER BY name ASC'
    );
    activeCourses = rows || [];
  } catch (err) {
    console.error(
      'getAdmissionReportCourses: secondary courses query failed, using primary:',
      err?.message || err
    );
    const [rows] = await primaryPool.execute(
      'SELECT id, name FROM courses WHERE is_active = 1 ORDER BY name ASC'
    );
    activeCourses = rows || [];
  }

  const [distinctCourseRows] = await primaryPool.execute(
    `SELECT ${SQL_A_EFF_COURSE_ID} AS courseId,
            ${SQL_A_BTECH_LATERAL_TRACK} AS lateralTrack,
            MAX(a.course) AS courseName
     FROM admissions a
     ${whereClause}
     GROUP BY ${SQL_A_EFF_COURSE_ID}, ${SQL_A_BTECH_LATERAL_TRACK}`,
    params
  );

  const idToSecondaryName = new Map(
    activeCourses.map((r) => [String(r.id), String(r.name || '').trim()])
  );

  const buckets = new Map();

  const addToBucket = (bucketKey, displayLabel, idStr) => {
    if (!buckets.has(bucketKey)) {
      buckets.set(bucketKey, {
        courseName: String(displayLabel || '').trim() || '—',
        mergeIds: new Set(),
      });
    }
    const b = buckets.get(bucketKey);
    b.mergeIds.add(String(idStr));
    const next = String(displayLabel || '').trim();
    if (next.length > String(b.courseName || '').trim().length) {
      b.courseName = next;
    }
  };

  /** Each course id must map to one pivot column (avoids double-count when catalog id ≠ admission label). */
  const assignedCourseIds = new Set();

  for (const row of distinctCourseRows) {
    const rawId = row.courseId;
    const idStr =
      rawId != null && String(rawId).trim() !== '' ? String(rawId).trim() : '__none__';
    const lateralTrack = Number(row.lateralTrack) === 1 ? 1 : 0;
    const fromAdmissionText = String(row.courseName || '').trim();
    const catalogName = idToSecondaryName.get(idStr) || '';
    let label =
      idStr === '__none__'
        ? '—'
        : isGenericImportCourseLabel(fromAdmissionText) && catalogName
          ? catalogName
          : fromAdmissionText || catalogName || 'Unknown';
    label = stripLateralCourseSuffix(label);
    if (isBtechCourseName(label) || isBtechCourseName(catalogName)) {
      label = formatBtechCourseDisplayName(catalogName || label, lateralTrack === 1);
    }
    const k = admissionPivotBucketKey(label, catalogName, idStr, lateralTrack);
    addToBucket(k, label, idStr);
    if (idStr !== '__none__') assignedCourseIds.add(idStr);
  }

  for (const r of activeCourses) {
    const id = String(r.id);
    const nm = String(r.name || '').trim() || 'Unknown';
    if (isBtechCourseName(nm)) {
      const norm = normalizeAdmissionCourseColumnName(stripLateralCourseSuffix(nm));
      for (const lateralTrack of [0, 1]) {
        const k = `${norm}::${lateralTrack}`;
        if (!buckets.has(k)) {
          addToBucket(k, formatBtechCourseDisplayName(nm, lateralTrack === 1), id);
        }
      }
      continue;
    }
    if (assignedCourseIds.has(id)) continue;
    const k = normalizeAdmissionCourseColumnName(nm);
    addToBucket(k, nm, id);
  }

  const orderedKeys = [...buckets.keys()].filter((key) => key !== '__none__');
  orderedKeys.sort((a, b) => {
    const na = buckets.get(a).courseName;
    const nb = buckets.get(b).courseName;
    return String(na).localeCompare(String(nb), undefined, { sensitivity: 'base' });
  });

  const out = [];
  for (const k of orderedKeys) {
    const b = buckets.get(k);
    const ids = [...b.mergeIds]
      .filter((id) => id !== '__none__')
      .sort((x, y) => String(x).localeCompare(String(y)));
    if (ids.length === 0) continue;
    const lateralTrack = parsePivotBucketLateral(k);
    const courseId = ids.length === 1 ? ids[0] : ids.join('|');
    out.push({
      courseId,
      courseName: b.courseName,
      courseIds: ids,
      lateralTrack,
      pivotKey: admissionPivotCountKey(courseId, lateralTrack),
    });
  }

  if (buckets.has('__none__')) {
    const b = buckets.get('__none__');
    const ids = [...b.mergeIds].sort((x, y) => String(x).localeCompare(String(y)));
    const courseId = ids.length === 1 ? ids[0] : ids.join('|');
    out.push({
      courseId,
      courseName: b.courseName,
      courseIds: ids,
      lateralTrack: 0,
      pivotKey: admissionPivotCountKey(courseId, 0),
    });
  }

  return out;
};

/**
 * @desc    Distinct Reference 1 names used on admissions, joinings, and leads (for picker suggestions)
 * @route   GET /api/admissions/reference-names
 */
export const listDistinctReferenceNames = async (req, res) => {
  try {
    const pool = getPool();
    const sqlJoiningLeadData = `COALESCE(CASE WHEN JSON_VALID(j.lead_data) THEN j.lead_data ELSE JSON_OBJECT() END, JSON_OBJECT())`;
    const sqlJoiningRef1 = `NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(${sqlJoiningLeadData}, '$.reference1'))), '')`;
    const sqlJoiningRefLegacy = `NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(${sqlJoiningLeadData}, '$.referenceName'))), '')`;
    const sqlLeadDynamic = `COALESCE(CASE WHEN JSON_VALID(l.dynamic_fields) THEN l.dynamic_fields ELSE JSON_OBJECT() END, JSON_OBJECT())`;
    const sqlLeadRef1 = `NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(${sqlLeadDynamic}, '$.reference1'))), '')`;

    let hiddenKeys = [];
    try {
      const [hiddenRows] = await pool.execute(
        'SELECT name_normalized FROM reference_picker_hidden'
      );
      hiddenKeys = hiddenRows
        .map((r) => String(r.name_normalized ?? '').trim())
        .filter(Boolean);
    } catch {
      /* reference_picker_hidden table may not exist until migration runs */
    }

    const hiddenClause =
      hiddenKeys.length > 0
        ? ` AND LOWER(TRIM(name)) NOT IN (${hiddenKeys.map(() => '?').join(', ')})`
        : '';

    const [rows] = await pool.execute(
      `SELECT DISTINCT TRIM(name) AS name FROM (
         SELECT ${SQL_A_REFERENCE1} AS name FROM admissions a
         WHERE ${SQL_A_REFERENCE1} IS NOT NULL
         UNION
         SELECT ${sqlJoiningRef1} AS name FROM joinings j
         WHERE ${sqlJoiningRef1} IS NOT NULL
         UNION
         SELECT ${sqlJoiningRefLegacy} AS name FROM joinings j
         WHERE ${sqlJoiningRefLegacy} IS NOT NULL
         UNION
         SELECT ${sqlLeadRef1} AS name FROM leads l
         WHERE ${sqlLeadRef1} IS NOT NULL
       ) refs
       WHERE name IS NOT NULL AND name != ''${hiddenClause}
       ORDER BY name ASC
       LIMIT 500`,
      hiddenKeys
    );

    const names = rows
      .map((row) => String(row.name ?? '').trim())
      .filter((n) => n.length > 0);

    return successResponse(res, { names }, 'Reference names retrieved successfully', 200);
  } catch (error) {
    console.error('Error listing distinct reference names:', error);
    return errorResponse(res, error.message || 'Failed to list reference names', 500);
  }
};

/**
 * @desc    Usage stats + sample admissions for a reference name (manage dialog)
 * @route   GET /api/admissions/reference-names/usage
 */
export const getDistinctReferenceNameUsage = async (req, res) => {
  try {
    const name = String(req.query?.name ?? '').trim();
    if (!name) {
      return errorResponse(res, 'name query parameter is required', 400);
    }
    const pool = getPool();
    const usage = await getReferenceNameUsage(pool, name);
    return successResponse(res, usage, 'Reference usage retrieved successfully', 200);
  } catch (error) {
    console.error('Error fetching reference name usage:', error);
    return errorResponse(
      res,
      error.message || 'Failed to fetch reference usage',
      error.statusCode || 500
    );
  }
};

/**
 * @desc    Rename a saved reference everywhere it appears (admissions, joinings, leads)
 * @route   PATCH /api/admissions/reference-names/rename
 */
export const renameDistinctReferenceName = async (req, res) => {
  try {
    const oldName = String(req.body?.oldName ?? req.body?.name ?? '').trim();
    const newName = String(req.body?.newName ?? '').trim();
    if (!oldName) {
      return errorResponse(res, 'oldName is required', 400);
    }
    if (!newName) {
      return errorResponse(res, 'newName is required', 400);
    }

    const pool = getPool();
    const result = await renameReferenceNameGlobally(pool, oldName, newName);

    return successResponse(
      res,
      { oldName, newName, ...result },
      result.renamed === false
        ? 'Reference name unchanged'
        : 'Reference renamed on all matching records',
      200
    );
  } catch (error) {
    console.error('Error renaming reference name:', error);
    return errorResponse(
      res,
      error.message || 'Failed to rename reference',
      error.statusCode || 500
    );
  }
};

/**
 * @desc    Hide a reference name from the picker (does not clear existing admissions)
 * @route   POST /api/admissions/reference-names/hide
 */
export const hideDistinctReferenceName = async (req, res) => {
  try {
    const name = String(req.body?.name ?? '').trim();
    if (!name) {
      return errorResponse(res, 'name is required', 400);
    }
    const clearRecords = Boolean(req.body?.clearRecords);

    const pool = getPool();
    let clearResult = null;
    if (clearRecords) {
      clearResult = await clearReferenceNameGlobally(pool, name);
    }
    const result = await hideReferenceNameFromPicker(pool, name, req.user?.id);

    return successResponse(
      res,
      { ...result, clearRecords, ...(clearResult || {}) },
      clearRecords
        ? 'Reference removed from list and cleared on matching records'
        : 'Reference removed from picker list',
      200
    );
  } catch (error) {
    console.error('Error hiding reference name:', error);
    return errorResponse(
      res,
      error.message || 'Failed to remove reference from list',
      error.statusCode || 500
    );
  }
};

const normalizeReferenceNameKey = (value) =>
  String(value ?? '')
    .trim()
    .toLowerCase();

/** Match reference display names directly to HRMS employees (read-only Dept / Designation). */
const enrichReferenceStatsRowsWithUserMeta = async (rows) => {
  if (!rows?.length) return rows;

  const referenceKeys = rows
    .map((row) => normalizeReferenceNameKey(row.name))
    .filter((key) => key && key !== '(not specified)');

  const hrmsMetaByKey = await buildHrmsEmployeeMetaByReferenceKeys(
    referenceKeys,
    'getAdmissionStatsByReference'
  );

  return rows.map((row) => {
    const key = normalizeReferenceNameKey(row.name);
    const meta = key ? hrmsMetaByKey.get(key) : null;
    return {
      ...row,
      department: meta?.department ?? null,
      designation: meta?.designation ?? null,
    };
  });
};

const appendReferencePivotMatchFilter = (conditions, params, { referenceKey, rawName, unspecified }) => {
  if (unspecified) {
    conditions.push(`${SQL_A_EFFECTIVE_REFERENCE1} IS NULL`);
    return;
  }
  const key = String(referenceKey ?? '').trim();
  if (key) {
    conditions.push(`COALESCE(${SQL_A_EFFECTIVE_REFERENCE1}, '__none__') = ?`);
    params.push(key);
    return;
  }
  const name = String(rawName ?? '').trim();
  if (name) {
    conditions.push(`LOWER(TRIM(${SQL_A_EFFECTIVE_REFERENCE1})) = ?`);
    params.push(normalizeReferenceNameKey(name));
  }
};

/**
 * @desc    Admissions list for one reference row (same filters as reference stats pivot)
 * @route   GET /api/admissions/stats/by-reference/admissions
 */
export const getAdmissionStatsByReferenceAdmissions = async (req, res) => {
  try {
    const referenceKey = String(req.query?.referenceKey ?? '').trim();
    const rawName = String(req.query?.name ?? '').trim();
    const unspecified =
      req.query?.unspecified === '1' ||
      req.query?.unspecified === 'true' ||
      rawName === '(Not specified)';

    if (!unspecified && !referenceKey && !rawName) {
      return errorResponse(res, 'name or referenceKey query parameter is required', 400);
    }

    const pool = getPool();
    const { conditions, params } = await buildAdmissionPivotFilters(req.query);
    appendReferencePivotMatchFilter(conditions, params, { referenceKey, rawName, unspecified });

    const limit = Math.min(Math.max(Number(req.query?.limit) || 500, 1), 500);
    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const pivotFrom = `FROM admissions a ${SQL_ADMISSION_PIVOT_JOINS}`;

    const [countRows] = await pool.execute(
      `SELECT COUNT(*) AS total ${pivotFrom} ${whereClause}`,
      params
    );
    const total = Number(countRows[0]?.total ?? 0);

    // Avoid ORDER BY on joined JSON expressions — RDS sort buffer overflows. Sort in Node instead.
    let admissions = [];
    if (total > 0) {
      const idFetchCap = Math.min(total, 2000);
      const [idRows] = await pool.execute(
        `SELECT a.id, a.admission_number
         ${pivotFrom}
         ${whereClause}
         LIMIT ${idFetchCap}`,
        params
      );

      const sortedIdRows = [...(idRows || [])]
        .sort((a, b) =>
          String(b.admission_number ?? '').localeCompare(String(a.admission_number ?? ''), undefined, {
            numeric: true,
          })
        )
        .slice(0, limit);

      if (sortedIdRows.length > 0) {
        const pageIds = sortedIdRows.map((row) => row.id);
        const orderIndex = new Map(pageIds.map((id, index) => [String(id), index]));
        const inMarks = pageIds.map(() => '?').join(',');

        const [pageRows] = await pool.execute(
          `SELECT
             a.id,
             a.admission_number AS admissionNumber,
             COALESCE(NULLIF(TRIM(a.student_name), ''), '—') AS studentName,
             a.status,
             ${SQL_A_EFF_COURSE_ID} AS courseId,
             a.managed_course_id AS managedCourseId,
             COALESCE(NULLIF(TRIM(a.course), ''), '—') AS course,
             COALESCE(NULLIF(TRIM(a.branch), ''), '—') AS branch
           FROM admissions a
           WHERE a.id IN (${inMarks})`,
          pageIds
        );

        admissions = pageRows
          .sort((a, b) => (orderIndex.get(String(a.id)) ?? 0) - (orderIndex.get(String(b.id)) ?? 0))
          .map((row) => ({
            id: String(row.id ?? ''),
            admissionNumber: String(row.admissionNumber ?? '').trim() || '—',
            studentName: String(row.studentName ?? '').trim() || '—',
            status: String(row.status ?? '').trim() || '—',
            courseId:
              String(row.courseId ?? row.managedCourseId ?? '')
                .trim() || null,
            course: String(row.course ?? '').trim() || '—',
            branch: String(row.branch ?? '').trim() || '—',
          }));
      }
    }

    return successResponse(
      res,
      {
        name: unspecified ? '(Not specified)' : rawName || referenceKey,
        referenceKey: unspecified ? null : referenceKey || rawName || null,
        admissions,
        total,
        truncated: total > admissions.length,
      },
      'Reference admissions retrieved successfully',
      200
    );
  } catch (error) {
    console.error('Error fetching reference admissions:', error);
    return errorResponse(
      res,
      error.message || 'Failed to fetch reference admissions',
      error.statusCode || 500
    );
  }
};

/**
 * @desc    Admissions counts by student Reference 1 (lead_data.reference1) × course
 * @route   GET /api/admissions/stats/by-reference
 */
export const getAdmissionStatsByReference = async (req, res) => {
  try {
    const pool = getPool();
    const { conditions, params } = await buildAdmissionPivotFilters(req.query);
    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const courses = await getAdmissionReportCourses(pool, whereClause, params);

    const pivotFrom = `FROM admissions a ${SQL_ADMISSION_PIVOT_JOINS}`;
    const [agg] = await pool.execute(
      `SELECT
         COALESCE(${SQL_A_EFFECTIVE_REFERENCE1}, '__none__') AS referenceKey,
         MAX(${SQL_A_EFFECTIVE_REFERENCE1}) AS referenceName,
         ${SQL_A_EFF_COURSE_ID} AS courseId,
         ${SQL_A_BTECH_LATERAL_TRACK} AS lateralTrack,
         COUNT(*) AS cnt
       ${pivotFrom}
       ${whereClause}
       GROUP BY COALESCE(${SQL_A_EFFECTIVE_REFERENCE1}, '__none__'), ${SQL_A_EFF_COURSE_ID}, ${SQL_A_BTECH_LATERAL_TRACK}`,
      params
    );

    const byReference = new Map();
    for (const row of agg) {
      const refKey = String(row.referenceKey || '__none__');
      if (!byReference.has(refKey)) {
        byReference.set(refKey, {
          displayName:
            refKey === '__none__'
              ? '(Not specified)'
              : String(row.referenceName || refKey).trim() || '(Not specified)',
        });
      }
      const bucket = byReference.get(refKey);
      if (!bucket.counts) bucket.counts = {};
      const ck = admissionPivotCountKey(row.courseId, row.lateralTrack);
      bucket.counts[ck] = (bucket.counts[ck] || 0) + (Number(row.cnt) || 0);
    }

    const rows = [...byReference.entries()]
      .sort((a, b) => {
        if (a[0] === '__none__') return 1;
        if (b[0] === '__none__') return -1;
        return String(a[1].displayName).localeCompare(String(b[1].displayName));
      })
      .map(([refKey, bucket]) => {
        const countsRaw = bucket.counts || {};
        const counts = {};
        for (const c of courses) {
          counts[admissionPivotColumnKey(c)] = sumCountsForCourseColumn(countsRaw, c);
        }
        const total = Object.values(countsRaw).reduce((sum, n) => sum + (Number(n) || 0), 0);
        return {
          referenceKey: refKey === '__none__' ? null : refKey,
          name: bucket.displayName,
          counts,
          total,
        };
      });

    const enrichedRows = await enrichReferenceStatsRowsWithUserMeta(rows);

    return successResponse(
      res,
      { courses, rows: enrichedRows },
      'Admission reference stats retrieved successfully',
      200
    );
  } catch (error) {
    console.error('Error getting admission reference stats:', error);
    return errorResponse(res, error.message || 'Failed to get admission reference stats', 500);
  }
};

/**
 * @desc    Admissions counts by lead source × course
 * @route   GET /api/admissions/stats/by-source
 */
export const getAdmissionStatsBySource = async (req, res) => {
  try {
    const pool = getPool();
    const { conditions, params } = await buildAdmissionPivotFilters(req.query);
    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const courses = await getAdmissionReportCourses(pool, whereClause, params);

    const pivotFrom = `FROM admissions a ${SQL_ADMISSION_PIVOT_JOINS}`;
    const [rows] = await pool.execute(
      `SELECT
         l.source AS lead_source,
         JSON_UNQUOTE(JSON_EXTRACT(${SQL_A_LEAD_DATA_JSON}, '$.source')) AS lead_data_source,
         JSON_UNQUOTE(JSON_EXTRACT(${SQL_A_LEAD_DATA_JSON}, '$.utmSource')) AS lead_data_utm_source,
         JSON_UNQUOTE(JSON_EXTRACT(${SQL_A_LEAD_DATA_JSON}, '$.leadSource')) AS lead_data_lead_source,
         l.upload_batch_id AS upload_batch_id,
         l.dynamic_fields AS lead_dynamic_fields,
         a.lead_data AS lead_data,
         j.lead_data AS joining_lead_data,
         ${SQL_A_EFFECTIVE_REFERENCE1} AS effective_reference1,
         ${SQL_A_EFF_COURSE_ID} AS courseId,
         ${SQL_A_BTECH_LATERAL_TRACK} AS lateralTrack
       ${pivotFrom}
       ${whereClause}`,
      params
    );

    const bySource = new Map();
    for (const row of rows) {
      const sourceName = normalizeAdmissionLeadSource(row);
      const sourceKey = sourceName.toLowerCase();
      if (!bySource.has(sourceKey)) {
        bySource.set(sourceKey, { displayName: sourceName, counts: {} });
      }
      const bucket = bySource.get(sourceKey);
      const ck = admissionPivotCountKey(row.courseId, row.lateralTrack);
      bucket.counts[ck] = (bucket.counts[ck] || 0) + 1;
    }

    const pivotRows = [...bySource.entries()]
      .sort((a, b) => String(a[1].displayName).localeCompare(String(b[1].displayName)))
      .map(([sourceKey, bucket]) => {
        const countsRaw = bucket.counts || {};
        const counts = {};
        for (const c of courses) {
          counts[admissionPivotColumnKey(c)] = sumCountsForCourseColumn(countsRaw, c);
        }
        const total = Object.values(countsRaw).reduce((sum, n) => sum + (Number(n) || 0), 0);
        return {
          sourceKey,
          name: bucket.displayName,
          counts,
          total,
        };
      });

    return successResponse(
      res,
      { courses, rows: pivotRows },
      'Admission source stats retrieved successfully',
      200
    );
  } catch (error) {
    console.error('Error getting admission source stats:', error);
    return errorResponse(res, error.message || 'Failed to get admission source stats', 500);
  }
};

/**
 * @desc    Admissions counts by calendar date × course
 * @route   GET /api/admissions/stats/by-date
 */
export const getAdmissionStatsByDate = async (req, res) => {
  try {
    const pool = getPool();
    const { conditions, params } = await buildAdmissionPivotFilters(req.query);
    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const courses = await getAdmissionReportCourses(pool, whereClause, params);

    const [agg] = await pool.execute(
      `SELECT DATE_FORMAT(${SQL_A_EFFECTIVE_ADMISSION_DATE}, '%Y-%m-%d') AS d,
              ${SQL_A_EFF_COURSE_ID} AS courseId,
              ${SQL_A_BTECH_LATERAL_TRACK} AS lateralTrack,
              COUNT(*) AS cnt
       FROM admissions a
       ${whereClause}
       GROUP BY DATE_FORMAT(${SQL_A_EFFECTIVE_ADMISSION_DATE}, '%Y-%m-%d'), ${SQL_A_EFF_COURSE_ID}, ${SQL_A_BTECH_LATERAL_TRACK}`,
      params
    );

    const byDate = new Map();
    for (const row of agg) {
      const dateStr = row.d ? String(row.d).slice(0, 10) : '';
      if (!dateStr) continue;
      if (!byDate.has(dateStr)) byDate.set(dateStr, {});
      const ck = admissionPivotCountKey(row.courseId, row.lateralTrack);
      const cur = byDate.get(dateStr);
      cur[ck] = (cur[ck] || 0) + (Number(row.cnt) || 0);
    }

    const rows = [...byDate.keys()]
      .sort((a, b) => b.localeCompare(a))
      .map((date) => {
        const countsRaw = byDate.get(date) || {};
        const counts = {};
        for (const c of courses) {
          counts[admissionPivotColumnKey(c)] = sumCountsForCourseColumn(countsRaw, c);
        }
        const total = Object.values(countsRaw).reduce((sum, n) => sum + (Number(n) || 0), 0);
        return { date, counts, total };
      });

    return successResponse(
      res,
      { courses, rows },
      'Admission date-wise stats retrieved successfully',
      200
    );
  } catch (error) {
    console.error('Error getting admission date-wise stats:', error);
    return errorResponse(res, error.message || 'Failed to get admission date-wise stats', 500);
  }
};

/**
 * @desc    Export admissions to Excel
 * @route   GET /api/admissions/export
 * @access  Private (Super Admin)
 */
export const exportAdmissions = async (req, res) => {
  try {
    const pool = getPool();
    const {
      search,
      status,
      collegeId,
      startDate,
      endDate,
      courseId,
      branchId,
      courseName,
      branchName,
      source,
      quota,
      merit,
    } = req.query;

    const conditions = [];
    const params = [];

    if (status && status !== 'all') {
      conditions.push('a.status = ?');
      params.push(status);
    }
    const quotaFilter = String(quota ?? '').trim();
    if (quotaFilter) {
      conditions.push(`LOWER(TRIM(COALESCE(a.quota, ''))) = LOWER(?)`);
      params.push(quotaFilter);
    }
    
    const meritFilter = String(merit ?? '').trim().toLowerCase();
    if (meritFilter === 'yes' || meritFilter === '1' || meritFilter === 'true') {
      conditions.push('a.qualification_merit = 1');
    } else if (meritFilter === 'no' || meritFilter === '0' || meritFilter === 'false') {
      conditions.push('a.qualification_merit = 0');
    }

    const collegeCourseIds = await loadManagedCourseIdsForCollege(collegeId);
    appendManagedCollegeCourseFilter(
      conditions,
      params,
      SQL_A_EFF_COURSE_ID,
      collegeCourseIds
    );

    if (courseId || courseName) {
      if (courseId && courseName) {
        conditions.push(`(${SQL_A_EFF_COURSE_ID} = ? OR a.course = ?)`);
        params.push(courseId, courseName);
      } else {
        conditions.push(`(${SQL_A_EFF_COURSE_ID} = ? OR a.course = ?)`);
        const val = courseId || courseName;
        params.push(val, val);
      }
    }

    if (branchId || branchName) {
      if (branchId && branchName) {
        conditions.push(`(${SQL_A_EFF_BRANCH_ID} = ? OR a.branch = ?)`);
        params.push(branchId, branchName);
      } else {
        conditions.push(`(${SQL_A_EFF_BRANCH_ID} = ? OR a.branch = ?)`);
        const val = branchId || branchName;
        params.push(val, val);
      }
    }

    if (startDate) {
      conditions.push(`DATE(${SQL_A_EFFECTIVE_ADMISSION_DATE}) >= ?`);
      params.push(String(startDate).slice(0, 10));
    }

    if (endDate) {
      conditions.push(`DATE(${SQL_A_EFFECTIVE_ADMISSION_DATE}) <= ?`);
      params.push(String(endDate).slice(0, 10));
    }

    if (search) {
      const t = String(search).trim();
      const searchTerm = `%${t}%`;
      const isPhone = /^\d{5,}$/.test(t);
      const phoneTerm = isPhone ? `${t}%` : searchTerm;
      conditions.push(
        '(a.student_name LIKE ? OR a.admission_number LIKE ? OR COALESCE(a.enquiry_number, \'\') LIKE ? OR a.student_phone LIKE ?)'
      );
      params.push(searchTerm, searchTerm, searchTerm, phoneTerm);
    }

    // Lead source filtering — same matching rules as listAdmissions (EXISTS keeps the
    // sorted rowset slim; joining leads overflows the session sort buffer).
    const exportSourceFilter = String(source ?? '').trim();
    if (exportSourceFilter) {
      const isSelfRegistrationSource = exportSourceFilter.toLowerCase() === 'self registration';
      const leadMatchers = [`TRIM(COALESCE(l.source, '')) = ?`];
      const snapshotMatchers = [
        `TRIM(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(a.lead_data, '$.source')), '')) = ?`,
        `TRIM(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(a.lead_data, '$.utmSource')), '')) = ?`,
        `TRIM(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(a.lead_data, '$.leadSource')), '')) = ?`,
      ];
      if (isSelfRegistrationSource) {
        leadMatchers.push(
          `TRIM(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(l.dynamic_fields, '$.createdFrom')), '')) = 'self_registration'`
        );
        snapshotMatchers.push(
          `TRIM(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(a.lead_data, '$.createdFrom')), '')) = 'self_registration'`
        );
      }
      conditions.push(`(
        EXISTS (
          SELECT 1 FROM leads l
          WHERE l.id = a.lead_id AND (${leadMatchers.join(' OR ')})
        )
        OR ${snapshotMatchers.join(' OR ')}
      )`);
      params.push(exportSourceFilter, exportSourceFilter, exportSourceFilter, exportSourceFilter);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // With the source filter, JSON conditions are evaluated in a materialized derived
    // table so the sorted outer query never references `lead_data` in its WHERE clause
    // (MySQL 8 packs referenced JSON into filesort rows → out of sort memory).
    const query = exportSourceFilter
      ? `
      SELECT /*+ NO_MERGE(src) */ a.*
      FROM admissions a
      JOIN (SELECT a.id FROM admissions a ${whereClause}) src ON src.id = a.id
      ORDER BY a.admission_number DESC, a.updated_at DESC
    `
      : `
      SELECT a.* 
      FROM admissions a
      ${whereClause}
      ORDER BY a.admission_number DESC, a.updated_at DESC
    `;

    // Increase sort buffer for this session to handle large rows (e.g., 1MB+)
    await pool.execute('SET SESSION sort_buffer_size = 4194304'); // 4MB

    const [rows] = await pool.execute(query, params);

    // Format admissions + desk Paid (TUI01/OTH1) + minimum fee configs in parallel.
    const deskFeeRows = rows.map((row) => ({
      admission_number: row.admission_number,
      quota: row.quota,
      course: row.course,
      branch: row.branch,
      joining_id: row.joining_id,
      id: row.id,
    }));
    const [formattedAdmissions, yearOnePaidByAdmissionNumber, minimumFeeConfigs] =
      await Promise.all([
        Promise.all(rows.map((row) => formatAdmission(row, pool))),
        fetchPaidByAdmissionRowsForDesk(deskFeeRows),
        loadMinimumFeeConfigs(pool),
      ]);

    // Create Excel Workbook
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Admissions');

    // Define Columns — Total Fee = configured minimum fee amount for course/branch/quota.
    worksheet.columns = [
      { header: 'Admission #', key: 'admissionNumber', width: 15 },
      { header: 'Timestamp', key: 'createdAt', width: 20 },
      { header: 'Student Name', key: 'studentName', width: 25 },
      { header: 'Contact No', key: 'studentPhone', width: 15 },
      { header: 'Course', key: 'course', width: 20 },
      { header: 'Branch', key: 'branch', width: 20 },
      { header: 'Quota', key: 'quota', width: 15 },
      { header: 'Reservation (General)', key: 'reservationGeneral', width: 20 },
      { header: 'Reservation (Other)', key: 'reservationOther', width: 20 },
      { header: 'EWS', key: 'isEws', width: 10 },
      { header: 'Status', key: 'status', width: 15 },
      { header: 'Total Fee (Min. Fee)', key: 'totalFee', width: 18 },
      { header: 'Total Paid', key: 'totalPaid', width: 15 },
      { header: 'Balance', key: 'balance', width: 15 },
      { header: 'Min Fee Met', key: 'minFeeMet', width: 12 },
      { header: 'Source', key: 'source', width: 15 },
      { header: 'Reference', key: 'reference', width: 22 },
      { header: 'SSC Result', key: 'sscResult', width: 10 },
      { header: 'SSC Passed Year', key: 'sscPassedYear', width: 15 },
      { header: 'Intermediate Passed Year', key: 'interPassedYear', width: 15 },
    ];

    const exportCollegeId = String(collegeId || '').trim() || undefined;
    const greenFill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFDCFCE7' }, // light green
    };
    const greenFont = { color: { argb: 'FF166534' }, bold: true };

    // Add Rows
    formattedAdmissions.forEach((record) => {
      const reservationOther = Array.isArray(record.reservation?.other)
        ? record.reservation.other.join(', ')
        : record.reservation?.other || '';

      const admissionNumber = String(record.admissionNumber || '').trim();
      const totalPaid = Number(yearOnePaidByAdmissionNumber.get(admissionNumber) ?? 0) || 0;
      const minimumFeeRequired = resolveMinimumFeeAmount(minimumFeeConfigs, {
        collegeId: exportCollegeId,
        courseId: record.courseInfo?.courseId,
        courseName: record.courseInfo?.course,
        branchId: record.courseInfo?.branchId,
        branchName: record.courseInfo?.branch,
        quota: record.courseInfo?.quota,
      });
      const hasMinFee = minimumFeeRequired > FEE_UNPAID_TOLERANCE;
      const totalFee = hasMinFee ? minimumFeeRequired : 0;
      const balance = hasMinFee ? Math.max(minimumFeeRequired - totalPaid, 0) : 0;
      // Green mark when student paid at least the configured minimum fee.
      const metMinimum =
        hasMinFee && totalPaid + FEE_UNPAID_TOLERANCE >= minimumFeeRequired;

      const excelRow = worksheet.addRow({
        admissionNumber: record.admissionNumber,
        createdAt: record.createdAt ? new Date(record.createdAt).toLocaleString() : '',
        studentName: record.studentInfo?.name || '',
        studentPhone: record.studentInfo?.phone || '',
        course: record.courseInfo?.course || '',
        branch: record.courseInfo?.branch || '',
        quota: record.courseInfo?.quota || '',
        reservationGeneral: record.reservation?.general || 'OC',
        reservationOther: reservationOther,
        isEws: record.reservation?.isEws ? 'Yes' : 'No',
        status: record.status || '',
        totalFee,
        totalPaid,
        balance,
        minFeeMet: metMinimum ? '✓' : '',
        source: record.leadData?.source || 'Direct',
        reference:
          record.leadData?.reference1 ||
          record.leadData?.referenceName ||
          record.registrationFormData?.reference1 ||
          '',
        sscResult: record.educationHistory?.[0]?.gradeOrPercentage || '',
        sscPassedYear: record.educationHistory?.[0]?.yearOfPassing || '',
        interPassedYear: record.educationHistory?.[1]?.yearOfPassing || '',
      });

      if (metMinimum) {
        excelRow.eachCell((cell) => {
          cell.fill = greenFill;
        });
        const markCell = excelRow.getCell('minFeeMet');
        markCell.font = greenFont;
        markCell.alignment = { horizontal: 'center' };
      }
    });

    // Style the header
    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE0E0E0' },
    };

    // Set Response Headers
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      'attachment; filename=admissions_export.xlsx'
    );

    // Write to stream
    await workbook.xlsx.write(res);
    res.end();

  } catch (error) {
    console.error('Error exporting admissions:', error);
    if (!res.headersSent) {
      return errorResponse(res, error.message || 'Failed to export admissions', 500);
    }
  }
};

/** "Other Documents to Submit" checklist (excludes Important Documents / certificate checklist). */
const OTHER_DOCUMENT_FIELDS_ALWAYS = [
  { column: 'document_aadhaar_card', label: 'Aadhaar Card' },
  { column: 'document_photos', label: 'Photos (5)' },
  { column: 'document_income_certificate', label: 'EWS Certificate' },
  { column: 'document_caste_certificate', label: 'Caste Certificate' },
];

/** CET / allotment docs — hidden for Management quota (same as joining other-documents checklist). */
const OTHER_DOCUMENT_FIELDS_NON_MGMT = [
  { column: 'document_cet_rank_card', label: 'CET Rank Card' },
  { column: 'document_cet_hall_ticket', label: 'CET Hall Ticket' },
  { column: 'document_allotment_letter', label: 'Allotment Letter' },
  { column: 'document_joining_report', label: 'Joining Report' },
];

const OTHER_DOCUMENT_FIELDS_ALL = [
  ...OTHER_DOCUMENT_FIELDS_ALWAYS,
  ...OTHER_DOCUMENT_FIELDS_NON_MGMT,
];

const PENDING_LIST_DEFAULT_LIMIT = 20;
const PENDING_LIST_MAX_LIMIT = 500;

const parsePendingListPagination = (query = {}) => {
  const allFlag = String(query.all ?? '').trim().toLowerCase();
  const limitRaw = String(query.limit ?? '').trim().toLowerCase();
  const returnAll =
    allFlag === '1' ||
    allFlag === 'true' ||
    allFlag === 'yes' ||
    limitRaw === 'all' ||
    limitRaw === '0';

  if (returnAll) {
    return { page: 1, limit: null, returnAll: true };
  }

  const page = Math.max(1, parseInt(String(query.page ?? '1'), 10) || 1);
  const rawLimit = parseInt(String(query.limit ?? String(PENDING_LIST_DEFAULT_LIMIT)), 10);
  const limit = Math.min(
    PENDING_LIST_MAX_LIMIT,
    Math.max(1, Number.isFinite(rawLimit) ? rawLimit : PENDING_LIST_DEFAULT_LIMIT)
  );
  return { page, limit, returnAll: false };
};

const paginatePendingRows = (allRows, page, limit, returnAll = false) => {
  const total = Array.isArray(allRows) ? allRows.length : 0;
  if (returnAll || limit == null) {
    return {
      rows: allRows || [],
      pagination: {
        page: 1,
        pages: 1,
        limit: total,
        total,
      },
    };
  }
  const pages = Math.max(1, Math.ceil(total / limit) || 1);
  const safePage = Math.min(Math.max(1, page), pages);
  const start = (safePage - 1) * limit;
  return {
    rows: (allRows || []).slice(start, start + limit),
    pagination: {
      page: safePage,
      pages,
      limit,
      total,
    },
  };
};

/** Mirrors frontend `isManagementQuotaLabel` for other-documents visibility. */
const isManagementQuotaForOtherDocs = (quota) => {
  const u = String(quota ?? '')
    .trim()
    .toUpperCase();
  if (!u) return false;
  if (u === 'MANG' || u === 'MANAGEMENT') return true;
  if (u.includes('MANAGEMENT')) return true;
  return u.includes('MANG') && !u.includes('CONV');
};

const pendingOtherDocumentLabelsFromRow = (row) => {
  const hideCet = isManagementQuotaForOtherDocs(row?.quota);
  return OTHER_DOCUMENT_FIELDS_ALL.filter((f) => {
    if (hideCet && OTHER_DOCUMENT_FIELDS_NON_MGMT.some((x) => x.column === f.column)) {
      return false;
    }
    return String(row?.[f.column] ?? 'pending').toLowerCase() === 'pending';
  }).map((f) => f.label);
};

const otherDocumentsCompleteFromRow = (row) => pendingOtherDocumentLabelsFromRow(row).length === 0;

const parseJsonMaybe = (raw) => {
  if (raw == null) return null;
  if (typeof raw === 'object' && !Array.isArray(raw) && !Buffer.isBuffer(raw)) return raw;
  if (Buffer.isBuffer(raw)) {
    try {
      return JSON.parse(raw.toString('utf8'));
    } catch {
      return null;
    }
  }
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (!t || t === 'null') return null;
    try {
      return JSON.parse(t);
    } catch {
      return null;
    }
  }
  return null;
};

const resolveProgramLevelFromAdmissionRow = (row) => {
  const candidates = [
    row?.program_level,
    row?.extras_program_level,
    row?.extras_programLevel,
    row?.extras_course_level,
  ];
  for (const raw of candidates) {
    const value = String(raw ?? '').trim();
    if (value && value !== 'null') return value;
  }
  return '';
};

/** Base filters aligned with abstract / student-info list — active admissions only. */
const buildPendingCertificatesBaseFilters = async (query) => {
  const {
    collegeId,
    courseId,
    courseName,
    branchId,
    branchName,
    startDate,
    endDate,
    quota,
  } = query;
  const conditions = ['a.status = ?'];
  const params = ['active'];

  const collegeCourseIds = await loadManagedCourseIdsForCollege(collegeId);
  appendManagedCollegeCourseFilter(
    conditions,
    params,
    SQL_A_EFF_COURSE_ID,
    collegeCourseIds
  );

  if (startDate) {
    conditions.push(`DATE(${SQL_A_EFFECTIVE_ADMISSION_DATE}) >= ?`);
    params.push(String(startDate).slice(0, 10));
  }

  if (endDate) {
    conditions.push(`DATE(${SQL_A_EFFECTIVE_ADMISSION_DATE}) <= ?`);
    params.push(String(endDate).slice(0, 10));
  }

  if (courseId || courseName) {
    if (courseId && courseName) {
      conditions.push(`(${SQL_A_EFF_COURSE_ID} = ? OR a.course = ?)`);
      params.push(courseId, courseName);
    } else {
      conditions.push(`(${SQL_A_EFF_COURSE_ID} = ? OR a.course = ?)`);
      const val = courseId || courseName;
      params.push(val, val);
    }
  }

  if (branchId || branchName) {
    if (branchId && branchName) {
      conditions.push(`(${SQL_A_EFF_BRANCH_ID} = ? OR a.branch = ?)`);
      params.push(branchId, branchName);
    } else {
      conditions.push(`(${SQL_A_EFF_BRANCH_ID} = ? OR a.branch = ?)`);
      const val = branchId || branchName;
      params.push(val, val);
    }
  }

  const quotaFilter = String(quota ?? '').trim();
  if (quotaFilter) {
    conditions.push('LOWER(TRIM(COALESCE(a.quota, \'\'))) = LOWER(?)');
    params.push(quotaFilter);
  }

  return {
    whereClause: `WHERE ${conditions.join(' AND ')}`,
    params,
  };
};

const formatPendingDocumentsRow = (row, certRoot) => {
  const otherPending = pendingOtherDocumentLabelsFromRow(row);
  const programLevel = resolveProgramLevelFromAdmissionRow(row);
  const items = getCertificateItemsForLevel(certRoot, programLevel);
  const checklistRaw = parseJsonMaybe(row?.certificate_checklist);
  const importantPending = pendingImportantDocumentLabels({
    checklistRaw,
    items,
  });
  const importantHasPending = importantPending.length > 0;
  const importantComplete = !importantHasPending;
  // List / export / “Pending” sample are driven by Other Documents only.
  const otherComplete = otherDocumentsCompleteFromRow(row);
  const isPending = otherPending.length > 0;
  const isCompleted = otherComplete;

  return {
    id: row.id,
    admissionNumber: row.admission_number || '',
    studentName: row.student_name || '',
    parentMobile: row.father_phone || '',
    studentMobile: row.student_phone || '',
    quota: row.quota || '',
    course: row.course || '',
    branch: row.branch || '',
    programLevel,
    importantDocumentsPending: importantPending,
    otherDocumentsPending: otherPending,
    importantDocumentsPendingText:
      importantPending.length > 0 ? importantPending.join(', ') : 'Completed',
    otherDocumentsPendingText:
      otherPending.length > 0 ? otherPending.join(', ') : 'Completed',
    pendingCertificates: otherPending,
    pendingCertificatesText: otherPending.length > 0 ? otherPending.join(', ') : 'Completed',
    importantComplete,
    importantHasPending: importantPending.length > 0,
    isPending,
    isCompleted,
  };
};

/**
 * Load filtered admissions and evaluate Important + Other Documents separately.
 *
 * Total students = all admissions matching college/course/quota/status filters.
 * Sample list + Excel = students with Other Documents still pending.
 *
 * Two-phase fetch (same pattern as listAdmissions): ORDER BY ids without JSON, then
 * load detail rows by PK without ORDER BY. MySQL 8 packs `lead_data` JSON into filesort
 * rows and overflows sort_buffer when JSON_EXTRACT is combined with ORDER BY.
 */
const evaluatePendingDocuments = async (query) => {
  const pool = getPool();
  const { whereClause, params } = await buildPendingCertificatesBaseFilters(query);
  const certRoot = await loadCertificateConfigRoot();

  // Phase 1: sorted ids only — no lead_data / JSON in the sort.
  const [idRows] = await pool.execute(
    `SELECT a.id
     FROM admissions a
     ${whereClause}
     ORDER BY a.admission_number DESC, a.updated_at DESC`,
    params
  );

  const emptyStats = {
    totalStudents: 0,
    pendingStudents: 0,
    completedStudents: 0,
    importantReceivedStudents: 0,
    importantPendingStudents: 0,
    otherPendingStudents: 0,
    otherCompletedStudents: 0,
  };

  if (!idRows.length) {
    return { stats: emptyStats, pendingRows: [] };
  }

  const orderedIds = idRows.map((row) => row.id);
  const orderIndex = new Map(orderedIds.map((id, index) => [String(id), index]));
  const detailRows = [];
  const CHUNK = 400;

  // Phase 2: fetch detail + JSON extracts by primary key (no ORDER BY).
  for (let i = 0; i < orderedIds.length; i += CHUNK) {
    const chunkIds = orderedIds.slice(i, i + CHUNK);
    const inMarks = chunkIds.map(() => '?').join(',');
    const [pageRows] = await pool.execute(
      `SELECT a.id, a.admission_number, a.student_name, a.student_phone, a.father_phone,
              a.quota, a.course, a.branch,
              a.document_aadhaar_card, a.document_photos,
              a.document_income_certificate, a.document_caste_certificate,
              a.document_cet_rank_card, a.document_cet_hall_ticket,
              a.document_allotment_letter, a.document_joining_report,
              a.document_bank_passbook, a.document_ration_card,
              JSON_UNQUOTE(JSON_EXTRACT(a.lead_data, '$._joiningProgramLevel')) AS program_level,
              JSON_UNQUOTE(JSON_EXTRACT(a.lead_data, '$._joiningRegistrationExtras.program_level')) AS extras_program_level,
              JSON_UNQUOTE(JSON_EXTRACT(a.lead_data, '$._joiningRegistrationExtras.programLevel')) AS extras_programLevel,
              JSON_UNQUOTE(JSON_EXTRACT(a.lead_data, '$._joiningRegistrationExtras.course_level')) AS extras_course_level,
              JSON_EXTRACT(a.lead_data, '$._joiningRegistrationExtras.certificate_checklist') AS certificate_checklist
       FROM admissions a
       WHERE a.id IN (${inMarks})`,
      chunkIds
    );
    detailRows.push(...pageRows);
  }

  detailRows.sort(
    (a, b) => (orderIndex.get(String(a.id)) ?? 0) - (orderIndex.get(String(b.id)) ?? 0)
  );

  const evaluated = detailRows.map((row) => formatPendingDocumentsRow(row, certRoot));
  const totalStudents = evaluated.length;
  const importantReceivedStudents = evaluated.filter((r) => r.importantComplete).length;
  const importantPendingStudents = evaluated.filter((r) => r.importantHasPending).length;
  const otherPendingStudents = evaluated.filter((r) => r.isPending).length;
  const otherCompletedStudents = evaluated.filter((r) => r.isCompleted).length;
  const pendingRows = evaluated.filter((r) => r.isPending);

  return {
    stats: {
      totalStudents,
      /** @deprecated alias — other-docs pending (sample list size). */
      pendingStudents: otherPendingStudents,
      /** @deprecated alias — other-docs completed. */
      completedStudents: otherCompletedStudents,
      importantReceivedStudents,
      importantPendingStudents,
      otherPendingStudents,
      otherCompletedStudents,
    },
    pendingRows,
  };
};

const fetchPendingCertificateRows = async (query, { limit } = {}) => {
  const { pendingRows } = await evaluatePendingDocuments(query);
  if (Number.isFinite(Number(limit)) && Number(limit) > 0) {
    return pendingRows.slice(0, Math.floor(Number(limit)));
  }
  return pendingRows;
};

const fetchPendingCertificateStats = async (query) => {
  const { stats } = await evaluatePendingDocuments(query);
  return stats;
};

/** List students with pending Other Documents (Important shown as Completed when done). */
export const listPendingCertificates = async (req, res) => {
  try {
    const { page, limit, returnAll } = parsePendingListPagination(req.query);
    const { stats, pendingRows } = await evaluatePendingDocuments(req.query);
    const { rows, pagination } = paginatePendingRows(pendingRows, page, limit, returnAll);
    return successResponse(
      res,
      {
        rows,
        pagination,
        stats,
        total: pagination.total,
      },
      'Pending other documents retrieved successfully',
      200
    );
  } catch (error) {
    console.error('Error listing pending certificates:', error);
    return errorResponse(
      res,
      error.message || 'Failed to list pending certificates',
      error.statusCode || 500
    );
  }
};

const formatPendingFeeRow = (row, feeSummary) => {
  const summary = feeSummary || {
    payable: 0,
    paid: 0,
    pending: 0,
    hasFeeEntry: false,
    feeStatus: 'no_entry',
    displayAmount: 0,
    displayLabel: 'Pending',
    tuition: { payable: 0, paid: 0, pending: 0, hasFeeEntry: false },
    other: { payable: 0, paid: 0, pending: 0, hasFeeEntry: false },
  };
  const tuition = summary.tuition || {
    payable: 0,
    paid: 0,
    pending: 0,
    hasFeeEntry: false,
  };
  const other = summary.other || {
    payable: 0,
    paid: 0,
    pending: 0,
    hasFeeEntry: false,
  };
  const isUnpaid = summary.feeStatus === 'unpaid';

  return {
    id: row.id,
    admissionNumber: row.admission_number || '',
    studentName: row.student_name || '',
    parentMobile: row.father_phone || '',
    studentMobile: row.student_phone || '',
    quota: row.quota || '',
    course: row.course || '',
    branch: row.branch || '',
    // Ids used for minimum-fee matching on export (optional on older callers)
    managedCourseId: row.managed_course_id || row.course_id || '',
    managedBranchId: row.managed_branch_id || row.branch_id || '',
    // Combined Step 4 totals (Tuition + Other/Special)
    totalPayable: summary.payable,
    totalPaid: summary.paid,
    totalPending: summary.pending,
    // Per-head Year 1 amounts
    tuitionPayable: tuition.payable,
    tuitionPaid: tuition.paid,
    tuitionPending: tuition.pending,
    otherPayable: other.payable,
    otherPaid: other.paid,
    otherPending: other.pending,
    // Legacy aliases — combined totals (kept for older UI fields)
    payable: summary.payable,
    paid: summary.paid,
    pending: summary.pending,
    hasFeeEntry: summary.hasFeeEntry,
    feeStatus: summary.feeStatus,
    displayAmount: summary.displayAmount,
    displayLabel: summary.displayLabel,
    feeStatusText: summary.displayLabel,
    feeAmountText: !summary.hasFeeEntry
      ? 'Pending — 0'
      : summary.feeStatus === 'paid'
        ? `Paid — ${summary.paid}`
        : `Unpaid — ${summary.pending > 0 ? summary.pending : summary.payable}`,
    isPending: isUnpaid,
    isPaid: summary.feeStatus === 'paid',
    isNoEntry: summary.feeStatus === 'no_entry',
  };
};

/**
 * Build min-fee match context for a pending fee row.
 * Prefer export/list query filters when present (same as PendingAdmissionsDownloadModal),
 * then per-admission course/branch ids and names.
 */
const buildPendingFeeMinFeeMatchContext = (row, query = {}) => ({
  collegeId: query.collegeId || query.college_id || undefined,
  courseId:
    query.courseId ||
    query.course_id ||
    row.managedCourseId ||
    row.managed_course_id ||
    row.course_id ||
    undefined,
  courseName: row.course || query.courseName || query.course_name || undefined,
  branchId:
    query.branchId ||
    query.branch_id ||
    row.managedBranchId ||
    row.managed_branch_id ||
    row.branch_id ||
    undefined,
  branchName: row.branch || query.branchName || query.branch_name || undefined,
  quota: row.quota || query.quota || undefined,
});

/**
 * Evaluate Year-1 Tuition (TUI01) + Other/Special (OTH1) fee status for filtered
 * active admissions — same heads as Step 4 admission view-details (excluding transport).
 * List + export base set = students who still have a remaining balance (payable − paid > 0).
 * Export then applies minimum-fee config for Amount columns / row inclusion.
 */
const evaluatePendingFees = async (query) => {
  const pool = getPool();
  const { whereClause, params } = await buildPendingCertificatesBaseFilters(query);
  const minimumFeeConfigs = await loadMinimumFeeConfigs(pool);

  const [idRows] = await pool.execute(
    `SELECT a.id
     FROM admissions a
     ${whereClause}
     ORDER BY a.admission_number DESC, a.updated_at DESC`,
    params
  );

  const emptyStats = {
    totalStudents: 0,
    tuitionPaidStudents: 0,
    tuitionUnpaidStudents: 0,
    tuitionNoEntryStudents: 0,
    tuitionFullySettledStudents: 0,
    pendingStudents: 0,
  };

  if (!idRows.length) {
    return { stats: emptyStats, pendingRows: [], minimumFeeConfigs };
  }

  const orderedIds = idRows.map((row) => row.id);
  const orderIndex = new Map(orderedIds.map((id, index) => [String(id), index]));
  const detailRows = [];
  const CHUNK = 400;

  for (let i = 0; i < orderedIds.length; i += CHUNK) {
    const chunkIds = orderedIds.slice(i, i + CHUNK);
    const inMarks = chunkIds.map(() => '?').join(',');
    const [pageRows] = await pool.execute(
      `SELECT a.id, a.admission_number, a.student_name, a.student_phone, a.father_phone,
              a.quota, a.course, a.branch,
              a.managed_course_id, a.course_id, a.managed_branch_id, a.branch_id
       FROM admissions a
       WHERE a.id IN (${inMarks})`,
      chunkIds
    );
    detailRows.push(...pageRows);
  }

  detailRows.sort(
    (a, b) => (orderIndex.get(String(a.id)) ?? 0) - (orderIndex.get(String(b.id)) ?? 0)
  );

  const feeSummaries = await buildTuitionAndOtherFeeSummariesForAdmissionRows(detailRows);

  const evaluated = detailRows.map((row) =>
    formatPendingFeeRow(row, feeSummaries.get(String(row.admission_number || '').trim()))
  );

  const totalStudents = evaluated.length;
  // Fee paid = any payment recorded on tuition + other (not only fully settled).
  const tuitionPaidStudents = evaluated.filter((r) => Number(r.totalPaid || 0) > 0.5).length;
  const tuitionUnpaidStudents = evaluated.filter((r) => r.isPending).length;
  const tuitionNoEntryStudents = evaluated.filter((r) => r.isNoEntry).length;
  const tuitionFullySettledStudents = evaluated.filter((r) => r.isPaid).length;
  const pendingRows = evaluated.filter((r) => r.isPending);

  return {
    stats: {
      totalStudents,
      tuitionPaidStudents,
      tuitionUnpaidStudents,
      tuitionNoEntryStudents,
      tuitionFullySettledStudents,
      pendingStudents: tuitionUnpaidStudents,
    },
    pendingRows,
    minimumFeeConfigs,
  };
};

/** List students with unpaid Year-1 Tuition + Other/Special fee. */
export const listPendingFees = async (req, res) => {
  try {
    const { page, limit, returnAll } = parsePendingListPagination(req.query);
    const { stats, pendingRows } = await evaluatePendingFees(req.query);
    const { rows, pagination } = paginatePendingRows(pendingRows, page, limit, returnAll);
    return successResponse(
      res,
      {
        rows,
        pagination,
        stats,
        total: pagination.total,
      },
      'Pending tuition and other fees retrieved successfully',
      200
    );
  } catch (error) {
    console.error('Error listing pending fees:', error);
    return errorResponse(
      res,
      error.message || 'Failed to list pending fees',
      error.statusCode || 500
    );
  }
};

/** Excel export — students with unpaid Year-1 Tuition + Other/Special fee
 *  (or below configured minimum fee when min-fee configs exist). */
export const exportPendingFees = async (req, res) => {
  try {
    const { pendingRows, minimumFeeConfigs = [] } = await evaluatePendingFees(req.query);
    const usingMinimumFee = Array.isArray(minimumFeeConfigs) && minimumFeeConfigs.length > 0;

    // Align Excel rows + Amount columns with Joining Desk min-fee UI / Print PDF.
    const exportRows = usingMinimumFee
      ? pendingRows
          .filter((row) =>
            isFeeStillPending(
              row,
              minimumFeeConfigs,
              buildPendingFeeMinFeeMatchContext(row, req.query)
            )
          )
          .map((row) =>
            applyMinimumFeeAmountsToPendingRow(
              row,
              minimumFeeConfigs,
              buildPendingFeeMinFeeMatchContext(row, req.query)
            )
          )
      : pendingRows;

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Pending Fees');
    worksheet.columns = [
      { header: 'S. No.', key: 'sno', width: 8 },
      { header: 'Student Name', key: 'studentName', width: 25 },
      { header: 'Admission No', key: 'admissionNumber', width: 15 },
      { header: 'Course', key: 'course', width: 20 },
      { header: 'Branch', key: 'branch', width: 20 },
      { header: 'Parent Mobile No', key: 'parentMobile', width: 16 },
      { header: 'Student Mobile No', key: 'studentMobile', width: 16 },
      { header: 'Quota', key: 'quota', width: 15 },
      { header: 'Tuition Payable', key: 'tuitionPayable', width: 16 },
      { header: 'Tuition Paid', key: 'tuitionPaid', width: 16 },
      { header: 'Tuition Pending', key: 'tuitionPending', width: 16 },
      { header: 'Other Payable', key: 'otherPayable', width: 16 },
      { header: 'Other Paid', key: 'otherPaid', width: 16 },
      { header: 'Other Pending', key: 'otherPending', width: 16 },
      {
        header: usingMinimumFee ? 'Minimum Fee Required' : 'Total Payable',
        key: 'totalPayable',
        width: 18,
      },
      { header: 'Total Paid', key: 'totalPaid', width: 16 },
      {
        header: usingMinimumFee ? 'Unpaid vs Minimum' : 'Total Pending',
        key: 'totalPending',
        width: 18,
      },
      { header: 'Fee Status', key: 'feeStatusText', width: 14 },
      { header: 'Amount', key: 'feeAmountText', width: 18 },
    ];

    exportRows.forEach((row, index) => {
      worksheet.addRow({
        sno: index + 1,
        studentName: row.studentName,
        admissionNumber: row.admissionNumber,
        course: row.course,
        branch: row.branch,
        parentMobile: row.parentMobile,
        studentMobile: row.studentMobile,
        quota: row.quota,
        tuitionPayable: row.tuitionPayable,
        tuitionPaid: row.tuitionPaid,
        tuitionPending: row.tuitionPending,
        otherPayable: row.otherPayable,
        otherPaid: row.otherPaid,
        otherPending: row.otherPending,
        totalPayable: row.totalPayable,
        totalPaid: row.totalPaid,
        totalPending: row.totalPending,
        feeStatusText: row.feeStatusText,
        feeAmountText: row.feeAmountText,
      });
    });

    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE0E0E0' },
    };

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader('Content-Disposition', 'attachment; filename=pending_fees.xlsx');

    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error('Error exporting pending fees:', error);
    if (!res.headersSent) {
      return errorResponse(res, error.message || 'Failed to export pending fees', 500);
    }
  }
};

/** Excel export — students with other documents pending; includes Important Documents status. */
export const exportPendingCertificates = async (req, res) => {
  try {
    const rows = await fetchPendingCertificateRows(req.query);

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Pending Documents');
    worksheet.columns = [
      { header: 'S. No.', key: 'sno', width: 8 },
      { header: 'Student Name', key: 'studentName', width: 25 },
      { header: 'Admission No', key: 'admissionNumber', width: 15 },
      { header: 'Course', key: 'course', width: 20 },
      { header: 'Branch', key: 'branch', width: 20 },
      { header: 'Parent Mobile No', key: 'parentMobile', width: 16 },
      { header: 'Student Mobile No', key: 'studentMobile', width: 16 },
      { header: 'Quota', key: 'quota', width: 15 },
      { header: 'Important Documents', key: 'importantDocumentsPendingText', width: 45 },
      { header: 'Other Documents Pending', key: 'otherDocumentsPendingText', width: 55 },
    ];

    rows.forEach((row, index) => {
      worksheet.addRow({
        sno: index + 1,
        studentName: row.studentName,
        admissionNumber: row.admissionNumber,
        course: row.course,
        branch: row.branch,
        parentMobile: row.parentMobile,
        studentMobile: row.studentMobile,
        quota: row.quota,
        importantDocumentsPendingText: row.importantDocumentsPendingText,
        otherDocumentsPendingText: row.otherDocumentsPendingText,
      });
    });

    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE0E0E0' },
    };

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      'attachment; filename=pending_documents.xlsx'
    );

    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error('Error exporting pending certificates:', error);
    if (!res.headersSent) {
      return errorResponse(res, error.message || 'Failed to export pending certificates', 500);
    }
  }
};
