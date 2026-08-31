import mongoose from 'mongoose';
import { calendarYearToAcademicYearSession } from './transportApplicationNumber.util.js';

const { Types: { ObjectId } } = mongoose;

const toObjectIdOrString = (value) => {
  const raw = String(value || '').trim();
  if (/^[a-fA-F0-9]{24}$/.test(raw)) {
    try {
      return new ObjectId(raw);
    } catch {
      return raw;
    }
  }
  return raw;
};

/** Hostel CMS format: BH26001 / GH25015 — prefix + 2-digit year + 3-digit serial. */
export function academicYearToHostelIdYearSuffix(academicYear) {
  const session = calendarYearToAcademicYearSession(academicYear);
  const match = String(session || '').match(/^(\d{4})/);
  if (match) return match[1].slice(-2);
  const cal = String(academicYear || '').match(/^(\d{4})/);
  if (cal) return cal[1].slice(-2);
  return String(new Date().getFullYear()).slice(-2);
}

export function resolveHostelTypePrefix(hostelName, gender = '') {
  const name = String(hostelName || '').trim().toLowerCase();
  if (name.includes('girl')) return 'GH';
  if (name.includes('boy')) return 'BH';
  const g = String(gender || '').trim().toLowerCase();
  if (g.startsWith('f')) return 'GH';
  if (g.startsWith('m')) return 'BH';
  return 'OH';
}

export function formatHostelStudentId(prefix, yearSuffix, serial) {
  return `${prefix}${yearSuffix}${String(serial).padStart(3, '0')}`;
}

export function buildHostelCounterKey(prefix, yearSuffix) {
  return `hostel_${prefix}${yearSuffix}`;
}

export function isValidHostelStudentId(value) {
  return /^[A-Z]{2}\d{5}$/i.test(String(value || '').trim());
}

export function hostelStudentIdScopeMatches(existingHostelId, prefix, yearSuffix) {
  const raw = String(existingHostelId || '').trim().toUpperCase();
  if (!isValidHostelStudentId(raw)) return false;
  return raw.startsWith(`${prefix}${yearSuffix}`);
}

const normalizeHostelCode = (value) =>
  String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

/** HCMS counter key: hostelseq:{academicYear}:{college}:{course}:{hostel} */
const buildHcmsCounterId = (academicYear, collegeCode, courseCode, hostelCode) =>
  `hostelseq:${academicYear}:${collegeCode}:${courseCode}:${hostelCode}`;

/** Atomically allocate the next serial using the same counters collection as HCMS admin registration. */
async function allocateHcmsSequenceSerial(db, { academicYear, collegeCode, courseCode, hostelCode }) {
  const counterId = buildHcmsCounterId(academicYear, collegeCode, courseCode, hostelCode);
  const counters = db.collection('counters');
  const result = await counters.findOneAndUpdate(
    { _id: counterId },
    { $inc: { sequence: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  const doc = result?.value ?? result;
  const serial = Number(doc?.sequence);
  return Number.isFinite(serial) && serial > 0 ? serial : 1;
}

const escapeRegexPrefix = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Helper to find the maximum sequential ID serial already assigned to HostelRequests in this academic year. */
export async function getMaxHostelSequenceSerialFromRequests(db, { prefix, academicYear }) {
  try {
    const query = {
      academicYear,
      hostelSequenceId: new RegExp(`^${escapeRegexPrefix(prefix)}\\d+`, 'i'),
    };

    const requests = await db.collection('hostelrequests')
      .find(query, { projection: { hostelSequenceId: 1 } })
      .toArray();

    let maxSerial = 0;
    for (const req of requests) {
      const seqId = String(req.hostelSequenceId || '').trim();
      const numPart = seqId.slice(prefix.length);
      const num = parseInt(numPart, 10);
      if (Number.isFinite(num) && num > maxSerial) {
        maxSerial = num;
      }
    }
    return maxSerial;
  } catch (err) {
    console.warn('[hostelStudentId] Failed to query max serial from requests:', err);
    return 0;
  }
}

/**
 * Assign the next hostel student id aligned with HCMS:
 * hostelSequenceId = collegeCode + courseCode + hostelCode + zeroPaddedSeq(3)
 * Uses HCMS `counters` collection when college/course/hostel codes are available.
 */
export async function assignHostelStudentId(db, {
  hostelObjectId,
  academicYear,
  gender = '',
  existingHostelId = null,
  collegeCode = '',
  courseCode = '',
}) {
  const yearSuffix = academicYearToHostelIdYearSuffix(academicYear);
  if (!yearSuffix) {
    throw new Error('Academic year is required to generate a hostel student id.');
  }
  if (!hostelObjectId) {
    throw new Error('Hostel is required to generate a hostel student id.');
  }

  const hostelDoc = await db.collection('hostels').findOne({
    _id: toObjectIdOrString(hostelObjectId),
  });
  const genderPrefix = resolveHostelTypePrefix(hostelDoc?.name, gender);
  const hostelCodeFromDoc = normalizeHostelCode(hostelDoc?.code) || genderPrefix;

  const cleanCollege = normalizeHostelCode(collegeCode);
  const cleanCourse = normalizeHostelCode(courseCode);
  const useHcmsFormat = Boolean(cleanCollege && cleanCourse && hostelCodeFromDoc);

  if (useHcmsFormat) {
    const idPrefix = `${cleanCollege}${cleanCourse}${hostelCodeFromDoc}`;
    const normalizedExisting = String(existingHostelId || '').trim().toUpperCase();
    const existingPattern = new RegExp(`^${escapeRegexPrefix(idPrefix)}\\d{3}$`, 'i');

    if (existingPattern.test(normalizedExisting)) {
      const sequence = parseInt(normalizedExisting.slice(idPrefix.length), 10) || 0;
      return {
        hostelId: normalizedExisting,
        hostelSequenceId: normalizedExisting,
        assigned: false,
        reusedExisting: true,
        collegeCode: cleanCollege,
        courseCode: cleanCourse,
        hostelCode: hostelCodeFromDoc,
        prefix: idPrefix,
        yearSuffix: '',
        sequence,
        format: 'hcms',
      };
    }

    let nextSerial;
    try {
      nextSerial = await allocateHcmsSequenceSerial(db, {
        academicYear,
        collegeCode: cleanCollege,
        courseCode: cleanCourse,
        hostelCode: hostelCodeFromDoc,
      });
    } catch (err) {
      console.warn('[hostelStudentId] HCMS counter failed; falling back to request scan:', err?.message);
      const requestsMaxSerial = await getMaxHostelSequenceSerialFromRequests(db, {
        prefix: idPrefix,
        academicYear,
      });
      nextSerial = requestsMaxSerial + 1;
    }

    const hostelSequenceId = `${idPrefix}${String(nextSerial).padStart(3, '0')}`;
    return {
      hostelId: hostelSequenceId,
      hostelSequenceId,
      assigned: true,
      reusedExisting: false,
      collegeCode: cleanCollege,
      courseCode: cleanCourse,
      hostelCode: hostelCodeFromDoc,
      prefix: idPrefix,
      yearSuffix: '',
      sequence: nextSerial,
      format: 'hcms',
    };
  }

  // Legacy BH26001 / GH26001 fallback when college/course codes are unavailable
  const finalPrefix = genderPrefix;
  const finalYearSuffix = yearSuffix;
  const normalizedExisting = String(existingHostelId || '').trim();
  const isExistingValid =
    isValidHostelStudentId(normalizedExisting) &&
    hostelStudentIdScopeMatches(normalizedExisting, finalPrefix, finalYearSuffix);

  if (isExistingValid) {
    const numPart = normalizedExisting.slice(finalPrefix.length);
    const sequence = parseInt(numPart, 10) || 0;
    return {
      hostelId: normalizedExisting.toUpperCase(),
      hostelSequenceId: normalizedExisting.toUpperCase(),
      assigned: false,
      reusedExisting: true,
      collegeCode: cleanCollege || null,
      courseCode: cleanCourse || null,
      hostelCode: hostelCodeFromDoc,
      prefix: finalPrefix,
      yearSuffix: finalYearSuffix,
      sequence,
      format: 'legacy',
    };
  }

  const searchPrefix = finalPrefix + finalYearSuffix;
  const requestsMaxSerial = await getMaxHostelSequenceSerialFromRequests(db, {
    prefix: searchPrefix,
    academicYear,
  });
  const nextSerial = requestsMaxSerial + 1;
  const generatedId = formatHostelStudentId(finalPrefix, finalYearSuffix, nextSerial);

  return {
    hostelId: generatedId,
    hostelSequenceId: generatedId,
    assigned: true,
    reusedExisting: false,
    collegeCode: cleanCollege || null,
    courseCode: cleanCourse || null,
    hostelCode: hostelCodeFromDoc,
    prefix: finalPrefix,
    yearSuffix: finalYearSuffix,
    sequence: nextSerial,
    format: 'legacy',
  };
}

/** Read-only preview of the next hostel student id. Supports collegeCode and courseCode parameters. */
export async function peekNextHostelStudentId(db, {
  hostelObjectId,
  academicYear,
  gender = '',
  collegeCode = '',
  courseCode = '',
}) {
  const yearSuffix = academicYearToHostelIdYearSuffix(academicYear);
  if (!yearSuffix || !hostelObjectId) {
    throw new Error('Hostel and academic year are required to preview a hostel student id.');
  }

  const hostelDoc = await db.collection('hostels').findOne({
    _id: toObjectIdOrString(hostelObjectId),
  });
  const prefix = resolveHostelTypePrefix(hostelDoc?.name, gender);

  let finalPrefix = prefix;
  let finalYearSuffix = yearSuffix;
  let finalFormat = 'legacy';

  if (collegeCode && courseCode) {
    const cleanCollege = String(collegeCode).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    const cleanCourse = String(courseCode).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    finalPrefix = `${cleanCollege}${cleanCourse}${prefix}`;
    finalYearSuffix = '';
    finalFormat = 'new';
  }

  const searchPrefix = finalPrefix + finalYearSuffix;
  const requestsMaxSerial = await getMaxHostelSequenceSerialFromRequests(db, {
    prefix: searchPrefix,
    academicYear,
  });

  const nextSerial = requestsMaxSerial + 1;

  const generatedId = finalFormat === 'new'
    ? `${finalPrefix}${String(nextSerial).padStart(3, '0')}`
    : formatHostelStudentId(finalPrefix, finalYearSuffix, nextSerial);

  return {
    hostelId: generatedId,
    prefix: finalPrefix,
    yearSuffix: finalYearSuffix,
    sequence: nextSerial,
  };
}
