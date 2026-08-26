import { getPool } from '../config-sql/database.js';
import { getPool as getSecondaryPool } from '../config-sql/database-secondary.js';
import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { successResponse, errorResponse } from '../utils/response.util.js';
import { createOrder as cashfreeCreateOrder, getOrder as cashfreeGetOrder } from '../services/cashfree.service.js';
import { decryptSensitiveValue } from '../utils/encryption.util.js';
import { connectFeeManagement } from '../config-mongo/feeManagement.js';
import { generateTransactionReceiptNumber } from '../services/receiptSequence.service.js';
import { normalizeOverallConcessionLinesForStorage } from '../utils/overallConcessions.util.js';
import crypto from 'crypto';
import axios from 'axios';

const resolveConfiguredFee = async (courseId, branchId) => {
  if (!courseId) return 0;

  const pool = getPool(); // Primary DB for payment configs

  // Note: courseId and branchId are expected to be strings (from secondary DB int IDs converted to strings)
  // Try to find branch-specific fee first
  if (branchId) {
    const [branchFees] = await pool.execute(
      `SELECT amount FROM payment_configs 
       WHERE course_id = ? AND branch_id = ? AND is_active = 1 
       ORDER BY updated_at DESC LIMIT 1`,
      [courseId, branchId] // Both are strings
    );
    if (branchFees.length > 0) {
      return Number(branchFees[0].amount) || 0;
    }
  }

  // Fallback to course-level fee
  const [courseFees] = await pool.execute(
    `SELECT amount FROM payment_configs 
     WHERE course_id = ? AND branch_id IS NULL AND is_active = 1 
     ORDER BY updated_at DESC LIMIT 1`,
    [courseId] // courseId is string
  );

  return courseFees.length > 0 ? Number(courseFees[0].amount) || 0 : 0;
};

const computeSummaryStatus = (summary) => {
  if (!summary.totalPaid || summary.totalPaid <= 0) {
    return 'not_started';
  }

  if (summary.balance <= 0.5) {
    return 'paid';
  }

  return 'partial';
};

const updatePaymentSummary = async ({
  joiningId,
  admissionId,
  leadId,
  courseId,
  branchId,
  amount,
  currency,
}) => {
  const pool = getPool();
  const updates = [];

  if (joiningId) {
    updates.push(
      (async () => {
        const [joinings] = await pool.execute(
          'SELECT * FROM joinings WHERE id = ?',
          [joiningId]
        );
        if (joinings.length === 0) return;

        const joining = joinings[0];
        let totalFee = Number(joining.payment_total_fee) || 0;
        let totalPaid = Number(joining.payment_total_paid) || 0;
        let balance = Number(joining.payment_balance) || 0;
        const currentCurrency = joining.payment_currency || currency || 'INR';

        const resolvedCourseId = courseId || joining.course_id;
        const resolvedBranchId = branchId || joining.branch_id;

        // Resolve fee if not set
        if (!totalFee || totalFee <= 0) {
          const configuredFee = await resolveConfiguredFee(resolvedCourseId, resolvedBranchId);
          if (configuredFee > 0) {
            totalFee = configuredFee;
          }
        }

        // Update payment summary
        totalPaid = totalPaid + amount;
        if (totalFee && totalFee > 0) {
          balance = Math.max(totalFee - totalPaid, 0);
        } else {
          balance = 0;
        }

        const status = computeSummaryStatus({
          totalPaid,
          balance,
        });

        await pool.execute(
          `UPDATE joinings SET
            payment_total_fee = ?,
            payment_total_paid = ?,
            payment_balance = ?,
            payment_currency = ?,
            payment_status = ?,
            payment_last_payment_at = NOW(),
            updated_at = NOW()
          WHERE id = ?`,
          [totalFee, totalPaid, balance, currentCurrency, status, joiningId]
        );
      })()
    );
  }

  if (admissionId) {
    updates.push(
      (async () => {
        const [admissions] = await pool.execute(
          'SELECT * FROM admissions WHERE id = ?',
          [admissionId]
        );
        if (admissions.length === 0) return;

        const admission = admissions[0];
        let totalFee = Number(admission.payment_total_fee) || 0;
        let totalPaid = Number(admission.payment_total_paid) || 0;
        let balance = Number(admission.payment_balance) || 0;
        const currentCurrency = admission.payment_currency || currency || 'INR';

        const resolvedCourseId = courseId || admission.course_id;
        const resolvedBranchId = branchId || admission.branch_id;

        // Resolve fee if not set
        if (!totalFee || totalFee <= 0) {
          const configuredFee = await resolveConfiguredFee(resolvedCourseId, resolvedBranchId);
          if (configuredFee > 0) {
            totalFee = configuredFee;
          }
        }

        // Update payment summary
        totalPaid = totalPaid + amount;
        if (totalFee && totalFee > 0) {
          balance = Math.max(totalFee - totalPaid, 0);
        } else {
          balance = 0;
        }

        const status = computeSummaryStatus({
          totalPaid,
          balance,
        });

        await pool.execute(
          `UPDATE admissions SET
            payment_total_fee = ?,
            payment_total_paid = ?,
            payment_balance = ?,
            payment_currency = ?,
            payment_status = ?,
            payment_last_payment_at = NOW(),
            updated_at = NOW()
          WHERE id = ?`,
          [totalFee, totalPaid, balance, currentCurrency, status, admissionId]
        );
      })()
    );
  }

  await Promise.all(updates);
};

const toMongoFeeHeadValue = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^[a-fA-F0-9]{24}$/.test(raw)) {
    try {
      return new mongoose.Types.ObjectId(raw);
    } catch {
      return raw;
    }
  }
  return raw;
};

const normalizeManualPaymentMode = (value) => {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'bank' || raw === 'net banking' || raw === 'upi') return 'UPI';
  return 'Cash';
};

const serializeFeeMongoTransaction = (doc, feeHeadDetails = null) => ({
  _id: String(doc._id),
  studentId: doc.studentId || '',
  studentName: doc.studentName || '',
  feeHead: doc.feeHead ? String(doc.feeHead) : '',
  feeHeadName: feeHeadDetails?.name || feeHeadDetails?.feeHeadName || feeHeadDetails?.headName || '',
  feeHeadCode: feeHeadDetails?.code || feeHeadDetails?.feeHeadCode || feeHeadDetails?.headCode || '',
  amount: Number(doc.amount) || 0,
  paymentDate: doc.paymentDate || null,
  transactionType: doc.transactionType || '',
  paymentMode: doc.paymentMode || '',
  bankName: doc.bankName || '',
  instrumentDate: doc.instrumentDate || null,
  referenceNo: doc.referenceNo || '',
  referenceDate: doc.referenceDate || null,
  gatewayPaymentId: doc.gatewayPaymentId || '',
  remarks: doc.remarks || '',
  semester: doc.semester || null,
  studentYear: doc.studentYear || null,
  receiptNumber: doc.receiptNumber || '',
  collectedBy: doc.collectedBy || '',
  collectedByName: doc.collectedByName || '',
  paymentConfigId: doc.paymentConfigId ? String(doc.paymentConfigId) : '',
  depositedToAccount: doc.depositedToAccount || '',
  proceedingId: doc.proceedingId ? String(doc.proceedingId) : '',
  concessionRequestId: doc.concessionRequestId ? String(doc.concessionRequestId) : '',
  status: doc.status === 'cancelled' ? 'cancelled' : 'success',
  createdAt: doc.createdAt || null,
  updatedAt: doc.updatedAt || null,
});

export const getOverallConcessions = async (req, res) => {
  try {
    const admissionNumber = String(req.query.admissionNumber || '').trim();
    if (!admissionNumber) {
      return errorResponse(res, 'admissionNumber is required', 422);
    }

    const secondaryPool = getSecondaryPool();
    const [rows] = await secondaryPool.execute(
      `SELECT admission_number, pin_no, student_name, batch, course, branch, revised_fees, updated_at
       FROM overall_concessions
       WHERE admission_number = ?
       LIMIT 1`,
      [admissionNumber]
    );

    const row = rows[0] || null;

    // Parse approved revised fees from the secondary overall_concessions table
    let approvedRevisedFees = [];
    if (row) {
      try {
        const raw =
          typeof row.revised_fees === 'string'
            ? JSON.parse(row.revised_fees || '[]')
            : Array.isArray(row.revised_fees)
              ? row.revised_fees
              : [];
        approvedRevisedFees = normalizeOverallConcessionLinesForStorage(
          Array.isArray(raw) ? raw : []
        );
      } catch {
        approvedRevisedFees = [];
      }
    }

    // Also check for a pending fee_request for this admission number.
    // If one exists, extract its concession lines and include them tagged with
    // pending:true so the builder and print can display them even before approval.
    let pendingRevisedFees = [];
    try {
      const primaryPool = getPool();
      const [pendingRows] = await primaryPool.execute(
        `SELECT student_fee_details, request_lines
         FROM fee_requests
         WHERE admission_number = ? AND status = 'pending_approval'
         ORDER BY submitted_at DESC
         LIMIT 1`,
        [admissionNumber]
      );
      if (pendingRows.length > 0) {
        const pr = pendingRows[0];
        let sfd = null;
        try {
          sfd =
            typeof pr.student_fee_details === 'string'
              ? JSON.parse(pr.student_fee_details || 'null')
              : pr.student_fee_details || null;
        } catch {
          sfd = null;
        }

        // Build canonical lines from builder studentFeeDetails (preferred) or request_lines (fallback)
        const { buildOverallConcessionLinesFromBuilder, buildOverallConcessionLinesFromPortalLines } =
          await import('../utils/overallConcessions.util.js');

        const fromBuilder = sfd ? buildOverallConcessionLinesFromBuilder(sfd) : [];
        if (fromBuilder.length > 0) {
          pendingRevisedFees = fromBuilder.map((line) => ({ ...line, pending: true }));
        } else {
          let requestLines = [];
          try {
            requestLines =
              typeof pr.request_lines === 'string'
                ? JSON.parse(pr.request_lines || '[]')
                : pr.request_lines || [];
          } catch {
            requestLines = [];
          }
          pendingRevisedFees = buildOverallConcessionLinesFromPortalLines(requestLines).map(
            (line) => ({ ...line, pending: true })
          );
        }
      }
    } catch (pendingErr) {
      console.error('[getOverallConcessions] Failed to fetch pending fee request lines:', pendingErr?.message || pendingErr);
    }

    // Merge: approved lines take precedence; pending lines fill in any heads not yet approved.
    // Key: feeHeadId (or feeHeadCode) + studentYear
    const keyFor = (line) => {
      const head = String(line.feeHeadId || line.feeHeadCode || '').trim().toUpperCase();
      const year = Number(line.studentYear) || 1;
      return `${head}::${year}`;
    };
    const mergedMap = new Map();
    for (const line of approvedRevisedFees) {
      const k = keyFor(line);
      if (k !== '::1') mergedMap.set(k, line);
    }
    for (const line of pendingRevisedFees) {
      const k = keyFor(line);
      // Only add pending line if no approved line already covers it
      if (k !== '::1' && !mergedMap.has(k)) mergedMap.set(k, line);
    }
    const revisedFees = Array.from(mergedMap.values());

    let feeHeads = [];
    try {
      const { connectFeeManagement } = await import('../config-mongo/feeManagement.js');
      const conn = await connectFeeManagement();
      feeHeads = await conn.db.collection('feeheads').find({}).toArray();
    } catch (mongoErr) {
      console.warn('[getOverallConcessions] Fee Mongo lookup skipped for enrichment:', mongoErr?.message);
    }

    const { resolveFeeHead } = await import('../utils/overallConcessions.util.js');
    const enrichedRevisedFees = revisedFees.map((line) => {
      const matched = resolveFeeHead(line, feeHeads);
      if (matched) {
        return {
          ...line,
          feeHeadId: String(matched._id || matched.id),
          feeHeadCode: matched.code || '',
          feeHeadName: matched.name || matched.feeHeadName || matched.headName || '',
        };
      }
      return line;
    });

    if (!row && enrichedRevisedFees.length === 0) {
      return successResponse(res, {
        admissionNumber,
        revisedFees: [],
      });
    }

    return successResponse(res, {
      admissionNumber: row?.admission_number || admissionNumber,
      pinNo: row?.pin_no || '',
      studentName: row?.student_name || '',
      batch: row?.batch || '',
      course: row?.course || '',
      branch: row?.branch || '',
      revisedFees: enrichedRevisedFees,
      updatedAt: row?.updated_at || null,
    });
  } catch (error) {
    console.error('Error fetching overall concessions:', error);
    return errorResponse(res, error.message || 'Failed to fetch overall concessions', 500);
  }
};

export const listFeeManagementTransactions = async (req, res) => {
  try {
    const joiningId = String(req.query.joiningId || '').trim();
    const admissionId = String(req.query.admissionId || '').trim();
    const fallbackStudentId = String(req.query.studentId || req.query.admissionNumber || '').trim();
    let studentId = '';
    const studentYear = String(req.query.studentYear || '').trim();
    if (admissionId || joiningId) {
      const pool = getPool();
      let admission = null;
      if (admissionId) {
        const [rows] = await pool.execute('SELECT admission_number FROM admissions WHERE id = ? LIMIT 1', [
          admissionId,
        ]);
        admission = rows[0] || null;
      }
      if (!admission && joiningId) {
        const [rows] = await pool.execute(
          'SELECT admission_number FROM admissions WHERE joining_id = ? ORDER BY updated_at DESC LIMIT 1',
          [joiningId]
        );
        admission = rows[0] || null;
      }
      studentId = String(admission?.admission_number || '').trim();
    }
    if (!studentId) studentId = fallbackStudentId;
    if (!studentId) {
      // Draft joinings have no admission number until Submit Fee Request — return empty list.
      return successResponse(res, {
        transactions: [],
        data: [],
        total: 0,
        filters: { studentId: null, studentYear: studentYear || null },
      });
    }

    const conn = await connectFeeManagement();
    const query = { studentId };
    if (studentYear) {
      const numericYear = Number(studentYear);
      query.studentYear = Number.isFinite(numericYear) ? { $in: [studentYear, numericYear] } : studentYear;
    }
    const docs = await conn.db
      .collection('transactions')
      .find(query)
      .sort({ paymentDate: -1, createdAt: -1 })
      .limit(100)
      .toArray();

    const feeHeadIds = [
      ...new Set(
        docs
          .map((doc) => (doc.feeHead ? String(doc.feeHead) : ''))
          .filter((id) => /^[a-fA-F0-9]{24}$/.test(id))
      ),
    ].map((id) => new mongoose.Types.ObjectId(id));
    const feeHeads =
      feeHeadIds.length > 0
        ? await conn.db.collection('feeheads').find({ _id: { $in: feeHeadIds } }).toArray()
        : [];
    const feeHeadById = new Map(feeHeads.map((head) => [String(head._id), head]));

    const transactions = docs.map((doc) =>
      serializeFeeMongoTransaction(doc, feeHeadById.get(String(doc.feeHead)))
    );

    return successResponse(res, {
      transactions,
      data: transactions,
      total: docs.length,
      filters: { studentId, studentYear: studentYear || null },
    });
  } catch (error) {
    console.error('Error listing Fee Management transactions:', error);
    return errorResponse(res, error.message || 'Failed to fetch fee transactions', 500);
  }
};

export const recordFeeManagementTransaction = async (req, res) => {
  try {
    const {
      joiningId,
      admissionId,
      feeHead,
      feeHeadName,
      feeHeadCode,
      amount,
      paymentMode,
      receiptNumber,
      remarks,
      semester,
      studentYear,
      paymentConfigId,
      depositedToAccount,
    } = req.body || {};

    if (!joiningId) {
      return errorResponse(res, 'joiningId is required', 422);
    }
    const amountValue = Number(amount);
    if (!Number.isFinite(amountValue) || amountValue <= 0) {
      return errorResponse(res, 'Amount must be a positive number', 422);
    }
    const feeHeadValue = toMongoFeeHeadValue(feeHead);
    if (!feeHeadValue) {
      return errorResponse(res, 'feeHead is required', 422);
    }

    const pool = getPool();
    const [joiningRows] = await pool.execute('SELECT * FROM joinings WHERE id = ? LIMIT 1', [
      joiningId,
    ]);
    if (joiningRows.length === 0) {
      return errorResponse(res, 'Joining not found', 404);
    }
    const joining = joiningRows[0];

    let admission = null;
    if (admissionId) {
      const [admissionRows] = await pool.execute('SELECT * FROM admissions WHERE id = ? LIMIT 1', [
        admissionId,
      ]);
      admission = admissionRows[0] || null;
    }
    if (!admission) {
      const [admissionRows] = await pool.execute(
        'SELECT * FROM admissions WHERE joining_id = ? ORDER BY updated_at DESC LIMIT 1',
        [joiningId]
      );
      admission = admissionRows[0] || null;
    }

    let studentId = String(admission?.admission_number || '').trim();
    // Admission number is minted on Submit Fee Request (revised amounts), not on collect.
    if (!studentId) {
      return errorResponse(
        res,
        'No admission number yet. Submit a fee request with revised fee amounts first to generate the admission number.',
        422
      );
    }

    const [users] = req.user?.id
      ? await pool.execute('SELECT id, name FROM users WHERE id = ? LIMIT 1', [req.user.id])
      : [[]];
    const collector = users[0] || null;
    const now = new Date();
    const conn = await connectFeeManagement();
    const bankReference =
      receiptNumber != null && String(receiptNumber).trim() !== ''
        ? String(receiptNumber).trim()
        : '';
    const normalizedReceipt = await generateTransactionReceiptNumber({
      admissionNumber: studentId,
      feeHeadId: feeHead,
      transactionDate: now,
      admission,
      joining,
      feeMgmtDb: conn.db,
    });
    const normalizedPaymentMode = normalizeManualPaymentMode(paymentMode);
    const normalizedStudentYear =
      studentYear != null && String(studentYear).trim() !== ''
        ? String(studentYear).trim()
        : '1';
    const normalizedSemester =
      semester != null && String(semester).trim() !== '' ? String(semester).trim() : null;

    const doc = {
      studentId,
      studentName: String(admission?.student_name || joining.student_name || '').trim(),
      feeHead: feeHeadValue,
      amount: amountValue,
      transactionType: 'DEBIT',
      paymentMode: normalizedPaymentMode,
      remarks:
        String(remarks || '').trim() ||
        String(feeHeadName || feeHeadCode || 'Fee payment').trim(),
      semester: normalizedSemester,
      studentYear: normalizedStudentYear,
      receiptNumber: normalizedReceipt,
      referenceNo: bankReference || normalizedReceipt,
      referenceDate: now,
      collectedBy: req.user?.id ? String(req.user.id) : '',
      collectedByName: String(collector?.name || req.user?.name || '').trim(),
      paymentDate: now,
      createdAt: now,
      updatedAt: now,
    };

    if (paymentConfigId) {
      const configIdVal = toMongoFeeHeadValue(paymentConfigId);
      if (configIdVal) {
        doc.paymentConfigId = configIdVal;
        if (!depositedToAccount) {
          try {
            const configDoc = await conn.db
              .collection('paymentconfigs')
              .findOne({ _id: configIdVal });
            if (configDoc && configDoc.account_name) {
              doc.depositedToAccount = configDoc.account_name;
            }
          } catch (err) {
            console.error('Error fetching account details from Mongo config:', err);
          }
        }
      }
    }
    if (depositedToAccount) {
      doc.depositedToAccount = String(depositedToAccount).trim();
    }

    await enrichTransactionMetadata(doc, admission, joining);

    const result = await conn.db.collection('transactions').insertOne(doc);

    return successResponse(
      res,
      {
        _id: String(result.insertedId),
        ...doc,
        feeHead: String(feeHeadValue),
        paymentConfigId: doc.paymentConfigId ? String(doc.paymentConfigId) : undefined,
        admissionNumber: studentId,
        admissionId: admission?.id || null,
      },
      'Fee payment transaction recorded',
      201
    );
  } catch (error) {
    console.error('Error recording Fee Management transaction:', error);
    return errorResponse(
      res,
      error.message || 'Failed to record fee payment transaction',
      error.statusCode || 500
    );
  }
};

const enrichTransactionMetadata = async (doc, admission = null, joining = null) => {
  const studentId = doc.studentId;
  if (!studentId) return;

  // Set default fallbacks from admission/joining first
  doc.college = String(admission?.college || joining?.college || '').trim() || null;
  doc.course = String(admission?.course || joining?.course || '').trim() || null;
  doc.branch = String(admission?.branch || joining?.branch || '').trim() || null;
  doc.admissionNumber = studentId;
  doc.pinNo = null;

  try {
    const secondaryPool = getSecondaryPool();
    const [rows] = await secondaryPool.execute(
      'SELECT student_name, college, course, branch, pin_no, admission_number, current_year FROM students WHERE admission_number = ? OR pin_no = ? LIMIT 1',
      [studentId, studentId]
    );
    if (rows && rows.length > 0) {
      const s = rows[0];
      if (s.student_name) doc.studentName = String(s.student_name).trim();
      if (s.college) doc.college = String(s.college).trim();
      if (s.course) doc.course = String(s.course).trim();
      if (s.branch) doc.branch = String(s.branch).trim();
      if (s.pin_no) doc.pinNo = String(s.pin_no).trim();
      if (s.admission_number) doc.admissionNumber = String(s.admission_number).trim();
      if (s.current_year) doc.studentYear = String(s.current_year).trim();
    }
  } catch (err) {
    console.error('[enrichTransactionMetadata] Failed to fetch student metadata from SQL:', err);
  }
};

// Helper function to format payment transaction
const formatPaymentTransaction = (transaction, collectedByUser = null, course = null, branch = null, joining = null, admission = null) => {
  if (!transaction) return null;
  const parsedMeta = typeof transaction.meta === 'string' ? JSON.parse(transaction.meta) : transaction.meta || {};
  return {
    _id: transaction.id,
    id: transaction.id,
    admissionId: transaction.admission_id,
    joiningId: transaction.joining_id,
    leadId: transaction.lead_id,
    courseId: transaction.course_id,
    branchId: transaction.branch_id,
    amount: Number(transaction.amount),
    currency: transaction.currency || 'INR',
    mode: transaction.mode,
    status: transaction.status,
    collectedBy: collectedByUser || transaction.collected_by,
    cashfreeOrderId: transaction.cashfree_order_id,
    cashfreePaymentSessionId: transaction.cashfree_payment_session_id,
    referenceId: transaction.reference_id,
    notes: transaction.notes,
    isAdditionalFee: transaction.is_additional_fee === 1 || transaction.is_additional_fee === true,
    // Fee-head tagging (Fee Management DB). Stored inside meta JSON for backward compatibility
    // with the existing payment_transactions schema — surfaced at top level so the UI can render
    // "paid against X" badges without parsing meta everywhere.
    feeHead: parsedMeta.feeHead || null,
    feeHeadName: parsedMeta.feeHeadName || '',
    feeHeadCode: parsedMeta.feeHeadCode || '',
    feeStructureBatch: parsedMeta.feeStructureBatch || '',
    feeStructureYear: parsedMeta.feeStructureYear || null,
    meta: parsedMeta,
    processedAt: transaction.processed_at,
    verifiedAt: transaction.verified_at,
    createdAt: transaction.created_at,
    updatedAt: transaction.updated_at,
    // Populated fields
    ...(collectedByUser && {
      collectedBy: {
        _id: collectedByUser.id,
        id: collectedByUser.id,
        name: collectedByUser.name,
        email: collectedByUser.email,
        roleName: collectedByUser.role_name,
      },
    }),
    ...(course && {
      courseId: {
        _id: course.id,
        id: course.id,
        name: course.name,
        code: course.code,
      },
    }),
    ...(branch && {
      branchId: {
        _id: branch.id,
        id: branch.id,
        name: branch.name,
        code: branch.code,
      },
    }),
    ...(joining && {
      joiningId: {
        _id: joining.id,
        id: joining.id,
        leadData: typeof joining.lead_data === 'string' ? JSON.parse(joining.lead_data) : joining.lead_data || {},
        courseInfo: {
          courseId: joining.course_id,
          branchId: joining.branch_id,
          course: joining.course || '',
          branch: joining.branch || '',
        },
        status: joining.status,
      },
    }),
    ...(admission && {
      admissionId: {
        _id: admission.id,
        id: admission.id,
        admissionNumber: admission.admission_number,
        leadData: typeof admission.lead_data === 'string' ? JSON.parse(admission.lead_data) : admission.lead_data || {},
        enquiryNumber: admission.enquiry_number,
        courseInfo: {
          courseId: admission.course_id,
          branchId: admission.branch_id,
          course: admission.course || '',
          branch: admission.branch || '',
        },
      },
    }),
  };
};

export const listTransactions = async (req, res) => {
  try {
    const { leadId, admissionId, joiningId } = req.query;
    const pool = getPool();

    // Build WHERE conditions
    const conditions = [];
    const params = [];

    // Prefer joiningId — callers often pass the joining UUID in the leadId route param.
    if (joiningId) {
      conditions.push('pt.joining_id = ?');
      params.push(joiningId);
    } else if (leadId) {
      conditions.push('pt.lead_id = ?');
      params.push(leadId);
    }
    if (admissionId) {
      conditions.push('pt.admission_id = ?');
      params.push(admissionId);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Fetch transactions with joins
    const [transactions] = await pool.execute(
      `SELECT 
        pt.*,
        u.id as collected_by_id, u.name as collected_by_name, u.email as collected_by_email, u.role_name as collected_by_role_name,
        c.id as course_id_full, c.name as course_name, c.code as course_code,
        b.id as branch_id_full, b.name as branch_name, b.code as branch_code,
        j.id as joining_id_full, j.lead_data as joining_lead_data, j.course_id as joining_course_id, 
        j.branch_id as joining_branch_id, j.course as joining_course, j.branch as joining_branch, j.status as joining_status,
        a.id as admission_id_full, a.admission_number, a.lead_data as admission_lead_data, a.enquiry_number,
        a.course_id as admission_course_id, a.branch_id as admission_branch_id, a.course as admission_course, a.branch as admission_branch
      FROM payment_transactions pt
      LEFT JOIN users u ON pt.collected_by = u.id
      LEFT JOIN courses c ON pt.course_id = c.id
      LEFT JOIN branches b ON pt.branch_id = b.id
      LEFT JOIN joinings j ON pt.joining_id = j.id
      LEFT JOIN admissions a ON pt.admission_id = a.id
      ${whereClause}
      ORDER BY pt.created_at DESC`,
      params
    );

    // Sync with Fee Management MongoDB if any transaction is linked to an admission_number
    const admissionNumbers = [
      ...new Set(
        transactions
          .map((t) => String(t.admission_number || '').trim())
          .filter(Boolean)
      ),
    ];

    if (admissionNumbers.length > 0) {
      try {
        const conn = await connectFeeManagement();
        const mongoTxns = await conn.db
          .collection('transactions')
          .find({ studentId: { $in: admissionNumbers } })
          .toArray();

        const mongoStatusMap = new Map();
        for (const mTx of mongoTxns) {
          const status = String(mTx.status || 'active').trim().toLowerCase();
          if (mTx.receiptNumber) {
            mongoStatusMap.set(String(mTx.receiptNumber).trim().toLowerCase(), status);
          }
          if (mTx.referenceNo) {
            mongoStatusMap.set(String(mTx.referenceNo).trim().toLowerCase(), status);
          }
        }

        for (const t of transactions) {
          if (t.status === 'failed') continue;

          const refId = String(t.reference_id || '').trim().toLowerCase();
          let meta = {};
          try {
            meta = typeof t.meta === 'string' ? JSON.parse(t.meta) : t.meta || {};
          } catch {}
          const receiptNum = String(meta.receiptNumber || '').trim().toLowerCase();

          let isCancelledInMongo = false;
          if (refId && mongoStatusMap.get(refId) === 'cancelled') {
            isCancelledInMongo = true;
          }
          if (receiptNum && mongoStatusMap.get(receiptNum) === 'cancelled') {
            isCancelledInMongo = true;
          }

          if (isCancelledInMongo) {
            // Update SQL to failed
            await pool.execute(
              "UPDATE payment_transactions SET status = 'failed', updated_at = NOW() WHERE id = ?",
              [t.id]
            );
            // Subtract from payment summary
            await updatePaymentSummary({
              joiningId: t.joining_id,
              admissionId: t.admission_id,
              leadId: t.lead_id,
              courseId: t.course_id,
              branchId: t.branch_id,
              amount: -Number(t.amount),
              currency: t.currency || 'INR',
            });
            // Update return status
            t.status = 'cancelled';
          }
        }
      } catch (err) {
        console.error('Error syncing SQL transaction status with Mongo:', err);
      }
    }

    // Format transactions
    const formattedTransactions = transactions.map((t) => {
      const collectedByUser = t.collected_by_id ? {
        id: t.collected_by_id,
        name: t.collected_by_name,
        email: t.collected_by_email,
        role_name: t.collected_by_role_name,
      } : null;

      const course = t.course_id_full ? {
        id: t.course_id_full,
        name: t.course_name,
        code: t.course_code,
      } : null;

      const branch = t.branch_id_full ? {
        id: t.branch_id_full,
        name: t.branch_name,
        code: t.branch_code,
      } : null;

      const joining = t.joining_id_full ? {
        id: t.joining_id_full,
        lead_data: t.joining_lead_data,
        course_id: t.joining_course_id,
        branch_id: t.joining_branch_id,
        course: t.joining_course,
        branch: t.joining_branch,
        status: t.joining_status,
      } : null;

      const admission = t.admission_id_full ? {
        id: t.admission_id_full,
        admission_number: t.admission_number,
        lead_data: t.admission_lead_data,
        enquiry_number: t.enquiry_number,
        course_id: t.admission_course_id,
        branch_id: t.admission_branch_id,
        course: t.admission_course,
        branch: t.admission_branch,
      } : null;

      return formatPaymentTransaction(t, collectedByUser, course, branch, joining, admission);
    });

    return successResponse(res, formattedTransactions);
  } catch (error) {
    console.error('Error listing transactions:', error);
    return errorResponse(res, error.message || 'Failed to load payment transactions', 500);
  }
};

export const recordCashPayment = async (req, res) => {
  try {
    const {
      leadId,
      joiningId,
      admissionId,
      courseId,
      branchId,
      amount,
      currency = 'INR',
      notes,
      referenceId,
      isAdditionalFee = false,
      // Optional fee-head tagging from Fee Management DB
      feeHead = null,
      feeHeadName = '',
      feeHeadCode = '',
      feeStructureBatch = '',
      feeStructureYear = null,
    } = req.body;

    const pool = getPool();

    if (!joiningId) {
      return errorResponse(res, 'joiningId is required', 422);
    }
    
    // Get leadId from joining if not provided
    let finalLeadId = leadId;
    if (!finalLeadId && joiningId) {
      const [joinings] = await pool.execute(
        'SELECT lead_id FROM joinings WHERE id = ?',
        [joiningId]
      );
      if (joinings.length > 0 && joinings[0].lead_id) {
        finalLeadId = joinings[0].lead_id;
      }
    }

    if (typeof amount !== 'number' || amount <= 0) {
      return errorResponse(res, 'Amount must be a positive number', 422);
    }

    // Resolve admission by joining when caller omits admissionId.
    let finalAdmissionId = admissionId || null;
    if (!finalAdmissionId && joiningId) {
      const [admissionRows] = await pool.execute(
        'SELECT id FROM admissions WHERE joining_id = ? ORDER BY updated_at DESC LIMIT 1',
        [joiningId]
      );
      if (admissionRows.length > 0) {
        finalAdmissionId = admissionRows[0].id;
      }
    }

    // Do not hard-fail on course/branch IDs from managed external catalogs.
    // Resolve from request first, then fallback to joining/admission row values.
    let resolvedCourseId = courseId || null;
    let resolvedBranchId = branchId || null;

    if ((!resolvedCourseId || !resolvedBranchId) && joiningId) {
      const [joinings] = await pool.execute(
        'SELECT course_id, branch_id FROM joinings WHERE id = ? LIMIT 1',
        [joiningId]
      );
      if (joinings.length > 0) {
        resolvedCourseId = resolvedCourseId || joinings[0].course_id || null;
        resolvedBranchId = resolvedBranchId || joinings[0].branch_id || null;
      }
    }

    if ((!resolvedCourseId || !resolvedBranchId) && finalAdmissionId) {
      const [admissions] = await pool.execute(
        'SELECT course_id, branch_id FROM admissions WHERE id = ? LIMIT 1',
        [finalAdmissionId]
      );
      if (admissions.length > 0) {
        resolvedCourseId = resolvedCourseId || admissions[0].course_id || null;
        resolvedBranchId = resolvedBranchId || admissions[0].branch_id || null;
      }
    }

    // Keep payment insert resilient when course/branch comes from external managed catalogs:
    // only persist IDs that actually exist in primary FK tables.
    if (resolvedCourseId != null && String(resolvedCourseId) !== '') {
      const [courses] = await pool.execute('SELECT id FROM courses WHERE id = ? LIMIT 1', [
        resolvedCourseId,
      ]);
      if (courses.length === 0) {
        resolvedCourseId = null;
      }
    }

    if (resolvedBranchId != null && String(resolvedBranchId) !== '') {
      const [branches] = await pool.execute('SELECT id FROM branches WHERE id = ? LIMIT 1', [
        resolvedBranchId,
      ]);
      if (branches.length === 0) {
        resolvedBranchId = null;
      }
    }

    if (!resolvedCourseId) {
      resolvedBranchId = null;
    }

    // Create transaction
    const transactionId = uuidv4();
    const normalizedReferenceId =
      referenceId != null && String(referenceId).trim() !== ''
        ? String(referenceId).trim()
        : null;

    await pool.execute(
      `INSERT INTO payment_transactions (
        id, lead_id, joining_id, admission_id, course_id, branch_id,
        amount, currency, mode, status, collected_by, reference_id, notes,
        is_additional_fee, meta, processed_at, verified_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), NOW(), NOW())`,
      [
        transactionId,
        finalLeadId || null,
        joiningId,
        finalAdmissionId,
        resolvedCourseId,
        resolvedBranchId,
        amount,
        currency.toUpperCase(),
        'cash',
        'success',
        req.user?.id || null,
        normalizedReferenceId,
        notes || null,
        isAdditionalFee === true ? 1 : 0,
        JSON.stringify({
          recordedBy: req.user?.id || null,
          isAdditionalFee,
          ...(feeHead ? { feeHead: String(feeHead) } : {}),
          ...(feeHeadName ? { feeHeadName: String(feeHeadName) } : {}),
          ...(feeHeadCode ? { feeHeadCode: String(feeHeadCode) } : {}),
          ...(feeStructureBatch ? { feeStructureBatch: String(feeStructureBatch) } : {}),
          ...(feeStructureYear != null ? { feeStructureYear } : {}),
        }),
      ]
    );

    // Update payment summary
    await updatePaymentSummary({
      joiningId,
      admissionId: finalAdmissionId,
      leadId: finalLeadId,
      courseId: resolvedCourseId,
      branchId: resolvedBranchId,
      amount,
      currency,
    });

    // Fetch created transaction
    const [transactions] = await pool.execute(
      `SELECT pt.*,
        u.id as collected_by_id, u.name as collected_by_name, u.email as collected_by_email, u.role_name as collected_by_role_name
      FROM payment_transactions pt
      LEFT JOIN users u ON pt.collected_by = u.id
      WHERE pt.id = ?`,
      [transactionId]
    );

    const transaction = formatPaymentTransaction(
      transactions[0],
      transactions[0].collected_by_id ? {
        id: transactions[0].collected_by_id,
        name: transactions[0].collected_by_name,
        email: transactions[0].collected_by_email,
        role_name: transactions[0].collected_by_role_name,
      } : null
    );

    return successResponse(res, transaction, 'Cash payment recorded successfully', 201);
  } catch (error) {
    console.error('Error recording cash payment:', error);
    return errorResponse(res, error.message || 'Failed to record cash payment', 500);
  }
};

export const createCashfreeOrder = async (req, res) => {
  try {
    const {
      leadId,
      joiningId,
      admissionId,
      courseId,
      branchId,
      amount,
      currency = 'INR',
      customer = {},
      notes,
      isAdditionalFee = false,
      // Optional fee-head tagging from Fee Management DB
      feeHead = null,
      feeHeadName = '',
      feeHeadCode = '',
      feeStructureBatch = '',
      feeStructureYear = null,
    } = req.body;

    const pool = getPool();

    if (!joiningId) {
      return errorResponse(res, 'joiningId is required', 422);
    }
    
    // Get leadId from joining if not provided
    let finalLeadId = leadId;
    if (!finalLeadId && joiningId) {
      const [joinings] = await pool.execute(
        'SELECT lead_id FROM joinings WHERE id = ?',
        [joiningId]
      );
      if (joinings.length > 0 && joinings[0].lead_id) {
        finalLeadId = joinings[0].lead_id;
      }
    }

    if (typeof amount !== 'number' || amount <= 0) {
      return errorResponse(res, 'Amount must be a positive number', 422);
    }

    // Resolve admission by joining when caller omits admissionId.
    let finalAdmissionId = admissionId || null;
    if (!finalAdmissionId && joiningId) {
      const [admissionRows] = await pool.execute(
        'SELECT id FROM admissions WHERE joining_id = ? ORDER BY updated_at DESC LIMIT 1',
        [joiningId]
      );
      if (admissionRows.length > 0) {
        finalAdmissionId = admissionRows[0].id;
      }
    }

    // Get Cashfree config
    const [configs] = await pool.execute(
      `SELECT * FROM payment_gateway_configs WHERE provider = 'cashfree' AND is_active = 1 LIMIT 1`
    );
    if (configs.length === 0) {
      return errorResponse(res, 'Cashfree configuration is not set', 503);
    }

    const config = configs[0];
    let clientId = decryptSensitiveValue(config.client_id);
    let clientSecret = decryptSensitiveValue(config.client_secret);

    // Trim whitespace and newlines from credentials
    if (clientId) {
      clientId = clientId.trim().replace(/\r?\n/g, '').replace(/\s+/g, '');
    }
    if (clientSecret) {
      clientSecret = clientSecret.trim().replace(/\r?\n/g, '').replace(/\s+/g, '');
    }

    if (!clientId || !clientSecret || clientId === '' || clientSecret === '') {
      console.error('Cashfree credentials missing or invalid:', {
        hasClientId: !!config.client_id,
        hasClientSecret: !!config.client_secret,
        clientIdLength: clientId?.length || 0,
        clientSecretLength: clientSecret?.length || 0,
        environment: config.environment,
        clientIdIsEmpty: !clientId || clientId === '',
        clientSecretIsEmpty: !clientSecret || clientSecret === '',
        rawClientIdLength: config.client_id?.length || 0,
        rawClientSecretLength: config.client_secret?.length || 0,
      });
      return errorResponse(
        res,
        'Cashfree credentials are misconfigured. Please update them in Payment Settings.',
        503
      );
    }

    // Validate credential format (basic checks)
    // Cashfree client IDs are typically numeric or alphanumeric
    // Cashfree client secrets typically start with 'cfsk_' for sandbox or 'cfsk_ma_' for production
    if (clientSecret.length < 20) {
      console.warn('Cashfree client secret seems too short. Expected length: 20+ characters');
    }
    if (clientId.length < 5) {
      console.warn('Cashfree client ID seems too short. Expected length: 5+ characters');
    }

    // Log credential info (without exposing secrets) - for debugging
    console.log('Using Cashfree config:', {
      environment: config.environment,
      clientIdLength: clientId.length,
      clientIdPrefix: clientId.length > 8 ? clientId.substring(0, 8) + '...' : '***',
      clientIdSuffix: clientId.length > 8 ? '...' + clientId.substring(clientId.length - 4) : '***',
      clientSecretLength: clientSecret.length,
      clientSecretPrefix: clientSecret.length > 8 ? clientSecret.substring(0, 8) + '...' : '***',
      clientSecretSuffix: clientSecret.length > 8 ? '...' + clientSecret.substring(clientSecret.length - 4) : '***',
      // Check for common issues
      clientIdHasWhitespace: clientId !== clientId.trim(),
      clientSecretHasWhitespace: clientSecret !== clientSecret.trim(),
      clientIdStartsWithSpace: clientId.startsWith(' ') || clientId.startsWith('\n') || clientId.startsWith('\t'),
      clientSecretStartsWithSpace: clientSecret.startsWith(' ') || clientSecret.startsWith('\n') || clientSecret.startsWith('\t'),
    });

    const orderId = `ADM-${Date.now()}-${uuidv4().slice(0, 8).toUpperCase()}`;

    const payload = {
      order_id: orderId,
      order_amount: amount,
      order_currency: currency,
      customer_details: {
        customer_id: customer.customerId || finalLeadId,
        customer_name: customer.name || 'Prospective Student',
        customer_email: customer.email || 'placeholder@example.com',
        customer_phone: customer.phone || '9999999999',
      },
      order_meta: {
        notify_url: customer.notifyUrl || undefined,
      },
      notes: {
        ...notes,
        leadId: finalLeadId,
        joiningId,
        admissionId: finalAdmissionId,
      },
    };

    const environment = config.environment || 'production';

    let orderResponse;
    try {
      orderResponse = await cashfreeCreateOrder({
        environment,
        clientId,
        clientSecret,
        payload,
      });
    } catch (cashfreeError) {
      console.error('Cashfree API error details:', {
        message: cashfreeError.message,
        environment,
        orderId: payload.order_id,
        amount: payload.order_amount,
        currency: payload.order_currency,
        clientIdLength: clientId.length,
        clientIdPrefix: clientId.substring(0, 8) + '...',
        clientSecretLength: clientSecret.length,
        clientSecretPrefix: clientSecret.substring(0, 8) + '...',
        // Don't log full credentials
      });
      
      // Provide more helpful error message
      if (cashfreeError.message && cashfreeError.message.toLowerCase().includes('authentication')) {
        return errorResponse(
          res,
          'Cashfree authentication failed. Please verify your Client ID and Client Secret are correct and match the selected environment (sandbox/production).',
          401
        );
      }
      
      throw cashfreeError;
    }

    if (!orderResponse || !orderResponse.order_id || !orderResponse.payment_session_id) {
      return errorResponse(res, 'Failed to create Cashfree order', 502);
    }

    // Create transaction
    const transactionId = uuidv4();
    await pool.execute(
      `INSERT INTO payment_transactions (
        id, lead_id, joining_id, admission_id, course_id, branch_id,
        amount, currency, mode, status, cashfree_order_id, cashfree_payment_session_id,
        notes, is_additional_fee, meta, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        transactionId,
        finalLeadId || null,
        joiningId,
        finalAdmissionId,
        courseId || null,
        branchId || null,
        amount,
        currency.toUpperCase(),
        'online',
        'pending',
        orderResponse.order_id,
        orderResponse.payment_session_id,
        notes || null,
        isAdditionalFee === true ? 1 : 0,
        JSON.stringify({
          cashfree: orderResponse,
          isAdditionalFee,
          ...(feeHead ? { feeHead: String(feeHead) } : {}),
          ...(feeHeadName ? { feeHeadName: String(feeHeadName) } : {}),
          ...(feeHeadCode ? { feeHeadCode: String(feeHeadCode) } : {}),
          ...(feeStructureBatch ? { feeStructureBatch: String(feeStructureBatch) } : {}),
          ...(feeStructureYear != null ? { feeStructureYear } : {}),
        }),
      ]
    );

    return successResponse(
      res,
      {
        orderId: orderResponse.order_id,
        paymentSessionId: orderResponse.payment_session_id,
        order: orderResponse,
        transactionId,
      },
      'Cashfree order created successfully',
      201
    );
  } catch (error) {
    console.error('Error creating Cashfree order:', error);
    return errorResponse(res, error.message || 'Failed to initiate online payment', 500);
  }
};

export const verifyCashfreePayment = async (req, res) => {
  try {
    const { orderId } = req.body;
    const pool = getPool();

    if (!orderId) {
      return errorResponse(res, 'orderId is required', 422);
    }

    // Find transaction
    const [transactions] = await pool.execute(
      'SELECT * FROM payment_transactions WHERE cashfree_order_id = ?',
      [orderId]
    );
    if (transactions.length === 0) {
      return errorResponse(res, 'Transaction not found for the provided orderId', 404);
    }

    const transaction = transactions[0];

    // Get Cashfree config
    const [configs] = await pool.execute(
      `SELECT * FROM payment_gateway_configs WHERE provider = 'cashfree' AND is_active = 1 LIMIT 1`
    );
    if (configs.length === 0) {
      return errorResponse(res, 'Cashfree configuration is not set', 503);
    }

    const config = configs[0];
    const clientId = decryptSensitiveValue(config.client_id);
    const clientSecret = decryptSensitiveValue(config.client_secret);

    if (!clientId || !clientSecret) {
      return errorResponse(
        res,
        'Cashfree credentials are misconfigured. Please update them in Payment Settings.',
        503
      );
    }

    const environment = config.environment || 'production';

    const order = await cashfreeGetOrder({
      environment,
      clientId,
      clientSecret,
      orderId,
    });

    if (!order || !order.order_status) {
      return errorResponse(res, 'Unable to verify payment status', 502);
    }

    const orderStatus = order.order_status.toLowerCase();
    let transactionStatus = 'pending';

    if (orderStatus === 'paid') {
      transactionStatus = 'success';
    } else if (['failed', 'cancelled', 'expired'].includes(orderStatus)) {
      transactionStatus = 'failed';
    }

    // Parse existing meta
    const existingMeta = typeof transaction.meta === 'string' 
      ? JSON.parse(transaction.meta) 
      : transaction.meta || {};

    // Update transaction
    await pool.execute(
      `UPDATE payment_transactions SET
        status = ?,
        reference_id = ?,
        meta = ?,
        processed_at = ?,
        verified_at = NOW(),
        updated_at = NOW()
      WHERE id = ?`,
      [
        transactionStatus,
        order.cf_payment_id || transaction.reference_id || null,
        JSON.stringify({
          ...existingMeta,
          cashfreeVerification: order,
        }),
        order?.order_completed_time ? new Date(order.order_completed_time) : transaction.processed_at,
        transaction.id,
      ]
    );

    // Update payment summary if successful
    if (transactionStatus === 'success') {
      await updatePaymentSummary({
        joiningId: transaction.joining_id,
        admissionId: transaction.admission_id,
        leadId: transaction.lead_id,
        courseId: transaction.course_id,
        branchId: transaction.branch_id,
        amount: Number(transaction.amount),
        currency: transaction.currency,
      });
    }

    // Fetch updated transaction
    const [updated] = await pool.execute(
      'SELECT * FROM payment_transactions WHERE id = ?',
      [transaction.id]
    );

    const formattedTransaction = formatPaymentTransaction(updated[0]);

    return successResponse(
      res,
      {
        status: transactionStatus,
        order,
        transaction: formattedTransaction,
      },
      'Payment status updated successfully'
    );
  } catch (error) {
    console.error('Error verifying Cashfree payment:', error);
    return errorResponse(res, error.message || 'Failed to verify payment status', 500);
  }
};

export const reconcilePendingTransactions = async (req, res) => {
  try {
    const pool = getPool();

    // Get Cashfree config
    const [configs] = await pool.execute(
      `SELECT * FROM payment_gateway_configs WHERE provider = 'cashfree' AND is_active = 1 LIMIT 1`
    );
    if (configs.length === 0) {
      return errorResponse(res, 'Cashfree configuration is not set', 503);
    }

    const config = configs[0];
    const clientId = decryptSensitiveValue(config.client_id);
    const clientSecret = decryptSensitiveValue(config.client_secret);

    if (!clientId || !clientSecret) {
      return errorResponse(
        res,
        'Cashfree credentials are misconfigured. Please update them in Payment Settings.',
        503
      );
    }

    // Find all pending transactions with cashfreeOrderId
    const [pendingTransactions] = await pool.execute(
      `SELECT * FROM payment_transactions 
       WHERE status = 'pending' 
       AND mode = 'online' 
       AND cashfree_order_id IS NOT NULL 
       AND cashfree_order_id != ''`
    );

    if (pendingTransactions.length === 0) {
      return successResponse(
        res,
        {
          checked: 0,
          updated: 0,
          failed: 0,
          results: [],
        },
        'No pending transactions to reconcile'
      );
    }

    const environment = config.environment || 'production';
    const results = [];
    let updatedCount = 0;
    let failedCount = 0;

    // Process each transaction
    for (const transaction of pendingTransactions) {
      try {
        const order = await cashfreeGetOrder({
          environment,
          clientId,
          clientSecret,
          orderId: transaction.cashfree_order_id,
        });

        if (!order || !order.order_status) {
          results.push({
            transactionId: transaction.id,
            orderId: transaction.cashfree_order_id,
            status: 'error',
            message: 'Unable to verify payment status from Cashfree',
          });
          failedCount++;
          continue;
        }

        const orderStatus = order.order_status.toLowerCase();
        let transactionStatus = 'pending';

        if (orderStatus === 'paid') {
          transactionStatus = 'success';
        } else if (['failed', 'cancelled', 'expired'].includes(orderStatus)) {
          transactionStatus = 'failed';
        }

        // Only update if status changed
        if (transactionStatus !== 'pending') {
          // Parse existing meta
          const existingMeta = typeof transaction.meta === 'string' 
            ? JSON.parse(transaction.meta) 
            : transaction.meta || {};

          await pool.execute(
            `UPDATE payment_transactions SET
              status = ?,
              reference_id = ?,
              meta = ?,
              processed_at = ?,
              verified_at = NOW(),
              updated_at = NOW()
            WHERE id = ?`,
            [
              transactionStatus,
              order.cf_payment_id || transaction.reference_id || null,
              JSON.stringify({
                ...existingMeta,
                cashfreeVerification: order,
              }),
              order?.order_completed_time ? new Date(order.order_completed_time) : transaction.processed_at,
              transaction.id,
            ]
          );

          // Update payment summary if successful
          if (transactionStatus === 'success') {
            await updatePaymentSummary({
              joiningId: transaction.joining_id,
              admissionId: transaction.admission_id,
              leadId: transaction.lead_id,
              courseId: transaction.course_id,
              branchId: transaction.branch_id,
              amount: Number(transaction.amount),
              currency: transaction.currency,
            });
          }

          updatedCount++;
          results.push({
            transactionId: transaction.id,
            orderId: transaction.cashfree_order_id,
            status: transactionStatus,
            message: `Status updated to ${transactionStatus}`,
          });
        } else {
          results.push({
            transactionId: transaction.id,
            orderId: transaction.cashfree_order_id,
            status: 'pending',
            message: 'Still pending at Cashfree',
          });
        }
      } catch (error) {
        console.error(`Error reconciling transaction ${transaction.id}:`, error);
        results.push({
          transactionId: transaction.id,
          orderId: transaction.cashfree_order_id,
          status: 'error',
          message: error.message || 'Failed to reconcile',
        });
        failedCount++;
      }
    }

    return successResponse(
      res,
      {
        checked: pendingTransactions.length,
        updated: updatedCount,
        failed: failedCount,
        results: results.slice(0, 100), // Limit results to first 100
      },
      `Reconciled ${pendingTransactions.length} pending transactions. ${updatedCount} updated, ${failedCount} failed.`
    );
  } catch (error) {
    console.error('Error reconciling pending transactions:', error);
    return errorResponse(res, error.message || 'Failed to reconcile pending transactions', 500);
  }
};

export const createRazorpayQR = async (req, res) => {
  try {
    const {
      joiningId,
      admissionId,
      amount,
      feeHeadId,
      feeHeadName,
      feeHeadCode,
      studentYear,
      semester,
      targets,
    } = req.body || {};

    if (!joiningId) {
      return errorResponse(res, 'joiningId is required', 422);
    }
    const amountValue = Number(amount);
    if (!Number.isFinite(amountValue) || amountValue <= 0) {
      return errorResponse(res, 'Amount must be a positive number', 422);
    }

    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;

    if (!keyId || !keySecret) {
      return errorResponse(
        res,
        'Razorpay configuration is missing or incomplete (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET)',
        503
      );
    }

    const pool = getPool();
    const [joinings] = await pool.execute(
      'SELECT lead_id, course_id, branch_id, student_name, student_phone FROM joinings WHERE id = ? LIMIT 1',
      [joiningId]
    );
    if (joinings.length === 0) {
      return errorResponse(res, 'Joining not found', 404);
    }
    const joining = joinings[0];
    const leadId = joining.lead_id || null;
    const courseId = joining.course_id || null;
    const branchId = joining.branch_id || null;
    const studentName = String(joining.student_name || 'Student').trim();
    const studentPhone = String(joining.student_phone || '').trim();

    const amountInPaise = Math.round(amountValue * 100);
    const authHeader = Buffer.from(`${keyId}:${keySecret}`).toString('base64');

    const orderData = {
      amount: amountInPaise,
      currency: 'INR',
      receipt: `receipt_${Date.now()}`,
      notes: {
        joiningId: String(joiningId),
        admissionId: admissionId ? String(admissionId) : '',
        leadId: leadId ? String(leadId) : '',
        feeHeadId: feeHeadId ? String(feeHeadId) : '',
        feeHeadName: feeHeadName || '',
        feeHeadCode: feeHeadCode || '',
        studentYear: String(studentYear || '1'),
        semester: semester ? String(semester) : '',
        targets: targets ? JSON.stringify(targets) : '',
      },
    };

    const response = await axios.post(
      'https://api.razorpay.com/v1/orders',
      orderData,
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Basic ${authHeader}`,
        },
      }
    );

    const order = response.data;
    if (!order || !order.id) {
      return errorResponse(res, 'Failed to create order from Razorpay', 502);
    }

    const transactionId = uuidv4();
    const metaObj = {
      order,
      feeHeadId,
      feeHeadName,
      feeHeadCode,
      studentYear,
      semester,
      targets,
    };

    await pool.execute(
      `INSERT INTO payment_transactions (
        id, admission_id, joining_id, lead_id, course_id, branch_id,
        amount, currency, mode, status, collected_by, reference_id,
        notes, is_additional_fee, meta, processed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        transactionId,
        admissionId || null,
        joiningId,
        leadId,
        courseId,
        branchId,
        amountValue,
        'INR',
        'upi_qr',
        'pending',
        req.user?.id || null,
        order.id,
        `Razorpay Order created for gateway check out: ${order.id}`,
        false,
        JSON.stringify(metaObj),
      ]
    );

    return successResponse(
      res,
      {
        transactionId,
        key: keyId,
        amount: order.amount,
        currency: order.currency,
        orderId: order.id,
        studentName,
        studentPhone,
      },
      'Razorpay Order created successfully',
      201
    );
  } catch (error) {
    console.error('Error creating Razorpay Order:', error.response?.data || error.message);
    return errorResponse(
      res,
      error.response?.data?.error?.description || error.message || 'Failed to create payment order',
      error.response?.status || 500
    );
  }
};

export const verifyRazorpayQR = async (req, res) => {
  try {
    const { razorpay_payment_id, razorpay_order_id, razorpay_signature } = req.body || {};
    
    if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
      return errorResponse(res, 'razorpay_payment_id, razorpay_order_id, and razorpay_signature are required', 422);
    }

    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keySecret) {
      return errorResponse(res, 'Razorpay configuration is missing', 503);
    }

    const generatedSignature = crypto
      .createHmac('sha256', keySecret)
      .update(razorpay_order_id + '|' + razorpay_payment_id)
      .digest('hex');

    if (generatedSignature !== razorpay_signature) {
      return errorResponse(res, 'Payment signature verification failed', 400);
    }

    const pool = getPool();
    const [transactions] = await pool.execute(
      `SELECT * FROM payment_transactions WHERE reference_id = ? AND mode = 'upi_qr' LIMIT 1`,
      [razorpay_order_id]
    );

    if (transactions.length === 0) {
      return errorResponse(res, 'Transaction not found for the provided order ID', 404);
    }

    const transaction = transactions[0];
    if (transaction.status === 'success') {
      return successResponse(
        res,
        { status: 'success', paymentId: transaction.reference_id },
        'Payment already verified'
      );
    }

    const transactionStatus = 'success';
    const metaObj = typeof transaction.meta === 'string'
      ? JSON.parse(transaction.meta)
      : transaction.meta || {};

    // Fetch detailed payment details from Razorpay to extract the bank UTR / UPI RRN
    let bankUtr = razorpay_payment_id;
    let paymentDetails = null;
    try {
      const authHeader = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${keySecret}`).toString('base64');
      const payResponse = await axios.get(
        `https://api.razorpay.com/v1/payments/${razorpay_payment_id}`,
        {
          headers: {
            Authorization: `Basic ${authHeader}`,
          },
        }
      );
      paymentDetails = payResponse.data;
      if (paymentDetails && paymentDetails.acquirer_data) {
        bankUtr = paymentDetails.acquirer_data.rrn || 
                  paymentDetails.acquirer_data.bank_transaction_id || 
                  paymentDetails.acquirer_data.upi_transaction_id || 
                  razorpay_payment_id;
      }
    } catch (fetchError) {
      console.error('Error fetching payment details from Razorpay:', fetchError.message || fetchError);
    }

    const updatedMetaObj = {
      ...metaObj,
      razorpay_payment_id,
      razorpay_signature,
      razorpayPaymentDetails: paymentDetails,
    };

    await pool.execute(
      `UPDATE payment_transactions SET
        status = ?,
        meta = ?,
        processed_at = NOW(),
        verified_at = NOW(),
        updated_at = NOW()
      WHERE id = ?`,
      [
        transactionStatus,
        JSON.stringify(updatedMetaObj),
        transaction.id,
      ]
    );

    const joiningId = transaction.joining_id;
    const [joiningRows] = await pool.execute('SELECT * FROM joinings WHERE id = ? LIMIT 1', [
      joiningId,
    ]);
    if (joiningRows.length === 0) {
      return errorResponse(res, 'Joining record not found', 404);
    }
    const joining = joiningRows[0];

    let admissionId = transaction.admission_id;
    let admission = null;
    if (admissionId) {
      const [admissionRows] = await pool.execute('SELECT * FROM admissions WHERE id = ? LIMIT 1', [
        admissionId,
      ]);
      admission = admissionRows[0] || null;
    }
    if (!admission) {
      const [admissionRows] = await pool.execute(
        'SELECT * FROM admissions WHERE joining_id = ? ORDER BY updated_at DESC LIMIT 1',
        [joiningId]
      );
      admission = admissionRows[0] || null;
    }

    let studentId = String(admission?.admission_number || '').trim();
    // Admission number is minted on Submit Fee Request (revised amounts), not on collect/verify.
    if (!studentId) {
      return errorResponse(
        res,
        'No admission number yet. Submit a fee request with revised fee amounts first to generate the admission number.',
        422
      );
    }

    const [users] = transaction.collected_by
      ? await pool.execute('SELECT id, name FROM users WHERE id = ? LIMIT 1', [transaction.collected_by])
      : [[]];
    const collector = users[0] || null;
    const now = new Date();
    const conn = await connectFeeManagement();

    const targets = metaObj.targets || [];
    if (Array.isArray(targets) && targets.length > 0) {
      for (const t of targets) {
        const feeHeadValue = toMongoFeeHeadValue(t.feeHeadId);
        if (!feeHeadValue) continue;
        const normalizedReceipt = await generateTransactionReceiptNumber({
          admissionNumber: studentId,
          feeHeadId: t.feeHeadId,
          transactionDate: now,
          admission,
          joining,
          feeMgmtDb: conn.db,
        });
        const doc = {
          studentId,
          studentName: String(admission?.student_name || joining.student_name || '').trim(),
          feeHead: feeHeadValue,
          amount: Number(t.amount),
          transactionType: 'DEBIT',
          paymentMode: 'UPI',
          remarks:
            String(metaObj.remarks || '').trim() ||
            String(t.feeHeadName || t.feeHeadCode || 'Fee payment').trim(),
          semester: t.semester ? String(t.semester) : null,
          studentYear: t.studentYear ? String(t.studentYear) : '1',
          receiptNumber: normalizedReceipt,
          referenceNo: bankUtr,
          referenceDate: now,
          collectedBy: transaction.collected_by ? String(transaction.collected_by) : '',
          collectedByName: String(collector?.name || 'Razorpay Online').trim(),
          paymentDate: now,
          createdAt: now,
          updatedAt: now,
        };
        await enrichTransactionMetadata(doc, admission, joining);
        await conn.db.collection('transactions').insertOne(doc);
      }
    } else {
      const feeHeadValue = toMongoFeeHeadValue(metaObj.feeHeadId);
      if (feeHeadValue) {
        const normalizedReceipt = await generateTransactionReceiptNumber({
          admissionNumber: studentId,
          feeHeadId: metaObj.feeHeadId,
          transactionDate: now,
          admission,
          joining,
          feeMgmtDb: conn.db,
        });
        const doc = {
          studentId,
          studentName: String(admission?.student_name || joining.student_name || '').trim(),
          feeHead: feeHeadValue,
          amount: Number(transaction.amount),
          transactionType: 'DEBIT',
          paymentMode: 'UPI',
          remarks:
            String(metaObj.remarks || '').trim() ||
            String(metaObj.feeHeadName || metaObj.feeHeadCode || 'Fee payment').trim(),
          semester: metaObj.semester ? String(metaObj.semester) : null,
          studentYear: metaObj.studentYear ? String(metaObj.studentYear) : '1',
          receiptNumber: normalizedReceipt,
          referenceNo: bankUtr,
          referenceDate: now,
          collectedBy: transaction.collected_by ? String(transaction.collected_by) : '',
          collectedByName: String(collector?.name || 'Razorpay Online').trim(),
          paymentDate: now,
          createdAt: now,
          updatedAt: now,
        };
        await enrichTransactionMetadata(doc, admission, joining);
        await conn.db.collection('transactions').insertOne(doc);
      }
    }

    await updatePaymentSummary({
      joiningId: transaction.joining_id,
      admissionId: transaction.admission_id,
      leadId: transaction.lead_id,
      courseId: transaction.course_id,
      branchId: transaction.branch_id,
      amount: Number(transaction.amount),
      currency: 'INR',
    });

    return successResponse(
      res,
      {
        status: 'success',
        paymentId: bankUtr,
      },
      'Payment verified and recorded successfully'
    );
  } catch (error) {
    console.error('Error verifying Razorpay payment:', error);
    return errorResponse(res, error.message || 'Failed to verify payment', 500);
  }
};

export const getFeeManagementGlobalAccounts = async (req, res) => {
  try {
    const conn = await connectFeeManagement();
    const globalAccounts = await conn.db
      .collection('paymentconfigs')
      .find({ is_global: true, is_active: true })
      .toArray();

    return successResponse(res, globalAccounts, 'Global accounts fetched successfully');
  } catch (error) {
    console.error('Error fetching global accounts:', error);
    return errorResponse(res, error.message || 'Failed to fetch global accounts', 500);
  }
};



