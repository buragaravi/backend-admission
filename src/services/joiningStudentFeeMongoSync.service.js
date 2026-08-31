import mongoose from 'mongoose';
import { connectFeeManagement } from '../config-mongo/feeManagement.js';
import { mapCourseLabel } from '../data/admissionsCourseBranchMap2026.js';
import { deriveAdmissionSeriesYear } from '../utils/lateralBatch.util.js';
import { resolveFeePortalBranchLabel } from '../utils/feePortalBranchLabel.util.js';
import { resolveTransportAcademicYear, normalizeCalendarAcademicYear } from '../utils/transportApplicationNumber.util.js';
import { mapQuotaToFeeCategory } from '../utils/quotaClassification.util.js';
import {
  previewJoiningBusSync,
  previewJoiningHostelSync,
  syncJoiningAccommodationToExternalDbs,
} from './joiningAccommodationSync.service.js';

const { Types: { ObjectId } } = mongoose;

export const JOINING_STUDENT_FEE_MONGO_COLLECTION = 'crm_joining_student_fee_details';
export const FEE_PORTAL_STUDENT_FEES_COLLECTION = 'studentfees';

const BUS_FEE_STRUCTURE_ID_PREFIX = 'joining-bus-fee-year-';
const HOSTEL_FEE_STRUCTURE_ID_PREFIX = 'joining-hostel-fee-year-';

const BUS_FEE_HEAD = {
  id: '6996e24c2e1678e39883918a',
  code: 'TRN01',
  name: 'Bus Fee',
};

const HOSTEL_FEE_HEAD = {
  id: '6996e24d2e1678e398839196',
  code: 'HST01',
  name: 'Hostel Fee',
};

const TUI_FEE_HEAD_ID = '6996e24c2e1678e398839187';

const DEFAULT_PROGRAM_YEARS = 4;
const DIPLOMA_PROGRAM_YEARS = 3;

/** Fee portal `feestructures` use canonical labels (Polytechnic → Diploma). */
const resolveFeePortalCourse = (course) => mapCourseLabel(course);

/** Intake calendar year for catalog lookup + tuition `studentfees.academicYear`. */
const resolveRequestedFeeBatch = ({ batch, intakeBatch, admissionNumber } = {}) => {
  const fromBatch = normalizeCalendarAcademicYear(batch || '');
  if (fromBatch) return fromBatch;
  const fromIntake = normalizeCalendarAcademicYear(intakeBatch || '');
  if (fromIntake) return fromIntake;
  return deriveAdmissionSeriesYear(admissionNumber) || '';
};

const isDiplomaProgram = (course) => /^diploma$/i.test(String(resolveFeePortalCourse(course) || '').trim());

const resolveProgramTotalYearsForFeeSync = (course, programTotalYears) => {
  if (isDiplomaProgram(course)) return DIPLOMA_PROGRAM_YEARS;
  const n = Number(programTotalYears);
  if (Number.isFinite(n) && n > 0) return Math.min(8, Math.trunc(n));
  return DEFAULT_PROGRAM_YEARS;
};

const mapFeeHeadDoc = (head, fallback) => {
  if (!head || typeof head !== 'object') return fallback;
  return {
    id: String(head._id || head.id || fallback.id),
    code: String(head.code || fallback.code),
    name: String(head.name || fallback.name),
  };
};

/** Resolve TRN01 / HST01 from Fee Management `feeheads` (falls back to constants). */
const loadAccommodationFeeHeads = async (db) => {
  try {
    const heads = await db
      .collection('feeheads')
      .find({ code: { $in: ['TRN01', 'HST01'] } })
      .toArray();
    const byCode = new Map(
      heads.map((head) => [String(head.code || '').trim().toUpperCase(), head])
    );
    return {
      bus: mapFeeHeadDoc(byCode.get('TRN01'), BUS_FEE_HEAD),
      hostel: mapFeeHeadDoc(byCode.get('HST01'), HOSTEL_FEE_HEAD),
    };
  } catch (err) {
    console.warn(
      '[joiningStudentFeeMongoSync] Could not load accommodation fee heads:',
      err?.message || err
    );
    return { bus: BUS_FEE_HEAD, hostel: HOSTEL_FEE_HEAD };
  }
};

const resolveAccommodationStudentYears = (overrideMap, programTotalYears = DEFAULT_PROGRAM_YEARS) => {
  const busYears = [...overrideMap.keys()]
    .filter(isBusStructureId)
    .map((id) => Number(String(id).replace(BUS_FEE_STRUCTURE_ID_PREFIX, '')))
    .filter((y) => y > 0);
  const hostelYears = [...overrideMap.keys()]
    .filter(isHostelStructureId)
    .map((id) => Number(String(id).replace(HOSTEL_FEE_STRUCTURE_ID_PREFIX, '')))
    .filter((y) => y > 0);
  const fromOverrides = [...new Set([...busYears, ...hostelYears])].sort((a, b) => a - b);
  if (fromOverrides.length > 0) return fromOverrides;

  const total = Math.max(1, Math.min(8, Math.trunc(Number(programTotalYears)) || DEFAULT_PROGRAM_YEARS));
  return Array.from({ length: total }, (_, index) => index + 1);
};

const normalize = (value) =>
  typeof value === 'string' ? value.trim() : value === undefined ? '' : String(value);

const exactIRegex = (value) => {
  const escaped = normalize(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}$`, 'i');
};

const isBusStructureId = (id) => String(id || '').startsWith(BUS_FEE_STRUCTURE_ID_PREFIX);
const isHostelStructureId = (id) => String(id || '').startsWith(HOSTEL_FEE_STRUCTURE_ID_PREFIX);

const getHostelFeeForYear = (transport, studentYear) => {
  const byYear = transport?.hostelFeesByYear;
  if (Array.isArray(byYear) && byYear.length > 0) {
    const row = byYear.find((fee) => Number(fee.studentYear) === studentYear);
    if (row?.amount != null && Number.isFinite(Number(row.amount))) return Number(row.amount);
  }
  if (transport?.hostelFee != null && Number.isFinite(Number(transport.hostelFee))) {
    return Number(transport.hostelFee);
  }
  return 0;
};

const buildAccommodationCatalogRows = (transportDetails, overrideMap, feeHeads, programTotalYears) => {
  if (!transportDetails || typeof transportDetails !== 'object') return [];

  const busHead = feeHeads?.bus || BUS_FEE_HEAD;
  const hostelHead = feeHeads?.hostel || HOSTEL_FEE_HEAD;

  if (transportDetails.accommodationType === 'bus' && transportDetails.routeId && transportDetails.stageId) {
    const uniqueYears = resolveAccommodationStudentYears(overrideMap, programTotalYears);
    return uniqueYears.map((studentYear) => ({
      _id: `${BUS_FEE_STRUCTURE_ID_PREFIX}${studentYear}`,
      studentYear,
      amount: Number(transportDetails.stageFare) || 0,
      feeHead: busHead.id,
      feeHeadCode: busHead.code,
      feeHeadName: busHead.name,
      accommodationType: 'bus',
    }));
  }

  if (
    transportDetails.accommodationType === 'hostel' &&
    transportDetails.hostelId &&
    transportDetails.categoryId &&
    (transportDetails.roomId || transportDetails.roomNumber)
  ) {
    const overrideIds = [...overrideMap.keys()].filter(isHostelStructureId);
    const yearsFromOverrides = overrideIds
      .map((id) => Number(String(id).replace(HOSTEL_FEE_STRUCTURE_ID_PREFIX, '')))
      .filter((y) => y > 0);
    const yearsFromTransport = (transportDetails.hostelFeesByYear || [])
      .map((row) => Number(row.studentYear))
      .filter((y) => y > 0);
    const uniqueYears = [
      ...new Set(
        yearsFromOverrides.length
          ? yearsFromOverrides
          : yearsFromTransport.length
            ? yearsFromTransport
            : resolveAccommodationStudentYears(overrideMap, programTotalYears)
      ),
    ].sort((a, b) => a - b);

    return uniqueYears.map((studentYear) => ({
      _id: `${HOSTEL_FEE_STRUCTURE_ID_PREFIX}${studentYear}`,
      studentYear,
      amount: getHostelFeeForYear(transportDetails, studentYear),
      feeHead: hostelHead.id,
      feeHeadCode: hostelHead.code,
      feeHeadName: hostelHead.name,
      accommodationType: 'hostel',
    }));
  }

  return [];
};

const enrichWithFeeHead = async (db, structures) => {
  const headIdStrings = [
    ...new Set(
      structures
        .map((doc) => doc.feeHead)
        .filter((id) => id !== undefined && id !== null && String(id).trim() !== '')
        .map((id) => String(id))
    ),
  ];
  if (headIdStrings.length === 0) return structures;

  const objectIds = headIdStrings
    .map((id) => {
      try {
        return new ObjectId(id);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const heads = await db
    .collection('feeheads')
    .find({ _id: { $in: [...objectIds, ...headIdStrings] } })
    .toArray();
  const byId = new Map(heads.map((head) => [String(head._id), head]));

  return structures.map((doc) => {
    const head = doc.feeHead ? byId.get(String(doc.feeHead)) : null;
    return {
      ...doc,
      feeHeadCode: doc.feeHeadCode || head?.code || '',
      feeHeadName: doc.feeHeadName || head?.name || '',
    };
  });
};

/** Fee Mongo mirror is written only when catalog or accommodation rows exist for the student batch. */
const shouldPersistFeePortalMirror = (catalogRows, accommodationRows) =>
  catalogRows.length > 0 || accommodationRows.length > 0;

const loadCatalogFeeStructures = async (
  db,
  { course, branch, quota, batch, intakeBatch, admissionNumber, managedBranchId = null, studentStatus = null }
) => {
  const catalogCourse = resolveFeePortalCourse(course);
  const feePortalBranch = await resolveFeePortalBranchLabel({
    branchLabel: branch,
    courseLabel: catalogCourse || course,
    managedBranchId,
  });
  const category = mapQuotaToFeeCategory(quota, studentStatus, batch);
  const requestedBatch = resolveRequestedFeeBatch({ batch, intakeBatch, admissionNumber });

  const buildFilter = (batchVal) => {
    const filter = {};
    if (catalogCourse) filter.course = exactIRegex(catalogCourse);
    if (feePortalBranch) filter.branch = exactIRegex(feePortalBranch);
    if (category) filter.category = category;
    if (batchVal) filter.batch = exactIRegex(batchVal);
    return filter;
  };

  const queryRows = async (batchVal) => {
    const docs = await db
      .collection('feestructures')
      .find(buildFilter(batchVal))
      .sort({ studentYear: 1 })
      .toArray();
    return enrichWithFeeHead(db, docs.map((doc) => ({ ...doc, _id: String(doc._id) })));
  };

  const resolvedBatch = requestedBatch;
  const batchMatchMode = 'exact';
  const rows = await queryRows(requestedBatch);

  return {
    rows,
    catalogLookup: {
      course: normalize(catalogCourse || course),
      branch: normalize(feePortalBranch || branch),
      branchInput: normalize(branch),
      quota: normalize(quota),
      categoryMapped: category,
      requestedBatch,
      resolvedBatch,
      batchMatchMode,
    },
  };
};

/** Fee portal ledger uses numeric admission numbers (e.g. 20260272), not enquiry ids. */
const isFeePortalAdmissionNumber = (value) => /^\d{8}$/.test(String(value || '').trim());

const feeHeadFilterValue = (feeHeadId) => {
  const raw = String(feeHeadId || '').trim();
  if (!raw) return null;
  try {
    return new ObjectId(raw);
  } catch {
    return raw;
  }
};

const feeHeadMatchValues = (feeHeadId) => {
  const raw = String(feeHeadId || '').trim();
  if (!raw) return [];
  const values = [raw];
  try {
    values.push(new ObjectId(raw));
  } catch {
    // Non-ObjectId fee heads are matched as-is.
  }
  return values;
};

const normalizeStudentFeeKeyPart = (value) =>
  value === undefined || value === null || value === '' ? 'null' : String(value).trim();

const buildStudentFeeSourceKey = ({ admissionNumber, feeHeadId, academicYear, studentYear, semester, remarks }) =>
  [
    'admissions_crm',
    normalizeStudentFeeKeyPart(admissionNumber),
    normalizeStudentFeeKeyPart(feeHeadId),
    normalizeStudentFeeKeyPart(academicYear),
    normalizeStudentFeeKeyPart(studentYear),
    normalizeStudentFeeKeyPart(semester),
    normalizeStudentFeeKeyPart(remarks),
  ].join('|');

const SESSION_ACADEMIC_YEAR_REGEX = /^\d{4}-\d{4}$/;

const normalizeStudentFeeAmount = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

/** Remove bad rows from earlier CRM pushes that crash the fee portal UI. */
async function cleanupStaleCrmStudentFeeRows(coll, admissionNumber) {
  const tuitionHead = feeHeadFilterValue(TUI_FEE_HEAD_ID);
  const transportHead = feeHeadFilterValue(BUS_FEE_HEAD.id);
  const hostelHead = feeHeadFilterValue(HOSTEL_FEE_HEAD.id);

  if (tuitionHead) {
    await coll.deleteMany({
      studentId: admissionNumber,
      feeHead: tuitionHead,
      academicYear: { $regex: SESSION_ACADEMIC_YEAR_REGEX },
    });
  }

  for (const head of [transportHead, hostelHead].filter(Boolean)) {
    await coll.deleteMany({
      studentId: admissionNumber,
      feeHead: head,
      studentYear: { $gt: 1 },
    });
  }
}

/** Match existing fee-portal rows (Transport/Hostel use short remarks in the unique key). */
const studentFeeRemarksForPortalLine = (line) => {
  const code = String(line?.feeHeadCode || '').trim().toUpperCase();
  if (code === 'TRN01') return 'Transport';
  if (code === 'HST01') return 'Hostel';
  return typeof line?.remarks === 'string' ? line.remarks.trim() : '';
};

const buildStudentFeeUpsertDocs = ({
  portalLines,
  joiningContext,
  transportDetails,
  batch,
  resolvedBatch,
  catalogRows,
}) => {
  const admissionNumber = String(joiningContext?.admissionNumber || '').trim();
  const requestedIntakeBatch = resolveRequestedFeeBatch({
    batch,
    intakeBatch: joiningContext?.intakeBatch,
    admissionNumber,
  });
  const catalogBatchYear = normalizeCalendarAcademicYear(resolvedBatch || '');
  // Tuition ledger uses student intake year (e.g. 2026), not prior-year catalog fallback (e.g. 2025).
  const tuitionBatchYear = requestedIntakeBatch || catalogBatchYear;
  const transportSessionYear = resolveTransportAcademicYear(
    transportDetails,
    requestedIntakeBatch || batch || joiningContext?.batch || ''
  );
  if (!isFeePortalAdmissionNumber(admissionNumber) || !portalLines?.length) {
    return [];
  }
  if (!tuitionBatchYear && !transportSessionYear) {
    return [];
  }

  const semesterByStructureId = new Map();
  for (const row of catalogRows || []) {
    semesterByStructureId.set(
      String(row._id),
      row.semester != null && Number.isFinite(Number(row.semester)) ? Number(row.semester) : null
    );
  }

  const now = new Date();
  return portalLines
    .filter((line) => line?.feeHeadId)
    .map((line) => {
      const structureId = String(line.structureId || '');
      const studentYear = Number(line.studentYear) > 0 ? Number(line.studentYear) : 1;
      const isAccommodation =
        line.accommodationType === 'bus' ||
        line.accommodationType === 'hostel' ||
        isBusStructureId(structureId) ||
        isHostelStructureId(structureId);
      if (isAccommodation && studentYear > 1) {
        return null;
      }
      const academicYear = isAccommodation ? transportSessionYear : tuitionBatchYear;
      if (!academicYear) return null;

      const semesterRaw = semesterByStructureId.get(structureId);
      const semester =
        semesterRaw != null && Number.isFinite(Number(semesterRaw)) && Number(semesterRaw) > 0
          ? Number(semesterRaw)
          : isAccommodation
            ? 1
            : null;
      const remarks = studentFeeRemarksForPortalLine(line);
      const feeHead = feeHeadFilterValue(line.feeHeadId);
      if (!feeHead) return null;
      const feeHeadId = String(line.feeHeadId || '').trim();
      const sourceKey = buildStudentFeeSourceKey({
        admissionNumber,
        feeHeadId,
        academicYear,
        studentYear,
        semester,
        remarks,
      });

      return {
        sourceKey,
        feeHeadId,
        filter: {
          sourceKey,
        },
        legacyFilter: {
          studentId: admissionNumber,
          feeHead: { $in: feeHeadMatchValues(feeHeadId) },
          academicYear,
          studentYear,
          semester,
          remarks,
        },
        update: {
          studentId: admissionNumber,
          studentName: String(joiningContext?.studentName || '').trim(),
          feeHead,
          feeHeadId,
          college: 'Default',
          course: String(joiningContext?.course || '').trim(),
          branch: String(joiningContext?.branch || '').trim(),
          academicYear,
          studentYear,
          semester,
          amount: normalizeStudentFeeAmount(line.revisedAmount),
          remarks,
          source: 'admissions_crm',
          sourceKey,
          isActive: true,
          updatedAt: now,
        },
      };
    })
    .filter(Boolean);
};

/** Dry-run: rows that would be upserted into Fee Management `studentfees`. */
export function previewJoiningStudentFeesSync({
  portalLines,
  joiningContext,
  transportDetails,
  batch,
  resolvedBatch,
  catalogRows,
}) {
  const admissionNumber = String(joiningContext?.admissionNumber || '').trim();
  if (!isFeePortalAdmissionNumber(admissionNumber)) {
    return {
      skipped: true,
      reason: 'Numeric admission number required (studentfees uses studentId=admission number)',
      admissionNumber,
    };
  }

  const docs = buildStudentFeeUpsertDocs({
    portalLines,
    joiningContext,
    transportDetails,
    batch,
    resolvedBatch,
    catalogRows,
  });
  if (docs.length === 0) {
    return {
      skipped: true,
      reason: 'No portal fee lines to upsert into studentfees',
      admissionNumber,
    };
  }

  const requestedIntakeBatch = resolveRequestedFeeBatch({
    batch,
    intakeBatch: joiningContext?.intakeBatch,
    admissionNumber,
  });
  const transportSessionYear = resolveTransportAcademicYear(
    transportDetails,
    requestedIntakeBatch || batch || joiningContext?.batch || ''
  );

  return {
    skipped: false,
    database: 'fee_management',
    collection: FEE_PORTAL_STUDENT_FEES_COLLECTION,
    operation: 'upsertMany',
    admissionNumber,
    intakeBatchYear: requestedIntakeBatch,
    catalogBatchYear: normalizeCalendarAcademicYear(resolvedBatch || '') || requestedIntakeBatch,
    transportSessionYear,
    rowCount: docs.length,
    sampleRows: docs.slice(0, 4).map((row) => row.update),
  };
}

async function findExistingStudentFeeRows(coll, row) {
  const selectors = [row.filter, row.legacyFilter].filter(Boolean);
  if (selectors.length === 0) return [];
  return coll
    .find({ $or: selectors })
    .sort({ updatedAt: -1, createdAt: -1, _id: -1 })
    .toArray();
}

async function cleanupDuplicateStudentFeeRowsForUpsert(coll, row) {
  const existingRows = await findExistingStudentFeeRows(coll, row);
  if (existingRows.length === 0) return { targetId: null, deletedCount: 0 };

  const survivor = existingRows[0];
  const duplicateIds = existingRows.slice(1).map((doc) => doc._id);
  let deletedCount = 0;
  if (duplicateIds.length > 0) {
    const result = await coll.deleteMany({ _id: { $in: duplicateIds } });
    deletedCount = result.deletedCount || 0;
  }

  return { targetId: survivor._id, deletedCount };
}

/**
 * Upsert resolved portal lines into the live Fee Management `studentfees` ledger.
 * This is what the fee portal UI uses (distinct from the CRM mirror collection).
 */
export async function syncPortalLinesToStudentFees(db, params) {
  const preview = previewJoiningStudentFeesSync(params);
  if (preview.skipped) return preview;

  const admissionNumber = String(params.joiningContext?.admissionNumber || '').trim();
  const coll = db.collection(FEE_PORTAL_STUDENT_FEES_COLLECTION);
  await cleanupStaleCrmStudentFeeRows(coll, admissionNumber);

  const docs = buildStudentFeeUpsertDocs(params);
  let upserted = 0;
  let modified = 0;
  let deduped = 0;

  for (const row of docs) {
    const cleanup = await cleanupDuplicateStudentFeeRowsForUpsert(coll, row);
    deduped += cleanup.deletedCount;
    if (cleanup.targetId) {
      const result = await coll.updateOne(
        { _id: cleanup.targetId },
        {
          $set: row.update,
          $setOnInsert: { createdAt: row.update.updatedAt },
        },
        { upsert: true }
      );
      upserted += result.upsertedCount || 0;
      modified += result.modifiedCount || 0;
      continue;
    }

    const result = await coll.updateOne(
      row.filter,
      {
        $set: row.update,
        $setOnInsert: { createdAt: row.update.updatedAt },
      },
      { upsert: true }
    );
    upserted += result.upsertedCount || 0;
    modified += result.modifiedCount || 0;
  }

  return {
    skipped: false,
    admissionNumber: preview.admissionNumber,
    intakeBatchYear: preview.intakeBatchYear,
    transportSessionYear: preview.transportSessionYear,
    rowCount: docs.length,
    upserted,
    modified,
    deduped,
  };
}

const readPositiveOverrideAmount = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const buildPortalLines = (catalogRows, accommodationRows, studentFeeDetails) => {
  const overrideMap = new Map();
  for (const line of studentFeeDetails?.lines || []) {
    const id = String(line?.structureId || '').trim();
    if (id) overrideMap.set(id, line);
  }

  const merged = new Map();
  for (const row of [...catalogRows, ...accommodationRows]) {
    merged.set(String(row._id), row);
  }

  const lines = [...merged.values()].map((row) => {
    const structureId = String(row._id);
    const override = overrideMap.get(structureId);
    const actualAmount = Number(row.amount) || 0;
    const overrideAmount =
      override?.amount !== undefined &&
      override?.amount !== null &&
      override?.amount !== '' &&
      Number.isFinite(Number(override.amount)) &&
      Number(override.amount) > 0
        ? Number(override.amount)
        : null;
    const concessionType =
      overrideAmount !== null &&
      (override?.concessionType === 'CONCESSION' || override?.concessionType === 'REVISED_FEE')
        ? override.concessionType
        : undefined;
    const revisedAmount =
      overrideAmount !== null
        ? concessionType === 'CONCESSION'
          ? Math.max(actualAmount - overrideAmount, 0)
          : overrideAmount
        : actualAmount;

    return {
      structureId,
      feeHeadId: row.feeHead ? String(row.feeHead) : null,
      feeHeadCode: row.feeHeadCode || '',
      feeHeadName: row.feeHeadName || '',
      studentYear: row.studentYear ?? null,
      actualAmount,
      revisedAmount,
      isRevised:
        overrideAmount !== null &&
        (revisedAmount !== actualAmount || Boolean(concessionType)),
      concessionType,
      remarks: typeof override?.remarks === 'string' ? override.remarks.trim() : '',
      accommodationType: row.accommodationType || null,
    };
  });

  for (const [structureId, override] of overrideMap.entries()) {
    if (!merged.has(structureId)) {
      const feeHeadId = override.feeHeadId || null;
      const feeHeadCode = override.feeHeadCode || '';
      const feeHeadName = override.feeHeadName || '';
      const studentYear = override.studentYear != null ? Number(override.studentYear) : null;
      const actualAmount = 0;
      const overrideAmount = readPositiveOverrideAmount(override?.amount);
      const concessionType =
        override?.concessionType === 'CONCESSION' || override?.concessionType === 'REVISED_FEE'
          ? override.concessionType
          : undefined;
      if (!overrideAmount || !concessionType) {
        continue;
      }
      const revisedAmount = concessionType === 'CONCESSION' ? 0 : overrideAmount;

      lines.push({
        structureId,
        feeHeadId,
        feeHeadCode,
        feeHeadName,
        studentYear,
        actualAmount,
        revisedAmount,
        isRevised: true,
        concessionType,
        remarks: typeof override.remarks === 'string' ? override.remarks.trim() : '',
        accommodationType: null,
      });
    }
  }

  return lines;
};

/**
 * Build Step 4 outbound sync plan without writing to any database (dry-run).
 */
export async function buildJoiningStepFourSyncPlan({
  joiningId,
  leadId = null,
  studentFeeDetails = null,
  joiningContext = null,
}) {
  if (!joiningId || typeof joiningId !== 'string') {
    return { error: 'joiningId is required', feePortal: null, transport: null, hostel: null, lines: [] };
  }

  const feeUri = process.env.FEE_MANAGEMENT_MONGO_URI?.trim();
  const linesIn = Array.isArray(studentFeeDetails?.lines) ? studentFeeDetails.lines : [];
  const batch =
    studentFeeDetails?.batch != null && String(studentFeeDetails.batch).trim() !== ''
      ? String(studentFeeDetails.batch).trim().slice(0, 32)
      : joiningContext?.batch || null;

  const overrideMap = new Map();
  for (const line of linesIn) {
    const id = String(line?.structureId || '').trim();
    if (id) overrideMap.set(id, line);
  }

  const transportDetails = joiningContext?.transportDetails || null;
  const accommodationType = transportDetails?.accommodationType || null;
  const programTotalYears = resolveProgramTotalYearsForFeeSync(
    joiningContext?.course,
    joiningContext?.programTotalYears
  );

  if (!feeUri) {
    return {
      joiningId,
      leadId,
      batch,
      accommodationType,
      feePortal: { skipped: true, reason: 'FEE_MANAGEMENT_MONGO_URI not set' },
      transport: previewJoiningBusSync({ joiningId, leadId, joiningContext, portalLines: [] }),
      hostel: previewJoiningHostelSync({ joiningId, leadId, joiningContext, portalLines: [] }),
      lines: [],
      revisedLineCount: 0,
    };
  }

  const conn = await connectFeeManagement();
  const db = conn.db;

  const catalogResult = await loadCatalogFeeStructures(db, {
    course: joiningContext?.course || '',
    branch: joiningContext?.branch || '',
    quota: joiningContext?.quota || '',
    batch: batch || '',
    intakeBatch: joiningContext?.intakeBatch || '',
    admissionNumber: joiningContext?.admissionNumber || '',
    managedBranchId: joiningContext?.managedBranchId || null,
    studentStatus: joiningContext?.studentStatus || null,
  });
  const catalogRows = catalogResult.rows;
  const resolvedBatch = catalogResult.catalogLookup.resolvedBatch || batch;

  const accommodationRows = buildAccommodationCatalogRows(
    joiningContext?.transportDetails,
    overrideMap,
    await loadAccommodationFeeHeads(db),
    programTotalYears
  );

  const portalLines = buildPortalLines(catalogRows, accommodationRows, studentFeeDetails);
  const revisedLineCount = portalLines.filter((line) => line.isRevised).length;
  const intakeBatchYear = resolveRequestedFeeBatch({
    batch,
    intakeBatch: joiningContext?.intakeBatch,
    admissionNumber: joiningContext?.admissionNumber,
  });
  const transportSessionYear = resolveTransportAcademicYear(
    transportDetails,
    intakeBatchYear || batch || ''
  );

  const persistFeePortal = shouldPersistFeePortalMirror(catalogRows, accommodationRows);

  const feePortalDoc = !persistFeePortal
      ? {
          skipped: false,
          collection: JOINING_STUDENT_FEE_MONGO_COLLECTION,
          database: 'fee_management',
          operation: 'deleteOne',
          filter: { joiningId },
          reason:
            catalogRows.length === 0
              ? `No feestructures for batch ${catalogResult.catalogLookup.requestedBatch || batch || '—'}; fee mirror not stored`
              : 'No catalog or accommodation fee rows to persist',
        }
      : {
          skipped: false,
          collection: JOINING_STUDENT_FEE_MONGO_COLLECTION,
          database: 'fee_management',
          operation: 'replaceOne',
          filter: { joiningId },
          document: {
            joiningId,
            leadId: leadId && String(leadId).trim() !== '' ? String(leadId).trim() : null,
            admissionNumber: joiningContext?.admissionNumber || '',
            studentName: joiningContext?.studentName || '',
            course: joiningContext?.course || '',
            branch: joiningContext?.branch || '',
            quota: joiningContext?.quota || '',
            batch: batch || resolvedBatch,
            requestedBatch: batch,
            intakeBatch: intakeBatchYear || null,
            transportAcademicYear: transportSessionYear || null,
            batchMatchMode: catalogResult.catalogLookup.batchMatchMode,
            accommodationType,
            transportDetails,
            lines: portalLines,
            legacyLines: linesIn,
            source: 'admissions_crm',
          },
        };

  return {
    joiningId,
    leadId,
    joiningContext: {
      course: joiningContext?.course || '',
      branch: joiningContext?.branch || '',
      quota: joiningContext?.quota || '',
      batch: resolvedBatch || '',
      requestedBatch: batch || '',
      admissionNumber: joiningContext?.admissionNumber || '',
      studentName: joiningContext?.studentName || '',
      accommodationType,
    },
    catalogLookup: catalogResult.catalogLookup,
    catalogRowCount: catalogRows.length,
    accommodationRowCount: accommodationRows.length,
    lineCount: portalLines.length,
    revisedLineCount,
    lines: portalLines,
    feePortal: feePortalDoc,
    studentFees: {
      skipped: true,
      reason: 'Standard student fee assignment is handled by Fee Management /api/sync/student-fees after SQL student sync',
      admissionNumber: joiningContext?.admissionNumber || '',
    },
    transport: previewJoiningBusSync({ joiningId, leadId, joiningContext, portalLines }),
    hostel: previewJoiningHostelSync({ joiningId, leadId, joiningContext, portalLines }),
  };
}

/**
 * Push joining fee snapshot to Fee Management Mongo and external bus/hostel DBs.
 *
 * @param {object} params
 * @param {string} params.joiningId
 * @param {string | null} [params.leadId]
 * @param {object | null} [params.studentFeeDetails]
 * @param {object | null} [params.joiningContext]
 */
export async function syncJoiningStudentFeeDetailsToFeeMongo({
  joiningId,
  leadId = null,
  studentFeeDetails = null,
  joiningContext = null,
  user = null,
}) {
  if (!joiningId || typeof joiningId !== 'string') return { lines: [] };

  const linesIn = Array.isArray(studentFeeDetails?.lines) ? studentFeeDetails.lines : [];
  const batch =
    studentFeeDetails?.batch != null && String(studentFeeDetails.batch).trim() !== ''
      ? String(studentFeeDetails.batch).trim().slice(0, 32)
      : joiningContext?.batch || null;

  const overrideMap = new Map();
  for (const line of linesIn) {
    const id = String(line?.structureId || '').trim();
    if (id) overrideMap.set(id, line);
  }

  let portalLines = [];
  let studentFeesResult = { skipped: true, reason: 'Fee sync not attempted' };

  const uri = process.env.FEE_MANAGEMENT_MONGO_URI?.trim();
  if (!uri) {
    console.warn(
      '[joiningStudentFeeMongoSync] FEE_MANAGEMENT_MONGO_URI not set; skipping Fee DB mirror (bus/hostel sync still runs)'
    );
  } else {
    let conn;
    try {
      conn = await connectFeeManagement();
    } catch (err) {
      console.error('[joiningStudentFeeMongoSync] Failed to connect to Fee Management DB:', err);
      conn = null;
    }

    if (conn) {
      const db = conn.db;

      if (studentFeeDetails && Array.isArray(studentFeeDetails.lines) && studentFeeDetails.lines.length > 0) {
        try {
          const feeHeads = await db.collection('feeheads').find({}).toArray();
          const { normalizeFeeHeadInEntries } = await import('../utils/overallConcessions.util.js');
          studentFeeDetails.lines = normalizeFeeHeadInEntries(studentFeeDetails.lines, feeHeads);
        } catch (e) {
          console.warn('[syncJoiningStudentFeeDetailsToFeeMongo] Failed to normalize fee heads:', e.message);
        }
      }

      try {
        const catalogResult = await loadCatalogFeeStructures(db, {
          course: joiningContext?.course || '',
          branch: joiningContext?.branch || '',
          quota: joiningContext?.quota || '',
          batch: batch || '',
          intakeBatch: joiningContext?.intakeBatch || '',
          admissionNumber: joiningContext?.admissionNumber || '',
          managedBranchId: joiningContext?.managedBranchId || null,
          studentStatus: joiningContext?.studentStatus || null,
        });
        const catalogRows = catalogResult.rows;
        const resolvedBatch = catalogResult.catalogLookup.resolvedBatch || batch;

        const accommodationFeeHeads = await loadAccommodationFeeHeads(db);
        const programTotalYears = resolveProgramTotalYearsForFeeSync(
          joiningContext?.course,
          joiningContext?.programTotalYears
        );
        const accommodationRows = buildAccommodationCatalogRows(
          joiningContext?.transportDetails,
          overrideMap,
          accommodationFeeHeads,
          programTotalYears
        );

        portalLines = buildPortalLines(catalogRows, accommodationRows, studentFeeDetails);

        const coll = conn.db.collection(JOINING_STUDENT_FEE_MONGO_COLLECTION);
        const transportDetails = joiningContext?.transportDetails || null;
        const accommodationType = transportDetails?.accommodationType || null;
        const intakeBatchYear = resolveRequestedFeeBatch({
          batch,
          intakeBatch: joiningContext?.intakeBatch,
          admissionNumber: joiningContext?.admissionNumber,
        });
        const transportSessionYear = resolveTransportAcademicYear(
          transportDetails,
          intakeBatchYear || batch || ''
        );

        if (!shouldPersistFeePortalMirror(catalogRows, accommodationRows)) {
          await coll.deleteOne({ joiningId });
        } else {
          await coll.replaceOne(
            { joiningId },
            {
              joiningId,
              leadId: leadId && String(leadId).trim() !== '' ? String(leadId).trim() : null,
              admissionNumber: joiningContext?.admissionNumber || '',
              studentName: joiningContext?.studentName || '',
              course: joiningContext?.course || '',
              branch: joiningContext?.branch || '',
              quota: joiningContext?.quota || '',
              batch: batch || resolvedBatch,
              requestedBatch: batch,
              intakeBatch: intakeBatchYear || null,
              transportAcademicYear: transportSessionYear || null,
              batchMatchMode: catalogResult.catalogLookup.batchMatchMode,
              accommodationType,
              transportDetails,
              lines: portalLines,
              legacyLines: linesIn,
              updatedAt: new Date(),
              source: 'admissions_crm',
            },
            { upsert: true }
          );
        }

        studentFeesResult = {
          skipped: true,
          reason: 'Standard student fee assignment is handled by Fee Management /api/sync/student-fees after SQL student sync',
          admissionNumber: joiningContext?.admissionNumber || '',
        };
      } catch (err) {
        console.error(
          '[joiningStudentFeeMongoSync] Fee Mongo mirror failed (SQL save still succeeded):',
          err?.message || err
        );
      }
    }
  }

  // Always attempt bus/hostel external sync — independent of Fee Management Mongo URI.
  await syncJoiningAccommodationToExternalDbs({
    joiningId,
    leadId,
    joiningContext,
    portalLines,
    user,
  });

  return { lines: portalLines, studentFees: studentFeesResult };
}
