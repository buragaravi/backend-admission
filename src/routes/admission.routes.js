import express from 'express';
import {
  protect,
  isSuperAdmin,
  requireJoiningEditAdmission,
  requireJoiningEditReference,
} from '../middleware/auth.middleware.js';
import { searchHrmsEmployees } from '../controllers/user.controller.js';
import {
  listAdmissions,
  getAdmissionById,
  getAdmissionApplicationHistory,
  getAdmissionByJoiningId,
  getAdmissionByLead,
  cancelAdmissionById,
  updateAdmissionById,
  updateAdmissionByLead,
  patchAdmissionReferenceById,
  patchAdmissionRemarksById,
  patchAdmissionPhaseById,
  getAdmissionStats,
  getAdmissionStatsByReference,
  getAdmissionStatsByReferenceAdmissions,
  getAdmissionStatsBySource,
  getAdmissionStatsByDate,
  listDistinctReferenceNames,
  getDistinctReferenceNameUsage,
  renameDistinctReferenceName,
  hideDistinctReferenceName,
  upsertAdmissionBranchIntake,
  exportAdmissions,
  listPendingCertificates,
  exportPendingCertificates,
  listPendingFees,
  exportPendingFees,
  sendAdmissionConfirmationSmsById,
  sendDocumentNotificationSmsById,
  sendDocumentNotificationSmsBulk,
} from '../controllers/admission.controller.js';
import {
  listMinimumFeeConfigs,
  upsertMinimumFeeConfigsForCourse,
  clearMinimumFeeConfigsForCourse,
  clearMinimumFeeConfigsForCollege,
} from '../controllers/minimumFeeConfig.controller.js';
import {
  getAdmissionPendingFeeDocsSmsScheduler,
  upsertAdmissionPendingFeeDocsSmsScheduler,
} from '../controllers/admissionPendingFeeDocsSmsScheduler.controller.js';

const router = express.Router();

router.use(protect);

router.get('/hrms-employees/search', searchHrmsEmployees);
router.get('/reference-names', listDistinctReferenceNames);
router.get('/reference-names/usage', getDistinctReferenceNameUsage);
router.patch('/reference-names/rename', requireJoiningEditReference, renameDistinctReferenceName);
router.post('/reference-names/hide', requireJoiningEditReference, hideDistinctReferenceName);
router.get('/stats/by-reference/admissions', getAdmissionStatsByReferenceAdmissions);
router.get('/stats/by-reference', getAdmissionStatsByReference);
router.get('/stats/by-source', getAdmissionStatsBySource);
router.get('/stats/by-date', getAdmissionStatsByDate);
router.get('/stats', getAdmissionStats);
router.put('/branch-intake', isSuperAdmin, upsertAdmissionBranchIntake);
router.get('/export', isSuperAdmin, exportAdmissions);
router.get('/pending-certificates/export', exportPendingCertificates);
router.get('/pending-certificates', listPendingCertificates);
router.get('/pending-fees/export', exportPendingFees);
router.get('/pending-fees', listPendingFees);
router.get('/minimum-fee-configs', listMinimumFeeConfigs);
router.put('/minimum-fee-configs/course', upsertMinimumFeeConfigsForCourse);
router.delete('/minimum-fee-configs/course', clearMinimumFeeConfigsForCourse);
router.delete('/minimum-fee-configs/college/:collegeId', clearMinimumFeeConfigsForCollege);

// Super Admin: schedule daily pending fee + pending documents SMS dispatch (AM/PM)
router.get(
  '/pending-fees-docs-sms-scheduler',
  isSuperAdmin,
  getAdmissionPendingFeeDocsSmsScheduler
);
router.put(
  '/pending-fees-docs-sms-scheduler',
  isSuperAdmin,
  upsertAdmissionPendingFeeDocsSmsScheduler
);

router.post('/send-document-notification-bulk', sendDocumentNotificationSmsBulk);
router.get('/', listAdmissions);
router.get('/id/:admissionId/history', getAdmissionApplicationHistory);
router.get('/id/:admissionId', getAdmissionById);
router.get('/joining/:joiningId', getAdmissionByJoiningId);
router.get('/:leadId', getAdmissionByLead); // Keep for backward compatibility
router.post('/id/:admissionId/cancel', requireJoiningEditAdmission, cancelAdmissionById);
router.post('/id/:admissionId/send-confirmation-sms', sendAdmissionConfirmationSmsById);
router.post('/id/:admissionId/send-document-notification', sendDocumentNotificationSmsById);
router.patch('/id/:admissionId/reference', requireJoiningEditReference, patchAdmissionReferenceById);
router.patch('/id/:admissionId/remarks', requireJoiningEditAdmission, patchAdmissionRemarksById);
router.patch('/id/:admissionId/phase', requireJoiningEditAdmission, patchAdmissionPhaseById);
router.put('/id/:admissionId', requireJoiningEditAdmission, updateAdmissionById);
router.put('/:leadId', requireJoiningEditAdmission, updateAdmissionByLead); // Keep for backward compatibility

export default router;


