const JOINING_KEY = 'joining';

const getJoiningPermission = (user) => {
  const permissions = user?.permissions;
  if (!permissions || typeof permissions !== 'object') return undefined;
  return permissions[JOINING_KEY];
};

export const isLegacyJoiningWrite = (entry) => {
  if (!entry?.access || entry.permission !== 'write') return false;
  return (
    entry.editReference === undefined &&
    entry.editAdmission === undefined &&
    entry.activateAdmission === undefined &&
    entry.approveFeeRequest === undefined
  );
};

export const canJoiningEditReference = (user) => {
  if (!user) return false;
  if (user.roleName === 'Super Admin') return true;
  const entry = getJoiningPermission(user);
  if (!entry?.access || entry.permission !== 'write') return false;
  if (isLegacyJoiningWrite(entry)) return true;
  return Boolean(entry.editReference);
};

export const canJoiningEditAdmission = (user, targetCollegeId = undefined) => {
  if (!user) return false;
  if (user.roleName === 'Super Admin') return true;
  const entry = getJoiningPermission(user);
  if (!entry?.access || entry.permission !== 'write') return false;
  if (isLegacyJoiningWrite(entry)) return true;
  if (!entry.editAdmission) return false;

  const allowedColleges = Array.isArray(entry.allowedColleges)
    ? entry.allowedColleges
        .filter((id) => typeof id === 'string')
        .map((id) => id.trim())
        .filter((id) => id !== '')
    : [];
  if (allowedColleges.length === 0) return true;
  if (targetCollegeId == null) return false;
  return allowedColleges.includes(String(targetCollegeId).trim());
};

/** Reactivate cancelled admissions (requires explicit activateAdmission flag). */
export const canJoiningActivateAdmission = (user, targetCollegeId = undefined) => {
  if (!user) return false;
  if (user.roleName === 'Super Admin') return true;
  const entry = getJoiningPermission(user);
  if (!entry?.access || entry.permission !== 'write') return false;
  if (isLegacyJoiningWrite(entry)) return true;
  if (!entry.activateAdmission) return false;

  const allowedColleges = Array.isArray(entry.allowedColleges)
    ? entry.allowedColleges
        .filter((id) => typeof id === 'string')
        .map((id) => id.trim())
        .filter((id) => id !== '')
    : [];
  if (allowedColleges.length === 0) return true;
  if (targetCollegeId == null) return false;
  return allowedColleges.includes(String(targetCollegeId).trim());
};

/** Submit revised fee requests from Step 4 — any joining desk Read & Write user. */
export const canSubmitFeeRequest = (user) => {
  if (!user) return false;
  if (user.roleName === 'Super Admin') return true;
  const entry = getJoiningPermission(user);
  return Boolean(entry?.access && entry.permission === 'write');
};

/** Approve / reject fee requests on the Fee Requests desk (requires explicit approveFeeRequest flag). */
export const canApproveFeeRequest = (user) => {
  if (!user) return false;
  if (user.roleName === 'Super Admin') return true;
  const entry = getJoiningPermission(user);
  if (!entry?.access || entry.permission !== 'write') return false;
  if (isLegacyJoiningWrite(entry)) return true;
  return Boolean(entry.approveFeeRequest);
};
