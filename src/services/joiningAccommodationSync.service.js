import mongoose from 'mongoose';
import { connectTransport } from '../config-mongo/transport.js';
import { connectHostel } from '../config-mongo/hostel.js';
import { getPool } from '../config-sql/database.js';
import {
  previewJoiningTransportRequestSync,
  syncJoiningBusToTransportRequestMysql,
} from './joiningTransportRequestSync.service.js';
import { resolveTransportAcademicYear } from '../utils/transportApplicationNumber.util.js';
import { assignHostelStudentId } from '../utils/hostelStudentId.util.js';
import {
  normalizeBrokenHostelRefField,
  resolveHmsTermFees,
  resolveNextBedAndLocker,
  toStoredHostelRefId,
  upsertHostelRoomOccupancyHistory,
} from '../utils/hostelHmsSync.util.js';
import { isValidCrmRollNumberFormat } from '../utils/studentRollNumber.util.js';

const { Types: { ObjectId } } = mongoose;

const toObjectId = (value) => {
  if (value instanceof ObjectId) return value;
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw || !/^[a-fA-F0-9]{24}$/.test(raw)) return null;
  try {
    return new ObjectId(raw);
  } catch {
    return null;
  }
};

const refMatch = (value) => {
  const raw = String(value || '').trim();
  const oid = toObjectId(raw);
  const keys = new Set([raw]);
  if (oid) keys.add(oid);
  return { $in: [...keys] };
};

const isSyntheticRollNumber = (value) => {
  const roll = String(value || '').trim().toUpperCase();
  return roll.startsWith('ADM-') || roll.startsWith('JOIN-');
};

/** Legacy CRM sync wrote `ADM-{admissionNumber}` — normalize to plain admission number. */
const normalizeStoredRollNumber = (value, admissionNumber) => {
  const roll = String(value || '').trim();
  if (!roll) return '';
  const upper = roll.toUpperCase();
  const adm = String(admissionNumber || '').trim().toUpperCase();
  if (adm && upper === `ADM-${adm}`) return adm;
  if (isSyntheticRollNumber(roll)) return '';
  return upper;
};

const isInterimAdmissionRoll = (roll, admissionNumber) => {
  const r = String(roll || '').trim().toUpperCase();
  const adm = String(admissionNumber || '').trim().toUpperCase();
  return Boolean(adm && r === adm);
};

const isRealHostelRollNumber = (roll, admissionNumber) => {
  const normalized = normalizeStoredRollNumber(roll, admissionNumber);
  if (!normalized) return false;
  if (isInterimAdmissionRoll(normalized, admissionNumber)) return false;
  if (/^20\d{6}$/.test(normalized)) return false;
  return isValidCrmRollNumberFormat(normalized) || !/^20\d+$/.test(normalized);
};

/**
 * HMS `users.rollNumber` has a unique index in production.
 * Before a CRM branch roll (e.g. 26DCSE001) is assigned, use the plain admission
 * number — never the legacy `ADM-{admissionNumber}` placeholder.
 */
const resolveHostelRollNumber = ({
  joiningContext,
  existing,
  admissionNumber,
  joiningId,
  secondaryRollNumber = '',
}) => {
  const adm = String(admissionNumber || '').trim().toUpperCase();
  const candidates = [
    joiningContext?.rollNumber,
    secondaryRollNumber,
    existing?.rollNumber,
  ];

  for (const raw of candidates) {
    const normalized = normalizeStoredRollNumber(raw, admissionNumber);
    if (!normalized) continue;
    if (isRealHostelRollNumber(normalized, admissionNumber)) return normalized;
  }

  if (adm) return adm;

  const join = String(joiningId || '').trim();
  if (join) return `JOIN-${join}`;

  return undefined;
};

async function fetchSecondaryRollForAdmission(admissionNumber) {
  const adm = String(admissionNumber || '').trim();
  if (!adm) return '';

  try {
    const { getPool: getSecondaryPool } = await import('../config-sql/database-secondary.js');
    const pool = getSecondaryPool();
    const [rows] = await pool.execute(
      `SELECT r.roll_number, s.pin_no
       FROM students s
       LEFT JOIN student_roll_numbers r ON r.student_id = s.id
       WHERE s.admission_number = ?
       LIMIT 1`,
      [adm]
    );
    const row = rows?.[0];
    const roll = normalizeStoredRollNumber(row?.roll_number || row?.pin_no || '', admissionNumber);
    return isRealHostelRollNumber(roll, admissionNumber) ? roll : '';
  } catch (err) {
    console.warn('[joiningAccommodationSync] secondary roll lookup failed:', err?.message || err);
    return '';
  }
}

/** HCMS-aligned user lookup: admission → real roll/PIN → CRM joiningId. */
const findExistingHmsUser = async (users, { admissionNumber, rollNumber, joiningId }) => {
  const adm = String(admissionNumber || '').trim().toUpperCase();
  if (adm) {
    const byAdmission = await users.findOne({ admissionNumber: adm });
    if (byAdmission) return byAdmission;
  }

  const roll = String(rollNumber || '').trim().toUpperCase();
  if (roll && !isSyntheticRollNumber(roll)) {
    const byRoll = await users.findOne({ rollNumber: roll });
    if (byRoll) return byRoll;
  }

  if (joiningId) {
    return users.findOne({ joiningId, source: 'admissions_crm' });
  }

  return null;
};

/** Expire prior-year active hostel requests when registering for a new academic year. */
const expirePriorActiveHostelRequests = async (hostelrequests, { admissionNumber, academicYear }) => {
  const adm = String(admissionNumber || '').trim().toUpperCase();
  if (!adm || !academicYear) return;

  await hostelrequests.updateMany(
    {
      admissionNumber: adm,
      academicYear: { $ne: academicYear },
      status: 'active',
    },
    {
      $set: {
        status: 'expired',
        expiredAt: new Date(),
        statusReason: 'new_academic_year_registration',
        updatedAt: new Date(),
      },
    }
  );
};

const buildSdmsSnapshot = ({ joiningContext, gender, resolvedRollNumber, studentYear }) => {
  const roll = String(resolvedRollNumber || '').trim().toUpperCase();
  return {
    sdmsRollNumber: isRealHostelRollNumber(roll, joiningContext?.admissionNumber) ? roll : undefined,
    sdmsName: joiningContext.studentName || undefined,
    sdmsGender: gender || undefined,
    sdmsCourse: joiningContext.course || undefined,
    sdmsBranch: joiningContext.branch || undefined,
    sdmsYearOfStudy: studentYear,
    sdmsBatch: joiningContext.intakeBatch || joiningContext.batch || undefined,
    sdmsCollegeName: joiningContext.collegeName || joiningContext.college || undefined,
    sdmsSyncedAt: new Date(),
  };
};

/**
 * Mirror bus selection into the Transport MongoDB (`studentfees` collection).
 */
export async function syncJoiningBusToTransportMongo({ joiningId, leadId, joiningContext, busLines }) {
  const uri = process.env.TRANSPORT_MONGO_URI?.trim();
  if (!uri) {
    console.warn('[joiningAccommodationSync] TRANSPORT_MONGO_URI not set; skipping bus sync');
    return;
  }

  const transport = joiningContext?.transportDetails;
  if (!transport || transport.accommodationType !== 'bus') return;
  if (!transport.routeId || !transport.stageId) return;

  const conn = await connectTransport();
  const coll = conn.db.collection('studentfees');

  const busLine = (busLines || []).find((line) => line.accommodationType === 'bus') || busLines?.[0];
  const actualFare = busLine?.actualAmount ?? Number(transport.stageFare) ?? 0;
  const revisedFare = busLine?.revisedAmount ?? actualFare;

  const transportSessionYear = resolveTransportAcademicYear(
    transport,
    joiningContext?.intakeBatch || joiningContext?.batch || ''
  );

  const doc = {
    joiningId,
    leadId: leadId || null,
    admissionNumber: joiningContext.admissionNumber || '',
    studentName: joiningContext.studentName || '',
    routeId: transport.routeId,
    routeName: transport.routeName || '',
    stageId: transport.stageId,
    stageName: transport.stageName || '',
    academicYear: transportSessionYear,
    busId:
      transport.busId || transport.busNumber || transport.bus_id || null,
    busNumber:
      transport.busNumber || transport.busId || transport.bus_id || null,
    actualFare,
    revisedFare,
    isRevised: revisedFare !== actualFare,
    batch: joiningContext.intakeBatch || joiningContext.batch || '',
    feeHeadCode: 'TRN01',
    feeHeadName: 'Bus Fee',
    source: 'admissions_crm',
    isActive: true,
    updatedAt: new Date(),
  };

  await coll.replaceOne({ joiningId }, doc, { upsert: true });
}

/**
 * Create or update a hostel student row in HMS (`users` collection).
 */
export async function syncJoiningHostelToHmsMongo({ joiningId, leadId, joiningContext, hostelLines }) {
  const uri = process.env.HOSTEL_MONGO_URI?.trim();
  if (!uri) {
    console.warn('[joiningAccommodationSync] HOSTEL_MONGO_URI not set; skipping hostel sync');
    return;
  }

  const transport = joiningContext?.transportDetails;
  if (!transport || transport.accommodationType !== 'hostel') return;
  if (!transport.hostelId || !transport.categoryId) return;

  const admissionNumber = String(joiningContext.admissionNumber || '').trim().toUpperCase();
  if (!admissionNumber) {
    console.warn(
      '[joiningAccommodationSync] Skipping HMS hostel sync: admissionNumber is required for HCMS StudentMaster + HostelRequest'
    );
    return { skipped: true, reason: 'admission_number_required' };
  }

  const conn = await connectHostel();
  const db = conn.db;
  const users = db.collection('users');
  const studentmasters = db.collection('studentmasters');
  const hostelrequests = db.collection('hostelrequests');

  const hostelLine = (hostelLines || []).find((line) => line.accommodationType === 'hostel') || hostelLines?.[0];
  const actualFee = hostelLine?.actualAmount ?? Number(transport.hostelFee) ?? 0;
  const revisedFee = hostelLine?.revisedAmount ?? actualFee;

  const genderRaw = String(joiningContext.studentGender || '').trim().toLowerCase();
  const gender =
    genderRaw.startsWith('f') ? 'Female' : genderRaw.startsWith('m') ? 'Male' : joiningContext.studentGender || '';

  const transportSessionYear = resolveTransportAcademicYear(
    transport,
    joiningContext?.intakeBatch || joiningContext?.batch || ''
  );

  const existingRequestKey = { admissionNumber, academicYear: transportSessionYear };

  const existingRequest = await hostelrequests.findOne(existingRequestKey);
  const existingHostelSequenceId = existingRequest?.hostelSequenceId || null;

  const existingUser = await findExistingHmsUser(users, {
    admissionNumber,
    rollNumber: joiningContext.rollNumber,
    joiningId,
  });
  const secondaryRollNumber = await fetchSecondaryRollForAdmission(admissionNumber);
  const resolvedRollNumber = resolveHostelRollNumber({
    joiningContext,
    existing: existingUser,
    admissionNumber,
    joiningId,
    secondaryRollNumber,
  });

  let collegeCode = joiningContext?.collegeCode || '';
  let courseCode = joiningContext?.courseCode || '';

  if (!collegeCode || !courseCode) {
    const pool = getPool();
    let sqlRow = null;
    if (admissionNumber) {
      const [rows] = await pool.execute(
        'SELECT managed_course_id, course FROM admissions WHERE admission_number = ? LIMIT 1',
        [admissionNumber]
      );
      if (rows?.[0]) sqlRow = rows[0];
    }
    if (!sqlRow && joiningId) {
      const [rows] = await pool.execute(
        'SELECT managed_course_id, course FROM joinings WHERE id = ? LIMIT 1',
        [joiningId]
      );
      if (rows?.[0]) sqlRow = rows[0];
    }
    if (sqlRow) {
      const { resolveTransportApplicationCodes } = await import('../utils/transportApplicationNumber.util.js');
      try {
        const { getPool: getSecondaryPool } = await import('../config-sql/database-secondary.js');
        const secPool = getSecondaryPool();
        const resolved = await resolveTransportApplicationCodes(secPool, {
          managedCourseId: sqlRow.managed_course_id,
          courseName: sqlRow.course,
        });
        if (resolved.collegeCode) collegeCode = resolved.collegeCode;
        if (resolved.courseCode) courseCode = resolved.courseCode;
      } catch (err) {
        console.warn('Failed to resolve fallback codes for sync:', err);
      }
    }
  }

  await expirePriorActiveHostelRequests(hostelrequests, {
    admissionNumber,
    academicYear: transportSessionYear,
  });

  const hostelIdAssignment = await assignHostelStudentId(db, {
    hostelObjectId: transport.hostelId,
    academicYear: transportSessionYear,
    gender,
    existingHostelId: existingHostelSequenceId,
    collegeCode,
    courseCode,
  });

  const studentYear = Math.max(1, Number(joiningContext.yearOfStudy || joiningContext.currentYear || 1));
  const termFees = await resolveHmsTermFees(db, {
    academicYear: transportSessionYear,
    course: joiningContext.course || '',
    categoryName: transport.categoryName || '',
    studentYear,
  });

  let bedNumber = existingRequest?.bedNumber || '';
  let lockerNumber = existingRequest?.lockerNumber || '';
  const roomObjectId = transport.roomId ? toStoredHostelRefId(transport.roomId) : null;
  if (transport.roomId && transport.roomNumber && (!bedNumber || !lockerNumber)) {
    const roomDoc = await db.collection('rooms').findOne({ _id: roomObjectId });
    const bedLocker = await resolveNextBedAndLocker(db, {
      roomId: transport.roomId,
      roomNumber: transport.roomNumber,
      academicYear: transportSessionYear,
      bedCount: roomDoc?.bedCount,
    });
    bedNumber = bedLocker.bedNumber || bedNumber;
    lockerNumber = bedLocker.lockerNumber || lockerNumber;
  }

  const parseHostelDate = (raw) => {
    if (raw == null || String(raw).trim() === '') return null;
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  // Admit date comes from Step 3 (defaults to today). Never write joiningDate from admissions.
  const admitDateValue =
    parseHostelDate(transport.admitDate) ||
    parseHostelDate(existingRequest?.admitDate) ||
    parseHostelDate(existingRequest?.createdAt) ||
    new Date();

  const sdmsSnapshot = buildSdmsSnapshot({
    joiningContext,
    gender,
    resolvedRollNumber,
    studentYear,
  });

  // 1. Upsert User (identity only — no room/hostel allocation on users)
  const userBaseDoc = {
    name: joiningContext.studentName || '',
    admissionNumber,
    rollNumber: resolvedRollNumber,
    joiningId,
    leadId: leadId || null,
    role: 'student',
    course: joiningContext.course || '',
    branch: joiningContext.branch || '',
    gender,
    studentPhone: joiningContext.studentPhone || '',
    parentPhone: joiningContext.fatherPhone || '',
    batch: joiningContext.intakeBatch || joiningContext.batch || '',
    academicYear: transportSessionYear,
    applicationStatus: 'Active',
    graduationStatus: 'Enrolled',
    source: 'admissions_crm',
    syncedAt: new Date(),
    updatedAt: new Date(),
  };

  let userId = existingUser?._id;

  if (existingUser) {
    await users.updateOne({ _id: existingUser._id }, { $set: userBaseDoc });
  } else {
    const insertResult = await users.insertOne({
      ...userBaseDoc,
      createdAt: new Date(),
    });
    userId = insertResult.insertedId;
  }

  // 2. Upsert StudentMaster (required before HostelRequest in HCMS)
  const studentMasterResult = await studentmasters.findOneAndUpdate(
    { admissionNumber },
    {
      $set: {
        userId,
        name: joiningContext.studentName || '',
        rollNumber: resolvedRollNumber || '',
        studentPhone: joiningContext.studentPhone || '',
        parentPhone: joiningContext.fatherPhone || '',
        contacts: {
          studentPhone: joiningContext.studentPhone || '',
          parentPhone: joiningContext.fatherPhone || '',
        },
        lastSdmsSyncAt: new Date(),
        updatedAt: new Date(),
      },
      $setOnInsert: { createdAt: new Date(), isActive: true },
    },
    { upsert: true, returnDocument: 'after' }
  );
  let studentMasterId =
    studentMasterResult?._id ||
    studentMasterResult?.value?._id ||
    existingRequest?.studentMasterId ||
    null;
  if (!studentMasterId) {
    const masterDoc = await studentmasters.findOne({ admissionNumber });
    studentMasterId = masterDoc?._id || null;
  }
  if (!studentMasterId) {
    throw new Error(`StudentMaster upsert failed for admission ${admissionNumber}`);
  }

  // 3. Upsert HostelRequest (academic-year source of truth for allocation)
  const hostelRequestDoc = {
    status: 'active',
    studentMasterId,
    admissionNumber,
    hostelId: toStoredHostelRefId(transport.hostelId),
    hostelCategoryId: toStoredHostelRefId(transport.categoryId),
    ...(roomObjectId ? { roomId: roomObjectId } : {}),
    ...(transport.roomNumber ? { roomNumber: transport.roomNumber } : {}),
    bedNumber: bedNumber || undefined,
    lockerNumber: lockerNumber || undefined,
    hostelSequenceId: hostelIdAssignment.hostelSequenceId || hostelIdAssignment.hostelId,
    academicYear: transportSessionYear,
    collegeCode: hostelIdAssignment.collegeCode || collegeCode || null,
    courseCode: hostelIdAssignment.courseCode || courseCode || null,
    hostelCode: hostelIdAssignment.hostelCode || null,
    yearlySequenceNumber: hostelIdAssignment.sequence || null,
    joiningId,
    leadId: leadId || null,
    admitDate: admitDateValue,
    joiningDate: existingRequest?.joiningDate ?? null,
    leftDate: existingRequest?.leftDate ?? null,
    mealType: existingRequest?.mealType || 'veg',
    parentPermissionForOuting:
      existingRequest?.parentPermissionForOuting !== undefined
        ? existingRequest.parentPermissionForOuting
        : true,
    concession: existingRequest?.concession ?? 0,
    actualHostelFee: actualFee,
    revisedHostelFee: revisedFee,
    isHostelFeeRevised: revisedFee !== actualFee,
    ...(termFees || {}),
    ...sdmsSnapshot,
    source: 'admissions_crm',
    updatedAt: new Date(),
  };

  await hostelrequests.updateOne(
    existingRequestKey,
    {
      $set: hostelRequestDoc,
      $setOnInsert: {
        createdAt: new Date(),
        allocatedAt: new Date(),
      },
    },
    { upsert: true }
  );

  const savedRequest = await hostelrequests.findOne(existingRequestKey);
  const hostelRequestId = savedRequest?._id || null;

  // 4. Room occupancy history — link to users._id and hostelRequestId
  if (transport.roomId && userId) {
    await upsertHostelRoomOccupancyHistory(db, {
      studentUserId: userId,
      studentName: joiningContext.studentName || '',
      rollNumber: resolvedRollNumber || '',
      course: joiningContext.course || '',
      branch: joiningContext.branch || '',
      yearOfStudy: studentYear,
      academicYear: transportSessionYear,
      hostelId: transport.hostelId,
      categoryId: transport.categoryId,
      roomId: transport.roomId,
      roomNumber: transport.roomNumber || '',
      bedNumber,
      lockerNumber,
      hostelRequestId,
    });
  }

  return hostelIdAssignment;
}

/** Dry-run: document that would be upserted into Transport `studentfees`. */
export function previewJoiningBusSync({ joiningId, leadId, joiningContext, portalLines }) {
  const transportRequestPreview = previewJoiningTransportRequestSync({ joiningContext });
  const uri = process.env.TRANSPORT_MONGO_URI?.trim();
  if (!uri) {
    return {
      ...transportRequestPreview,
      legacyStudentFees: { skipped: true, reason: 'TRANSPORT_MONGO_URI not set' },
    };
  }

  const transport = joiningContext?.transportDetails;
  if (!transport || transport.accommodationType !== 'bus') {
    return { skipped: true, reason: 'No bus accommodation on joining' };
  }
  if (!transport.routeId || !transport.stageId) {
    return { skipped: true, reason: 'Bus route or stage not selected' };
  }

  const accommodationLines = (portalLines || []).filter((line) => line.accommodationType === 'bus');
  const busLine =
    accommodationLines.find((line) => line.accommodationType === 'bus') || accommodationLines[0];
  const actualFare = busLine?.actualAmount ?? Number(transport.stageFare) ?? 0;
  const revisedFare = busLine?.revisedAmount ?? actualFare;

  const transportSessionYear = resolveTransportAcademicYear(
    transport,
    joiningContext?.intakeBatch || joiningContext?.batch || ''
  );

  return {
    skipped: false,
    transportRequest: transportRequestPreview,
    collection: 'studentfees',
    database: 'transport',
    operation: 'replaceOne',
    filter: { joiningId },
    document: {
      joiningId,
      leadId: leadId || null,
      admissionNumber: joiningContext.admissionNumber || '',
      studentName: joiningContext.studentName || '',
      routeId: transport.routeId,
      routeName: transport.routeName || '',
      stageId: transport.stageId,
      stageName: transport.stageName || '',
      academicYear: transportSessionYear,
      actualFare,
      revisedFare,
      isRevised: revisedFare !== actualFare,
      batch: joiningContext.intakeBatch || joiningContext.batch || '',
      feeHeadCode: 'TRN01',
      feeHeadName: 'Bus Fee',
      source: 'admissions_crm',
    },
  };
}

/** Dry-run: document that would be inserted/updated in HMS collections. */
export function previewJoiningHostelSync({ joiningId, leadId, joiningContext, portalLines }) {
  const uri = process.env.HOSTEL_MONGO_URI?.trim();
  if (!uri) return { skipped: true, reason: 'HOSTEL_MONGO_URI not set' };

  const transport = joiningContext?.transportDetails;
  if (!transport || transport.accommodationType !== 'hostel') {
    return { skipped: true, reason: 'No hostel accommodation on joining' };
  }
  if (!transport.hostelId || !transport.categoryId) {
    return { skipped: true, reason: 'Hostel or category not selected' };
  }

  const accommodationLines = (portalLines || []).filter((line) => line.accommodationType === 'hostel');
  const hostelLine =
    accommodationLines.find((line) => line.accommodationType === 'hostel') || accommodationLines[0];
  const actualFee = hostelLine?.actualAmount ?? Number(transport.hostelFee) ?? 0;
  const revisedFee = hostelLine?.revisedAmount ?? actualFee;

  const genderRaw = String(joiningContext.studentGender || '').trim().toLowerCase();
  const gender =
    genderRaw.startsWith('f') ? 'Female' : genderRaw.startsWith('m') ? 'Male' : joiningContext.studentGender || '';

  const admissionNumber = String(joiningContext.admissionNumber || '').trim().toUpperCase();
  if (!admissionNumber) {
    return { skipped: true, reason: 'admission_number_required_for_hcms_sync' };
  }

  const previewRollNumber =
    String(joiningContext.rollNumber || '').trim() ||
    admissionNumber;
  const transportSessionYear = resolveTransportAcademicYear(
    transport,
    joiningContext?.intakeBatch || joiningContext?.batch || ''
  );
  const collegeCode = joiningContext?.collegeCode || '';
  const courseCode = joiningContext?.courseCode || '';

  return {
    skipped: false,
    database: 'hostel_hms',
    operations: [
      {
        collection: 'users',
        operation: 'upsert',
        lookupOrder: ['admissionNumber', 'rollNumber', 'joiningId+source'],
        lookup: { admissionNumber },
        document: {
          name: joiningContext.studentName || '',
          admissionNumber,
          rollNumber: previewRollNumber,
          joiningId,
          leadId: leadId || null,
          role: 'student',
          course: joiningContext.course || '',
          branch: joiningContext.branch || '',
          gender,
          studentPhone: joiningContext.studentPhone || '',
          parentPhone: joiningContext.fatherPhone || '',
          batch: joiningContext.batch || '',
          academicYear: transportSessionYear,
          applicationStatus: 'Active',
          graduationStatus: 'Enrolled',
          source: 'admissions_crm',
        },
      },
      {
        collection: 'studentmasters',
        operation: 'upsert',
        lookup: { admissionNumber },
        document: {
          admissionNumber,
          userId: '(user._id reference)',
          name: joiningContext.studentName || '',
          rollNumber: previewRollNumber || '',
          studentPhone: joiningContext.studentPhone || '',
          parentPhone: joiningContext.fatherPhone || '',
        },
      },
      {
        collection: 'hostelrequests',
        operation: 'upsert',
        lookup: { admissionNumber, academicYear: transportSessionYear },
        preActions: ['expire prior active requests for other academic years'],
        document: {
          status: 'active',
          studentMasterId: '(studentmasters._id — required)',
          hostelId: transport.hostelId,
          hostelCategoryId: transport.categoryId,
          roomId: transport.roomId || undefined,
          roomNumber: transport.roomNumber || '',
          admitDate: transport.admitDate || '(defaults to today)',
          hostelSequenceId:
            collegeCode && courseCode
              ? `(HCMS counter — ${collegeCode.trim().toUpperCase()}${courseCode.trim().toUpperCase()}{hostel.code}+3-digit serial)`
              : '(legacy BH/GH serial fallback)',
          academicYear: transportSessionYear,
          admissionNumber,
          sdmsCourse: joiningContext.course || '',
          sdmsBranch: joiningContext.branch || '',
          joiningId,
          leadId: leadId || null,
          actualHostelFee: actualFee,
          revisedHostelFee: revisedFee,
          isHostelFeeRevised: revisedFee !== actualFee,
          source: 'admissions_crm',
        },
      },
    ],
  };
}

export async function syncJoiningAccommodationToExternalDbs({
  joiningId,
  leadId,
  joiningContext,
  portalLines,
  user = null,
}) {
  if (!joiningId) return;

  const accommodationType = joiningContext?.transportDetails?.accommodationType;
  const accommodationLines = (portalLines || []).filter((line) => line.accommodationType);

  try {
    if (accommodationType === 'bus') {
      await syncJoiningBusToTransportRequestMysql({ joiningId, joiningContext, user });
      await syncJoiningBusToTransportMongo({
        joiningId,
        leadId,
        joiningContext,
        busLines: accommodationLines,
      });
    } else if (accommodationType === 'hostel') {
      await syncJoiningHostelToHmsMongo({
        joiningId,
        leadId,
        joiningContext,
        hostelLines: accommodationLines,
      });
    }
  } catch (err) {
    console.error(
      '[joiningAccommodationSync] External accommodation sync failed (SQL save still succeeded):',
      err?.message || err
    );
  }
}
