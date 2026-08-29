import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { getPool as getSecondaryPool } from '../config-sql/database-secondary.js';
import {
  mapCourseAndBranch,
  mapCourseLabel,
  pickSecondaryBranchDisplayLabel,
} from '../data/admissionsCourseBranchMap2026.js';
import {
  deriveAdmissionSeriesYear,
  enrichRegistrationExtrasWithFeeDetails,
  isBtechCourseName,
  isLateralRegistrationExtras,
  normalizeCourseNameForSecondarySync,
  parseSemesterForSecondaryColumns,
  resolveExpectedBatchYear,
  resolveSecondarySemesterForSync,
  resolveSecondaryYearOfStudy,
} from './lateralBatch.util.js';
import { classifyAdmissionQuotaCategory } from './quotaClassification.util.js';
import { extractPortraitPhotosFromRegistrationFormData, preferIntactPortraitPhoto } from './joiningParentPhotos.util.js';
import {
  assignStudentRollNumber,
  isRollEligibleAdmissionNumber,
  isAdmissionCancelledStatus,
  revokeStudentRollNumber,
  resolveBranchScope,
} from './studentRollNumber.util.js';
import { syncStudentFeesToFeeManagement } from '../services/feeManagementStudentFeeSync.service.js';
import { getTableColumnSet } from './secondarySchema.util.js';
import { resolveSecondaryStudentCasteFields } from './casteCatalog.util.js';

const normalizeChecklistItemStatus = (entry) => {
  if (typeof entry === 'string') {
    const s = String(entry).trim().toLowerCase();
    return s === 'received' || s === 'pending' ? s : null;
  }
  if (entry && typeof entry === 'object') {
    const s = String(entry.status ?? '').trim().toLowerCase();
    return s === 'received' || s === 'pending' ? s : null;
  }
  return null;
};

const normalizeChecklistOption = (entry) => {
  if (entry && typeof entry === 'object') {
    const opt = String(entry.option ?? '').trim();
    return opt || null;
  }
  return null;
};

const normalizeVerifiedState = (value) => {
  const v = String(value ?? '').trim().toLowerCase();
  if (!v) return null;
  if (v === 'yes' || v === 'y' || v === 'true' || v === '1') return 'Verified';
  if (v === 'no' || v === 'n' || v === 'false' || v === '0') return 'Not Verified';
  if (v === 'verified' || v === 'received' || v === 'complete' || v === 'completed')
    return 'Verified';
  if (v === 'certified') return 'Verified';
  if (v === 'partial' || v === 'temporary' || v === 'provisional') return 'Temporary';
  if (v === 'unverified' || v === 'not verified' || v === 'pending' || v === 'incomplete')
    return 'Not Verified';
  if (v === 'not certified' || v === 'submitted') return 'Not Verified';
  return null;
};

const deriveCertificatesStatus = (registrationExtras) => {
  const checklist = registrationExtras?.certificate_checklist;
  if (checklist && typeof checklist === 'object' && !Array.isArray(checklist)) {
    const values = Object.values(checklist);
    if (values.length > 0) {
      const everyReceived = values.every(
        (entry) => normalizeChecklistItemStatus(entry) === 'received'
      );
      if (!everyReceived) return 'Not Verified';

      // Business rule: received + temporary/provisional/memo option means Temporary.
      const hasTemporaryOption = values.some((entry) => {
        const option = normalizeChecklistOption(entry);
        if (!option) return false;
        return /(temporary|provisional|memo)/i.test(option);
      });
      return hasTemporaryOption ? 'Temporary' : 'Verified';
    }
  }

  // Fallback only when checklist is unavailable.
  return normalizeVerifiedState(registrationExtras?.certificates_status);
};

const normalizeStudentPhotoForSecondary = (value) => {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;

  if (/^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(raw)) {
    return raw;
  }

  if (/^[A-Za-z0-9+/=\r\n]+$/.test(raw) && raw.length > 100) {
    return `data:image/jpeg;base64,${raw}`;
  }

  // Preserve non-empty filename/URL strings instead of dropping them.
  // Some records currently store only filename in registration extras.
  return raw;
};

export const deriveSecondaryStudentStatus = (admissionStatus, registrationExtras) => {
  const admission = String(admissionStatus ?? '').trim().toLowerCase();
  if (admission === 'withdrawn') return 'Discontinued';
  if (admission === 'admission cancelled') return 'Admission Cancelled';

  const explicitStatus = String(
    registrationExtras?.student_status ?? registrationExtras?.studentStatus ?? ''
  ).trim();
  if (explicitStatus) {
    const lower = explicitStatus.toLowerCase();
    // Never persist primary workflow labels into secondary student_status.
    if (lower === 'active' || lower === 'pending_approval' || lower === 'approved') {
      return 'Regular';
    }
    if (lower === 'withdrawn') return 'Discontinued';
    // Lateral entry is intake metadata (batch/semester/year) — not lifecycle student_status on sync.
    if (lower === 'lateral') return 'Regular';

    // Keep known secondary lifecycle values, fallback to Regular for unknown workflow-like tokens.
    const allowed = new Set([
      'regular',
      'discontinued',
      'admission cancelled',
      'detained',
      'long absent',
      're-joined',
      'rejoined',
    ]);
    if (allowed.has(lower)) return explicitStatus;
    return 'Regular';
  }

  // Secondary DB: academic student status, not admission row status (active/withdrawn).
  return 'Regular';
};

const normalizeDobForSecondary = (value) => {
  const raw = String(value ?? '').trim();
  if (!raw) return '';

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

  const dmy = raw.match(/^(\d{2})[-\/](\d{2})[-\/](\d{4})$/);
  if (dmy) {
    const day = Number.parseInt(dmy[1], 10);
    const month = Number.parseInt(dmy[2], 10);
    const year = Number.parseInt(dmy[3], 10);
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  return raw;
};
const deriveCertificationDialogCompat = (certificatesStatus, registrationExtras) => {
  const status = String(certificatesStatus ?? '').trim();
  const statusLower = status.toLowerCase();
  const isCertified = statusLower === 'verified' || statusLower === 'temporary';
  const yesNo = isCertified ? 'Yes' : 'No';

  const checklist =
    registrationExtras?.certificate_checklist &&
    typeof registrationExtras.certificate_checklist === 'object' &&
    !Array.isArray(registrationExtras.certificate_checklist)
      ? registrationExtras.certificate_checklist
      : {};

  const findChecklistEntry = (patterns) => {
    const hit = Object.entries(checklist).find(([key]) =>
      patterns.some((re) => re.test(String(key || '').toLowerCase()))
    );
    return hit ? hit[1] : null;
  };

  const isChecklistReceived = (entry) => normalizeChecklistItemStatus(entry) === 'received';
  const mapInterStudyOption = (entry) => {
    const statusVal = normalizeChecklistItemStatus(entry);
    if (statusVal !== 'received') return 'No';
    const option = String(normalizeChecklistOption(entry) ?? '').toLowerCase();
    if (/(memo|temporary|provisional)/i.test(option)) return 'Memo';
    return 'Original';
  };

  const tenthStudyEntry = findChecklistEntry([/10th[_\s-]*study/, /ssc[_\s-]*study/, /10th/, /ssc/]);
  const tenthTcEntry = findChecklistEntry([/10th[_\s-]*tc/]);
  const interTcEntry = findChecklistEntry([/inter[_\s-]*diploma[_\s-]*tc/, /inter[_\s-]*tc/, /diploma[_\s-]*tc/]);
  const interStudyEntry = findChecklistEntry([/inter[_\s-]*diploma[_\s-]*study/, /inter[_\s-]*study/, /diploma[_\s-]*study/]);

  const tenthStudyReceived = tenthStudyEntry != null ? isChecklistReceived(tenthStudyEntry) : null;
  const tenthTcReceived = tenthTcEntry != null ? isChecklistReceived(tenthTcEntry) : null;
  const interTcReceived = interTcEntry != null ? isChecklistReceived(interTcEntry) : null;
  const interStudyReceived = interStudyEntry != null ? isChecklistReceived(interStudyEntry) : null;
  const interStudySelection = interStudyEntry != null ? mapInterStudyOption(interStudyEntry) : (isCertified ? 'Original' : 'No');

  return {
    certification_status: yesNo,
    certificates_verified: yesNo,
    certificates_status: status || (isCertified ? 'Verified' : 'Not Verified'),
    ssc_certificate: tenthStudyReceived == null ? isCertified : tenthStudyReceived,
    inter_diploma_cert: interStudyReceived == null ? yesNo : interStudyReceived ? 'Yes' : 'No',
    inter_diploma_study: interStudySelection,
    inter_diploma_tc: interTcReceived == null ? yesNo : interTcReceived ? 'Yes' : 'No',
    '10th_study': tenthStudyReceived == null ? isCertified : tenthStudyReceived,
    '10th_tc': tenthTcReceived == null ? isCertified : tenthTcReceived,
    '10th_original': tenthStudyReceived == null ? yesNo : tenthStudyReceived ? 'Yes' : 'No',
  };
};
/**
 * Resolve secondary `colleges` row from a managed (secondary) `courses.id`.
 * @returns {Promise<{ collegeId: number|null, collegeName: string|null }>}
 */
export const resolveSecondaryCollegeFromManagedCourseId = async (secondaryPool, courseIdRaw) => {
  const courseId = Number.parseInt(String(courseIdRaw ?? '').trim(), 10);
  if (!Number.isFinite(courseId)) return { collegeId: null, collegeName: null };

  const [courseRows] = await secondaryPool.execute(
    'SELECT college_id FROM courses WHERE id = ? LIMIT 1',
    [courseId]
  );
  if (!courseRows.length || courseRows[0].college_id == null) {
    return { collegeId: null, collegeName: null };
  }

  const collegeId = Number.parseInt(String(courseRows[0].college_id), 10);
  if (!Number.isFinite(collegeId)) return { collegeId: null, collegeName: null };

  const [collegeRows] = await secondaryPool.execute(
    'SELECT name FROM colleges WHERE id = ? LIMIT 1',
    [collegeId]
  );
  const collegeName =
    collegeRows.length > 0 && collegeRows[0].name != null
      ? String(collegeRows[0].name).trim() || null
      : null;
  return { collegeId, collegeName };
};

const isUuidLike = (value) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value ?? '').trim());

/** @see resolveExpectedBatchYear — respects B.Tech lateral (2026 admission no, 2025 batch). */
export const resolveSecondaryStudentBatch = (registrationExtras, admissionNumber) => {
  const lateral =
    isLateralRegistrationExtras(registrationExtras, admissionNumber) ||
    /lateral/i.test(
      String(registrationExtras?.student_status ?? registrationExtras?.studentStatus ?? '').trim()
    );
  const expected = resolveExpectedBatchYear(registrationExtras, admissionNumber);

  if (lateral && expected && !isUuidLike(expected) && /^(19|20)\d{2}$/.test(expected)) {
    return expected;
  }

  const fromBatch =
    registrationExtras?.batch != null && String(registrationExtras.batch).trim() !== ''
      ? String(registrationExtras.batch).trim()
      : null;

  if (fromBatch && !isUuidLike(fromBatch) && /^(19|20)\d{2}$/.test(fromBatch)) {
    if (!expected || fromBatch === expected) return fromBatch;
    if (lateral) return expected;
    return expected;
  }

  if (expected && !isUuidLike(expected)) return expected;
  return null;
};

/**
 * Secondary `students.course` must match catalog names (B.Tech, B.Sc, …) — not UI labels like "B.Tech (LATERAL)".
 */
export const resolveSecondaryCourseNameForSync = async (
  secondaryPool,
  { managedCourseId, courseLabel, registrationExtras, admissionNumber }
) => {
  const courseId = Number.parseInt(
    String(managedCourseId ?? registrationExtras?.managed_course_id ?? '').trim(),
    10
  );
  if (Number.isFinite(courseId)) {
    try {
      const [rows] = await secondaryPool.execute(
        'SELECT name FROM courses WHERE id = ? LIMIT 1',
        [courseId]
      );
      if (rows.length > 0 && rows[0].name != null) {
        const catalogName = String(rows[0].name).trim();
        if (catalogName) return normalizeCourseNameForSecondarySync(catalogName);
      }
    } catch (err) {
      console.warn('[secondary-sync] courses lookup failed:', err?.message || err);
    }
  }

  const raw = String(courseLabel || '').trim();
  const mapped = mapCourseLabel(normalizeCourseNameForSecondarySync(raw));
  return mapped || normalizeCourseNameForSecondarySync(raw) || raw;
};

/**
 * Resolves the branch label for secondary `students.branch` using the managed branch ID.
 * Uses catalog `name` for display when it differs from roll `code` (e.g. DAP not DAPPTV).
 */
const resolveSecondaryBranchLabelForSync = async (
  secondaryPool,
  { managedBranchId, branchLabel, courseLabel }
) => {
  const mappedBranch = mapCourseAndBranch(courseLabel || '', branchLabel || '').branch;
  const branchHint = mappedBranch || branchLabel;

  const branchId = Number.parseInt(String(managedBranchId ?? '').trim(), 10);
  if (Number.isFinite(branchId)) {
    try {
      const [rows] = await secondaryPool.execute(
        'SELECT name, code FROM course_branches WHERE id = ? LIMIT 1',
        [branchId]
      );
      if (rows.length > 0) {
        const catalogLabel = pickSecondaryBranchDisplayLabel(rows[0], branchHint);
        if (catalogLabel) return catalogLabel;
      }
    } catch (err) {
      console.warn('[secondary-sync] course_branches lookup failed:', err?.message || err);
    }
  }
  return String(branchHint || branchLabel || '').trim();
};

export { deriveAdmissionSeriesYear as deriveAdmissionBatchFromNumber } from './lateralBatch.util.js';

const deriveStudTypeFromQuota = (quotaValue, registrationExtras) => {
  const raw =
    quotaValue ??
    registrationExtras?.quota ??
    registrationExtras?.admission_quota ??
    registrationExtras?.quota_type ??
    '';
  const category = classifyAdmissionQuotaCategory(raw);
  if (category) return category;

  const fallback = String(registrationExtras?.data_collection_type ?? '').trim().toUpperCase();
  if (fallback === 'MANG' || fallback === 'MANAGEMENT') return 'MANG';
  if (fallback === 'CONV' || fallback === 'CONVENOR' || fallback === 'CONVENER') return 'CONV';
  if (fallback === 'SPOT') return 'SPOT';
  return null;
};

/**
 * Build JSON for `students.student_data` so legacy consumers (e.g. sibling apps that
 * flatten objects into SQL) do not receive nested `address` objects, which can produce
 * invalid SQL like `student_address = communication = '[object Object]'`.
 */
const buildStudentDataForSecondaryStorage = (
  admissionData,
  admissionNumber,
  extraInfo,
  secondaryStudentStatus,
  normalizedDob,
  certificationCompat,
  managedCollegeId = null
) => {
  const payload = {
    ...admissionData,
    admission_number: admissionNumber,
    admission_date: new Date().toISOString().split('T')[0],
    _lead_id: extraInfo.leadId,
    _joining_id: extraInfo.joiningId,
    _synced_at: new Date().toISOString(),
  };

  const ci = admissionData?.courseInfo;
  if (ci && typeof ci === 'object') {
    if (ci.courseId != null && String(ci.courseId).trim() !== '') {
      payload._crm_managed_course_id = String(ci.courseId).trim();
    }
    if (ci.branchId != null && String(ci.branchId).trim() !== '') {
      payload._crm_managed_branch_id = String(ci.branchId).trim();
    }
  }

  if (managedCollegeId != null && String(managedCollegeId).trim() !== '') {
    payload._crm_managed_college_id = String(managedCollegeId).trim();
  }

  // Never leave primary joining/admission workflow on top-level `status` — other apps treat it like student_status.
  if ('status' in payload) {
    const raw = payload.status;
    const s = String(raw ?? '').trim().toLowerCase();
    if (s === 'active' || s === 'withdrawn' || s === 'admission cancelled') {
      payload.admission_status = raw;
    }
    delete payload.status;
  }
  payload.student_status = secondaryStudentStatus;
  payload.dob = normalizedDob || '';
  Object.assign(payload, certificationCompat || {});

  /** Registration extras sometimes copy joining workflow into `student_status` — strip from JSON blob. */
  const stripWorkflowStudentStatus = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    const v = String(obj.student_status ?? '').trim().toLowerCase();
    const joiningLike = new Set(['draft', 'pending_approval', 'approved']);
    if (joiningLike.has(v)) delete obj.student_status;
  };
  stripWorkflowStudentStatus(payload.registrationFormData);
  if (payload.leadData && typeof payload.leadData === 'object') {
    stripWorkflowStudentStatus(payload.leadData._joiningRegistrationExtras);
  }

  if (payload?.studentInfo && typeof payload.studentInfo === 'object') {
    payload.studentInfo = {
      ...payload.studentInfo,
      dateOfBirth: normalizedDob || payload.studentInfo.dateOfBirth || '',
    };
  }

  const comm = admissionData?.address?.communication;
  const lineParts = [
    comm?.doorOrStreet,
    comm?.landmark,
    comm?.villageOrCity,
    comm?.mandal,
    comm?.district,
    comm?.state,
    comm?.pinCode,
  ]
    .map((p) => (p == null ? '' : String(p).trim()))
    .filter(Boolean);
  const fullAddressLine = lineParts.join(', ').trim();

  delete payload.address;
  if (fullAddressLine) {
    payload.student_address = fullAddressLine;
  }

  return { payload, studentAddressLine: fullAddressLine };
};

/** Remove base64 photo blobs from JSON — photos live in dedicated `students` columns. */
const stripHeavyMediaFromStudentDataPayload = (payload) => {
  if (!payload || typeof payload !== 'object') return payload;
  const walk = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    for (const key of Object.keys(obj)) {
      const val = obj[key];
      if (typeof val === 'string' && val.startsWith('data:image') && val.length > 256) {
        delete obj[key];
      } else if (val && typeof val === 'object') {
        walk(val);
      }
    }
  };
  walk(payload);
  return payload;
};

const STUDENT_PORTAL_PASSWORD_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Six-character portal password (no ambiguous 0/O or 1/I). */
export const generateStudentPortalPassword = () => {
  let password = '';
  for (let i = 0; i < 6; i += 1) {
    password += STUDENT_PORTAL_PASSWORD_CHARS[crypto.randomInt(STUDENT_PORTAL_PASSWORD_CHARS.length)];
  }
  return password;
};

/**
 * Map CRM qualification merit (boolean / 0|1 / yes|no) → secondary `student_merit_status.merit_status`.
 * @returns {'yes'|'no'|null} null when value is absent / unknown (caller may skip write)
 */
export const mapQualificationMeritToSecondaryStatus = (merit) => {
  if (merit === undefined || merit === null || merit === '') return null;
  if (merit === true || merit === 1 || merit === '1') return 'yes';
  if (merit === false || merit === 0 || merit === '0') return 'no';
  const s = String(merit).trim().toLowerCase();
  if (s === 'yes' || s === 'y' || s === 'true') return 'yes';
  if (s === 'no' || s === 'n' || s === 'false') return 'no';
  return null;
};

/**
 * Upsert secondary `student_merit_status` for (student_id, student_year).
 * Does not overwrite `remarks`.
 *
 * @returns {Promise<{ action: 'inserted'|'updated'|'unchanged'|'skipped', previous: string|null, next: string|null }>}
 */
export const upsertStudentMeritStatus = async (
  secondaryPool,
  { studentId, studentYear, meritStatus }
) => {
  const sid = Number.parseInt(String(studentId ?? ''), 10);
  const year = Number.parseInt(String(studentYear ?? ''), 10);
  const next = mapQualificationMeritToSecondaryStatus(meritStatus);
  if (!Number.isFinite(sid) || sid <= 0) {
    return { action: 'skipped', previous: null, next };
  }
  if (!Number.isFinite(year) || year < 1 || year > 12) {
    return { action: 'skipped', previous: null, next };
  }
  if (next !== 'yes' && next !== 'no') {
    return { action: 'skipped', previous: null, next: null };
  }

  const meritCols = await getTableColumnSet(secondaryPool, 'student_merit_status');
  if (
    !meritCols.has('student_id') ||
    !meritCols.has('student_year') ||
    !meritCols.has('merit_status')
  ) {
    return { action: 'skipped', previous: null, next };
  }

  const [existing] = await secondaryPool.execute(
    `SELECT id, merit_status FROM student_merit_status
     WHERE student_id = ? AND student_year = ?
     LIMIT 1`,
    [sid, year]
  );

  if (existing.length === 0) {
    await secondaryPool.execute(
      `INSERT INTO student_merit_status (student_id, student_year, merit_status, created_at, updated_at)
       VALUES (?, ?, ?, NOW(), NOW())`,
      [sid, year, next]
    );
    return { action: 'inserted', previous: null, next };
  }

  const previous = existing[0].merit_status == null ? null : String(existing[0].merit_status);
  if (previous === next) {
    return { action: 'unchanged', previous, next };
  }

  await secondaryPool.execute(
    `UPDATE student_merit_status
     SET merit_status = ?, updated_at = NOW()
     WHERE student_id = ? AND student_year = ?`,
    [next, sid, year]
  );
  return { action: 'updated', previous, next };
};

/**
 * Resolve CRM merit from formatted admission / joining payload and upsert secondary row.
 */
export const syncStudentMeritStatusFromAdmission = async (
  secondaryPool,
  { studentId, studentYear, admissionData }
) => {
  const merit =
    admissionData?.qualifications?.merit !== undefined
      ? admissionData.qualifications.merit
      : admissionData?.qualification_merit;
  return upsertStudentMeritStatus(secondaryPool, {
    studentId,
    studentYear,
    meritStatus: merit,
  });
};

/**
 * Ensure SDMS `student_credentials` row exists (username = admission number).
 * @returns {Promise<{ credentialsCreated: boolean, plainPassword: string|null }>}
 */
export const ensureSecondaryStudentCredentials = async (
  secondaryPool,
  studentId,
  admissionNumber
) => {
  const safeAdmissionNumber = String(admissionNumber || '').trim();
  if (!safeAdmissionNumber || !studentId) {
    return { credentialsCreated: false, plainPassword: null };
  }

  const [existing] = await secondaryPool.execute(
    'SELECT id FROM student_credentials WHERE admission_number = ? LIMIT 1',
    [safeAdmissionNumber]
  );
  if (existing.length > 0) {
    return { credentialsCreated: false, plainPassword: null };
  }

  const plainPassword = generateStudentPortalPassword();
  const passwordHash = await bcrypt.hash(plainPassword, 10);
  await secondaryPool.execute(
    `INSERT INTO student_credentials (
      student_id, admission_number, username, password_hash, created_at, updated_at
    ) VALUES (?, ?, ?, ?, NOW(), NOW())`,
    [studentId, safeAdmissionNumber, safeAdmissionNumber, passwordHash]
  );
  console.log(
    `[secondary-sync] Created student portal credentials for ${safeAdmissionNumber}`
  );
  return { credentialsCreated: true, plainPassword };
};

/**
 * Sync admission/student data to secondary database
 * @param {Object} admissionData - Formatted admission/joining data
 * @param {string} [admissionNumber] - The student's admission number (falls back to admissionData / leadData)
 * @param {Object} [extraInfo] - Optional extra info like lead email, joining id
 * @returns {Promise<{ ok: boolean, credentialsCreated?: boolean, plainPassword?: string|null }>}
 */
export const syncToSecondaryDatabase = async (admissionData, admissionNumber, extraInfo = {}) => {
  const toTrim = (v) => {
    if (v === undefined || v === null) return '';
    return String(v).trim();
  };

  let resolvedAdmissionNumber = toTrim(admissionNumber);
  if (!resolvedAdmissionNumber) {
    resolvedAdmissionNumber = toTrim(admissionData?.admissionNumber);
  }
  if (!resolvedAdmissionNumber && admissionData?.leadData && typeof admissionData.leadData === 'object') {
    resolvedAdmissionNumber = toTrim(
      admissionData.leadData.admission_number ?? admissionData.leadData.admissionNumber
    );
  }

  if (!resolvedAdmissionNumber) {
    console.warn('[secondary-sync] skipped: missing admission number on admission payload');
    return { ok: false };
  }

  try {
    const secondaryPool = getSecondaryPool();
    const joiningExtras =
      admissionData?.leadData &&
      typeof admissionData.leadData === 'object' &&
      admissionData.leadData._joiningRegistrationExtras &&
      typeof admissionData.leadData._joiningRegistrationExtras === 'object'
        ? admissionData.leadData._joiningRegistrationExtras
        : {};
    const regFormExtras =
      admissionData?.registrationFormData &&
      typeof admissionData.registrationFormData === 'object'
        ? admissionData.registrationFormData
        : {};
    const leadDataForExtras =
      admissionData?.leadData && typeof admissionData.leadData === 'object'
        ? admissionData.leadData
        : {};
    const registrationExtras = enrichRegistrationExtrasWithFeeDetails(
      { ...joiningExtras, ...regFormExtras },
      leadDataForExtras
    );
    for (const key of [
      'semester',
      'current_semester',
      'currentSemester',
      'semister',
      'current_year',
      'currentYear',
    ]) {
      if (!String(registrationExtras[key] ?? '').trim() && joiningExtras[key]) {
        registrationExtras[key] = joiningExtras[key];
      }
    }

    const toText = (value) => {
      if (value === undefined || value === null) return '';
      return String(value).trim();
    };
    const toNullableText = (value) => {
      const text = toText(value);
      return text || null;
    };
    const parseCurrentYear = (value) => {
      const parsed = Number.parseInt(String(value ?? '').trim(), 10);
      if (!Number.isFinite(parsed)) return null;
      if (parsed < 1 || parsed > 12) return null;
      return parsed;
    };

    const reservationGeneral = toText(admissionData?.reservation?.general);
    const reservationMeta =
      admissionData?.leadData &&
      typeof admissionData.leadData === 'object' &&
      admissionData.leadData._joiningReservation &&
      typeof admissionData.leadData._joiningReservation === 'object'
        ? admissionData.leadData._joiningReservation
        : {};
    const resolvedCasteFields = await resolveSecondaryStudentCasteFields({
      general: reservationGeneral,
      categoryId:
        admissionData?.reservation?.categoryId ?? reservationMeta.categoryId ?? null,
      casteId: admissionData?.reservation?.casteId ?? reservationMeta.casteId ?? null,
    });
    const secondaryCaste = resolvedCasteFields.caste;
    const secondaryCategoryId = resolvedCasteFields.categoryId;
    const secondaryCasteId = resolvedCasteFields.casteId;
    const courseLabelRaw = admissionData?.courseInfo?.course || '';
    const courseLabelNorm = normalizeCourseNameForSecondarySync(courseLabelRaw);
    const isDegreeProgram =
      /^degree$/i.test(String(courseLabelRaw).trim()) ||
      /^b\.?\s*sc$/i.test(courseLabelNorm);
    const lateralSignals =
      isLateralRegistrationExtras(registrationExtras, resolvedAdmissionNumber) ||
      /lateral/i.test(
        String(registrationExtras?.student_status ?? registrationExtras?.studentStatus ?? '').trim()
      ) ||
      /lateral/i.test(String(admissionData?.courseInfo?.quota ?? '').trim()) ||
      /\(lateral\)/i.test(String(courseLabelRaw));
    const btechLateralForSync = isBtechCourseName(courseLabelNorm) && lateralSignals && !isDegreeProgram;

    let currentYearFromExtras =
      resolveSecondaryYearOfStudy(registrationExtras) ??
      parseCurrentYear(registrationExtras?.current_year) ??
      parseCurrentYear(registrationExtras?.currentYear);
    const resolvedSemester = resolveSecondarySemesterForSync(
      registrationExtras,
      resolvedAdmissionNumber,
      courseLabelRaw
    );
    if (currentYearFromExtras == null && resolvedSemester) {
      currentYearFromExtras = resolveSecondaryYearOfStudy({
        semester: resolvedSemester,
        current_semester: resolvedSemester,
      });
    }
    const isDiplomaProgram =
      /^diploma/i.test(courseLabelNorm) ||
      /^d\.pharm/i.test(courseLabelNorm) ||
      /^d\.ed/i.test(courseLabelNorm);
    if (isDegreeProgram) {
      currentYearFromExtras = currentYearFromExtras ?? 1;
    } else if (isDiplomaProgram && currentYearFromExtras == null) {
      currentYearFromExtras = 1;
    } else if (currentYearFromExtras == null && btechLateralForSync) {
      currentYearFromExtras = 2;
    }
    const parsedSemesterColumns = parseSemesterForSecondaryColumns(resolvedSemester);
    if (parsedSemesterColumns.yearOfStudy != null) {
      currentYearFromExtras = parsedSemesterColumns.yearOfStudy;
    }
    const currentSemesterColumn = parsedSemesterColumns.semesterInYear;
    const certificatesStatus = deriveCertificatesStatus(registrationExtras);
    const secondaryStudentStatus = deriveSecondaryStudentStatus(
      admissionData?.status,
      registrationExtras
    );
    const studType = deriveStudTypeFromQuota(
      admissionData?.courseInfo?.quota || admissionData?.leadData?.quota,
      registrationExtras
    );
    let resolvedBatch = isDegreeProgram
      ? deriveAdmissionSeriesYear(resolvedAdmissionNumber) || '2026'
      : resolveSecondaryStudentBatch(registrationExtras, resolvedAdmissionNumber);
    const normalizedDob = normalizeDobForSecondary(admissionData?.studentInfo?.dateOfBirth);
    const certificationCompat = deriveCertificationDialogCompat(certificatesStatus, registrationExtras);

    const collegeIdRaw =
      registrationExtras?.college_id ??
      registrationExtras?.collegeId ??
      registrationExtras?.school_or_college_id ??
      registrationExtras?.schoolOrCollegeId;
    let resolvedCollegeId = null;
    let resolvedCollegeName = null;
    if (collegeIdRaw !== undefined && collegeIdRaw !== null && String(collegeIdRaw).trim() !== '') {
      const collegeId = Number.parseInt(String(collegeIdRaw), 10);
      if (Number.isFinite(collegeId)) {
        resolvedCollegeId = collegeId;
        const [collegeRows] = await secondaryPool.execute(
          'SELECT name FROM colleges WHERE id = ? LIMIT 1',
          [collegeId]
        );
        if (collegeRows.length > 0) {
          resolvedCollegeName = toNullableText(collegeRows[0].name);
        }
      }
    }

    const managedCourseIdForCollege =
      admissionData?.courseInfo?.courseId ??
      registrationExtras?.managed_course_id ??
      registrationExtras?.managedCourseId;
    if (!resolvedCollegeName && managedCourseIdForCollege) {
      const fromCourse = await resolveSecondaryCollegeFromManagedCourseId(
        secondaryPool,
        managedCourseIdForCollege
      );
      if (fromCourse.collegeName) {
        resolvedCollegeName = fromCourse.collegeName;
        resolvedCollegeId = fromCourse.collegeId;
      }
    }

    // Check if student exists
    const [existingStudents] = await secondaryPool.execute(
      'SELECT id FROM students WHERE admission_number = ?',
      [resolvedAdmissionNumber]
    );

    const resolvedSecondaryCourse = await resolveSecondaryCourseNameForSync(secondaryPool, {
      managedCourseId:
        admissionData?.courseInfo?.courseId ??
        registrationExtras?.managed_course_id ??
        registrationExtras?.managedCourseId,
      courseLabel: admissionData?.courseInfo?.course || '',
      registrationExtras,
      admissionNumber: resolvedAdmissionNumber,
    });

    const resolvedSecondaryBranch = await resolveSecondaryBranchLabelForSync(secondaryPool, {
      managedBranchId:
        admissionData?.courseInfo?.branchId ??
        registrationExtras?.managed_branch_id ??
        registrationExtras?.managedBranchId,
      branchLabel: admissionData?.courseInfo?.branch || '',
      courseLabel: admissionData?.courseInfo?.course || courseLabelRaw,
    });

    const { payload: studentDataSecondary, studentAddressLine } = buildStudentDataForSecondaryStorage(
      admissionData,
      resolvedAdmissionNumber,
      extraInfo,
      secondaryStudentStatus,
      normalizedDob,
      certificationCompat,
      resolvedCollegeId
    );
    if (resolvedSemester) {
      studentDataSecondary.semester = resolvedSemester;
      studentDataSecondary.current_semester = resolvedSemester;
    }
    if (resolvedBatch) {
      studentDataSecondary.batch = resolvedBatch;
      studentDataSecondary.academic_year = resolvedBatch;
    }
    if (btechLateralForSync) {
      const seriesYear = deriveAdmissionSeriesYear(resolvedAdmissionNumber);
      if (seriesYear) {
        studentDataSecondary._lateral_intake_year = String(Number(seriesYear) - 1);
      }
      if (!studentDataSecondary.semester) {
        studentDataSecondary.semester = '2-1';
        studentDataSecondary.current_semester = '2-1';
      }
      if (studentDataSecondary.current_year == null) {
        studentDataSecondary.current_year = 2;
        studentDataSecondary.currentYear = 2;
      }
    }
    if (studType) {
      studentDataSecondary.stud_type = studType;
      if (studentDataSecondary.courseInfo && typeof studentDataSecondary.courseInfo === 'object') {
        studentDataSecondary.courseInfo = {
          ...studentDataSecondary.courseInfo,
          quota:
            admissionData?.courseInfo?.quota ||
            admissionData?.leadData?.quota ||
            studentDataSecondary.courseInfo.quota ||
            '',
        };
      }
    }
    studentDataSecondary._crm_secondary_course = resolvedSecondaryCourse;
    stripHeavyMediaFromStudentDataPayload(studentDataSecondary);

    const portraitsFromReg = extractPortraitPhotosFromRegistrationFormData(registrationExtras);
    const studentPhotoExtracted =
      preferIntactPortraitPhoto(
        admissionData?.studentInfo?.photo,
        portraitsFromReg.studentPhoto
      ) || null;
    const fatherPhotoExtracted =
      preferIntactPortraitPhoto(
        admissionData?.parents?.father?.photo,
        portraitsFromReg.fatherPhoto
      ) || null;
    const motherPhotoExtracted =
      preferIntactPortraitPhoto(
        admissionData?.parents?.mother?.photo,
        portraitsFromReg.motherPhoto
      ) || null;

    const preferredMobileForSecondary = (() => {
      const preferred = String(admissionData.studentInfo?.preferredMobileNumber ?? '')
        .replace(/\D/g, '')
        .slice(-10);
      if (preferred.length === 10) return preferred;
      const student = String(admissionData.studentInfo?.phone ?? '')
        .replace(/\D/g, '')
        .slice(-10);
      return student.length === 10 ? student : null;
    })();

    const studentCols = await getTableColumnSet(secondaryPool, 'students');
    const hasCategoryIdColumn = studentCols.has('category_id');
    const hasCasteIdColumn = studentCols.has('caste_id');
    const hasCollegeIdColumn = studentCols.has('college_id');
    const hasCourseIdColumn = studentCols.has('course_id');
    const hasBranchIdColumn = studentCols.has('branch_id');
    const hasIsScholarApplicableColumn = studentCols.has('is_scholar_applicable');

    const casteWriteColumns = ['caste'];
    const casteWriteValues = [secondaryCaste];
    if (hasCategoryIdColumn) {
      casteWriteColumns.push('category_id');
      casteWriteValues.push(secondaryCategoryId);
    }
    if (hasCasteIdColumn) {
      casteWriteColumns.push('caste_id');
      casteWriteValues.push(secondaryCasteId);
    }
    if (hasCollegeIdColumn) {
      casteWriteColumns.push('college_id');
      casteWriteValues.push(resolvedCollegeId ?? null);
    }
    if (hasCourseIdColumn) {
      casteWriteColumns.push('course_id');
      const mcid = Number.parseInt(String(managedCourseIdForCollege ?? '').trim(), 10);
      casteWriteValues.push(Number.isFinite(mcid) ? mcid : null);
    }
    if (hasBranchIdColumn) {
      casteWriteColumns.push('branch_id');
      const mbid = Number.parseInt(String(admissionData?.courseInfo?.branchId ?? registrationExtras?.managed_branch_id ?? registrationExtras?.managedBranchId ?? '').trim(), 10);
      casteWriteValues.push(Number.isFinite(mbid) ? mbid : null);
    }
    if (hasIsScholarApplicableColumn) {
      casteWriteColumns.push('is_scholar_applicable');
      casteWriteValues.push(admissionData?.studentInfo?.isScholarApplicable ? 1 : 0);
    }

    const studentCoreParams = [
      resolvedAdmissionNumber,
      resolvedAdmissionNumber,
      admissionData.studentInfo?.name || '',
      admissionData.studentInfo?.phone || '',
      normalizedDob,
      admissionData.studentInfo?.aadhaarNumber || '',
      admissionData.parents?.father?.name || '',
      admissionData.parents?.father?.phone || '',
      extraInfo.email || '',
      resolvedSecondaryCourse,
      resolvedSecondaryBranch,
      admissionData.studentInfo?.gender || '',
      admissionData.address?.communication?.villageOrCity || '',
      admissionData.address?.communication?.mandal || '',
      admissionData.address?.communication?.district || '',
      // `pin_no` is institutional student PIN in SDMS — not address postal pinCode.
      null,
      studentAddressLine ||
        `${admissionData.address?.communication?.doorOrStreet || ''}, ${admissionData.address?.communication?.landmark || ''}`.trim(),
      JSON.stringify(studentDataSecondary),
      admissionData.parents?.mother?.phone || '',
      preferredMobileForSecondary,
      toNullableText(resolvedBatch),
      resolvedCollegeName ||
        toNullableText(registrationExtras?.school_or_college_name) ||
        toNullableText(registrationExtras?.college),
      studType,
      toNullableText(registrationExtras?.scholar_status),
    ];

    const studentTailParams = [
      toNullableText(admissionData?.remarks ?? registrationExtras?.remarks),
      toNullableText(registrationExtras?.previous_college),
      certificatesStatus,
      normalizeStudentPhotoForSecondary(studentPhotoExtracted),
      normalizeStudentPhotoForSecondary(fatherPhotoExtracted),
      normalizeStudentPhotoForSecondary(motherPhotoExtracted),
      currentYearFromExtras,
      currentSemesterColumn,
      new Date().toISOString().split('T')[0],
      secondaryStudentStatus,
    ];

    const studentParams = [...studentCoreParams, ...casteWriteValues, ...studentTailParams];
    const casteUpdateSql = casteWriteColumns.map((col) => `${col} = ?`).join(',\n          ');
    const casteInsertColsSql = casteWriteColumns.join(',\n          ');
    const casteInsertPlaceholders = casteWriteColumns.map(() => '?').join(', ');

    if (existingStudents.length > 0) {
      await secondaryPool.execute(
        `UPDATE students SET
          student_name = ?,
          student_mobile = ?,
          dob = ?,
          adhar_no = ?,
          father_name = ?,
          parent_mobile1 = ?,
          email = ?,
          course = ?,
          branch = ?,
          gender = ?,
          city_village = ?,
          mandal_name = ?,
          district = ?,
          pin_no = ?,
          student_address = ?,
          student_data = ?,
          parent_mobile2 = ?,
          preferred_mobile_number = ?,
          batch = ?,
          college = ?,
          stud_type = ?,
          scholar_status = ?,
          ${casteUpdateSql},
          remarks = ?,
          previous_college = ?,
          certificates_status = ?,
          student_photo = ?,
          father_photo = ?,
          mother_photo = ?,
          current_year = COALESCE(?, current_year),
          current_semester = COALESCE(?, current_semester),
          updated_at = NOW(),
          admission_date = ?,
          student_status = ?
        WHERE admission_number = ?`,
        [...studentParams.slice(2), resolvedAdmissionNumber]
      );
      console.log(`Synced update for student ${resolvedAdmissionNumber} to secondary DB`);
    } else {
      await secondaryPool.execute(
        `INSERT INTO students (
          admission_number,
          admission_no,
          student_name,
          student_mobile,
          dob,
          adhar_no,
          father_name,
          parent_mobile1,
          email,
          course,
          branch,
          gender,
          city_village,
          mandal_name,
          district,
          pin_no,
          student_address,
          student_data,
          parent_mobile2,
          preferred_mobile_number,
          batch,
          college,
          stud_type,
          scholar_status,
          ${casteInsertColsSql},
          remarks,
          previous_college,
          certificates_status,
          student_photo,
          father_photo,
          mother_photo,
          current_year,
          current_semester,
          created_at,
          updated_at,
          admission_date,
          student_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${casteInsertPlaceholders}, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), ?, ?)`,
        studentParams
      );
      console.log(`Synced new student ${resolvedAdmissionNumber} to secondary DB`);
    }

    const [studentIdRows] = await secondaryPool.execute(
      'SELECT id, current_year FROM students WHERE admission_number = ? LIMIT 1',
      [resolvedAdmissionNumber]
    );
    const studentId = studentIdRows[0]?.id;
    const studentYearForMerit =
      currentYearFromExtras ??
      (() => {
        const y = Number.parseInt(String(studentIdRows[0]?.current_year ?? '').trim(), 10);
        return Number.isFinite(y) && y >= 1 && y <= 12 ? y : 1;
      })();

    let meritStatusResult = null;
    if (studentId) {
      try {
        meritStatusResult = await syncStudentMeritStatusFromAdmission(secondaryPool, {
          studentId,
          studentYear: studentYearForMerit,
          admissionData,
        });
        if (meritStatusResult?.action === 'inserted' || meritStatusResult?.action === 'updated') {
          console.log(
            `[secondary-sync] merit ${meritStatusResult.action} for ${resolvedAdmissionNumber} ` +
              `(student_id=${studentId}, year=${studentYearForMerit}): ` +
              `${meritStatusResult.previous ?? '∅'} → ${meritStatusResult.next}`
          );
        }
      } catch (meritErr) {
        console.error(
          `[secondary-sync] merit status sync failed for ${resolvedAdmissionNumber}:`,
          meritErr?.message || meritErr
        );
      }
    }

    const credentialResult = studentId
      ? await ensureSecondaryStudentCredentials(
          secondaryPool,
          studentId,
          resolvedAdmissionNumber
        )
      : { credentialsCreated: false, plainPassword: null };

    let rollNumberResult = null;
    if (studentId && isRollEligibleAdmissionNumber(resolvedAdmissionNumber)) {
      try {
        const admissionStatus = admissionData?.status ?? null;
        if (isAdmissionCancelledStatus(admissionStatus)) {
          rollNumberResult = await revokeStudentRollNumber(secondaryPool, {
            studentId,
            admissionNumber: resolvedAdmissionNumber,
          });
        } else {
          const managedBranchIdForRoll =
            admissionData?.courseInfo?.branchId ??
            registrationExtras?.managed_branch_id ??
            registrationExtras?.managedBranchId;
          const branchScope = resolveBranchScope({
            managedBranchId: managedBranchIdForRoll,
            branchLabel: resolvedSecondaryBranch,
          });
          let forceRoll = Boolean(extraInfo.reconcileRollNumber);
          if (!forceRoll) {
            const [rollRows] = await secondaryPool.execute(
              `SELECT branch_scope, roll_number FROM student_roll_numbers WHERE student_id = ? LIMIT 1`,
              [studentId]
            );
            if (
              rollRows.length > 0 &&
              rollRows[0].branch_scope &&
              rollRows[0].branch_scope !== branchScope
            ) {
              forceRoll = true;
            }
          }

          rollNumberResult = await assignStudentRollNumber(secondaryPool, {
            studentId,
            admissionNumber: resolvedAdmissionNumber,
            admissionStatus,
            managedBranchId: managedBranchIdForRoll,
            branchLabel: resolvedSecondaryBranch,
            batch: resolvedBatch,
            force: forceRoll,
          });
        }
      } catch (rollErr) {
        console.error(
          `[student-roll] assignment failed for ${resolvedAdmissionNumber}:`,
          rollErr?.message || rollErr
        );
      }
    }

    const feeManagementStudentFeeSync = await syncStudentFeesToFeeManagement(resolvedAdmissionNumber);

    return {
      ok: true,
      ...credentialResult,
      rollNumber: rollNumberResult?.roll_number ?? null,
      feeManagementStudentFeeSync,
      meritStatus: meritStatusResult,
    };
  } catch (error) {
    console.error('Secondary DB sync failed:', error);
    return { ok: false };
  }
};

/** Normalize legacy boolean return from `syncToSecondaryDatabase`. */
export const isSecondarySyncOk = (result) => {
  if (result === true) return true;
  if (result === false) return false;
  return Boolean(result?.ok);
};

/** Call after `syncToSecondaryDatabase`; logs when sync was skipped or secondary DB failed (primary already committed). */
export const warnIfSecondaryStudentSyncMissed = (context, meta, result) => {
  if (!isSecondarySyncOk(result)) {
    console.warn(`[secondary-sync] Student table sync did not complete (${context})`, meta);
  }
};














