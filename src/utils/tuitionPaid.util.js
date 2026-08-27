import mongoose from 'mongoose';
import { connectFeeManagement } from '../config-mongo/feeManagement.js';
import { classifyAdmissionQuotaCategory } from './quotaClassification.util.js';

/** Tuition fee head in Fee Management (TUI01). */
export const TUI_FEE_HEAD_ID = '6996e24c2e1678e398839187';
export const TUI_FEE_HEAD_CODE = 'TUI01';

/** Special Fee head included with tuition in the Student Info Paid amount. */
export const SPECIAL_FEE_HEAD_CODE = 'OTH1';

/** Regular admissions desk reports use Year 1 tuition + other. */
export const TUI_STUDENT_YEAR = 1;

/**
 * Lateral Entry / Lateral Spot start from Year 2 (2-1) — never Year 1.
 * "Onwards" covers later years if Year 2 ledger is missing but Year 3+ exists.
 */
export const LATERAL_FEE_STUDENT_YEAR = 2;
export const LATERAL_FEE_STUDENT_YEARS = [2, 3, 4, 5, 6];

const FEE_PENDING_TOLERANCE = 0.5;

/** True for Lateral Entry / Lateral Spot quota labels. */
export function isLateralDeskFeeQuota(quota) {
  const category = classifyAdmissionQuotaCategory(quota);
  return category === 'LATER' || category === 'LSPOT';
}

/**
 * Same lateral track as Step 4 Collect Fee:
 * Lateral Entry / Spot quotas OR course label containing LATERAL (e.g. B.Tech (LATERAL)).
 */
export function isLateralDeskFeeStudent(quota, course) {
  if (isLateralDeskFeeQuota(quota)) return true;
  return isLateralCourseLabel(course);
}

/** Course label indicates lateral intake (e.g. B.Tech (LATERAL)). */
export function isLateralCourseLabel(course) {
  const c = String(course ?? '').trim();
  if (!c) return false;
  return /\(lateral\)/i.test(c) || /\blateral\b/i.test(c);
}

/**
 * Lateral course / track stored with a non-lateral quota (Convenor / Management / Spot, etc.).
 * These are the No Fee Entry desk targets when Year 2+ TUI01/OTH1 ledger is missing.
 */
export function isLateralQuotaMismatch(quota, course) {
  return isLateralCourseLabel(course) && !isLateralDeskFeeQuota(quota);
}

/** Desk fee student-year(s) — mirrors Step 4 year columns. */
export function resolveDeskFeeStudentYears(quota, course) {
  return isLateralDeskFeeStudent(quota, course)
    ? [...LATERAL_FEE_STUDENT_YEARS]
    : [TUI_STUDENT_YEAR];
}

const feeHeadMatchValues = (feeHeadId) => {
  const raw = String(feeHeadId || '').trim();
  if (!raw) return [];
  const values = [raw];
  try {
    values.push(new mongoose.Types.ObjectId(raw));
  } catch {
    // Non-ObjectId fee heads are matched as-is.
  }
  return values;
};

/**
 * Mongo may store studentYear as number or string.
 * Accepts a single year or an array (e.g. lateral Year 2 onwards).
 */
const studentYearMatchFilter = (studentYear = TUI_STUDENT_YEAR) => {
  const years = Array.isArray(studentYear) ? studentYear : [studentYear];
  const values = [];
  for (const year of years) {
    const numeric = Number(year);
    const text = String(year).trim();
    if (text) values.push(text);
    if (Number.isFinite(numeric)) values.push(numeric);
  }
  return { $in: [...new Set(values)] };
};

const emptyHeadAmounts = () => ({
  payable: 0,
  paid: 0,
  pending: 0,
  hasFeeEntry: false,
});

/**
 * Paid amount = actual collections only (DEBIT).
 * CREDIT rows are concessions / adjustments / refunds — never count them as paid.
 */
const isDebitPaymentTransaction = (doc) => {
  const type = String(doc?.transactionType || '')
    .trim()
    .toUpperCase();
  return type === 'DEBIT';
};

/** Add a payment amount only when the ledger row is a DEBIT collection. */
const debitPaidAmount = (doc) => {
  if (!isDebitPaymentTransaction(doc)) return 0;
  if (String(doc?.status || '').toLowerCase() === 'cancelled') return 0;
  const amount = Number(doc?.amount) || 0;
  return amount > 0 ? amount : 0;
};

/**
 * Resolve Fee Management head ids/codes for Step 4 tuition + other (Special Fee).
 * Matches admission view-details pivot: TUI01 + OTH1 / Special Fee.
 */
export async function resolveTuitionAndOtherFeeHeadRefs() {
  const includedCodes = [TUI_FEE_HEAD_CODE, SPECIAL_FEE_HEAD_CODE];
  const codeMatchers = includedCodes.map(
    (code) => new RegExp(`^${code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')
  );

  const conn = await connectFeeManagement();
  const heads = await conn.db
    .collection('feeheads')
    .find({
      $or: [
        { code: { $in: codeMatchers } },
        { feeHeadCode: { $in: codeMatchers } },
      ],
    })
    .project({ _id: 1, code: 1, feeHeadCode: 1, name: 1 })
    .toArray();

  const tuitionIds = new Set([TUI_FEE_HEAD_ID]);
  const otherIds = new Set();

  for (const head of heads) {
    const id = String(head._id || '').trim();
    if (!id) continue;
    const code = String(head.code || head.feeHeadCode || '')
      .trim()
      .toUpperCase();
    const name = String(head.name || '')
      .trim()
      .toUpperCase();
    if (code === TUI_FEE_HEAD_CODE) {
      tuitionIds.add(id);
    } else if (code === SPECIAL_FEE_HEAD_CODE || name === 'SPECIAL FEE') {
      otherIds.add(id);
    }
  }

  return {
    tuitionIds: [...tuitionIds],
    otherIds: [...otherIds],
    allIds: [...new Set([...tuitionIds, ...otherIds])],
    codeMatchers,
  };
}

const classifyHeadBucket = (doc, refs) => {
  const code = String(doc.feeHeadCode || doc.code || '')
    .trim()
    .toUpperCase();
  if (code === TUI_FEE_HEAD_CODE) return 'tuition';
  if (code === SPECIAL_FEE_HEAD_CODE) return 'other';

  const normalizeId = (value) => {
    if (value == null) return '';
    if (typeof value === 'object') {
      if (value._id) return String(value._id).trim();
      if (typeof value.toHexString === 'function') return value.toHexString();
    }
    return String(value).trim();
  };

  const feeHeadStr = normalizeId(doc.feeHead);
  const feeHeadIdStr = normalizeId(doc.feeHeadId);
  if (refs.tuitionIds.includes(feeHeadStr) || refs.tuitionIds.includes(feeHeadIdStr)) {
    return 'tuition';
  }
  if (refs.otherIds.includes(feeHeadStr) || refs.otherIds.includes(feeHeadIdStr)) {
    return 'other';
  }
  return null;
};

/**
 * Sum payments across exactly the two Student Info fee heads for a student year:
 * Tuition (TUI01) + Special Fee (OTH1). Application, school, other, transport,
 * hostel, and every other fee head are intentionally excluded.
 *
 * @param {string[]} admissionNumbers
 * @param {number} [studentYear=1]
 * @returns {Promise<Map<string, number>>}
 */
export async function fetchPaidByAdmissionNumbersForStudentYear(
  admissionNumbers,
  studentYear = TUI_STUDENT_YEAR
) {
  const ids = [
    ...new Set(
      (Array.isArray(admissionNumbers) ? admissionNumbers : [])
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    ),
  ];
  const result = new Map();
  if (ids.length === 0) return result;

  try {
    const conn = await connectFeeManagement();
    const refs = await resolveTuitionAndOtherFeeHeadRefs();
    const includedFeeHeadValues = [
      ...new Set(refs.allIds.flatMap((id) => feeHeadMatchValues(id))),
    ];
    const docs = await conn.db
      .collection('transactions')
      .find({
        studentId: { $in: ids },
        studentYear: studentYearMatchFilter(studentYear),
        $or: [
          { feeHead: { $in: includedFeeHeadValues } },
          { feeHeadId: { $in: refs.allIds } },
          { feeHeadCode: { $in: refs.codeMatchers } },
        ],
      })
      .project({ studentId: 1, amount: 1, transactionType: 1, status: 1 })
      .toArray();

    for (const doc of docs) {
      const amount = debitPaidAmount(doc);
      if (amount <= 0) continue;
      const studentId = String(doc.studentId || '').trim();
      if (!studentId) continue;
      result.set(studentId, (result.get(studentId) || 0) + amount);
    }
  } catch (error) {
    console.error('[fetchPaidByAdmissionNumbersForStudentYear]', error?.message || error);
  }

  return result;
}

const emptyTuitionSummary = () => ({
  payable: 0,
  paid: 0,
  pending: 0,
  hasFeeEntry: false,
  feeStatus: 'no_entry',
  displayAmount: 0,
  displayLabel: 'Pending',
  tuition: emptyHeadAmounts(),
  other: emptyHeadAmounts(),
});

/**
 * Sum Year-1 tuition payable per admission from Fee Management `studentfees` ledger.
 *
 * @param {string[]} admissionNumbers
 * @param {number} [studentYear=1]
 * @returns {Promise<Map<string, { payable: number; hasFeeEntry: boolean }>>}
 */
export async function fetchTuitionPayableByAdmissionNumbers(
  admissionNumbers,
  studentYear = TUI_STUDENT_YEAR
) {
  const ids = [
    ...new Set(
      (Array.isArray(admissionNumbers) ? admissionNumbers : [])
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    ),
  ];
  const result = new Map();
  if (ids.length === 0) return result;

  try {
    const conn = await connectFeeManagement();
    const feeHeadValues = feeHeadMatchValues(TUI_FEE_HEAD_ID);
    const docs = await conn.db
      .collection('studentfees')
      .find({
        studentId: { $in: ids },
        isActive: { $ne: false },
        studentYear: studentYearMatchFilter(studentYear),
        $or: [{ feeHead: { $in: feeHeadValues } }, { feeHeadId: TUI_FEE_HEAD_ID }],
      })
      .project({ studentId: 1, amount: 1 })
      .toArray();

    for (const doc of docs) {
      const studentId = String(doc.studentId || '').trim();
      if (!studentId) continue;
      const amount = Number(doc.amount) || 0;
      const prev = result.get(studentId) || { payable: 0, hasFeeEntry: false };
      prev.payable += amount;
      prev.hasFeeEntry = true;
      result.set(studentId, prev);
    }
  } catch (error) {
    console.error('[fetchTuitionPayableByAdmissionNumbers]', error?.message || error);
  }

  return result;
}

/**
 * Sum Year-1 tuition fee-head payments per admission from Fee Management MongoDB.
 * Mirrors JoiningLeadFormWorkspace feeMongoPaidByHeadYear for studentYear 1.
 *
 * @param {string[]} admissionNumbers
 * @param {number} [studentYear=1]
 * @returns {Promise<Map<string, number>>}
 */
export async function fetchTuitionPaidByAdmissionNumbers(
  admissionNumbers,
  studentYear = TUI_STUDENT_YEAR
) {
  const ids = [
    ...new Set(
      (Array.isArray(admissionNumbers) ? admissionNumbers : [])
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    ),
  ];
  const result = new Map();
  if (ids.length === 0) return result;

  try {
    const conn = await connectFeeManagement();
    const feeHeadValues = feeHeadMatchValues(TUI_FEE_HEAD_ID);
    const docs = await conn.db
      .collection('transactions')
      .find({
        studentId: { $in: ids },
        feeHead: { $in: feeHeadValues },
        studentYear: studentYearMatchFilter(studentYear),
      })
      .project({ studentId: 1, amount: 1, transactionType: 1, status: 1 })
      .toArray();

    for (const doc of docs) {
      const amount = debitPaidAmount(doc);
      if (amount <= 0) continue;
      const studentId = String(doc.studentId || '').trim();
      if (!studentId) continue;
      result.set(studentId, (result.get(studentId) || 0) + amount);
    }
  } catch (error) {
    console.error('[fetchTuitionPaidByAdmissionNumbers]', error?.message || error);
  }

  return result;
}

/**
 * Year-1 payable + paid for Tuition (TUI01) and Other/Special (OTH1), matching Step 4
 * admission view-details heads (excluding transport/hostel/application).
 *
 * @param {string[]} admissionNumbers
 * @param {number} [studentYear=1]
 * @returns {Promise<Map<string, { tuition: object; other: object }>>}
 */
export async function fetchTuitionAndOtherAmountsByAdmissionNumbers(
  admissionNumbers,
  studentYear = TUI_STUDENT_YEAR
) {
  const ids = [
    ...new Set(
      (Array.isArray(admissionNumbers) ? admissionNumbers : [])
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    ),
  ];
  const result = new Map(
    ids.map((id) => [id, { tuition: emptyHeadAmounts(), other: emptyHeadAmounts() }])
  );
  if (ids.length === 0) return result;

  try {
    const conn = await connectFeeManagement();
    const refs = await resolveTuitionAndOtherFeeHeadRefs();
    const includedFeeHeadValues = [
      ...new Set(refs.allIds.flatMap((id) => feeHeadMatchValues(id))),
    ];

    const [payableDocs, paidDocs] = await Promise.all([
      conn.db
        .collection('studentfees')
        .find({
          studentId: { $in: ids },
          isActive: { $ne: false },
          studentYear: studentYearMatchFilter(studentYear),
          $or: [
            { feeHead: { $in: includedFeeHeadValues } },
            { feeHeadId: { $in: refs.allIds } },
            { feeHeadCode: { $in: refs.codeMatchers } },
          ],
        })
        .project({
          studentId: 1,
          amount: 1,
          feeHead: 1,
          feeHeadId: 1,
          feeHeadCode: 1,
          code: 1,
        })
        .toArray(),
      conn.db
        .collection('transactions')
        .find({
          studentId: { $in: ids },
          studentYear: studentYearMatchFilter(studentYear),
          $or: [
            { feeHead: { $in: includedFeeHeadValues } },
            { feeHeadId: { $in: refs.allIds } },
            { feeHeadCode: { $in: refs.codeMatchers } },
          ],
        })
        .project({
          studentId: 1,
          amount: 1,
          transactionType: 1,
          status: 1,
          feeHead: 1,
          feeHeadId: 1,
          feeHeadCode: 1,
          code: 1,
        })
        .toArray(),
    ]);

    for (const doc of payableDocs) {
      const studentId = String(doc.studentId || '').trim();
      if (!studentId) continue;
      const bucket = classifyHeadBucket(doc, refs);
      if (!bucket) continue;
      const entry = result.get(studentId) || {
        tuition: emptyHeadAmounts(),
        other: emptyHeadAmounts(),
      };
      entry[bucket].payable += Number(doc.amount) || 0;
      entry[bucket].hasFeeEntry = true;
      result.set(studentId, entry);
    }

    for (const doc of paidDocs) {
      const amount = debitPaidAmount(doc);
      if (amount <= 0) continue;
      const studentId = String(doc.studentId || '').trim();
      if (!studentId) continue;
      const bucket = classifyHeadBucket(doc, refs);
      if (!bucket) continue;
      const entry = result.get(studentId) || {
        tuition: emptyHeadAmounts(),
        other: emptyHeadAmounts(),
      };
      entry[bucket].paid += amount;
      entry[bucket].hasFeeEntry = true;
      result.set(studentId, entry);
    }

    for (const [studentId, entry] of result.entries()) {
      for (const key of ['tuition', 'other']) {
        const head = entry[key];
        head.pending = Math.max(head.payable - head.paid, 0);
        if (head.paid > 0 || head.payable > 0) head.hasFeeEntry = true;
      }
      result.set(studentId, entry);
    }
  } catch (error) {
    console.error('[fetchTuitionAndOtherAmountsByAdmissionNumbers]', error?.message || error);
  }

  return result;
}

/**
 * Build Year-1 tuition fee summary per admission (payable, paid, pending, display label).
 * Kept for callers that still need tuition-only.
 *
 * @param {string[]} admissionNumbers
 * @param {number} [studentYear=1]
 * @returns {Promise<Map<string, ReturnType<typeof emptyTuitionSummary>>>}
 */
export async function buildTuitionFeeSummariesByAdmissionNumbers(
  admissionNumbers,
  studentYear = TUI_STUDENT_YEAR
) {
  const ids = [
    ...new Set(
      (Array.isArray(admissionNumbers) ? admissionNumbers : [])
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    ),
  ];
  const summaries = new Map(ids.map((id) => [id, emptyTuitionSummary()]));
  if (ids.length === 0) return summaries;

  const [paidMap, payableMap] = await Promise.all([
    fetchTuitionPaidByAdmissionNumbers(ids, studentYear),
    fetchTuitionPayableByAdmissionNumbers(ids, studentYear),
  ]);

  for (const id of ids) {
    const paid = paidMap.get(id) || 0;
    const payableInfo = payableMap.get(id) || { payable: 0, hasFeeEntry: false };
    const payable = payableInfo.payable;
    const hasFeeEntry = payableInfo.hasFeeEntry || paid > 0 || payable > 0;
    const pending = Math.max(payable - paid, 0);

    if (!hasFeeEntry) {
      summaries.set(id, emptyTuitionSummary());
      continue;
    }

    // Any recorded payment counts as Paid (partial payments included).
    if (paid > FEE_PENDING_TOLERANCE) {
      summaries.set(id, {
        ...emptyTuitionSummary(),
        payable,
        paid,
        pending,
        hasFeeEntry: true,
        feeStatus: 'paid',
        displayAmount: paid,
        displayLabel: 'Paid',
        tuition: {
          payable,
          paid,
          pending,
          hasFeeEntry: true,
        },
      });
      continue;
    }

    summaries.set(id, {
      ...emptyTuitionSummary(),
      payable,
      paid,
      pending,
      hasFeeEntry: true,
      feeStatus: 'unpaid',
      displayAmount: pending > 0 ? pending : payable,
      displayLabel: 'Unpaid',
      tuition: {
        payable,
        paid,
        pending,
        hasFeeEntry: true,
      },
    });
  }

  return summaries;
}

/**
 * Build Step 4 fee summary (Tuition TUI01 + Other/Special OTH1) per admission.
 * Combined totals drive paid/unpaid; per-head amounts are included for UI/export/print.
 *
 * Paid uses the same Student Info lookup (TUI01 + OTH1 transactions).
 * Unpaid = remaining balance (payable − paid) > tolerance — partial payments stay in the pending list.
 *
 * @param {string[]} admissionNumbers
 * @param {number|number[]} [studentYear=1] Single year or years array (lateral: 2+)
 * @returns {Promise<Map<string, ReturnType<typeof emptyTuitionSummary>>>}
 */
export async function buildTuitionAndOtherFeeSummariesByAdmissionNumbers(
  admissionNumbers,
  studentYear = TUI_STUDENT_YEAR
) {
  const ids = [
    ...new Set(
      (Array.isArray(admissionNumbers) ? admissionNumbers : [])
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    ),
  ];
  const summaries = new Map(ids.map((id) => [id, emptyTuitionSummary()]));
  if (ids.length === 0) return summaries;

  const [amountsMap, combinedPaidMap] = await Promise.all([
    fetchTuitionAndOtherAmountsByAdmissionNumbers(ids, studentYear),
    fetchPaidByAdmissionNumbersForStudentYear(ids, studentYear),
  ]);

  for (const id of ids) {
    const amounts = amountsMap.get(id) || {
      tuition: emptyHeadAmounts(),
      other: emptyHeadAmounts(),
    };
    const tuition = { ...emptyHeadAmounts(), ...amounts.tuition };
    const other = { ...emptyHeadAmounts(), ...amounts.other };

    // Authoritative combined paid (same source as Student Info PAID column).
    const combinedPaid = Math.max(0, Number(combinedPaidMap.get(id) || 0));
    const classifiedPaid = Math.max(0, (tuition.paid || 0) + (other.paid || 0));

    // Prefer Student Info paid total; fall back to classified per-head sum.
    const paid = combinedPaid > FEE_PENDING_TOLERANCE ? combinedPaid : classifiedPaid;

    // If per-head paid didn't classify but combined paid exists, attribute paid to tuition
    // for display (combined columns are primary).
    if (paid > FEE_PENDING_TOLERANCE && classifiedPaid <= FEE_PENDING_TOLERANCE) {
      tuition.paid = paid;
      other.paid = 0;
    }

    tuition.pending = Math.max(tuition.payable - tuition.paid, 0);
    other.pending = Math.max(other.payable - other.paid, 0);

    const payable = tuition.payable + other.payable;
    const pending = Math.max(payable - paid, 0);
    const hasFeeEntry =
      tuition.hasFeeEntry || other.hasFeeEntry || payable > 0 || paid > 0;

    if (!hasFeeEntry) {
      summaries.set(id, emptyTuitionSummary());
      continue;
    }

    // Fully paid when little/no balance remains.
    if (pending <= FEE_PENDING_TOLERANCE) {
      summaries.set(id, {
        payable,
        paid,
        pending: 0,
        hasFeeEntry: true,
        feeStatus: 'paid',
        displayAmount: paid,
        displayLabel: 'Paid',
        tuition,
        other,
      });
      continue;
    }

    // Still owes — include partial payers with paid + remaining unpaid.
    summaries.set(id, {
      payable,
      paid,
      pending,
      hasFeeEntry: true,
      feeStatus: 'unpaid',
      displayAmount: pending,
      displayLabel: 'Unpaid',
      tuition,
      other,
    });
  }

  return summaries;
}

/**
 * Build tuition + other fee summaries for desk admissions.
 * Regular → Year 1; Lateral (quota or course label) → Year 2 onwards — same as Step 4 Collect.
 *
 * No Fee Entry (UI / filter) is only for lateral quota-mismatch students
 * (course is LATERAL but quota is not Lateral Entry / Spot) with no TUI01/OTH1 ledger.
 * Catalog config and unrelated transactions do not clear that flag.
 *
 * @param {Array<{ admissionNumber?: string; quota?: string; course?: string; branch?: string; admission_number?: string }>} rows
 * @returns {Promise<Map<string, ReturnType<typeof emptyTuitionSummary>>>}
 */
export async function buildTuitionAndOtherFeeSummariesForAdmissionRows(rows) {
  const regularIds = [];
  const lateralIds = [];
  const rowById = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = String(row?.admissionNumber ?? row?.admission_number ?? '').trim();
    if (!id) continue;
    rowById.set(id, row);
    if (isLateralDeskFeeStudent(row?.quota, row?.course)) lateralIds.push(id);
    else regularIds.push(id);
  }

  const [regularMap, lateralMap] = await Promise.all([
    buildTuitionAndOtherFeeSummariesByAdmissionNumbers(regularIds, TUI_STUDENT_YEAR),
    buildTuitionAndOtherFeeSummariesByAdmissionNumbers(lateralIds, LATERAL_FEE_STUDENT_YEARS),
  ]);

  const merged = new Map(regularMap);
  for (const [id, summary] of lateralMap.entries()) {
    merged.set(id, summary);
  }

  for (const [id, summary] of merged.entries()) {
    const row = rowById.get(id);
    const payable = Math.max(0, Number(summary?.payable || 0));
    // Ledger amount = studentfees payable for TUI01/OTH1 (not catalog, not other heads).
    const hasLedger = payable > FEE_PENDING_TOLERANCE;
    const mismatch = isLateralQuotaMismatch(row?.quota, row?.course);

    if (mismatch && !hasLedger) {
      merged.set(id, emptyTuitionSummary());
      continue;
    }

    // Non-mismatch students without ledger/payment are not "No Fee Entry".
    if (!summary?.hasFeeEntry) {
      merged.set(id, {
        ...emptyTuitionSummary(),
        hasFeeEntry: false,
        feeStatus: 'unpaid',
        displayLabel: 'Unpaid',
      });
    }
  }

  return merged;
}

/**
 * Desk paid amounts: Year 1 for regular; Year 2 onwards for lateral track (quota or course).
 *
 * @param {Array<{ admissionNumber?: string; quota?: string; course?: string; admission_number?: string }>} rows
 * @returns {Promise<Map<string, number>>}
 */
export async function fetchPaidByAdmissionRowsForDesk(rows) {
  const regularIds = [];
  const lateralIds = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = String(row?.admissionNumber ?? row?.admission_number ?? '').trim();
    if (!id) continue;
    if (isLateralDeskFeeStudent(row?.quota, row?.course)) lateralIds.push(id);
    else regularIds.push(id);
  }

  const [regularPaid, lateralPaid] = await Promise.all([
    fetchPaidByAdmissionNumbersForStudentYear(regularIds, TUI_STUDENT_YEAR),
    fetchPaidByAdmissionNumbersForStudentYear(lateralIds, LATERAL_FEE_STUDENT_YEARS),
  ]);

  const merged = new Map(regularPaid);
  for (const [id, amount] of lateralPaid.entries()) {
    merged.set(id, amount);
  }
  return merged;
}
