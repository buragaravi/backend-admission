import mongoose from 'mongoose';
import {
  connectHostel,
  getHostelConnection,
} from '../config-mongo/hostel.js';
import { mapCourseLabel } from '../data/admissionsCourseBranchMap2026.js';
import { successResponse, errorResponse } from '../utils/response.util.js';
import { getPool } from '../config-sql/database.js';

const { Types: { ObjectId } } = mongoose;

const getActiveConnection = async () => {
  try {
    return getHostelConnection();
  } catch {
    return connectHostel();
  }
};

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

const toObjectIdOrString = (value) => {
  const oid = toObjectId(value);
  return oid || String(value || '').trim();
};

/** Match Mongo refs stored as ObjectId or plain string. */
const refMatch = (value) => {
  const raw = String(value || '').trim();
  const oid = toObjectId(raw);
  const keys = new Set([raw]);
  if (oid) keys.add(oid);
  return { $in: [...keys] };
};

const normalizeAcademicYear = (value) => String(value || '').trim();

const compareAcademicYearsDesc = (a, b) => normalizeAcademicYear(b).localeCompare(normalizeAcademicYear(a));

const formatFeeDoc = (doc) => ({
  _id: String(doc._id),
  amount: doc.amount ?? null,
  course: doc.course || '',
  academicYear: doc.academicYear || '',
  studentYear:
    doc.studentYear !== undefined && doc.studentYear !== null
      ? Number(doc.studentYear)
      : null,
  description: doc.description || '',
});

/**
 * Hostel fee catalogs are keyed by base program (B.Tech), not lateral display labels.
 * "B.Tech (LATERAL)" → lookup "B.Tech"; year-of-study (2+) selects the fee row.
 */
const hostelCourseLookupLabels = (course) => {
  const raw = String(course || '').trim();
  if (!raw) return [];
  const labels = [];
  const mapped = mapCourseLabel(raw);
  // Prefer base catalog name first so lateral students hit B.Tech / Diploma configs.
  if (mapped) labels.push(mapped);
  if (raw && raw.toLowerCase() !== String(mapped || '').toLowerCase()) {
    labels.push(raw);
  }
  return [...new Set(labels.filter(Boolean))];
};

const courseRefToIdString = (value) => {
  if (value == null) return '';
  if (typeof value === 'object') {
    if (value._id) return String(value._id).trim();
    if (typeof value.toHexString === 'function') return value.toHexString();
  }
  return String(value).trim();
};

const isMongoObjectIdString = (value) => /^[a-fA-F0-9]{24}$/.test(String(value || '').trim());

const resolveHostelCourseLabel = async (db, courseRef, cache = new Map()) => {
  const raw = courseRefToIdString(courseRef);
  if (!raw) return '';
  if (!isMongoObjectIdString(raw)) return raw;
  if (cache.has(raw)) return cache.get(raw);

  const courseDoc = await db.collection('courses').findOne(
    { _id: toObjectIdOrString(raw) },
    { projection: { name: 1, courseName: 1, title: 1 } }
  );
  const label = String(
    courseDoc?.name || courseDoc?.courseName || courseDoc?.title || ''
  ).trim();
  const resolved = label || raw;
  cache.set(raw, resolved);
  return resolved;
};

const sumHmsFeePortalAmount = (doc) => {
  const termTotal =
    (Number(doc.term1Fee) || 0) +
    (Number(doc.term2Fee) || 0) +
    (Number(doc.term3Fee) || 0);
  const additional = doc.additionalFees;
  let additionalTotal = 0;
  if (additional && typeof additional === 'object' && !Array.isArray(additional)) {
    for (const value of Object.values(additional)) {
      additionalTotal += Number(value) || 0;
    }
  }
  const total = termTotal + additionalTotal;
  return Number.isFinite(total) && total > 0 ? total : null;
};

const formatHmsFeePortalDoc = (doc, courseLabel = '') => {
  const course =
    String(courseLabel || '').trim() ||
    (doc.course && typeof doc.course === 'object'
      ? courseRefToIdString(doc.course)
      : String(doc.course || '').trim());
  return {
    _id: String(doc._id),
    amount: sumHmsFeePortalAmount(doc),
    course,
    academicYear: doc.academicYear || '',
    studentYear: doc.year !== undefined && doc.year !== null ? Number(doc.year) : null,
    description: 'HMS fee structure config',
  };
};

const loadHostelCategoryName = async (db, categoryId) => {
  const category = await db.collection('hostelcategories').findOne({
    _id: toObjectIdOrString(categoryId),
  });
  return String(category?.name || '').trim();
};

const buildHmsCourseMatchers = async (db, course) => {
  const labels = hostelCourseLookupLabels(course);
  if (labels.length === 0) return [];

  const matchers = labels.map((label) => new RegExp(`^${escapeRegex(label)}$`, 'i'));

  const courseDocs = await db
    .collection('courses')
    .find({
      $or: labels.flatMap((label) => [
        { name: new RegExp(`^${escapeRegex(label)}$`, 'i') },
        { courseName: new RegExp(`^${escapeRegex(label)}$`, 'i') },
        { title: new RegExp(`^${escapeRegex(label)}$`, 'i') },
      ]),
    })
    .project({ _id: 1 })
    .toArray();

  for (const courseDoc of courseDocs) {
    matchers.push(courseDoc._id);
  }

  return matchers;
};

const buildCourseRegexes = (courseName) => {
  const labels = hostelCourseLookupLabels(courseName);
  return labels.map((label) => new RegExp(`^${escapeRegex(label)}$`, 'i'));
};

const filterFeeDocsByCourse = (docs, courseName) => {
  if (!courseName || !Array.isArray(docs) || docs.length === 0) return docs;
  const labels = new Set(
    hostelCourseLookupLabels(courseName).map((l) => l.toLowerCase())
  );
  const filtered = docs.filter((doc) => {
    const course = String(doc.course || '').trim().toLowerCase();
    return course && labels.has(course);
  });
  return filtered;
};

const findLegacyHostelFeeDocs = async (db, { hostelId, categoryId, academicYear, course }) => {
  const baseQuery = {
    hostel: refMatch(hostelId),
    category: refMatch(categoryId),
  };

  const courseName = String(course || '').trim();
  const normalizedYear = normalizeAcademicYear(academicYear);

  const queryWithFilters = (yearFilter, courseFilter) => {
    const query = { ...baseQuery };
    if (yearFilter) query.academicYear = yearFilter;
    if (courseFilter) query.course = courseFilter;
    return query;
  };

  const courseRegexes = buildCourseRegexes(courseName);

  const attempts = [];

  if (normalizedYear && courseRegexes.length > 0) {
    for (const courseRegex of courseRegexes) {
      attempts.push(queryWithFilters(normalizedYear, courseRegex));
    }
  } else if (normalizedYear) {
    // No course on the student — year-wide category fee is acceptable.
    attempts.push(queryWithFilters(normalizedYear, null));
  }

  // When a session year is requested (e.g. 2026-2027 from Step 1), do not fall back to
  // fee rows from other academic years — that surfaces stale test amounts (e.g. ₹10).
  if (!normalizedYear) {
    for (const courseRegex of courseRegexes) {
      attempts.push(queryWithFilters(null, courseRegex));
    }
    if (courseRegexes.length === 0) {
      attempts.push(baseQuery);
    }
  }

  for (const query of attempts) {
    const docs = await db.collection('hostelfeestructures').find(query).toArray();
    const matchedDocs = courseName ? filterFeeDocsByCourse(docs, courseName) : docs;
    if (matchedDocs.length > 0) {
      const resolved = normalizeAcademicYear(
        matchedDocs.find((doc) => normalizeAcademicYear(doc.academicYear))?.academicYear ||
          matchedDocs[0]?.academicYear ||
          normalizedYear ||
          ''
      );
      return {
        docs: matchedDocs,
        resolvedAcademicYear: resolved,
        matchedBy: 'legacy',
      };
    }
  }

  return { docs: [], resolvedAcademicYear: normalizedYear, matchedBy: 'none' };
};

/** HMS portal fee config (`feestructures` collection). */
const findHmsFeePortalDocs = async (db, { categoryId, academicYear, course }) => {
  const normalizedYear = normalizeAcademicYear(academicYear);
  if (!normalizedYear || !categoryId) {
    return { docs: [], resolvedAcademicYear: normalizedYear, matchedBy: 'none' };
  }

  const categoryName = await loadHostelCategoryName(db, categoryId);
  if (!categoryName) {
    return { docs: [], resolvedAcademicYear: normalizedYear, matchedBy: 'none' };
  }

  const courseMatchers = await buildHmsCourseMatchers(db, course);
  const query = {
    academicYear: normalizedYear,
    category: categoryName,
    isActive: { $ne: false },
  };

  if (courseMatchers.length > 0) {
    query.course = { $in: courseMatchers };
  }

  const portalDocs = await db.collection('feestructures').find(query).toArray();
  if (portalDocs.length === 0) {
    return { docs: [], resolvedAcademicYear: normalizedYear, matchedBy: 'none' };
  }

  const courseLabelCache = new Map();
  const formattedDocs = [];
  for (const doc of portalDocs) {
    const courseLabel = await resolveHostelCourseLabel(db, doc.course, courseLabelCache);
    formattedDocs.push({
      ...formatHmsFeePortalDoc(doc, courseLabel),
      _source: 'feestructures',
    });
  }

  return {
    docs: formattedDocs,
    resolvedAcademicYear: normalizedYear,
    matchedBy: 'feestructures',
  };
};

const findHostelFeeDocs = async (db, params) => {
  // HMS portal `feestructures` is the source of truth for configured course fees.
  const portal = await findHmsFeePortalDocs(db, params);
  if (portal.docs.length > 0) return portal;

  const legacy = await findLegacyHostelFeeDocs(db, params);
  if (legacy.docs.length > 0) return legacy;

  return {
    docs: [],
    resolvedAcademicYear: normalizeAcademicYear(params.academicYear),
    matchedBy: 'none',
  };
};

const deriveHostelType = (name) => {
  const normalized = String(name || '').trim().toLowerCase();
  if (normalized.includes('girl')) return 'girls';
  if (normalized.includes('boy')) return 'boys';
  return 'other';
};

const escapeRegex = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** GET /api/hostel/academic-years */
export const listHostelAcademicYears = async (_req, res) => {
  try {
    const db = (await getActiveConnection()).db;
    const [fromLegacyFees, fromPortalFees, fromCalendar] = await Promise.all([
      db.collection('hostelfeestructures').distinct('academicYear'),
      db.collection('feestructures').distinct('academicYear'),
      db.collection('academiccalendars').distinct('academicYear'),
    ]);
    const feeYears = [...new Set([...fromLegacyFees, ...fromPortalFees].filter(Boolean))]
      .map((year) => String(year).trim())
      .filter(Boolean)
      .sort(compareAcademicYearsDesc);
    const calendarYears = [...new Set(fromCalendar.filter(Boolean))]
      .map((year) => String(year).trim())
      .filter(Boolean)
      .sort(compareAcademicYearsDesc);

    // Prefer years that actually have fee structures configured.
    const years = [...new Set([...feeYears, ...calendarYears])].sort(compareAcademicYearsDesc);

    return successResponse(res, { data: years, total: years.length });
  } catch (error) {
    console.error('listHostelAcademicYears error:', error);
    return errorResponse(res, error.message || 'Failed to load hostel academic years', 500);
  }
};

/** GET /api/hostel/hostels */
export const listHostels = async (_req, res) => {
  try {
    const db = (await getActiveConnection()).db;
    const hostels = await db
      .collection('hostels')
      .find({ isActive: { $ne: false } })
      .sort({ name: 1 })
      .toArray();

    return successResponse(res, {
      data: hostels.map((hostel) => ({
        _id: String(hostel._id),
        name: hostel.name || '',
        type: deriveHostelType(hostel.name),
        description: hostel.description || '',
      })),
      total: hostels.length,
    });
  } catch (error) {
    console.error('listHostels error:', error);
    return errorResponse(res, error.message || 'Failed to load hostels', 500);
  }
};

/** GET /api/hostel/categories?hostelId= */
export const listHostelCategories = async (req, res) => {
  try {
    const hostelId = String(req.query.hostelId || '').trim();
    if (!hostelId) {
      return errorResponse(res, 'hostelId is required', 400);
    }

    const db = (await getActiveConnection()).db;
    const hostelKey = toObjectIdOrString(hostelId);
    const categories = await db
      .collection('hostelcategories')
      .find({
        hostel: hostelKey,
        isActive: { $ne: false },
      })
      .sort({ name: 1 })
      .toArray();

    return successResponse(res, {
      data: categories.map((category) => ({
        _id: String(category._id),
        name: category.name || '',
        description: category.description || '',
        hostelId: String(category.hostel),
      })),
      total: categories.length,
    });
  } catch (error) {
    console.error('listHostelCategories error:', error);
    return errorResponse(res, error.message || 'Failed to load hostel categories', 500);
  }
};

const ACTIVE_OCCUPANCY_STATUSES = new Set([
  'Active',
  'active',
  'ACTIVE',
  'Extended',
  'extended',
  'EXTENDED',
]);

const WITHDRAWN_OCCUPANCY_STATUSES = new Set([
  'Withdrawn',
  'withdrawn',
  'WITHDRAWN',
]);

const ACTIVE_HOSTEL_USER_STATUSES = ['Active', 'active', 'ACTIVE'];

const isActiveOccupancyHistoryRow = (row) => {
  const status = String(row?.status || '').trim();
  if (!status || WITHDRAWN_OCCUPANCY_STATUSES.has(status)) return false;
  if (!ACTIVE_OCCUPANCY_STATUSES.has(status)) return false;
  return row.allocatedTo == null;
};

const buildRoomRefMatch = (roomIds) => {
  const objectIds = roomIds.map((id) => toObjectId(id)).filter(Boolean);
  const idStrings = roomIds.map((id) => String(id));
  return { $in: [...objectIds, ...idStrings] };
};

const emptyOccupancyCounts = () => ({
  studentCount: 0,
  staffCount: 0,
  totalOccupancy: 0,
  source: 'none',
});

/**
 * Academic-year scoped occupancy aligned with Hostel CMS:
 * - Primary: roomoccupancyhistories for the requested YYYY-YYYY session
 * - Fallback: active users in that room/year only when no history exists for that room/year
 */
const loadAcademicYearRoomOccupancyMap = async (db, { roomIds, academicYear }) => {
  const map = new Map();
  for (const roomId of roomIds) {
    map.set(String(roomId), emptyOccupancyCounts());
  }
  if (!roomIds.length) return map;

  const normalizedYear = normalizeAcademicYear(academicYear);
  if (!normalizedYear) return map;

  const roomMatch = buildRoomRefMatch(roomIds);
  const historyRows = await db
    .collection('roomoccupancyhistories')
    .find({
      academicYear: normalizedYear,
      room: roomMatch,
      status: { $nin: [...WITHDRAWN_OCCUPANCY_STATUSES] },
    })
    .toArray();

  const roomsWithHistory = new Set(historyRows.map((row) => String(row.room)));

  for (const row of historyRows) {
    if (!isActiveOccupancyHistoryRow(row)) continue;
    const roomKey = String(row.room);
    const current = map.get(roomKey) || emptyOccupancyCounts();
    current.studentCount += 1;
    current.totalOccupancy = current.studentCount + current.staffCount;
    current.source = 'history';
    map.set(roomKey, current);
  }

  const roomsNeedingUserFallback = roomIds
    .map((id) => String(id))
    .filter((roomId) => !roomsWithHistory.has(roomId));

  if (roomsNeedingUserFallback.length === 0) return map;

  const fallbackRequests = await db
    .collection('hostelrequests')
    .find({
      roomId: buildRoomRefMatch(roomsNeedingUserFallback),
      academicYear: normalizedYear,
      status: 'active',
    })
    .project({ roomId: 1 })
    .toArray();

  for (const req of fallbackRequests) {
    const roomKey = String(req.roomId);
    const current = map.get(roomKey) || emptyOccupancyCounts();
    current.studentCount += 1;
    current.totalOccupancy = current.studentCount + current.staffCount;
    current.source = 'hostelrequests';
    map.set(roomKey, current);
  }

  return map;
};

const resolveHostelFeesByYear = async (
  db,
  { hostelId, categoryId, academicYear, course, totalYears = 4 }
) => {
  const { docs, resolvedAcademicYear, matchedBy } = await findHostelFeeDocs(db, {
    hostelId,
    categoryId,
    academicYear,
    course,
  });

  if (docs.length === 0) {
    return { yearlyFees: [], flatFee: null, resolvedAcademicYear: '', matchedBy: 'none' };
  }

  const byYear = new Map();
  let flatDoc = null;
  let defaultAmountDoc = null;

  for (const doc of docs) {
    const formatted = formatFeeDoc(doc);
    const studentYear = formatted.studentYear;

    if (studentYear != null && Number.isFinite(studentYear) && studentYear > 0) {
      byYear.set(studentYear, formatted);
      if (!defaultAmountDoc) defaultAmountDoc = formatted;
      continue;
    }

    if (!flatDoc) flatDoc = formatted;
    if (!defaultAmountDoc) defaultAmountDoc = formatted;
  }

  const years = Math.max(1, Math.trunc(Number(totalYears)) || 4);
  const yearlyFees = [];

  for (let studentYear = 1; studentYear <= years; studentYear += 1) {
    const specific = byYear.get(studentYear);
    if (specific) {
      yearlyFees.push({ ...specific, studentYear });
      continue;
    }

    if (flatDoc) {
      yearlyFees.push({ ...flatDoc, studentYear });
      continue;
    }

    const configuredYears = [...byYear.keys()].sort((a, b) => a - b);
    if (configuredYears.length > 0) {
      const nearestYear =
        configuredYears.find((year) => year >= studentYear) ??
        configuredYears[configuredYears.length - 1];
      const nearest = byYear.get(nearestYear);
      if (nearest) {
        yearlyFees.push({ ...nearest, studentYear });
      }
    }
  }

  return {
    yearlyFees,
    flatFee: flatDoc || defaultAmountDoc,
    resolvedAcademicYear,
    matchedBy,
  };
};

/** @deprecated single-fee helper — prefer resolveHostelFeesByYear */
const resolveHostelFee = async (db, params) => {
  const { yearlyFees, flatFee } = await resolveHostelFeesByYear(db, params);
  if (yearlyFees.length > 0) {
    return yearlyFees[0];
  }
  return flatFee;
};

/** GET /api/hostel/rooms?hostelId=&categoryId=&academicYear=&course=&totalYears= */
export const listHostelRooms = async (req, res) => {
  try {
    const hostelId = String(req.query.hostelId || '').trim();
    const categoryId = String(req.query.categoryId || '').trim();
    const academicYear = String(req.query.academicYear || '').trim();
    const course = String(req.query.course || '').trim();
    const totalYears = Math.min(
      8,
      Math.max(1, parseInt(String(req.query.totalYears || '4'), 10) || 4)
    );

    if (!hostelId || !categoryId) {
      return errorResponse(res, 'hostelId and categoryId are required', 400);
    }
    if (!academicYear) {
      return errorResponse(
        res,
        'academicYear is required (YYYY-YYYY, e.g. 2026-2027) for year-scoped room availability',
        400
      );
    }

    const db = (await getActiveConnection()).db;
    const rooms = await db
      .collection('rooms')
      .find({
        hostel: refMatch(hostelId),
        category: refMatch(categoryId),
        isActive: { $ne: false },
      })
      .sort({ roomNumber: 1 })
      .toArray();

    const occupancyMap = await loadAcademicYearRoomOccupancyMap(db, {
      roomIds: rooms.map((room) => String(room._id)),
      academicYear,
    });

    const feeResult = await resolveHostelFeesByYear(db, {
      hostelId,
      categoryId,
      academicYear,
      course,
      totalYears,
    });

    const formattedRooms = rooms.map((room) => {
      const bedCount = Number(room.bedCount) || 0;
      const occupancy = occupancyMap.get(String(room._id)) || emptyOccupancyCounts();
      const totalOccupancy = occupancy.totalOccupancy;
      const availableBeds = Math.max(bedCount - totalOccupancy, 0);
      return {
        _id: String(room._id),
        roomNumber: room.roomNumber || '',
        bedCount,
        studentCount: occupancy.studentCount,
        occupiedBeds: totalOccupancy,
        totalOccupancy,
        availableBeds,
        isAvailable: availableBeds > 0,
        hostelId: String(room.hostel),
        categoryId: String(room.category),
      };
    });

    return successResponse(res, {
      data: {
        rooms: formattedRooms,
        yearlyFees: feeResult.yearlyFees,
        fee: feeResult.yearlyFees[0] || feeResult.flatFee,
        resolvedAcademicYear: feeResult.resolvedAcademicYear || academicYear,
        feeMatchedBy: feeResult.matchedBy || 'none',
        academicYear,
        total: formattedRooms.length,
        availableCount: formattedRooms.filter((room) => room.isAvailable).length,
      },
    });
  } catch (error) {
    console.error('listHostelRooms error:', error);
    return errorResponse(res, error.message || 'Failed to load hostel rooms', 500);
  }
};

/** GET /api/hostel/fee?hostelId=&categoryId=&academicYear=&course= */
export const getHostelFee = async (req, res) => {
  try {
    const hostelId = String(req.query.hostelId || '').trim();
    const categoryId = String(req.query.categoryId || '').trim();
    const academicYear = String(req.query.academicYear || '').trim();
    const course = String(req.query.course || '').trim();
    const totalYears = Math.min(
      8,
      Math.max(1, parseInt(String(req.query.totalYears || '4'), 10) || 4)
    );

    if (!hostelId || !categoryId || !academicYear) {
      return errorResponse(res, 'hostelId, categoryId, and academicYear are required', 400);
    }

    const db = (await getActiveConnection()).db;
    const feeResult = await resolveHostelFeesByYear(db, {
      hostelId,
      categoryId,
      academicYear,
      course,
      totalYears,
    });

    if (feeResult.yearlyFees.length === 0) {
      return errorResponse(res, 'Hostel fee not configured for this selection', 404);
    }

    return successResponse(res, {
      data: {
        yearlyFees: feeResult.yearlyFees,
        fee: feeResult.yearlyFees[0] || feeResult.flatFee,
        resolvedAcademicYear: feeResult.resolvedAcademicYear || academicYear,
        feeMatchedBy: feeResult.matchedBy || 'none',
      },
    });
  } catch (error) {
    console.error('getHostelFee error:', error);
    return errorResponse(res, error.message || 'Failed to load hostel fee', 500);
  }
};

/** GET /api/hostel/student */
export const getHostelStudentDetails = async (req, res) => {
  try {
    const { admissionNumber, joiningId, hostelId, academicYear } = req.query;
    const conn = await getActiveConnection();
    const db = conn.db;

    let existingRequest = null;
    let gender = '';

    const admNum = String(admissionNumber || '').trim();
    const joinId = String(joiningId || '').trim();
    const normYear = String(academicYear || '').trim();

    // 1. Try to find an active HostelRequest in HMS by admissionNumber + academicYear
    if (admNum && normYear) {
      existingRequest = await db.collection('hostelrequests').findOne({ 
        admissionNumber: admNum,
        academicYear: normYear,
        status: 'active'
      });
    }

    // 2. If not found, try by joiningId + academicYear (Admissions CRM source fallback)
    if (!existingRequest && joinId && normYear) {
      existingRequest = await db.collection('hostelrequests').findOne({ 
        joiningId: joinId,
        academicYear: normYear,
        status: 'active',
        source: 'admissions_crm'
      });
    }

    // 3. If student has an active request, return their details
    if (existingRequest && existingRequest.hostelSequenceId) {
      let hostelName = '';
      const hostelRef = existingRequest.hostelId;
      if (hostelRef) {
        const hostelDoc = await db.collection('hostels').findOne({
          _id: toObjectIdOrString(hostelRef)
        });
        hostelName = hostelDoc?.name || '';
      }

      // HMS print (`hostel-admit`) looks up `users._id`, not hostelrequests._id.
      let studentUserId = '';
      if (existingRequest.studentMasterId) {
        const master = await db.collection('studentmasters').findOne({
          _id: toObjectIdOrString(existingRequest.studentMasterId),
        });
        if (master?.userId) studentUserId = String(master.userId);
      }
      if (!studentUserId && admNum) {
        const hostelUser = await db.collection('users').findOne({ admissionNumber: admNum });
        if (hostelUser?._id) studentUserId = String(hostelUser._id);
      }
      if (!studentUserId && joinId) {
        const hostelUser = await db.collection('users').findOne({
          joiningId: joinId,
          source: 'admissions_crm',
        });
        if (hostelUser?._id) studentUserId = String(hostelUser._id);
      }

      return successResponse(res, {
        _id: String(existingRequest._id),
        studentUserId,
        admissionNumber: existingRequest.admissionNumber || admNum || '',
        hostelId: existingRequest.hostelSequenceId, // Return hostelSequenceId as the display ID
        isAssigned: true,
        bedNumber: existingRequest.bedNumber || '',
        roomNumber: existingRequest.roomNumber || '',
        hostelName: hostelName,
        joiningDate: existingRequest.joiningDate
          ? new Date(existingRequest.joiningDate).toISOString().slice(0, 10)
          : null,
        admitDate: existingRequest.admitDate
          ? new Date(existingRequest.admitDate).toISOString().slice(0, 10)
          : existingRequest.createdAt
            ? new Date(existingRequest.createdAt).toISOString().slice(0, 10)
            : null,
      });
    }

    // 4. If not registered, let's resolve gender from SQL database
    const pool = getPool();
    if (admNum) {
      const [rows] = await pool.execute(
        'SELECT student_gender FROM admissions WHERE admission_number = ? LIMIT 1',
        [admNum]
      );
      if (rows?.[0]?.student_gender) {
        gender = rows[0].student_gender;
      }
    }
    if (!gender && joinId) {
      const [rows] = await pool.execute(
        'SELECT student_gender, gender FROM joinings WHERE id = ? LIMIT 1',
        [joinId]
      );
      if (rows?.[0]) {
        gender = rows[0].student_gender || rows[0].gender || '';
      }
    }

    // 5. If we have a hostel selected, peek the next hostel student ID
    if (hostelId && academicYear) {
      const { peekNextHostelStudentId } = await import('../utils/hostelStudentId.util.js');
      const { resolveTransportApplicationCodes } = await import('../utils/transportApplicationNumber.util.js');
      const normalizedGender = String(gender || '').trim().toLowerCase().startsWith('f') ? 'Female' : 'Male';

      let collegeCode = '';
      let courseCode = '';
      let sqlRow = null;

      if (admNum) {
        const [rows] = await pool.execute(
          'SELECT managed_course_id, course FROM admissions WHERE admission_number = ? LIMIT 1',
          [admNum]
        );
        if (rows?.[0]) sqlRow = rows[0];
      }
      if (!sqlRow && joinId) {
        const [rows] = await pool.execute(
          'SELECT managed_course_id, course FROM joinings WHERE id = ? LIMIT 1',
          [joinId]
        );
        if (rows?.[0]) sqlRow = rows[0];
      }

      if (sqlRow) {
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
          console.warn('Failed to resolve college/course codes for peeking hostel sequence ID:', err);
        }
      }

      try {
        const preview = await peekNextHostelStudentId(db, {
          hostelObjectId: hostelId,
          academicYear,
          gender: normalizedGender,
          collegeCode,
          courseCode,
        });
        return successResponse(res, {
          hostelId: preview.hostelId,
          isAssigned: false,
        });
      } catch (err) {
        return successResponse(res, {
          hostelId: null,
          isAssigned: false,
          error: err.message,
        });
      }
    }

    return successResponse(res, {
      hostelId: null,
      isAssigned: false,
    });
  } catch (err) {
    console.error('Error fetching hostel student details:', err);
    return errorResponse(res, err.message, 500);
  }
};
