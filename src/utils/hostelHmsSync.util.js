import mongoose from 'mongoose';
import { mapCourseLabel } from '../data/admissionsCourseBranchMap2026.js';

const { Types: { ObjectId } } = mongoose;

export const toStoredHostelRefId = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return undefined;
  if (/^[a-fA-F0-9]{24}$/.test(raw)) {
    try {
      return new ObjectId(raw);
    } catch {
      return raw;
    }
  }
  return raw;
};

const escapeRegex = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export async function resolveHmsTermFees(db, {
  academicYear,
  course,
  categoryName,
  studentYear = 1,
}) {
  const mappedCourse = mapCourseLabel(course);
  if (!academicYear || !mappedCourse || !categoryName) return null;

  const feeDoc = await db.collection('feestructures').findOne({
    academicYear,
    category: categoryName,
    year: Math.max(1, Number(studentYear) || 1),
    course: new RegExp(`^${escapeRegex(mappedCourse)}$`, 'i'),
    isActive: { $ne: false },
  });

  if (!feeDoc) return null;

  const term1 = Number(feeDoc.term1Fee) || 0;
  const term2 = Number(feeDoc.term2Fee) || 0;
  const term3 = Number(feeDoc.term3Fee) || 0;

  return {
    calculatedTerm1Fee: term1,
    calculatedTerm2Fee: term2,
    calculatedTerm3Fee: term3,
    totalCalculatedFee: term1 + term2 + term3,
    term1LateFee: 0,
    term2LateFee: 0,
    term3LateFee: 0,
    lateFeeApplied: { term1: false, term2: false, term3: false },
  };
}

export async function resolveNextBedAndLocker(db, {
  roomId,
  roomNumber,
  academicYear,
  bedCount = 0,
}) {
  const roomRef = toStoredHostelRefId(roomId);
  const rn = String(roomNumber || '').trim();
  if (!roomRef || !rn || !academicYear) {
    return { bedNumber: '', lockerNumber: '' };
  }

  const occupied = await db
    .collection('roomoccupancyhistories')
    .find({
      academicYear,
      room: roomRef,
      status: { $in: ['Active', 'active', 'ACTIVE', 'Extended', 'extended', 'EXTENDED'] },
      allocatedTo: null,
    })
    .project({ bedNumber: 1 })
    .toArray();

  const usedBeds = new Set();
  for (const row of occupied) {
    const match = String(row.bedNumber || '').match(/Bed\s*(\d+)/i);
    if (match) usedBeds.add(Number(match[1]));
  }

  const maxBeds = Math.max(1, Number(bedCount) || 0);
  let nextBed = 1;
  while (usedBeds.has(nextBed) && nextBed <= maxBeds) nextBed += 1;
  if (nextBed > maxBeds) {
    return { bedNumber: '', lockerNumber: '' };
  }

  return {
    bedNumber: `${rn} Bed ${nextBed}`,
    lockerNumber: `${rn} Locker ${nextBed}`,
  };
}

export async function upsertHostelRoomOccupancyHistory(db, {
  studentUserId,
  studentName,
  rollNumber = '',
  course = '',
  branch = '',
  yearOfStudy = 1,
  academicYear,
  hostelId,
  categoryId,
  roomId,
  roomNumber,
  bedNumber = '',
  lockerNumber = '',
  hostelRequestId = null,
}) {
  if (!studentUserId || !academicYear || !hostelId || !categoryId || !roomId) {
    return { skipped: true, reason: 'Missing required occupancy fields' };
  }

  const studentRef = toStoredHostelRefId(studentUserId);
  const filter = {
    student: studentRef,
    academicYear,
    status: { $in: ['Active', 'active', 'ACTIVE', 'Extended', 'extended', 'EXTENDED'] },
    allocatedTo: null,
  };

  const payload = {
    student: studentRef,
    studentName: String(studentName || '').trim(),
    rollNumber: String(rollNumber || '').trim(),
    course: String(course || '').trim(),
    branch: String(branch || '').trim(),
    yearOfStudy: Math.max(1, Number(yearOfStudy) || 1),
    academicYear,
    hostel: toStoredHostelRefId(hostelId),
    hostelCategory: toStoredHostelRefId(categoryId),
    room: toStoredHostelRefId(roomId),
    roomNumber: String(roomNumber || '').trim(),
    bedNumber: String(bedNumber || '').trim(),
    lockerNumber: String(lockerNumber || '').trim(),
    allocatedFrom: new Date(),
    allocatedTo: null,
    status: 'Active',
    expiryReason: 'registration',
    notes: 'Synced from admissions CRM',
    updatedAt: new Date(),
    ...(hostelRequestId ? { hostelRequestId: toStoredHostelRefId(hostelRequestId) } : {}),
  };

  const existing = await db.collection('roomoccupancyhistories').findOne(filter);
  if (existing) {
    await db.collection('roomoccupancyhistories').updateOne(
      { _id: existing._id },
      { $set: payload }
    );
    return { skipped: false, operation: 'update', historyId: String(existing._id) };
  }

  const insertResult = await db.collection('roomoccupancyhistories').insertOne({
    ...payload,
    createdAt: new Date(),
    __v: 0,
  });

  return {
    skipped: false,
    operation: 'insert',
    historyId: String(insertResult.insertedId),
  };
}

/** Fix records that incorrectly stored Mongo query objects in ref fields. */
export function normalizeBrokenHostelRefField(value) {
  if (!value || typeof value !== 'object') {
    return toStoredHostelRefId(value);
  }
  if (Array.isArray(value.$in) && value.$in.length > 0) {
    return toStoredHostelRefId(value.$in[0]);
  }
  if (value._id) return toStoredHostelRefId(value._id);
  return undefined;
}
