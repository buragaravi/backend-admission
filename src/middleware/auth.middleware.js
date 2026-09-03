import jwt from 'jsonwebtoken';
import { getPool } from '../config-sql/database.js';
import { errorResponse } from '../utils/response.util.js';
import { hasElevatedAdminPrivileges, isTrueSuperAdmin } from '../utils/role.util.js';
import {
  canJoiningEditAdmission,
  canJoiningEditReference,
  canJoiningActivateAdmission,
} from '../utils/joiningPermissions.util.js';

export const protect = async (req, res, next) => {
  try {
    let token;

    // Check for token in Authorization header
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      return errorResponse(res, 'Not authorized to access this route', 401);
    }

    try {
      // Verify token
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      // Get database pool
      let pool;
      try {
        pool = getPool();
      } catch (error) {
        console.error('Database connection error:', error);
        return errorResponse(res, 'Database connection failed', 500);
      }

      // Get user from SQL database
      const [users] = await pool.execute(
        'SELECT id, hrms_id, emp_no, name, email, role_name, managed_by, is_manager, designation, permissions, is_active, time_tracking_enabled, created_at, updated_at FROM users WHERE id = ?',
        [decoded.id]
      );

      if (users.length === 0) {
        return errorResponse(res, 'User not found', 404);
      }

      const userData = users[0];
      const timeTrackingEnabled = userData.time_tracking_enabled === undefined
        ? true
        : (userData.time_tracking_enabled === 1 || userData.time_tracking_enabled === true);

      // Format user object to match expected structure (camelCase)
      req.user = {
        id: userData.id,
        _id: userData.id, // Keep _id for backward compatibility
        hrmsId: userData.hrms_id,
        empNo: userData.emp_no,
        name: userData.name,
        email: userData.email,
        roleName: userData.role_name,
        managedBy: userData.managed_by,
        isManager: userData.is_manager === 1 || userData.is_manager === true,
        designation: userData.designation,
        permissions: typeof userData.permissions === 'string'
          ? JSON.parse(userData.permissions)
          : userData.permissions || {},
        isActive: userData.is_active === 1 || userData.is_active === true,
        timeTrackingEnabled,
        createdAt: userData.created_at,
        updatedAt: userData.updated_at,
      };

      if (!req.user.isActive) {
        return errorResponse(res, 'User account is inactive', 403);
      }

      next();
    } catch (error) {
      return errorResponse(res, 'Not authorized to access this route', 401);
    }
  } catch (error) {
    return errorResponse(res, 'Authentication error', 500);
  }
};

// Check if user is Super Admin
export const isSuperAdmin = (req, res, next) => {
  if (!req.user) {
    return errorResponse(res, 'Not authenticated', 401);
  }

  if (!hasElevatedAdminPrivileges(req.user.roleName)) {
    return errorResponse(res, 'Access denied. Super Admin only', 403);
  }

  next();
};

// Authorize roles
export const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return errorResponse(res, 'Not authenticated', 401);
    }
    if (!roles.includes(req.user.roleName)) {
      return errorResponse(res, `User role ${req.user.roleName} is not authorized to access this route`, 403);
    }
    next();
  };
};

const getCollegeIdFromRegistrationExtras = (extras) => {
  if (!extras || typeof extras !== 'object') return null;
  const collegeKeys = ['college_id', 'collegeId', 'school_or_college_id', 'schoolOrCollegeId'];
  for (const key of collegeKeys) {
    const value = extras[key];
    if (value != null && String(value).trim() !== '') {
      return String(value).trim();
    }
  }
  return null;
};

const getCollegeIdFromJoiningRow = (joiningRow) => {
  if (!joiningRow) return null;
  let leadData = joiningRow.lead_data;
  if (typeof leadData === 'string') {
    try {
      leadData = JSON.parse(leadData || '{}');
    } catch {
      leadData = {};
    }
  }
  if (!leadData || typeof leadData !== 'object') return null;
  const registrationExtras = leadData._joiningRegistrationExtras;
  return getCollegeIdFromRegistrationExtras(registrationExtras);
};

const resolveAdmissionCollegeId = async (pool, admissionRow) => {
  if (!admissionRow) return null;
  if (admissionRow.joining_id) {
    const [joinings] = await pool.execute(
      'SELECT lead_data FROM joinings WHERE id = ? LIMIT 1',
      [admissionRow.joining_id]
    );
    if (joinings.length > 0) {
      const collegeId = getCollegeIdFromJoiningRow(joinings[0]);
      if (collegeId) return collegeId;
    }
  }

  const courseId = admissionRow.managed_course_id || admissionRow.course_id;
  if (!courseId || String(courseId).trim() === '') return null;

  const [courses] = await pool.execute(
    'SELECT college_id FROM courses WHERE id = ? LIMIT 1',
    [courseId]
  );
  if (!courses.length || courses[0].college_id == null) return null;
  return String(courses[0].college_id).trim() || null;
};

const resolveTargetCollegeId = async (req) => {
  const pool = getPool();
  if (req.params.admissionId) {
    const [admissions] = await pool.execute(
      'SELECT * FROM admissions WHERE id = ? LIMIT 1',
      [req.params.admissionId]
    );
    if (admissions.length > 0) {
      return resolveAdmissionCollegeId(pool, admissions[0]);
    }
  }

  if (req.params.leadId) {
    const [joinings] = await pool.execute(
      'SELECT lead_data FROM joinings WHERE id = ? OR lead_id = ? LIMIT 1',
      [req.params.leadId, req.params.leadId]
    );
    if (joinings.length > 0) {
      const collegeId = getCollegeIdFromJoiningRow(joinings[0]);
      if (collegeId) return collegeId;
    }

    const [admissions] = await pool.execute(
      'SELECT * FROM admissions WHERE lead_id = ? LIMIT 1',
      [req.params.leadId]
    );
    if (admissions.length > 0) {
      return resolveAdmissionCollegeId(pool, admissions[0]);
    }
  }

  return null;
};

// Check if time tracking is enabled for User/Counsellor/Manager dashboards
// Super Admin, Sub Super Admin, Data Entry User are not restricted by this setting
export const requireTimeTrackingEnabled = (req, res, next) => {
  if (!req.user) {
    return errorResponse(res, 'Not authenticated', 401);
  }
  const { roleName, isManager, timeTrackingEnabled } = req.user;
  const isAdminOrDataEntry = roleName === 'Super Admin' || roleName === 'Sub Super Admin' || roleName === 'Data Entry User';
  if (isAdminOrDataEntry) {
    return next();
  }
  const isUserOrCounsellor = roleName === 'User' || roleName === 'Student Counselor' || roleName === 'PRO';
  const isManagerRole = isManager === true;
  if ((isUserOrCounsellor || isManagerRole) && timeTrackingEnabled === false) {
    return errorResponse(res, 'Login and logout time tracking must be enabled to access this resource. Please enable it in Settings.', 403);
  }
  next();
};

/** Sub Super Admin joining desk: edit Reference 1 on admissions (Super Admin always allowed). */
export const requireJoiningEditReference = (req, res, next) => {
  if (!req.user) {
    return errorResponse(res, 'Not authenticated', 401);
  }
  if (canJoiningEditReference(req.user)) {
    return next();
  }
  return errorResponse(res, 'Access denied. Joining reference edit permission required', 403);
};

/** Sub Super Admin joining desk: edit admission / joining forms (Super Admin always allowed). */
export const requireJoiningEditAdmission = async (req, res, next) => {
  if (!req.user) {
    return errorResponse(res, 'Not authenticated', 401);
  }

  try {
    const targetCollegeId = await resolveTargetCollegeId(req);
    if (canJoiningEditAdmission(req.user, targetCollegeId)) {
      return next();
    }
  } catch (error) {
    console.error('requireJoiningEditAdmission error:', error);
  }

  return errorResponse(res, 'Access denied. Joining admission edit permission required', 403);
};

/** Sub Super Admin joining desk: reactivate cancelled admissions (Super Admin always allowed). */
export const requireJoiningActivateAdmission = async (req, res, next) => {
  if (!req.user) {
    return errorResponse(res, 'Not authenticated', 401);
  }

  try {
    const targetCollegeId = await resolveTargetCollegeId(req);
    if (canJoiningActivateAdmission(req.user, targetCollegeId)) {
      return next();
    }
  } catch (error) {
    console.error('requireJoiningActivateAdmission error:', error);
  }

  return errorResponse(res, 'Access denied. Activate admission permission required', 403);
};

// Check if user has specific permission (for future use)
export const hasPermission = (permission) => {
  return (req, res, next) => {
    if (!req.user) {
      return errorResponse(res, 'Not authenticated', 401);
    }

    if (hasElevatedAdminPrivileges(req.user.roleName)) {
      return next();
    }

    // For now, only Super Admin has permissions
    return errorResponse(res, 'Access denied. Insufficient permissions', 403);
  };
};

