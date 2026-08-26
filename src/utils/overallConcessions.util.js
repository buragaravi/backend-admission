/**
 * overall_concessions.revised_fees JSON lines.
 * Source of truth: concessionType + amount (builder input).
 * actual / payable amounts are resolved at read time from Fee Management catalog.
 */

export const normalizeOverallConcessionType = (raw) => {
  const type = String(raw || '').trim().toUpperCase();
  if (type === 'CONCESSION') return 'CONCESSION';
  if (type === 'REVISED_FEE' || type === 'REVISED') return 'REVISED_FEE';
  return null;
};

const readPositiveAmount = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** True when builder line has an explicit concession/revised amount for a year. */
export const isPersistableBuilderConcessionLine = (line) => {
  const concessionType = normalizeOverallConcessionType(line?.concessionType);
  if (!concessionType) return false;
  return readPositiveAmount(line?.amount) !== null;
};

const normalizeFeeHeadCode = (raw) => {
  let code = String(raw || '')
    .trim()
    .toUpperCase();
  if (code === 'OTH02') code = 'OTH1';
  return code;
};

const lineMatchesBuilderHead = (line, head) => {
  const headCode = normalizeFeeHeadCode(head?.code || head?.feeHeadCode);
  const lineCode = normalizeFeeHeadCode(line?.feeHeadCode || line?.code);

  if (headCode && lineCode) {
    return headCode === lineCode;
  }

  const headId = String(head?.id || head?.feeHeadId || head?.feeHead || '').trim();
  const lineId = String(line?.feeHeadId || line?.feeHead || '').trim();

  if (headId && lineId) {
    return headId === lineId;
  }
  return false;
};

/**
 * Step 4: at least one selected builder fee head must have a revised/concession
 * amount for every displayed year before admission number may be minted on submit.
 * Other heads may remain empty.
 * @returns {{ complete: boolean, missing: Array<{ headName: string, headCode: string, year: number }> }}
 */
export const getMissingBuilderHeadYearAmounts = ({
  heads = [],
  years = [],
  lines = [],
} = {}) => {
  const yearList = (Array.isArray(years) ? years : [])
    .map((y) => Number(y))
    .filter((y) => Number.isFinite(y) && y > 0);
  const headList = Array.isArray(heads) ? heads : [];
  const lineList = Array.isArray(lines) ? lines : [];

  if (headList.length === 0 || yearList.length === 0) {
    return { complete: false, missing: [] };
  }

  let bestHead = null;
  let bestMissing = yearList.map((year) => ({
    headName: String(headList[0]?.name || headList[0]?.feeHeadName || headList[0]?.code || headList[0]?.id || 'Fee head'),
    headCode: normalizeFeeHeadCode(headList[0]?.code || headList[0]?.feeHeadCode),
    year,
  }));

  for (const head of headList) {
    const headName = String(head?.name || head?.feeHeadName || head?.code || head?.id || 'Fee head');
    const headCode = normalizeFeeHeadCode(head?.code || head?.feeHeadCode);
    const missingForHead = [];
    for (const year of yearList) {
      const found = lineList.some(
        (line) =>
          lineMatchesBuilderHead(line, head) &&
          Number(line?.studentYear) === year &&
          isPersistableBuilderConcessionLine(line)
      );
      if (!found) {
        missingForHead.push({ headName, headCode, year });
      }
    }
    if (missingForHead.length === 0) {
      return { complete: true, missing: [] };
    }
    if (missingForHead.length < bestMissing.length) {
      bestHead = head;
      bestMissing = missingForHead;
    }
  }

  return { complete: false, missing: bestMissing };
};

/** Canonical overall_concessions.revised_fees JSON line (no catalog computed fields). */
export const formatOverallConcessionStorageLine = ({
  feeHeadId = null,
  feeHeadCode = '',
  studentYear = 1,
  concessionType,
  amount,
}) => ({
  semester: null,
  feeHeadId: feeHeadId ? String(feeHeadId).trim() : null,
  feeHeadCode: feeHeadCode ? String(feeHeadCode).trim() : '',
  studentYear: Number(studentYear) > 0 ? Number(studentYear) : 1,
  concessionType,
  amount,
});

/** Builder line (_joiningStudentFeeDetails.lines) → overall_concessions row. */
export const buildOverallConcessionLineFromBuilderLine = (line) => {
  if (!isPersistableBuilderConcessionLine(line)) return null;

  const concessionType = normalizeOverallConcessionType(line.concessionType);
  const amount = readPositiveAmount(line.amount);

  return formatOverallConcessionStorageLine({
    feeHeadId: line?.feeHeadId,
    feeHeadCode: line?.feeHeadCode,
    studentYear: line?.studentYear,
    concessionType,
    amount,
  });
};

/** All builder override lines for overall_concessions.revised_fees. */
export const buildOverallConcessionLinesFromBuilder = (studentFeeDetails) => {
  const linesIn = Array.isArray(studentFeeDetails?.lines) ? studentFeeDetails.lines : [];
  return linesIn.map(buildOverallConcessionLineFromBuilderLine).filter(Boolean);
};

/**
 * Legacy fee-request portal line (actualAmount + revisedAmount) → builder-style row.
 * Used when student_fee_details is missing on an old request.
 */
export const buildOverallConcessionLineFromPortalLine = (line) => {
  const concessionType = normalizeOverallConcessionType(line?.concessionType);
  const actualAmount = Number(line?.actualAmount) || 0;
  const revisedAmount = Number(line?.revisedAmount) || 0;

  let resolvedType = concessionType;
  if (!resolvedType && actualAmount > 0 && revisedAmount > 0 && revisedAmount < actualAmount) {
    resolvedType = 'CONCESSION';
  }
  if (!resolvedType && revisedAmount > 0) {
    resolvedType = 'REVISED_FEE';
  }
  if (!resolvedType) return null;

  let amount = null;
  if (resolvedType === 'CONCESSION') {
    const raw = readPositiveAmount(line?.amount);
    if (raw !== null) {
      amount = raw;
    } else if (readPositiveAmount(line?.concessionAmount) !== null) {
      amount = readPositiveAmount(line.concessionAmount);
    } else if (actualAmount > 0 && revisedAmount >= 0 && revisedAmount < actualAmount) {
      amount = actualAmount - revisedAmount;
    }
  } else {
    const explicit = readPositiveAmount(line?.amount);
    if (explicit !== null) {
      amount = explicit;
    } else if (
      actualAmount > 0 &&
      readPositiveAmount(revisedAmount) !== null &&
      revisedAmount !== actualAmount
    ) {
      amount = readPositiveAmount(revisedAmount);
    }
  }

  if (amount === null) return null;

  return formatOverallConcessionStorageLine({
    feeHeadId: line?.feeHeadId,
    feeHeadCode: line?.feeHeadCode,
    studentYear: line?.studentYear,
    concessionType: resolvedType,
    amount,
  });
};

export const buildOverallConcessionLinesFromPortalLines = (portalLines) => {
  const linesIn = Array.isArray(portalLines) ? portalLines : [];
  return linesIn.map(buildOverallConcessionLineFromPortalLine).filter(Boolean);
};

/** Normalize any stored/API line (new or legacy) → canonical storage shape. */
export const normalizeOverallConcessionLineForStorage = (line) => {
  if (!line || typeof line !== 'object') return null;
  return buildOverallConcessionLineFromBuilderLine(line) || buildOverallConcessionLineFromPortalLine(line);
};

export const normalizeOverallConcessionLinesForStorage = (lines = []) =>
  (Array.isArray(lines) ? lines : []).map(normalizeOverallConcessionLineForStorage).filter(Boolean);

/** True when Step 4 builder (`_joiningStudentFeeDetails`) has any revised/concession amount. */
export const studentFeeDetailsHasRevisedFeeEntries = (studentFeeDetails) =>
  buildOverallConcessionLinesFromBuilder(studentFeeDetails).length > 0;

/**
 * True when overall_concessions.revised_fees JSON has any persistable revised/concession line.
 * Accepts array, JSON string, or already-parsed object wrapper.
 */
export const overallConcessionsJsonHasRevisedFeeEntries = (revisedFeesRaw) => {
  let lines = revisedFeesRaw;
  if (typeof lines === 'string') {
    try {
      lines = JSON.parse(lines);
    } catch {
      return false;
    }
  }
  if (lines && typeof lines === 'object' && !Array.isArray(lines) && Array.isArray(lines.revisedFees)) {
    lines = lines.revisedFees;
  }
  if (Array.isArray(lines) && lines.length === 0) return false;
  // Fast path: non-empty stored lines were sanitized to persistable amounts at write time.
  if (Array.isArray(lines) && lines.length > 0) {
    return normalizeOverallConcessionLinesForStorage(lines).length > 0;
  }
  return false;
};

const parseJsonMaybe = (raw) => {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed === 'null') return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
};

const chunkArray = (items, size = 500) => {
  const list = Array.isArray(items) ? items : [];
  const chunks = [];
  for (let i = 0; i < list.length; i += size) {
    chunks.push(list.slice(i, i + size));
  }
  return chunks;
};

/**
 * Student Info "No Fee Entry" = no Step 4 revised/concession fee amounts.
 * Uses JSON path extracts only (never pulls full lead_data blobs with photos).
 *
 * @param {import('mysql2/promise').Pool} pool
 * @param {Array<{ admission_number?: string; admissionNumber?: string; joining_id?: string; id?: string }>} rows
 * @param {{ getSecondaryPool?: () => import('mysql2/promise').Pool }} [options]
 * @returns {Promise<Map<string, boolean>>} admissionNumber → hasRevisedFeeEntries
 */
export async function buildHasStepFourRevisedFeeEntriesByAdmissionRows(pool, rows, options = {}) {
  const result = new Map();
  const joiningIds = new Set();
  const admissionNumbers = [];

  for (const row of Array.isArray(rows) ? rows : []) {
    const admissionNumber = String(row?.admission_number ?? row?.admissionNumber ?? '').trim();
    if (!admissionNumber) continue;
    result.set(admissionNumber, false);
    admissionNumbers.push(admissionNumber);
    if (row?.joining_id) joiningIds.add(String(row.joining_id));
  }

  if (result.size === 0) return result;

  // 1) Joining Step 4 builder — extract only the fee sidecar path (not full lead_data).
  const joiningHasFees = new Map();
  const joiningIdList = [...joiningIds];
  await Promise.all(
    chunkArray(joiningIdList, 500).map(async (ids) => {
      if (ids.length === 0) return;
      const placeholders = ids.map(() => '?').join(',');
      const [joiningRows] = await pool.execute(
        `SELECT id,
                JSON_EXTRACT(lead_data, '$._joiningStudentFeeDetails') AS fee_details
         FROM joinings
         WHERE id IN (${placeholders})
           AND JSON_EXTRACT(lead_data, '$._joiningStudentFeeDetails.lines') IS NOT NULL
           AND COALESCE(JSON_LENGTH(JSON_EXTRACT(lead_data, '$._joiningStudentFeeDetails.lines')), 0) > 0`,
        ids
      );
      for (const joining of joiningRows || []) {
        const feeDetails = parseJsonMaybe(joining.fee_details);
        if (studentFeeDetailsHasRevisedFeeEntries(feeDetails)) {
          joiningHasFees.set(String(joining.id), true);
        }
      }
    })
  );

  for (const row of Array.isArray(rows) ? rows : []) {
    const admissionNumber = String(row?.admission_number ?? row?.admissionNumber ?? '').trim();
    if (!admissionNumber) continue;
    const joiningId = row?.joining_id ? String(row.joining_id) : '';
    if (joiningId && joiningHasFees.get(joiningId)) {
      result.set(admissionNumber, true);
    }
  }

  // 2) Secondary overall_concessions — only for admissions still missing a builder entry.
  const stillMissing = admissionNumbers.filter((adm) => !result.get(adm));
  if (stillMissing.length === 0) return result;

  try {
    const getSecondaryPool = options.getSecondaryPool;
    if (typeof getSecondaryPool !== 'function') return result;
    const secondaryPool = getSecondaryPool();
    await Promise.all(
      chunkArray(stillMissing, 500).map(async (numbers) => {
        if (numbers.length === 0) return;
        const placeholders = numbers.map(() => '?').join(',');
        const [ocRows] = await secondaryPool.execute(
          `SELECT admission_number
           FROM overall_concessions
           WHERE admission_number IN (${placeholders})
             AND revised_fees IS NOT NULL
             AND TRIM(CAST(revised_fees AS CHAR)) NOT IN ('', 'null', 'NULL', '[]')
             AND LENGTH(TRIM(CAST(revised_fees AS CHAR))) > 2`,
          numbers
        );
        for (const oc of ocRows || []) {
          const admissionNumber = String(oc.admission_number || '').trim();
          if (admissionNumber) result.set(admissionNumber, true);
        }
      })
    );
  } catch (error) {
    console.warn(
      'overall_concessions revised-fee lookup failed for Student Info fee entry filter:',
      error?.message || error
    );
  }

  return result;
}

export function resolveFeeHead(entry, feeHeads) {
  if (!entry || !Array.isArray(feeHeads)) return null;
  const code = String(entry.feeHeadCode || '').trim().toUpperCase();
  if (code) {
    const byCode = feeHeads.find(h => String(h.code || '').trim().toUpperCase() === code);
    if (byCode) return byCode;
  }
  const idStr = String(entry.feeHeadId || entry.feeHead || '').trim();
  if (idStr) {
    const byId = feeHeads.find(h => String(h._id || h.id || '') === idStr);
    if (byId) return byId;
  }
  return null;
}

export function normalizeFeeHeadInEntries(entries, feeHeads) {
  if (!Array.isArray(entries) || !Array.isArray(feeHeads) || feeHeads.length === 0) {
    return entries;
  }
  return entries.map(entry => {
    if (!entry) return entry;
    const matched = resolveFeeHead(entry, feeHeads);
    if (matched) {
      const updated = { ...entry };
      const matchedId = String(matched._id || matched.id);
      const matchedCode = matched.code || '';
      const matchedName = matched.name || matched.feeHeadName || matched.headName || '';

      if (updated.feeHeadId !== undefined || updated.feeHead !== undefined) {
        if (updated.feeHeadId !== undefined) updated.feeHeadId = matchedId;
        if (updated.feeHead !== undefined) updated.feeHead = matchedId;
      } else {
        updated.feeHeadId = matchedId;
      }

      if (updated.feeHeadCode !== undefined) {
        updated.feeHeadCode = matchedCode;
      }
      if (updated.feeHeadName !== undefined) {
        updated.feeHeadName = matchedName;
      }
      return updated;
    }
    return entry;
  });
}

export async function normalizeStudentFeeDetails(studentFeeDetails) {
  if (!studentFeeDetails || !Array.isArray(studentFeeDetails.lines) || studentFeeDetails.lines.length === 0) {
    return studentFeeDetails;
  }
  try {
    const { connectFeeManagement } = await import('../config-mongo/feeManagement.js');
    const conn = await connectFeeManagement();
    const feeHeads = await conn.db.collection('feeheads').find({}).toArray();
    studentFeeDetails.lines = normalizeFeeHeadInEntries(studentFeeDetails.lines, feeHeads);
  } catch (err) {
    console.warn('[normalizeStudentFeeDetails] Failed to normalize:', err.message);
  }
  return studentFeeDetails;
}

