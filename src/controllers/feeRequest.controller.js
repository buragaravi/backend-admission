import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../config-sql/database.js';
import { getPool as getSecondaryPool } from '../config-sql/database-secondary.js';
import { successResponse, errorResponse } from '../utils/response.util.js';
import {
  syncJoiningStudentFeeDetailsToFeeMongo,
  buildJoiningStepFourSyncPlan,
} from '../services/joiningStudentFeeMongoSync.service.js';
import { normalizeCalendarAcademicYear } from '../utils/transportApplicationNumber.util.js';
import { deriveAdmissionSeriesYear } from '../utils/lateralBatch.util.js';
import {
  canApproveFeeRequest,
  canSubmitFeeRequest,
} from '../utils/joiningPermissions.util.js';
import {
  buildOverallConcessionLinesFromBuilder,
  buildOverallConcessionLinesFromPortalLines,
  getMissingBuilderHeadYearAmounts,
  isPersistableBuilderConcessionLine,
  normalizeStudentFeeDetails,
  resolveFeeHead,
  normalizeFeeHeadInEntries,
} from '../utils/overallConcessions.util.js';
import { connectFeeManagement } from '../config-mongo/feeManagement.js';

/**
 * Mirror a fee request into the Fee Management Mongo OverallConcessionRequest collection.
 * Creates a PENDING document when one doesn't exist; updates/replaces concessions when one does.
 * This is fire-and-forget — failures are logged but do not fail the primary SQL save.
 *
 * The concessionType stored in Fee Mongo uses 'REVISED' (not 'REVISED_FEE') to match the
 * existing OverallConcessionRequest schema enum.
 */
const syncRequestToFeeManagementMongo = async ({
  admissionNumber,
  studentName,
  pinNo,
  college,
  course,
  branch,
  batch,
  studentFeeDetails,
  requestedBy,
  requestedByName,
}) => {
  try {
    const conn = await connectFeeManagement();

    // Build concession entries from studentFeeDetails builder lines
    const linesIn = Array.isArray(studentFeeDetails?.lines) ? studentFeeDetails.lines : [];
    const concessions = linesIn
      .filter((line) => isPersistableBuilderConcessionLine(line))
      .map((line) => ({
        feeHeadId:      String(line.feeHeadId || '').trim(),
        feeHeadCode:    String(line.feeHeadCode || '').trim(),
        studentYear:    Number(line.studentYear) || 1,
        semester:       line.semester != null ? Number(line.semester) || null : null,
        amount:         Number(line.amount) || 0,
        // Fee Mongo schema uses 'REVISED' not 'REVISED_FEE'
        concessionType: line.concessionType === 'REVISED_FEE' ? 'REVISED' : 'CONCESSION',
      }))
      .filter((e) => e.feeHeadId && e.amount > 0);

    if (concessions.length === 0) return;

    const collection = conn.db.collection('overallconcessionrequests');

    // Check for an existing PENDING document for this student
    const existing = await collection.findOne({ admissionNumber, status: 'PENDING' });

    if (existing) {
      // Merge: same feeHeadId + studentYear + semester replaces, new entries are added
      const mergedMap = {};
      (existing.concessions || []).forEach((e) => {
        mergedMap[`${e.feeHeadId}_${e.studentYear}_${e.semester ?? 'null'}`] = e;
      });
      concessions.forEach((e) => {
        mergedMap[`${e.feeHeadId}_${e.studentYear}_${e.semester ?? 'null'}`] = e;
      });

      await collection.updateOne(
        { _id: existing._id },
        {
          $set: {
            concessions:     Object.values(mergedMap),
            studentName:     studentName || existing.studentName,
            pinNo:           pinNo || existing.pinNo,
            batch:           batch || existing.batch,
            requestedBy:     requestedBy || existing.requestedBy,
            requestedByName: requestedByName || existing.requestedByName,
            updatedAt:       new Date(),
          },
        }
      );
      console.log(`[FeeRequestMongo] Updated PENDING OverallConcessionRequest for ${admissionNumber}`);
    } else {
      // Create new PENDING document
      const now = new Date();
      await collection.insertOne({
        admissionNumber,
        studentName:     studentName || '',
        pinNo:           pinNo || '-',
        college:         college || '',
        course:          course || '',
        branch:          branch || '',
        batch:           batch || '',
        category:        'Regular',
        concessions,
        status:          'PENDING',
        requestedBy:     requestedBy || 'admissions',
        requestedByName: requestedByName || '',
        approvedBy:      '',
        approvedByName:  '',
        concessionGivenBy: '',
        rejectionReason: '',
        createdAt:       now,
        updatedAt:       now,
      });
      console.log(`[FeeRequestMongo] Created PENDING OverallConcessionRequest for ${admissionNumber}`);
    }
  } catch (err) {
    console.error('[FeeRequestMongo] Failed to sync to Fee Management Mongo:', err?.message || err);
  }
};

const sanitizeStudentFeeDetailsForDb = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  const batch =
    raw.batch != null && String(raw.batch).trim() !== ''
      ? String(raw.batch).trim().slice(0, 32)
      : undefined;
  const linesIn = Array.isArray(raw.lines) ? raw.lines : [];
  const lines = linesIn
    .map((line) => {
      const structureId = String(line?.structureId ?? '').trim();
      if (!structureId) return null;
      let amount = null;
      if (line?.amount !== undefined && line?.amount !== null && line?.amount !== '') {
        const n = Number(line.amount);
        if (Number.isFinite(n) && n >= 0) amount = n;
      }
      const remarks = typeof line?.remarks === 'string' ? line.remarks.trim().slice(0, 2000) : '';
      const rawConcessionType = String(line?.concessionType || '').trim().toUpperCase();
      const concessionType =
        rawConcessionType === 'CONCESSION' || rawConcessionType === 'REVISED_FEE'
          ? rawConcessionType
          : undefined;

      const feeHeadId = line?.feeHeadId ? String(line.feeHeadId).trim() : undefined;
      const feeHeadCode = line?.feeHeadCode ? String(line.feeHeadCode).trim() : undefined;
      const feeHeadName = line?.feeHeadName ? String(line.feeHeadName).trim() : undefined;
      const studentYear = line?.studentYear != null ? Number(line.studentYear) : undefined;

      const row = {
        structureId,
        amount,
        remarks,
        ...(concessionType ? { concessionType } : {}),
        ...(feeHeadId ? { feeHeadId } : {}),
        ...(feeHeadCode ? { feeHeadCode } : {}),
        ...(feeHeadName ? { feeHeadName } : {}),
        ...(studentYear != null && !Number.isNaN(studentYear) ? { studentYear } : {}),
      };
      return isPersistableBuilderConcessionLine(row) ? row : null;
    })
    .filter(Boolean);
  if (lines.length === 0 && !batch) return null;
  return { ...(batch ? { batch } : {}), lines };
};

const parseLeadData = (raw) => {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) || {};
    } catch {
      return {};
    }
  }
  return typeof raw === 'object' ? raw : {};
};

/**
 * Persist Step 4 builder amounts onto joining (+ linked admission) lead_data when a
 * fee request is submitted. Without this, amounts live only on fee_requests until
 * approve / a separate Save Configuration — so Student Info shows "No Fee Entry".
 * overall_concessions / portal sync still wait for approve.
 */
const persistStudentFeeDetailsToJoiningBuilder = async ({
  pool,
  joiningId,
  joiningRow,
  studentFeeDetails,
  registrationExtras = {},
  userId,
}) => {
  if (!joiningId || !studentFeeDetails) return;

  let leadData = parseLeadData(joiningRow?.lead_data);
  const prevExtras =
    leadData._joiningRegistrationExtras && typeof leadData._joiningRegistrationExtras === 'object'
      ? { ...leadData._joiningRegistrationExtras }
      : {};
  const transportDetails =
    registrationExtras?.transport_details && typeof registrationExtras.transport_details === 'object'
      ? registrationExtras.transport_details
      : null;
  const mergedExtras = {
    ...prevExtras,
    ...(transportDetails ? { transport_details: transportDetails } : {}),
  };

  leadData = {
    ...leadData,
    ...(Object.keys(mergedExtras).length > 0
      ? { _joiningRegistrationExtras: mergedExtras }
      : {}),
    _joiningStudentFeeDetails: studentFeeDetails,
  };

  await pool.execute(
    `UPDATE joinings SET lead_data = ?, updated_by = ?, updated_at = NOW() WHERE id = ?`,
    [JSON.stringify(leadData), userId || null, joiningId]
  );

  const [admRows] = await pool.execute(
    `SELECT id, lead_data FROM admissions WHERE joining_id = ? LIMIT 1`,
    [joiningId]
  );
  if (!admRows.length) return;

  let admLead = parseLeadData(admRows[0].lead_data);
  admLead = {
    ...admLead,
    ...(Object.keys(mergedExtras).length > 0
      ? { _joiningRegistrationExtras: mergedExtras }
      : {}),
    _joiningStudentFeeDetails: studentFeeDetails,
  };
  await pool.execute(
    `UPDATE admissions SET lead_data = ?, updated_by = ?, updated_at = NOW() WHERE id = ?`,
    [JSON.stringify(admLead), userId || null, admRows[0].id]
  );
};

const isProbablyEnquiryNumber = (value) => {
  const v = String(value || '').trim();
  if (!v) return false;
  return /^ENQ/i.test(v);
};

const normalizeAdmissionNumberCandidate = (value) => {
  const v = String(value || '').trim();
  if (!v) return '';
  if (isProbablyEnquiryNumber(v)) return '';
  return v;
};

const resolveJoiningAdmissionNumber = (leadData, registrationExtras) => {
  const fromLead =
    leadData?.admissionNumber ||
    leadData?.admission_number ||
    '';
  const normalizedFromLead = normalizeAdmissionNumberCandidate(fromLead);
  if (normalizedFromLead) return normalizedFromLead;

  const extras =
    (registrationExtras && typeof registrationExtras === 'object' ? registrationExtras : null) ||
    (leadData?._joiningRegistrationExtras &&
    typeof leadData._joiningRegistrationExtras === 'object'
      ? leadData._joiningRegistrationExtras
      : null);
  if (extras) {
    const n = normalizeAdmissionNumberCandidate(extras.admission_number || extras.admissionNumber);
    if (n) return n;
  }
  return '';
};

const buildJoiningFeeSyncContext = (
  joiningRow,
  studentFeeDetails,
  registrationExtras,
  admissionNumber = ''
) => {
  const transportDetails =
    registrationExtras?.transport_details &&
    typeof registrationExtras.transport_details === 'object'
      ? registrationExtras.transport_details
      : null;
  return {
    course: joiningRow?.course || '',
    branch: joiningRow?.branch || '',
    quota: joiningRow?.quota || '',
    studentStatus:
      String(
        registrationExtras?.student_status ??
        registrationExtras?.studentStatus ??
        joiningRow?.student_status ??
        joiningRow?.studentStatus ??
        ''
      ).trim(),
    batch:
      studentFeeDetails?.batch != null && String(studentFeeDetails.batch).trim() !== ''
        ? String(studentFeeDetails.batch).trim()
        : '',
    admissionNumber: admissionNumber || '',
    studentName: joiningRow?.student_name || '',
    studentPhone: joiningRow?.student_phone || '',
    studentGender: joiningRow?.student_gender || '',
    fatherPhone: joiningRow?.father_phone || '',
    managedCourseId:
      joiningRow?.managed_course_id ??
      registrationExtras?.managed_course_id ??
      registrationExtras?.managedCourseId ??
      null,
    collegeId:
      registrationExtras?.college_id ??
      registrationExtras?.collegeId ??
      registrationExtras?.school_or_college_id ??
      registrationExtras?.schoolOrCollegeId ??
      null,
    transportDetails,
    programTotalYears: resolveProgramTotalYearsFromExtras(
      registrationExtras,
      joiningRow?.course || ''
    ),
    intakeBatch: resolveIntakeBatchFromExtras(
      registrationExtras,
      studentFeeDetails,
      admissionNumber
    ),
  };
};

const resolveIntakeBatchFromExtras = (registrationExtras, studentFeeDetails, admissionNumber = '') => {
  const fromFees = normalizeCalendarAcademicYear(studentFeeDetails?.batch ?? '');
  if (fromFees) return fromFees;
  const fromExtras = normalizeCalendarAcademicYear(
    registrationExtras?.academic_year ?? registrationExtras?.academicYear ?? ''
  );
  if (fromExtras) return fromExtras;
  return deriveAdmissionSeriesYear(admissionNumber) || '';
};

const resolveProgramTotalYearsFromExtras = (registrationExtras, course = '') => {
  const normalizedCourse = String(course || '').trim().toLowerCase();
  if (normalizedCourse === 'diploma' || normalizedCourse === 'polytechnic') return 3;
  const raw =
    registrationExtras?.program_total_years ??
    registrationExtras?.programTotalYears ??
    null;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return Math.min(8, Math.trunc(n));
  return 4;
};

const resolveJoiningAdmissionNumberFromDb = async (pool, joining) => {
  const leadData = parseLeadData(joining.lead_data);
  let admissionNumber = resolveJoiningAdmissionNumber(leadData);

  if (!admissionNumber && joining.lead_id) {
    const [leadRows] = await pool.execute(
      'SELECT admission_number FROM leads WHERE id = ? LIMIT 1',
      [joining.lead_id]
    );
    if (leadRows[0]?.admission_number) {
      admissionNumber = normalizeAdmissionNumberCandidate(leadRows[0].admission_number);
    }
  }

  if (!admissionNumber) {
    const [admRows] = await pool.execute(
      'SELECT admission_number FROM admissions WHERE joining_id = ? LIMIT 1',
      [joining.id]
    );
    if (admRows[0]?.admission_number) {
      admissionNumber = normalizeAdmissionNumberCandidate(admRows[0].admission_number);
    }
  }

  return admissionNumber;
};

const formatFeeRequestRow = (row) => ({
  id: row.id,
  joiningId: row.joining_id,
  leadId: row.lead_id,
  admissionNumber: row.admission_number || '',
  studentName: row.student_name || '',
  course: row.course || '',
  branch: row.branch || '',
  batch: row.batch || '',
  status: row.status,
  requestLines:
    typeof row.request_lines === 'string'
      ? JSON.parse(row.request_lines)
      : row.request_lines || [],
  accommodationType: row.accommodation_type || null,
  transportDetails:
    typeof row.transport_details === 'string'
      ? JSON.parse(row.transport_details)
      : row.transport_details || null,
  studentFeeDetails:
    typeof row.student_fee_details === 'string'
      ? JSON.parse(row.student_fee_details)
      : row.student_fee_details || null,
  submittedAt: row.submitted_at,
  submittedBy: row.submitted_by,
  approvedAt: row.approved_at,
  approvedBy: row.approved_by,
  rejectedAt: row.rejected_at,
  rejectedBy: row.rejected_by,
  rejectionReason: row.rejection_reason || '',
  reviewerNote: row.reviewer_note || '',
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const formatFeeRequestRowWithHeads = (row, feeHeads = []) => {
  const formatted = formatFeeRequestRow(row);
  if (!Array.isArray(feeHeads) || feeHeads.length === 0) return formatted;

  if (Array.isArray(formatted.requestLines)) {
    formatted.requestLines = normalizeFeeHeadInEntries(formatted.requestLines, feeHeads);
  }

  if (formatted.studentFeeDetails && Array.isArray(formatted.studentFeeDetails.lines)) {
    formatted.studentFeeDetails.lines = normalizeFeeHeadInEntries(formatted.studentFeeDetails.lines, feeHeads);
  }

  return formatted;
};

/** GET /api/fee-requests?status=pending_approval|approved&page=&limit=&search= */
export const listFeeRequests = async (req, res) => {
  try {
    if (!canApproveFeeRequest(req.user)) {
      return errorResponse(res, 'Not authorized to view fee requests', 403);
    }

    const status = String(req.query.status || 'pending_approval').trim();
    if (!['pending_approval', 'approved', 'rejected'].includes(status)) {
      return errorResponse(res, 'Invalid status filter', 400);
    }

    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '20'), 10) || 20));
    const offset = (page - 1) * limit;
    const search = String(req.query.search || '').trim();

    const pool = getPool();
    const where = ['status = ?'];
    const params = [status];

    if (search) {
      where.push(
        '(student_name LIKE ? OR admission_number LIKE ? OR course LIKE ? OR branch LIKE ?)'
      );
      const like = `%${search}%`;
      params.push(like, like, like, like);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [countRows] = await pool.execute(
      `SELECT COUNT(*) AS total FROM fee_requests ${whereSql}`,
      params
    );
    const total = Number(countRows[0]?.total) || 0;

    const [rows] = await pool.execute(
      `SELECT * FROM fee_requests ${whereSql}
       ORDER BY COALESCE(submitted_at, created_at) DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    let feeHeads = [];
    try {
      const conn = await connectFeeManagement();
      feeHeads = await conn.db.collection('feeheads').find({}).toArray();
    } catch (fhErr) {
      console.warn('Failed to load feeheads for listFeeRequests:', fhErr.message);
    }

    return successResponse(res, {
      feeRequests: rows.map((r) => formatFeeRequestRowWithHeads(r, feeHeads)),
      pagination: {
        page,
        limit,
        total,
        pages: Math.max(1, Math.ceil(total / limit)),
      },
    });
  } catch (error) {
    console.error('listFeeRequests error:', error);
    return errorResponse(res, error.message || 'Failed to list fee requests', 500);
  }
};

/** POST /api/fee-requests/submit */
export const submitFeeRequest = async (req, res) => {
  try {
    if (!canSubmitFeeRequest(req.user)) {
      return errorResponse(res, 'Not authorized to submit fee requests', 403);
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const joiningId = String(body.joiningId || body.joining_id || '').trim();
    if (!joiningId) {
      return errorResponse(res, 'joiningId is required', 400);
    }

    const studentFeeDetails = sanitizeStudentFeeDetailsForDb(body.studentFeeDetails);

    let feeHeads = [];
    try {
      const conn = await connectFeeManagement();
      feeHeads = await conn.db.collection('feeheads').find({}).toArray();
    } catch (fhErr) {
      console.warn('Failed to load feeheads for submitFeeRequest normalization:', fhErr.message);
    }

    if (studentFeeDetails && Array.isArray(studentFeeDetails.lines)) {
      studentFeeDetails.lines = normalizeFeeHeadInEntries(studentFeeDetails.lines, feeHeads);
    }

    const registrationExtras =
      body.registrationFormData && typeof body.registrationFormData === 'object'
        ? body.registrationFormData
        : {};

    const pool = getPool();
    const [joiningRows] = await pool.execute('SELECT * FROM joinings WHERE id = ? LIMIT 1', [
      joiningId,
    ]);
    if (!joiningRows.length) {
      return errorResponse(res, 'Joining not found', 404);
    }
    let joining = joiningRows[0];
    if (
      joining.status !== 'approved' &&
      joining.status !== 'draft' &&
      joining.status !== 'pending_approval'
    ) {
      return errorResponse(
        res,
        'Fee requests can only be submitted for draft or approved joinings',
        400
      );
    }

    // Determine revised lines first — admission number is minted only when amounts exist.
    let revisedLines = [];
    const rawLines = Array.isArray(studentFeeDetails?.lines) ? studentFeeDetails.lines : [];
    revisedLines = rawLines
      .filter((line) =>
        isPersistableBuilderConcessionLine(line) &&
        (line.concessionType === 'CONCESSION' || line.concessionType === 'REVISED_FEE')
      )
      .map((line) => ({
        feeHeadId:      line.feeHeadId || '',
        feeHeadCode:    line.feeHeadCode || '',
        feeHeadName:    line.feeHeadName || '',
        studentYear:    Number(line.studentYear) || 1,
        amount:         Number(line.amount) || 0,
        concessionType: line.concessionType,
        isRevised:      true,
      }));

    if (revisedLines.length === 0) {
      return errorResponse(
        res,
        'No revised fees to submit — add at least one concession or revised fee amount in the builder',
        400
      );
    }

    // Admission number is minted only when at least one selected Step 4 fee head
    // has amounts for all required years (other heads may stay empty).
    const builderFeeHeadCheck =
      body.builderFeeHeadCheck && typeof body.builderFeeHeadCheck === 'object'
        ? body.builderFeeHeadCheck
        : null;
    const completeness = getMissingBuilderHeadYearAmounts({
      heads: Array.isArray(builderFeeHeadCheck?.heads) ? builderFeeHeadCheck.heads : [],
      years: Array.isArray(builderFeeHeadCheck?.years) ? builderFeeHeadCheck.years : [],
      lines: Array.isArray(studentFeeDetails?.lines) ? studentFeeDetails.lines : [],
    });
    if (!builderFeeHeadCheck || !Array.isArray(builderFeeHeadCheck.heads) || !Array.isArray(builderFeeHeadCheck.years)) {
      return errorResponse(
        res,
        'Enter amounts for all years on at least one fee head before submitting the fee request',
        400
      );
    }
    if (!completeness.complete) {
      const missingLabel = completeness.missing
        .map((m) => `${m.headName} (Year ${m.year})`)
        .join(', ');
      return errorResponse(
        res,
        `Enter amounts for all years on at least one fee head before generating the admission number` +
          (missingLabel ? ` — still missing: ${missingLabel}` : ''),
        400
      );
    }

    // Mint admission number on Submit Fee Request when revised amounts are present
    // (not on collect payment). Approves draft/pending joinings if needed.
    let admissionNumber = await resolveJoiningAdmissionNumberFromDb(pool, joining);
    if (!admissionNumber) {
      if (!req.user?.id) {
        return errorResponse(res, 'Authentication required to generate admission number', 401);
      }
      try {
        const { ensureAdmissionForFeeCollection } = await import('./joining.controller.js');
        const ensured = await ensureAdmissionForFeeCollection(joiningId, req.user.id);
        admissionNumber = String(ensured.admissionNumber || '').trim();
      } catch (ensureErr) {
        return errorResponse(
          res,
          ensureErr.message || 'Failed to generate admission number for fee request',
          ensureErr.statusCode || 422
        );
      }
      if (!admissionNumber) {
        return errorResponse(
          res,
          'Admission number could not be generated for this fee request',
          500
        );
      }
      const [refreshedJoinings] = await pool.execute(
        'SELECT * FROM joinings WHERE id = ? LIMIT 1',
        [joiningId]
      );
      if (refreshedJoinings.length) {
        joining = refreshedJoinings[0];
      }
    }

    const syncContext = buildJoiningFeeSyncContext(
      joining,
      studentFeeDetails,
      registrationExtras,
      admissionNumber
    );

    // Prefer catalog sync plan when available (more accurate fee-head matching).
    try {
      const syncResult = await buildJoiningStepFourSyncPlan({
        joiningId,
        leadId: joining.lead_id,
        studentFeeDetails,
        joiningContext: syncContext,
      });
      const catalogRevised = (syncResult?.lines || []).filter((line) => line.isRevised);
      if (catalogRevised.length > 0) {
        revisedLines = catalogRevised;
      }
    } catch (syncErr) {
      console.warn(
        '[submitFeeRequest] buildJoiningStepFourSyncPlan failed, using raw builder lines:',
        syncErr?.message
      );
    }

    // Fetch student metadata from secondary DB for the Mongo document
    let studentPinNo = '';
    let studentCollege = syncContext?.collegeId || '';
    try {
      const secondaryPool = getSecondaryPool();
      if (admissionNumber) {
        const [sRows] = await secondaryPool.execute(
          'SELECT pin_no, college FROM students WHERE admission_number = ? LIMIT 1',
          [admissionNumber]
        );
        if (sRows[0]) {
          studentPinNo  = sRows[0].pin_no  || '';
          studentCollege = sRows[0].college || studentCollege;
        }
      }
    } catch (secErr) {
      console.warn('[submitFeeRequest] Secondary DB lookup skipped:', secErr?.message);
    }

    const transportDetails =
      req.body?.transportDetails && typeof req.body.transportDetails === 'object'
        ? req.body.transportDetails
        : req.body?.registrationFormData?.transport_details && typeof req.body.registrationFormData.transport_details === 'object'
          ? req.body.registrationFormData.transport_details
          : registrationExtras.transport_details || null;

    const accommodationType =
      transportDetails && typeof transportDetails === 'object'
        ? transportDetails.accommodationType || null
        : null;

    // Also save builder amounts onto joining/admission lead_data (same as Save Configuration)
    // so Student Info "Has Fee Entry" is true without a second save click.
    // Approval still gates overall_concessions / fee-portal final sync.
    await persistStudentFeeDetailsToJoiningBuilder({
      pool,
      joiningId,
      joiningRow: joining,
      studentFeeDetails,
      registrationExtras: {
        ...registrationExtras,
        ...(transportDetails ? { transport_details: transportDetails } : {}),
      },
      userId: req.user?.id,
    });

    // HMS sync immediately after admission number is minted (Step 3 hostel may have been skipped).
    if (admissionNumber) {
      try {
        const { runJoiningFeePortalSync } = await import('./joining.controller.js');
        await runJoiningFeePortalSync({
          pool,
          joiningId,
          leadId: joining.lead_id || null,
          studentFeeDetails,
          registrationExtras: {
            ...registrationExtras,
            ...(transportDetails ? { transport_details: transportDetails } : {}),
          },
          user: req.user,
        });
      } catch (portalSyncErr) {
        console.error(
          '[submitFeeRequest] Portal/HMS sync after admission mint failed (fee request still submitted):',
          portalSyncErr?.message || portalSyncErr
        );
      }
    }

    const [existingPending] = await pool.execute(
      `SELECT id FROM fee_requests WHERE joining_id = ? AND status = 'pending_approval' LIMIT 1`,
      [joiningId]
    );

    const payload = {
      lead_id: joining.lead_id || null,
      admission_number: admissionNumber,
      student_name: joining.student_name || '',
      course: joining.course || '',
      branch: joining.branch || '',
      batch: studentFeeDetails?.batch || syncContext.batch || '',
      status: 'pending_approval',
      request_lines: JSON.stringify(revisedLines),
      accommodation_type: accommodationType,
      transport_details: transportDetails ? JSON.stringify(transportDetails) : null,
      student_fee_details: studentFeeDetails ? JSON.stringify(studentFeeDetails) : null,
      submitted_at: new Date(),
      submitted_by: req.user.id,
      rejected_at: null,
      rejected_by: null,
      rejection_reason: null,
      approved_at: null,
      approved_by: null,
      reviewer_note: null,
    };

    if (existingPending.length > 0) {
      await pool.execute(
        `UPDATE fee_requests SET
          lead_id = ?, admission_number = ?, student_name = ?, course = ?, branch = ?, batch = ?,
          request_lines = ?, accommodation_type = ?, transport_details = ?, student_fee_details = ?,
          submitted_at = NOW(), submitted_by = ?, updated_at = NOW()
         WHERE id = ?`,
        [
          payload.lead_id,
          payload.admission_number,
          payload.student_name,
          payload.course,
          payload.branch,
          payload.batch,
          payload.request_lines,
          payload.accommodation_type,
          payload.transport_details,
          payload.student_fee_details,
          payload.submitted_by,
          existingPending[0].id,
        ]
      );
      const [updated] = await pool.execute('SELECT * FROM fee_requests WHERE id = ?', [
        existingPending[0].id,
      ]);

      // Mirror into Fee Management Mongo (fire-and-forget)
      void syncRequestToFeeManagementMongo({
        admissionNumber,
        studentName:     joining.student_name || '',
        pinNo:           studentPinNo,
        college:         studentCollege,
        course:          joining.course || '',
        branch:          joining.branch || '',
        batch:           payload.batch,
        studentFeeDetails,
        requestedBy:     String(req.user?.id || ''),
        requestedByName: String(req.user?.name || ''),
      });

      return successResponse(res, formatFeeRequestRowWithHeads(updated[0], feeHeads), 'Fee request updated', 200);
    }

    const id = uuidv4();
    await pool.execute(
      `INSERT INTO fee_requests (
        id, joining_id, lead_id, admission_number, student_name, course, branch, batch,
        status, request_lines, accommodation_type, transport_details, student_fee_details,
        submitted_at, submitted_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, NOW(), NOW())`,
      [
        id,
        joiningId,
        payload.lead_id,
        payload.admission_number,
        payload.student_name,
        payload.course,
        payload.branch,
        payload.batch,
        payload.status,
        payload.request_lines,
        payload.accommodation_type,
        payload.transport_details,
        payload.student_fee_details,
        payload.submitted_by,
      ]
    );

    const [created] = await pool.execute('SELECT * FROM fee_requests WHERE id = ?', [id]);

    // Mirror into Fee Management Mongo (fire-and-forget)
    void syncRequestToFeeManagementMongo({
      admissionNumber,
      studentName:     joining.student_name || '',
      pinNo:           studentPinNo,
      college:         studentCollege,
      course:          joining.course || '',
      branch:          joining.branch || '',
      batch:           payload.batch,
      studentFeeDetails,
      requestedBy:     String(req.user?.id || ''),
      requestedByName: String(req.user?.name || ''),
    });

    return successResponse(res, formatFeeRequestRowWithHeads(created[0], feeHeads), 'Fee request submitted', 201);
  } catch (error) {
    console.error('submitFeeRequest error:', error);
    return errorResponse(res, error.message || 'Failed to submit fee request', 500);
  }
};

/** POST /api/fee-requests/:id/approve */
export const approveFeeRequest = async (req, res) => {
  try {
    if (!canApproveFeeRequest(req.user)) {
      return errorResponse(res, 'Not authorized to approve fee requests', 403);
    }

    const { id } = req.params;
    const reviewerNote =
      typeof req.body?.reviewerNote === 'string' ? req.body.reviewerNote.trim().slice(0, 2000) : '';

    const pool = getPool();
    const [rows] = await pool.execute('SELECT * FROM fee_requests WHERE id = ? LIMIT 1', [id]);
    if (!rows.length) {
      return errorResponse(res, 'Fee request not found', 404);
    }
    const request = rows[0];
    if (request.status !== 'pending_approval') {
      return errorResponse(res, 'Only pending fee requests can be approved', 400);
    }

    const studentFeeDetails = sanitizeStudentFeeDetailsForDb(
      typeof request.student_fee_details === 'string'
        ? JSON.parse(request.student_fee_details)
        : request.student_fee_details
    );
    const transportDetails =
      typeof request.transport_details === 'string'
        ? JSON.parse(request.transport_details)
        : request.transport_details;

    const [joiningRows] = await pool.execute('SELECT * FROM joinings WHERE id = ? LIMIT 1', [
      request.joining_id,
    ]);
    if (!joiningRows.length) {
      return errorResponse(res, 'Linked joining not found', 404);
    }
    const joining = joiningRows[0];

    let leadData = parseLeadData(joining.lead_data);
    const prevExtras =
      leadData._joiningRegistrationExtras && typeof leadData._joiningRegistrationExtras === 'object'
        ? { ...leadData._joiningRegistrationExtras }
        : {};
    const mergedExtras = {
      ...prevExtras,
      ...(transportDetails ? { transport_details: transportDetails } : {}),
    };

    leadData = {
      ...leadData,
      ...(Object.keys(mergedExtras).length > 0
        ? { _joiningRegistrationExtras: mergedExtras }
        : {}),
      ...(studentFeeDetails ? { _joiningStudentFeeDetails: studentFeeDetails } : {}),
    };

    await pool.execute(
      `UPDATE joinings SET lead_data = ?, updated_by = ?, updated_at = NOW() WHERE id = ?`,
      [JSON.stringify(leadData), req.user.id, joining.id]
    );

    const syncContext = buildJoiningFeeSyncContext(
      joining,
      studentFeeDetails,
      mergedExtras,
      request.admission_number || ''
    );
    await syncJoiningStudentFeeDetailsToFeeMongo({
      joiningId: joining.id,
      leadId: joining.lead_id,
      studentFeeDetails,
      joiningContext: syncContext,
    });

    await pool.execute(
      `UPDATE fee_requests SET
        status = 'approved', approved_at = NOW(), approved_by = ?, reviewer_note = ?, updated_at = NOW()
       WHERE id = ?`,
      [req.user.id, reviewerNote || null, id]
    );

    // Update status in Fee Management Mongo (fire-and-forget)
    try {
      const conn = await connectFeeManagement();
      const collection = conn.db.collection('overallconcessionrequests');
      await collection.updateOne(
        { admissionNumber: request.admission_number, status: 'PENDING' },
        {
          $set: {
            status: 'APPROVED',
            approvedBy: String(req.user?.id || ''),
            approvedByName: String(req.user?.name || ''),
            updatedAt: new Date(),
          }
        }
      );
      console.log(`[FeeRequestMongo] Approved OverallConcessionRequest for ${request.admission_number}`);
    } catch (mongoErr) {
      console.error('[FeeRequestMongo] Failed to update status to APPROVED in Mongo:', mongoErr?.message || mongoErr);
    }

    // Sync approved concessions to secondary database overall_concessions table
    try {
      const secondaryPool = getSecondaryPool();
      
      const [studentRows] = await secondaryPool.execute(
        'SELECT pin_no, student_name, batch, course, branch FROM students WHERE admission_number = ? LIMIT 1',
        [request.admission_number]
      );
      
      const pinNo = studentRows[0]?.pin_no || request.admission_number || '';
      const studentName = studentRows[0]?.student_name || request.student_name || '';
      const batch = studentRows[0]?.batch || request.batch || '';
      const course = studentRows[0]?.course || request.course || '';
      const branch = studentRows[0]?.branch || request.branch || '';
      
      const requestLines = typeof request.request_lines === 'string'
        ? JSON.parse(request.request_lines)
        : request.request_lines || [];

      let studentFeeDetails = null;
      try {
        studentFeeDetails =
          typeof request.student_fee_details === 'string'
            ? JSON.parse(request.student_fee_details || 'null')
            : request.student_fee_details || null;
      } catch {
        studentFeeDetails = null;
      }
      studentFeeDetails = sanitizeStudentFeeDetailsForDb(studentFeeDetails);

      let feeHeads = [];
      try {
        const conn = await connectFeeManagement();
        feeHeads = await conn.db.collection('feeheads').find({}).toArray();
      } catch (fhErr) {
        console.warn('Failed to load feeheads for approveFeeRequest:', fhErr.message);
      }

      if (studentFeeDetails && Array.isArray(studentFeeDetails.lines)) {
        studentFeeDetails.lines = normalizeFeeHeadInEntries(studentFeeDetails.lines, feeHeads);
      }

      const revisedFeesFromBuilder = buildOverallConcessionLinesFromBuilder(
        studentFeeDetails || { lines: [] }
      );
      const revisedFees =
        revisedFeesFromBuilder.length > 0
          ? revisedFeesFromBuilder
          : buildOverallConcessionLinesFromPortalLines(requestLines);

      const revisedFeesNormalized = normalizeFeeHeadInEntries(revisedFees, feeHeads);

      await secondaryPool.execute(
        `INSERT INTO overall_concessions 
          (admission_number, pin_no, student_name, batch, course, branch, revised_fees, created_at, updated_at)
         VALUES 
          (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
         ON DUPLICATE KEY UPDATE
          pin_no = VALUES(pin_no),
          student_name = VALUES(student_name),
          batch = VALUES(batch),
          course = VALUES(course),
          branch = VALUES(branch),
          revised_fees = VALUES(revised_fees),
          updated_at = NOW()`,
        [
          request.admission_number,
          pinNo,
          studentName,
          batch,
          course,
          branch,
          JSON.stringify(revisedFeesNormalized)
        ]
      );
      console.log(`Synced concessions for ${request.admission_number} to secondary overall_concessions`);
    } catch (secErr) {
      console.error('Failed to sync concessions to secondary database overall_concessions:', secErr);
    }

    let responseFeeHeads = [];
    try {
      const conn = await connectFeeManagement();
      responseFeeHeads = await conn.db.collection('feeheads').find({}).toArray();
    } catch (fhErr) {
      console.warn('Failed to load feeheads for approveFeeRequest response:', fhErr.message);
    }

    const [updated] = await pool.execute('SELECT * FROM fee_requests WHERE id = ?', [id]);
    return successResponse(res, formatFeeRequestRowWithHeads(updated[0], responseFeeHeads), 'Fee request approved', 200);
  } catch (error) {
    console.error('approveFeeRequest error:', error);
    return errorResponse(res, error.message || 'Failed to approve fee request', 500);
  }
};

/** POST /api/fee-requests/:id/reject */
export const rejectFeeRequest = async (req, res) => {
  try {
    if (!canApproveFeeRequest(req.user)) {
      return errorResponse(res, 'Not authorized to reject fee requests', 403);
    }

    const { id } = req.params;
    const reason =
      typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 2000) : '';

    const pool = getPool();
    const [rows] = await pool.execute('SELECT * FROM fee_requests WHERE id = ? LIMIT 1', [id]);
    if (!rows.length) {
      return errorResponse(res, 'Fee request not found', 404);
    }
    if (rows[0].status !== 'pending_approval') {
      return errorResponse(res, 'Only pending fee requests can be rejected', 400);
    }

    await pool.execute(
      `UPDATE fee_requests SET
        status = 'rejected', rejected_at = NOW(), rejected_by = ?, rejection_reason = ?, updated_at = NOW()
       WHERE id = ?`,
      [req.user.id, reason || null, id]
    );

    // Update status in Fee Management Mongo (fire-and-forget)
    try {
      const conn = await connectFeeManagement();
      const collection = conn.db.collection('overallconcessionrequests');
      await collection.updateOne(
        { admissionNumber: rows[0].admission_number, status: 'PENDING' },
        {
          $set: {
            status: 'REJECTED',
            rejectionReason: reason || '',
            updatedAt: new Date(),
          }
        }
      );
      console.log(`[FeeRequestMongo] Rejected OverallConcessionRequest for ${rows[0].admission_number}`);
    } catch (mongoErr) {
      console.error('[FeeRequestMongo] Failed to update status to REJECTED in Mongo:', mongoErr?.message || mongoErr);
    }

    let feeHeads = [];
    try {
      const conn = await connectFeeManagement();
      feeHeads = await conn.db.collection('feeheads').find({}).toArray();
    } catch (fhErr) {
      console.warn('Failed to load feeheads for rejectFeeRequest:', fhErr.message);
    }
    const [updated] = await pool.execute('SELECT * FROM fee_requests WHERE id = ?', [id]);
    return successResponse(res, formatFeeRequestRowWithHeads(updated[0], feeHeads), 'Fee request rejected', 200);
  } catch (error) {
    console.error('rejectFeeRequest error:', error);
    return errorResponse(res, error.message || 'Failed to reject fee request', 500);
  }
};

/** GET /api/fee-requests/joining/:joiningId/pending — check pending for a joining */
export const getPendingFeeRequestForJoining = async (req, res) => {
  try {
    const joiningId = String(req.params.joiningId || '').trim();
    if (!joiningId) {
      return errorResponse(res, 'joiningId is required', 400);
    }

    const pool = getPool();
    const [rows] = await pool.execute(
      `SELECT * FROM fee_requests WHERE joining_id = ? AND status = 'pending_approval' ORDER BY submitted_at DESC LIMIT 1`,
      [joiningId]
    );

    let feeHeads = [];
    try {
      const conn = await connectFeeManagement();
      feeHeads = await conn.db.collection('feeheads').find({}).toArray();
    } catch (fhErr) {
      console.warn('Failed to load feeheads for getPendingFeeRequestForJoining:', fhErr.message);
    }
    return successResponse(res, rows.length ? formatFeeRequestRowWithHeads(rows[0], feeHeads) : null);
  } catch (error) {
    console.error('getPendingFeeRequestForJoining error:', error);
    return errorResponse(res, error.message || 'Failed to load fee request', 500);
  }
};
