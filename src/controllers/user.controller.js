import { getPool } from '../config-sql/database.js';
import { successResponse, errorResponse } from '../utils/response.util.js';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import mongoose from 'mongoose';
import { connectHRMS } from '../config-mongo/hrms.js';
import {
  snapshotUserForAudit,
  diffUserAuditSnapshots,
  getRequestAuditMeta,
  recordUserAuditLog,
} from '../utils/recordUserAuditLog.js';

const VALID_ROLES = ['Super Admin', 'Sub Super Admin', 'Student Counselor', 'Data Entry User', 'PRO'];

/**
 * Align CRM emp_no with HRMS emp_no when HRMS uses leading zeros, strings, or numeric types differently.
 */
export const normalizeEmpNoKey = (value) => {
  const s = String(value ?? '').trim();
  if (!s) return '';
  if (/^\d+$/.test(s)) return String(parseInt(s, 10));
  return s;
};

/**
 * Same resolution as GET /users/hrms/:empNo and /users/hrms/id/:mongoId — findById on division / department / group.
 * Used for list hydration so table org columns match the view dialog exactly.
 */
export const resolveHrmsOrgNamesFindById = async (employee, Division, Department, Group) => {
  const [divDoc, deptDoc, groupDoc] = await Promise.all([
    employee.division_id ? Division.findById(employee.division_id) : Promise.resolve(null),
    employee.department_id ? Department.findById(employee.department_id) : Promise.resolve(null),
    employee.employee_group_id ? Group.findById(employee.employee_group_id) : Promise.resolve(null),
  ]);
  return {
    division: divDoc?.name || '-',
    department: deptDoc?.name || '-',
    group: groupDoc?.name || '-',
  };
};

const toMongoObjectIdString = (ref) => {
  if (ref == null) return '';
  if (typeof ref === 'object' && ref._id) return String(ref._id);
  const s = String(ref).trim();
  return mongoose.Types.ObjectId.isValid(s) ? s : '';
};

const collectUniqueObjectIdHexStrings = (refs) => {
  const out = [];
  const seen = new Set();
  for (const ref of refs || []) {
    const hex = toMongoObjectIdString(ref);
    if (hex && !seen.has(hex)) {
      seen.add(hex);
      out.push(hex);
    }
  }
  return out;
};

const extractHrmsDesignationName = (emp, desigMap) => {
  const byId = desigMap.get(toMongoObjectIdString(emp?.designation_id));
  if (byId) return byId;
  const dynamicFields = emp?.dynamicFields || {};
  if (typeof dynamicFields.designation_name === 'string' && dynamicFields.designation_name.trim()) {
    return dynamicFields.designation_name.trim();
  }
  const rawDesignation = dynamicFields.designation;
  if (typeof rawDesignation === 'string' && rawDesignation.trim()) {
    try {
      const parsed = JSON.parse(rawDesignation);
      if (parsed?.name && String(parsed.name).trim()) return String(parsed.name).trim();
    } catch {
      // ignore malformed JSON
    }
  }
  return null;
};

/**
 * Mutates each user row that has `emp_no` and/or `hrms_id` to set `division`, `department`, `group`,
 * and `designation` (when available) from HRMS.
 * Rows must be plain objects (same shape as `formatUser` output for getUsers, or assignable list rows with emp_no/hrms_id).
 */
export async function hydrateUserRowsFromHrms(formattedUsers, logContext = 'users') {
  if (!formattedUsers?.length) return;
  const empNoStrings = [
    ...new Set(
      formattedUsers
        .filter((u) => u.emp_no != null && String(u.emp_no).trim() !== '')
        .map((u) => String(u.emp_no).trim())
    ),
  ];
  const hrmsIdStrings = [
    ...new Set(
      formattedUsers
        .map((u) => (u.hrms_id != null ? String(u.hrms_id).trim() : ''))
        .filter((s) => s && mongoose.Types.ObjectId.isValid(s))
    ),
  ];

  if (empNoStrings.length === 0 && hrmsIdStrings.length === 0) return;

  try {
    const hrmsConn = await connectHRMS();
    const Employee = hrmsConn.models.employees || hrmsConn.model('employees', new hrmsConn.base.Schema({}, { strict: false }));
    const Division = hrmsConn.models.divisions || hrmsConn.model('divisions', new hrmsConn.base.Schema({}, { strict: false }));
    const Department = hrmsConn.models.departments || hrmsConn.model('departments', new hrmsConn.base.Schema({}, { strict: false }));
    const Group = hrmsConn.models.employeegroups || hrmsConn.model('employeegroups', new hrmsConn.base.Schema({}, { strict: false }));
    const Designation =
      hrmsConn.models.designations || hrmsConn.model('designations', new hrmsConn.base.Schema({}, { strict: false }));
    const empByMongoId = new Map();

    if (empNoStrings.length > 0) {
      const empNoNumbers = [
        ...new Set(
          empNoStrings
            .map((s) => Number(s))
            .filter((n) => Number.isFinite(n) && !Number.isNaN(n))
        ),
      ];
      const empNoOr = [];
      if (empNoStrings.length) empNoOr.push({ emp_no: { $in: empNoStrings } });
      if (empNoNumbers.length) empNoOr.push({ emp_no: { $in: empNoNumbers } });
      const hrmsEmployeesRaw = await Employee.find(empNoOr.length === 1 ? empNoOr[0] : { $or: empNoOr })
        .select('emp_no division_id department_id employee_group_id designation_id dynamicFields');

      for (const emp of hrmsEmployeesRaw || []) {
        if (emp?._id) empByMongoId.set(emp._id.toString(), emp);
      }
    }

    if (hrmsIdStrings.length > 0) {
      const oids = hrmsIdStrings.map((id) => new mongoose.Types.ObjectId(id));
      const byIdRaw = await Employee.find({ _id: { $in: oids } })
        .select('emp_no division_id department_id employee_group_id designation_id dynamicFields');
      for (const emp of byIdRaw || []) {
        if (emp?._id) empByMongoId.set(emp._id.toString(), emp);
      }
    }

    const hrmsEmployees = [...empByMongoId.values()];

    if (hrmsEmployees.length > 0) {
      const desigIdHexes = collectUniqueObjectIdHexStrings(hrmsEmployees.map((e) => e.designation_id));
      const designations =
        desigIdHexes.length > 0
          ? await Designation.find({
              _id: { $in: desigIdHexes.map((h) => new mongoose.Types.ObjectId(h)) },
            })
              .select('name')
              .lean()
          : [];

      const desigMap = new Map();
      for (const doc of designations || []) {
        if (!doc?._id) continue;
        const name = doc.name != null && String(doc.name).trim() !== '' ? String(doc.name).trim() : null;
        if (!name) continue;
        desigMap.set(doc._id.toString(), name);
        const alt = toMongoObjectIdString(doc._id);
        if (alt && alt !== doc._id.toString()) desigMap.set(alt, name);
      }

      const orgRows = await Promise.all(
        hrmsEmployees.map(async (emp) => {
          const org = await resolveHrmsOrgNamesFindById(emp, Division, Department, Group);
          const designation = extractHrmsDesignationName(emp, desigMap);
          return {
            emp,
            org: {
              ...org,
              designation,
            },
          };
        })
      );

      const needDesFallback = orgRows.filter(
        ({ emp, org }) => !org.designation && emp.designation_id
      );
      const DESIG_FALLBACK_CONC = 10;
      for (let i = 0; i < needDesFallback.length; i += DESIG_FALLBACK_CONC) {
        const batch = needDesFallback.slice(i, i + DESIG_FALLBACK_CONC);
        // eslint-disable-next-line no-await-in-loop
        const desDocs = await Promise.all(
          batch.map(({ emp }) => Designation.findById(emp.designation_id).select('name').lean())
        );
        batch.forEach(({ org }, j) => {
          const n = desDocs[j]?.name;
          if (n != null && String(n).trim() !== '') org.designation = String(n).trim();
        });
      }

      const hrmsRowByEmployeeId = Object.fromEntries(
        orgRows.map(({ emp, org }) => [emp._id.toString(), org])
      );
      const hrmsMap = {};
      for (const { emp, org } of orgRows) {
        const rawKey = String(emp.emp_no ?? '').trim();
        const normKey = normalizeEmpNoKey(emp.emp_no);
        if (rawKey) hrmsMap[rawKey] = org;
        if (normKey && normKey !== rawKey) hrmsMap[normKey] = org;
      }

      formattedUsers.forEach((user) => {
        const rawKey = user.emp_no != null ? String(user.emp_no).trim() : '';
        const normKey = normalizeEmpNoKey(user.emp_no);
        let hrmsRow =
          (rawKey && hrmsMap[rawKey]) ||
          (normKey && hrmsMap[normKey]) ||
          null;
        if (!hrmsRow && user.hrms_id) {
          const hid = String(user.hrms_id).trim();
          if (mongoose.Types.ObjectId.isValid(hid)) {
            hrmsRow = hrmsRowByEmployeeId[hid] || null;
          }
        }
        if (hrmsRow) {
          user.division = hrmsRow.division;
          user.department = hrmsRow.department;
          user.group = hrmsRow.group;
          if (hrmsRow.designation) {
            user.designation = hrmsRow.designation;
          }
        }
      });
    }
  } catch (hrmsError) {
    console.error(`HRMS hydration error (${logContext}):`, hrmsError);
  }
}

const normalizeReferenceLookupKey = (value) =>
  String(value ?? '')
    .trim()
    .toLowerCase();

const formatHrmsDepartmentLabel = (department) =>
  department && String(department).trim() && department !== '-'
    ? String(department).trim()
    : null;

const ROLES_WITH_DESIGNATION = new Set(['Student Counselor', 'Data Entry User', 'PRO']);

const resolveHrmsDesignationForEmployee = async (emp, Designation, desigMap) => {
  let designation = extractHrmsDesignationName(emp, desigMap);
  if (!designation && emp?.designation_id) {
    const desDoc = await Designation.findById(emp.designation_id).select('name').lean();
    const n = desDoc?.name;
    if (n != null && String(n).trim() !== '') designation = String(n).trim();
  }
  return designation && String(designation).trim() ? String(designation).trim() : null;
};

/**
 * Resolve department / designation (and link ids) from HRMS using users.hrms_id and/or emp_no.
 */
export async function fetchHrmsEmployeeMetaByLink({ hrms_id, emp_no }, logContext = 'hrms-meta') {
  const hrmsIdStr = hrms_id != null ? String(hrms_id).trim() : '';
  const empNoStr = emp_no != null ? String(emp_no).trim() : '';
  if (!hrmsIdStr && !empNoStr) return null;

  try {
    const hrmsConn = await connectHRMS();
    const Employee =
      hrmsConn.models.employees ||
      hrmsConn.model('employees', new hrmsConn.base.Schema({}, { strict: false }));
    const Division =
      hrmsConn.models.divisions ||
      hrmsConn.model('divisions', new hrmsConn.base.Schema({}, { strict: false }));
    const Department =
      hrmsConn.models.departments ||
      hrmsConn.model('departments', new hrmsConn.base.Schema({}, { strict: false }));
    const Group =
      hrmsConn.models.employeegroups ||
      hrmsConn.model('employeegroups', new hrmsConn.base.Schema({}, { strict: false }));
    const Designation =
      hrmsConn.models.designations ||
      hrmsConn.model('designations', new hrmsConn.base.Schema({}, { strict: false }));

    const selectFields =
      'emp_no employee_name division_id department_id employee_group_id designation_id dynamicFields';

    let employee = null;
    if (hrmsIdStr && mongoose.Types.ObjectId.isValid(hrmsIdStr)) {
      employee = await Employee.findById(hrmsIdStr).select(selectFields).lean();
    }
    if (!employee && empNoStr) {
      const empNoNum = Number(empNoStr);
      const empNoOr = [{ emp_no: empNoStr }];
      if (Number.isFinite(empNoNum) && !Number.isNaN(empNoNum)) empNoOr.push({ emp_no: empNoNum });
      employee = await Employee.findOne(empNoOr.length === 1 ? empNoOr[0] : { $or: empNoOr })
        .select(selectFields)
        .lean();
    }
    if (!employee) return null;

    const desigIdHexes = collectUniqueObjectIdHexStrings([employee.designation_id]);
    const designations =
      desigIdHexes.length > 0
        ? await Designation.find({
            _id: { $in: desigIdHexes.map((h) => new mongoose.Types.ObjectId(h)) },
          })
            .select('name')
            .lean()
        : [];
    const desigMap = new Map();
    for (const doc of designations || []) {
      if (!doc?._id) continue;
      const name = doc.name != null && String(doc.name).trim() !== '' ? String(doc.name).trim() : null;
      if (!name) continue;
      desigMap.set(doc._id.toString(), name);
      const alt = toMongoObjectIdString(doc._id);
      if (alt && alt !== doc._id.toString()) desigMap.set(alt, name);
    }

    const org = await resolveHrmsOrgNamesFindById(employee, Division, Department, Group);
    const designation = await resolveHrmsDesignationForEmployee(employee, Designation, desigMap);

    return {
      hrms_id: employee._id ? String(employee._id) : hrmsIdStr || null,
      emp_no: employee.emp_no != null ? String(employee.emp_no).trim() : empNoStr || null,
      name: employee.employee_name || null,
      division: org.division,
      department: formatHrmsDepartmentLabel(org.department),
      group: org.group,
      designation,
    };
  } catch (hrmsError) {
    console.error(`HRMS employee meta error (${logContext}):`, hrmsError);
    return null;
  }
};

/**
 * Read-only HRMS lookup for admissions Reference tab rows.
 * Matches reference display names (and numeric employee IDs) to HRMS employees.
 */
export async function buildHrmsEmployeeMetaByReferenceKeys(referenceKeys, logContext = 'reference-meta') {
  const keys = [
    ...new Set(
      (referenceKeys || [])
        .map((key) => normalizeReferenceLookupKey(key))
        .filter(Boolean)
    ),
  ];
  if (!keys.length) return new Map();

  const empNoKeys = new Set();
  for (const key of keys) {
    empNoKeys.add(key);
    const norm = normalizeEmpNoKey(key);
    if (norm) empNoKeys.add(String(norm).toLowerCase());
  }
  const empNoMatchKeys = [...empNoKeys].filter(Boolean);
  const nameMatchKeys = keys.filter((key) => !/^\d+$/.test(key));

  try {
    const hrmsConn = await connectHRMS();
    const Employee =
      hrmsConn.models.employees ||
      hrmsConn.model('employees', new hrmsConn.base.Schema({}, { strict: false }));
    const Division =
      hrmsConn.models.divisions ||
      hrmsConn.model('divisions', new hrmsConn.base.Schema({}, { strict: false }));
    const Department =
      hrmsConn.models.departments ||
      hrmsConn.model('departments', new hrmsConn.base.Schema({}, { strict: false }));
    const Group =
      hrmsConn.models.employeegroups ||
      hrmsConn.model('employeegroups', new hrmsConn.base.Schema({}, { strict: false }));
    const Designation =
      hrmsConn.models.designations ||
      hrmsConn.model('designations', new hrmsConn.base.Schema({}, { strict: false }));

    const matchClauses = [];
    if (nameMatchKeys.length) matchClauses.push({ nameKey: { $in: nameMatchKeys } });
    if (empNoMatchKeys.length) {
      matchClauses.push({
        $expr: { $in: [{ $toLower: { $trim: { input: { $toString: '$emp_no' } } } }, empNoMatchKeys] },
      });
      const empNoNumbers = [
        ...new Set(
          empNoMatchKeys
            .map((value) => Number(value))
            .filter((n) => Number.isFinite(n) && !Number.isNaN(n))
        ),
      ];
      if (empNoNumbers.length) matchClauses.push({ emp_no: { $in: empNoNumbers } });
    }
    if (!matchClauses.length) return new Map();

    const hrmsEmployees = await Employee.aggregate([
      {
        $addFields: {
          nameKey: {
            $toLower: {
              $trim: {
                input: { $ifNull: ['$employee_name', ''] },
              },
            },
          },
        },
      },
      { $match: { $or: matchClauses } },
      {
        $project: {
          emp_no: 1,
          employee_name: 1,
          division_id: 1,
          department_id: 1,
          employee_group_id: 1,
          designation_id: 1,
          dynamicFields: 1,
          nameKey: 1,
        },
      },
    ]);

    if (!hrmsEmployees?.length) return new Map();

    const desigIdHexes = collectUniqueObjectIdHexStrings(hrmsEmployees.map((e) => e.designation_id));
    const designations =
      desigIdHexes.length > 0
        ? await Designation.find({
            _id: { $in: desigIdHexes.map((h) => new mongoose.Types.ObjectId(h)) },
          })
            .select('name')
            .lean()
        : [];

    const desigMap = new Map();
    for (const doc of designations || []) {
      if (!doc?._id) continue;
      const name = doc.name != null && String(doc.name).trim() !== '' ? String(doc.name).trim() : null;
      if (!name) continue;
      desigMap.set(doc._id.toString(), name);
      const alt = toMongoObjectIdString(doc._id);
      if (alt && alt !== doc._id.toString()) desigMap.set(alt, name);
    }

    const orgRows = await Promise.all(
      hrmsEmployees.map(async (emp) => {
        const org = await resolveHrmsOrgNamesFindById(emp, Division, Department, Group);
        const designation = await resolveHrmsDesignationForEmployee(emp, Designation, desigMap);
        return {
          emp,
          meta: {
            department: formatHrmsDepartmentLabel(org.department),
            designation,
          },
        };
      })
    );

    const metaByKey = new Map();
    for (const { emp, meta } of orgRows) {
      if (!meta.department && !meta.designation) continue;

      const nameKey = normalizeReferenceLookupKey(emp.employee_name);
      if (nameKey && !metaByKey.has(nameKey)) metaByKey.set(nameKey, meta);

      const rawEmp = String(emp.emp_no ?? '').trim().toLowerCase();
      const normEmp = String(normalizeEmpNoKey(emp.emp_no) ?? '').trim().toLowerCase();
      if (rawEmp && !metaByKey.has(rawEmp)) metaByKey.set(rawEmp, meta);
      if (normEmp && !metaByKey.has(normEmp)) metaByKey.set(normEmp, meta);
    }

    const missingKeys = keys.filter((key) => {
      const meta = metaByKey.get(key);
      return !meta?.department && !meta?.designation;
    });

    if (missingKeys.length > 0) {
      const pool = getPool();
      const placeholders = missingKeys.map(() => '?').join(',');
      const [crmUsers] = await pool.execute(
        `SELECT name, hrms_id, emp_no
         FROM users
         WHERE LOWER(TRIM(name)) IN (${placeholders})
           AND (hrms_id IS NOT NULL OR (emp_no IS NOT NULL AND TRIM(emp_no) != ''))`,
        missingKeys
      );

      for (const row of crmUsers || []) {
        const nameKey = normalizeReferenceLookupKey(row.name);
        if (!nameKey) continue;
        const existing = metaByKey.get(nameKey);
        if (existing?.department || existing?.designation) continue;

        const meta = await fetchHrmsEmployeeMetaByLink(
          { hrms_id: row.hrms_id, emp_no: row.emp_no },
          logContext
        );
        if (!meta || (!meta.department && !meta.designation)) continue;

        metaByKey.set(nameKey, {
          department: meta.department,
          designation: meta.designation,
        });
      }
    }

    return metaByKey;
  } catch (hrmsError) {
    console.error(`HRMS reference meta error (${logContext}):`, hrmsError);
    return new Map();
  }
}

const sanitizePermissions = (permissions = {}) => {
  if (!permissions || typeof permissions !== 'object') {
    return {};
  }
  const sanitized = {};
  Object.entries(permissions).forEach(([key, value]) => {
    if (key === 'allowedSources') {
      if (Array.isArray(value)) {
        sanitized[key] = value.filter((v) => typeof v === 'string');
      }
      return;
    }
    if (!value || typeof value !== 'object') return;
    const access = Boolean(value.access);
    const permission = value.permission === 'write' ? 'write' : 'read';
    const entry = {
      access,
      permission,
    };
    if (key === 'joining' && access) {
      entry.pageConfirmedLeads = Boolean(value.pageConfirmedLeads);
      entry.pageSelfRegistration = Boolean(value.pageSelfRegistration);
      entry.pageJoiningPipeline = Boolean(value.pageJoiningPipeline);
      entry.pageFeeRequests = Boolean(value.pageFeeRequests);
      entry.pageAdmissions = Boolean(value.pageAdmissions);
      entry.admissionTabAbstract = Boolean(value.admissionTabAbstract);
      entry.admissionTabStudentInfo = Boolean(value.admissionTabStudentInfo);
      entry.admissionTabReference = Boolean(value.admissionTabReference);
      entry.admissionTabSource = Boolean(value.admissionTabSource);
      entry.admissionTabDateWise = Boolean(value.admissionTabDateWise);
      if (permission === 'write') {
        entry.editReference = Boolean(value.editReference);
        entry.editAdmission = Boolean(value.editAdmission);
        entry.activateAdmission = Boolean(value.activateAdmission);
        entry.approveFeeRequest = Boolean(value.approveFeeRequest);
          entry.requireStudentPhoto = Boolean(value.requireStudentPhoto);
        if (entry.approveFeeRequest) {
          entry.pageFeeRequests = true;
        }
      }
      if (Array.isArray(value.allowedColleges)) {
        entry.allowedColleges = value.allowedColleges
          .filter((v) => typeof v === 'string')
          .map((v) => v.trim())
          .filter((v) => v !== '');
      }
    }
    sanitized[key] = entry;
  });
  return sanitized;
};

// Helper function to format user data from SQL to camelCase
const formatUser = (userData) => {
  if (!userData) return null;
  const timeTrackingEnabled = userData.time_tracking_enabled === undefined
    ? true
    : (userData.time_tracking_enabled === 1 || userData.time_tracking_enabled === true);
  return {
    id: userData.id,
    _id: userData.id, // Keep _id for backward compatibility
    hrms_id: userData.hrms_id,
    emp_no: userData.emp_no,
    name: userData.name,
    email: userData.email,
    mobileNumber: userData.mobile_number,
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
};

// @desc    Get all users
// @route   GET /api/users
// @access  Private (Super Admin)
export const getUsers = async (req, res) => {
  try {
    const pool = getPool();

    const [users] = await pool.execute(
      'SELECT id, hrms_id, emp_no, name, email, mobile_number, role_name, managed_by, is_manager, designation, permissions, is_active, time_tracking_enabled, created_at, updated_at FROM users ORDER BY created_at DESC'
    );

    const formattedUsers = users.map(formatUser);

    await hydrateUserRowsFromHrms(formattedUsers, 'getUsers');

    // Resolve manager id to a small object so list/card views match detail modal lookups
    const userById = Object.fromEntries(formattedUsers.map((u) => [String(u._id), u]));
    formattedUsers.forEach((u) => {
      const mb = u.managedBy;
      if (mb == null || mb === '') return;
      if (typeof mb === 'object') return;
      const manager = userById[String(mb)];
      if (manager) {
        u.managedBy = { _id: manager._id, name: manager.name, email: manager.email };
      }
    });

    return successResponse(res, formattedUsers, 'Users retrieved successfully', 200);
  } catch (error) {
    console.error('Get users error:', error);
    return errorResponse(res, error.message || 'Failed to get users', 500);
  }
};

// @desc    Get lightweight assignable users list
// @route   GET /api/users/assignable
// @access  Private (Super Admin)
export const getAssignableUsers = async (req, res) => {
  try {
    const pool = getPool();
    const [users] = await pool.execute(
      `SELECT id, hrms_id, emp_no, name, email, role_name, designation, is_active
       FROM users
       WHERE is_active = 1
         AND role_name IN ('Sub Super Admin', 'Student Counselor', 'Data Entry User', 'PRO')
       ORDER BY name ASC`
    );

    const formattedUsers = (users || []).map((u) => ({
      id: u.id,
      _id: u.id,
      hrms_id: u.hrms_id,
      emp_no: u.emp_no,
      name: u.name,
      email: u.email,
      roleName: u.role_name,
      designation: u.designation,
      isActive: u.is_active === 1 || u.is_active === true,
    }));

    await hydrateUserRowsFromHrms(formattedUsers, 'getAssignableUsers');

    const payload = formattedUsers.map((u) => ({
      id: u.id,
      _id: u.id,
      name: u.name,
      email: u.email,
      roleName: u.roleName,
      isActive: u.isActive,
      division: u.division,
      department: u.department,
      group: u.group,
      designation: u.designation,
    }));

    return successResponse(res, payload, 'Assignable users retrieved successfully', 200);
  } catch (error) {
    console.error('Get assignable users error:', error);
    return errorResponse(res, error.message || 'Failed to get assignable users', 500);
  }
};

// @desc    Get single user
// @route   GET /api/users/:id
// @access  Private (Super Admin or Manager for their team members)
export const getUser = async (req, res) => {
  try {
    const isAdmin = req.user.roleName === 'Super Admin' || req.user.roleName === 'Sub Super Admin';
    const isManager = req.user.isManager === true;

    // If not admin or manager, deny access
    if (!isAdmin && !isManager) {
      return errorResponse(res, 'Access denied', 403);
    }

    const pool = getPool();

    const [users] = await pool.execute(
      'SELECT id, hrms_id, emp_no, name, email, mobile_number, role_name, managed_by, is_manager, designation, permissions, is_active, time_tracking_enabled, created_at, updated_at FROM users WHERE id = ?',
      [req.params.id]
    );

    if (users.length === 0) {
      return errorResponse(res, 'User not found', 404);
    }

    const user = formatUser(users[0]);

    // If manager (not admin), check if the requested user is in their team
    if (isManager && !isAdmin) {
      const managedById = user.managedBy;
      const managerId = req.user.id || req.user._id;

      if (managedById !== managerId) {
        return errorResponse(res, 'Access denied. You can only view your team members.', 403);
      }
    }

    return successResponse(res, user, 'User retrieved successfully', 200);
  } catch (error) {
    console.error('Get user error:', error);
    return errorResponse(res, error.message || 'Failed to get user', 500);
  }
};

// @desc    Create new user
// @route   POST /api/users
// @access  Private (Super Admin)
export const createUser = async (req, res) => {
  try {
    const { name, email, password, roleName, designation, permissions, mobileNumber, hrms_id, emp_no } = req.body;

    if (!VALID_ROLES.includes(roleName)) {
      return errorResponse(res, 'Invalid role. Must be one of: Super Admin, Sub Super Admin, Student Counselor, Data Entry User, PRO', 400);
    }

    if (roleName === 'Sub Super Admin' && (permissions && typeof permissions !== 'object')) {
      return errorResponse(res, 'Permissions must be provided as an object for sub super admins', 400);
    }

    const pool = getPool();

    // Check if user exists (email only if provided)
    if (email && email.trim()) {
      const [existingUsers] = await pool.execute(
        'SELECT id FROM users WHERE email = ?',
        [email.toLowerCase().trim()]
      );

      if (existingUsers.length > 0) {
        return errorResponse(res, 'User with this email already exists', 400);
      }
    }

    if (mobileNumber) {
      const [existingMobile] = await pool.execute(
        'SELECT id FROM users WHERE mobile_number = ?',
        [mobileNumber.trim()]
      );

      if (existingMobile.length > 0) {
        return errorResponse(res, 'User with this mobile number already exists', 400);
      }
    }

    const sanitizedPermissions = sanitizePermissions(permissions);

    let finalHrmsId = hrms_id || null;
    let finalEmpNo = emp_no || null;
    let finalDesignation =
      roleName === 'Student Counselor' || roleName === 'Data Entry User' || roleName === 'PRO'
        ? designation?.trim() || null
        : null;

    if (finalHrmsId || finalEmpNo) {
      const hrmsMeta = await fetchHrmsEmployeeMetaByLink(
        { hrms_id: finalHrmsId, emp_no: finalEmpNo },
        'createUser'
      );
      if (hrmsMeta) {
        if (!finalHrmsId && hrmsMeta.hrms_id) finalHrmsId = hrmsMeta.hrms_id;
        if (!finalEmpNo && hrmsMeta.emp_no) finalEmpNo = hrmsMeta.emp_no;
        if (!finalDesignation && hrmsMeta.designation && ROLES_WITH_DESIGNATION.has(roleName)) {
          finalDesignation = hrmsMeta.designation;
        }
      }
    }

    // Hash password (only if not an HRMS-linked user)
    let hashedPassword = null;
    if (!finalEmpNo && !finalHrmsId) {
      if (!password) {
        return errorResponse(res, 'Password is required for non-HRMS users', 400);
      }
      const salt = await bcrypt.genSalt(10);
      hashedPassword = await bcrypt.hash(password, salt);
    }

    // Generate UUID
    const userId = uuidv4();

    // Insert user
    await pool.execute(
      `INSERT INTO users (id, hrms_id, emp_no, name, email, mobile_number, password, role_name, designation, permissions, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        userId,
        finalHrmsId,
        finalEmpNo,
        name.trim(),
        email && email.trim() ? email.toLowerCase().trim() : null,
        mobileNumber ? mobileNumber.trim() : null,
        hashedPassword,
        roleName,
        finalDesignation,
        JSON.stringify(sanitizedPermissions),
        true
      ]
    );

    // Fetch created user
    const [users] = await pool.execute(
      'SELECT id, hrms_id, emp_no, name, email, mobile_number, role_name, managed_by, is_manager, designation, permissions, is_active, created_at, updated_at FROM users WHERE id = ?',
      [userId]
    );

    const user = formatUser(users[0]);
    const actorId = req.user?.id || req.user?._id || null;
    const actorName = req.user?.name || null;
    const { ipAddress, userAgent } = getRequestAuditMeta(req);
    const afterSnap = snapshotUserForAudit(users[0]);
    await recordUserAuditLog({
      targetUserId: userId,
      targetUserName: afterSnap?.name || null,
      targetUserEmail: afterSnap?.email || null,
      action: 'create',
      changedBy: actorId,
      changedByName: actorName,
      changes: diffUserAuditSnapshots(null, afterSnap),
      ipAddress,
      userAgent,
    });

    return successResponse(res, user, 'User created successfully', 201);
  } catch (error) {
    console.error('Create user error:', error);
    return errorResponse(res, error.message || 'Failed to create user', 500);
  }
};

// @desc    Update user
// @route   PUT /api/users/:id
// @access  Private (Super Admin)
export const updateUser = async (req, res) => {
  try {
    const { name, email, password, roleName, isActive, designation, permissions, mobileNumber, unassignLeads, hrms_id, emp_no } = req.body;
    const pool = getPool();

    // Get current user
    const [users] = await pool.execute(
      'SELECT id, hrms_id, emp_no, name, email, mobile_number, role_name, managed_by, is_manager, designation, permissions, is_active FROM users WHERE id = ?',
      [req.params.id]
    );

    if (users.length === 0) {
      return errorResponse(res, 'User not found', 404);
    }

    const currentUser = users[0];
    const wasManager = currentUser.is_manager === 1 || currentUser.is_manager === true;
    const beforeSnap = snapshotUserForAudit(currentUser);
    const passwordChanged = Boolean(password);

    // Build update fields
    const updateFields = [];
    const updateValues = [];

    if (name) {
      updateFields.push('name = ?');
      updateValues.push(name.trim());
    }

    if (email && email.trim()) {
      // Check if email is already in use by another user
      const [existingUsers] = await pool.execute(
        'SELECT id FROM users WHERE email = ? AND id != ?',
        [email.toLowerCase().trim(), req.params.id]
      );
      if (existingUsers.length > 0) {
        return errorResponse(res, 'Email already in use', 400);
      }
      updateFields.push('email = ?');
      updateValues.push(email.toLowerCase().trim());
    } else if (email === null || email === '') {
      // Explicitly clearing email
      updateFields.push('email = NULL');
    }

    if (mobileNumber !== undefined) {
      if (mobileNumber) {
        // Check if mobile number is already in use by another user
        const [existingMobile] = await pool.execute(
          'SELECT id FROM users WHERE mobile_number = ? AND id != ?',
          [mobileNumber.trim(), req.params.id]
        );
        if (existingMobile.length > 0) {
          return errorResponse(res, 'Mobile number already in use', 400);
        }
        updateFields.push('mobile_number = ?');
        updateValues.push(mobileNumber.trim());
      } else {
        // Allow clearing mobile number
        updateFields.push('mobile_number = NULL');
      }
    }

    if (password) {
      if (password.length < 6) {
        return errorResponse(res, 'Password must be at least 6 characters long', 400);
      }
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(password, salt);
      updateFields.push('password = ?');
      updateValues.push(hashedPassword);
    }

    let nextHrmsId = currentUser.hrms_id;
    let nextEmpNo = currentUser.emp_no;
    if (hrms_id !== undefined) nextHrmsId = hrms_id || null;
    if (emp_no !== undefined) nextEmpNo = emp_no || null;

    const hrmsLinkChanged = hrms_id !== undefined || emp_no !== undefined;
    let syncedDesignationFromHrms = null;
    if (hrmsLinkChanged && (nextHrmsId || nextEmpNo)) {
      const hrmsMeta = await fetchHrmsEmployeeMetaByLink(
        { hrms_id: nextHrmsId, emp_no: nextEmpNo },
        'updateUser'
      );
      if (hrmsMeta) {
        if (!nextHrmsId && hrmsMeta.hrms_id) nextHrmsId = hrmsMeta.hrms_id;
        if (!nextEmpNo && hrmsMeta.emp_no) nextEmpNo = hrmsMeta.emp_no;
        syncedDesignationFromHrms = hrmsMeta.designation || null;
      }
    }

    if (hrms_id !== undefined) {
      updateFields.push('hrms_id = ?');
      updateValues.push(nextHrmsId);
    }

    if (emp_no !== undefined) {
      updateFields.push('emp_no = ?');
      updateValues.push(nextEmpNo);
    }

    // Handle isManager boolean
    let newIsManager = currentUser.is_manager === 1 || currentUser.is_manager === true;
    if (req.body.isManager !== undefined) {
      newIsManager = Boolean(req.body.isManager);
      updateFields.push('is_manager = ?');
      updateValues.push(newIsManager);
    }

    // Determine final roleName
    let finalRoleName = currentUser.role_name;
    if (roleName) {
      if (!VALID_ROLES.includes(roleName)) {
        return errorResponse(res, 'Invalid role. Must be one of: Super Admin, Sub Super Admin, Student Counselor, Data Entry User, PRO', 400);
      }
      if (roleName === 'Manager') {
        return errorResponse(res, 'Use isManager boolean field instead of setting roleName to Manager', 400);
      }
      finalRoleName = roleName;
      updateFields.push('role_name = ?');
      updateValues.push(roleName);
      // If changing role away from Manager-like role, clear isManager
      if (roleName !== 'Sub Super Admin') {
        newIsManager = false;
        updateFields.push('is_manager = ?');
        updateValues.push(false);
      }
    }

    // Handle managedBy field
    if (req.body.managedBy !== undefined) {
      if (req.body.managedBy === null || req.body.managedBy === '') {
        updateFields.push('managed_by = ?');
        updateValues.push(null);
      } else {
        // Verify manager exists and is a manager
        const [managers] = await pool.execute(
          'SELECT id, is_manager FROM users WHERE id = ?',
          [req.body.managedBy]
        );
        if (managers.length === 0) {
          return errorResponse(res, 'Manager not found', 404);
        }
        if (managers[0].is_manager !== 1 && managers[0].is_manager !== true) {
          return errorResponse(res, 'Only users with Manager privileges can manage team members', 400);
        }
        updateFields.push('managed_by = ?');
        updateValues.push(req.body.managedBy);
      }
    }

    if (typeof isActive === 'boolean') {
      updateFields.push('is_active = ?');
      updateValues.push(isActive);
    }

    // Handle designation and permissions based on role
    if (permissions && typeof permissions === 'object') {
      const sanitizedPerms = sanitizePermissions(permissions);
      updateFields.push('permissions = ?');
      updateValues.push(JSON.stringify(sanitizedPerms));
    }
    if (finalRoleName === 'Student Counselor' || finalRoleName === 'Data Entry User' || finalRoleName === 'PRO') {
      if (designation !== undefined) {
        updateFields.push('designation = ?');
        updateValues.push(designation && designation.trim() ? designation.trim() : null);
      } else if (syncedDesignationFromHrms && hrmsLinkChanged) {
        updateFields.push('designation = ?');
        updateValues.push(syncedDesignationFromHrms);
      }
    } else if (finalRoleName === 'Sub Super Admin') {
      updateFields.push('designation = ?');
      updateValues.push(null);
    } else {
      // Super Admin
      updateFields.push('designation = ?');
      updateValues.push(null);
    }

    // Add updated_at
    updateFields.push('updated_at = NOW()');

    // Execute update
    if (updateFields.length > 0) {
      updateValues.push(req.params.id);
      await pool.execute(
        `UPDATE users SET ${updateFields.join(', ')} WHERE id = ?`,
        updateValues
      );
    }

    // If revoking manager, clear managedBy for all team members
    if (wasManager && !newIsManager) {
      await pool.execute(
        'UPDATE users SET managed_by = NULL WHERE managed_by = ?',
        [req.params.id]
      );
    }

    // Unassign leads if requested during deactivation
    if (isActive === false && unassignLeads) {
      const isProRole = currentUser.role_name === 'PRO';
      const assignmentCol = isProRole ? 'assigned_to_pro' : 'assigned_to';
      const assignmentAtCol = isProRole ? 'pro_assigned_at' : 'assigned_at';
      const assignmentByCol = isProRole ? 'pro_assigned_by' : 'assigned_by';
      const currentUserId = req.user.id || req.user._id;

      // Get all leads assigned to this user
      const [leadsToUnassign] = await pool.execute(
        `SELECT id, lead_status FROM leads WHERE ${assignmentCol} = ?`,
        [req.params.id]
      );

      if (leadsToUnassign.length > 0) {
        const leadIds = leadsToUnassign.map((l) => l.id);
        const placeholders = leadIds.map(() => '?').join(',');

        // Unassign leads
        await pool.execute(
          `UPDATE leads SET ${assignmentCol} = NULL, ${assignmentAtCol} = NULL, ${assignmentByCol} = NULL, lead_status = 'New', updated_at = NOW() WHERE id IN (${placeholders})`,
          leadIds
        );

        // Add activity logs
        for (const lead of leadsToUnassign) {
          const activityLogId = uuidv4();
          await pool.execute(
            `INSERT INTO activity_logs (
              id, lead_id, type, old_status, new_status, comment, performed_by, metadata, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
            [
              activityLogId,
              lead.id,
              'status_change',
              lead.lead_status || 'Assigned',
              'New',
              `Assignment removed due to user deactivation`,
              currentUserId,
              JSON.stringify({
                unassignment: {
                  removedFrom: req.params.id,
                  removedBy: currentUserId,
                  reason: 'User Deactivation'
                },
              }),
            ]
          );
        }
      }
    }

    // Fetch updated user
    const [updatedUsers] = await pool.execute(
      'SELECT id, name, email, mobile_number, role_name, managed_by, is_manager, designation, permissions, is_active, hrms_id, emp_no, created_at, updated_at FROM users WHERE id = ?',
      [req.params.id]
    );

    const user = formatUser(updatedUsers[0]);
    const afterSnap = snapshotUserForAudit(updatedUsers[0]);
    const changes = diffUserAuditSnapshots(beforeSnap, afterSnap, { passwordChanged });
    if (Object.keys(changes).length > 0) {
      const actorId = req.user?.id || req.user?._id || null;
      const actorName = req.user?.name || null;
      const { ipAddress, userAgent } = getRequestAuditMeta(req);
      await recordUserAuditLog({
        targetUserId: req.params.id,
        targetUserName: afterSnap?.name || beforeSnap?.name || null,
        targetUserEmail: afterSnap?.email || beforeSnap?.email || null,
        action: 'update',
        changedBy: actorId,
        changedByName: actorName,
        changes,
        ipAddress,
        userAgent,
      });
    }

    return successResponse(res, user, 'User updated successfully', 200);
  } catch (error) {
    console.error('Update user error:', error);
    return errorResponse(res, error.message || 'Failed to update user', 500);
  }
};

// @desc    Search employees from HRMS MongoDB
// @route   GET /api/users/hrms/search
// @access  Private (Super Admin)
export const searchHrmsEmployees = async (req, res) => {
  try {
    const term = String(req.query.q ?? req.query.name ?? '').trim();

    if (!term || term.length < 2) {
      return successResponse(res, [], 'Please provide at least 2 characters for search');
    }

    const hrmsConn = await connectHRMS();
    
    // Define models if they don't exist
    const Employee = hrmsConn.models.employees || hrmsConn.model('employees', new hrmsConn.base.Schema({}, { strict: false }));
    const Division = hrmsConn.models.divisions || hrmsConn.model('divisions', new hrmsConn.base.Schema({}, { strict: false }));
    const Department = hrmsConn.models.departments || hrmsConn.model('departments', new hrmsConn.base.Schema({}, { strict: false }));
    const Group = hrmsConn.models.employeegroups || hrmsConn.model('employeegroups', new hrmsConn.base.Schema({}, { strict: false }));
    const Designation =
      hrmsConn.models.designations || hrmsConn.model('designations', new hrmsConn.base.Schema({}, { strict: false }));

    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Search by employee name or employee id (emp_no), case-insensitive partial match
    const employees = await Employee.find({
      $or: [
        { employee_name: { $regex: escaped, $options: 'i' } },
        { $expr: { $regexMatch: { input: { $toString: '$emp_no' }, regex: escaped, options: 'i' } } },
      ],
    }).limit(20).select('_id emp_no employee_name email phone_number division_id department_id employee_group_id designation_id dynamicFields');

    // Collect IDs for bulk resolution
    const divIds = [...new Set(employees.map(e => e.division_id).filter(id => id))];
    const deptIds = [...new Set(employees.map(e => e.department_id).filter(id => id))];
    const groupIds = [...new Set(employees.map(e => e.employee_group_id).filter(id => id))];
    const desigIdHexes = collectUniqueObjectIdHexStrings(employees.map((e) => e.designation_id));

    const [divisions, departments, groups, designations] = await Promise.all([
      Division.find({ _id: { $in: divIds } }).select('name'),
      Department.find({ _id: { $in: deptIds } }).select('name'),
      Group.find({ _id: { $in: groupIds } }).select('name'),
      desigIdHexes.length > 0
        ? Designation.find({
            _id: { $in: desigIdHexes.map((h) => new mongoose.Types.ObjectId(h)) },
          }).select('name')
        : [],
    ]);

    const divMap = Object.fromEntries(divisions.map(d => [d._id.toString(), d.name]));
    const deptMap = Object.fromEntries(departments.map(d => [d._id.toString(), d.name]));
    const groupMap = Object.fromEntries(groups.map(g => [g._id.toString(), g.name]));
    const desigMap = new Map();
    for (const doc of designations || []) {
      if (!doc?._id) continue;
      const name = doc.name != null && String(doc.name).trim() !== '' ? String(doc.name).trim() : null;
      if (!name) continue;
      desigMap.set(doc._id.toString(), name);
      const alt = toMongoObjectIdString(doc._id);
      if (alt && alt !== doc._id.toString()) desigMap.set(alt, name);
    }

    // Map fields for frontend consistency (employee_name -> name)
    const formattedEmployees = employees.map(emp => ({
      _id: emp._id,
      id: emp._id,
      emp_no: emp.emp_no,
      name: emp.employee_name,
      email: emp.email,
      mobileNumber: emp.phone_number,
      division: emp.division_id ? divMap[emp.division_id.toString()] || '-' : '-',
      department: emp.department_id ? deptMap[emp.department_id.toString()] || '-' : '-',
      group: emp.employee_group_id ? groupMap[emp.employee_group_id.toString()] || '-' : '-',
      designation: extractHrmsDesignationName(emp, desigMap),
    }));

    return successResponse(res, formattedEmployees, 'Employees retrieved successfully');
  } catch (error) {
    console.error('Search HRMS employees error:', error);
    return errorResponse(res, 'Failed to search HRMS employees', 500);
  }
};

// @desc    Get employee details from HRMS by Mongo employee _id (stored as users.hrms_id)
// @route   GET /api/users/hrms/id/:mongoId
// @access  Private (Super Admin)
export const getHrmsEmployeeByMongoId = async (req, res) => {
  try {
    const { mongoId } = req.params;
    const idStr = String(mongoId ?? '').trim();
    if (!mongoose.Types.ObjectId.isValid(idStr)) {
      return errorResponse(res, 'Invalid HRMS employee id', 400);
    }

    const hrmsConn = await connectHRMS();

    const Employee = hrmsConn.models.employees || hrmsConn.model('employees', new hrmsConn.base.Schema({}, { strict: false }));
    const Division = hrmsConn.models.divisions || hrmsConn.model('divisions', new hrmsConn.base.Schema({}, { strict: false }));
    const Department = hrmsConn.models.departments || hrmsConn.model('departments', new hrmsConn.base.Schema({}, { strict: false }));
    const Group = hrmsConn.models.employeegroups || hrmsConn.model('employeegroups', new hrmsConn.base.Schema({}, { strict: false }));

    const employee = await Employee.findById(idStr);

    if (!employee) {
      return errorResponse(res, 'Employee not found in HRMS', 404);
    }

    const { division, department, group } = await resolveHrmsOrgNamesFindById(employee, Division, Department, Group);

    const result = {
      _id: employee._id,
      id: employee._id,
      emp_no: employee.emp_no,
      name: employee.employee_name,
      email: employee.email,
      mobileNumber: employee.phone_number,
      division,
      department,
      group,
    };

    return successResponse(res, result, 'Employee details retrieved successfully');
  } catch (error) {
    console.error('Get HRMS employee by id error:', error);
    return errorResponse(res, 'Failed to fetch HRMS employee details', 500);
  }
};

// @desc    Get employee details from HRMS by emp_no
// @route   GET /api/users/hrms/:empNo
// @access  Private (Super Admin)
export const getHrmsEmployeeByEmpNo = async (req, res) => {
  try {
    const { empNo } = req.params;
    const empNoStr = String(empNo ?? '').trim();
    const empNoNum = Number(empNoStr);

    const hrmsConn = await connectHRMS();
    
    const Employee = hrmsConn.models.employees || hrmsConn.model('employees', new hrmsConn.base.Schema({}, { strict: false }));
    const Division = hrmsConn.models.divisions || hrmsConn.model('divisions', new hrmsConn.base.Schema({}, { strict: false }));
    const Department = hrmsConn.models.departments || hrmsConn.model('departments', new hrmsConn.base.Schema({}, { strict: false }));
    const Group = hrmsConn.models.employeegroups || hrmsConn.model('employeegroups', new hrmsConn.base.Schema({}, { strict: false }));

    const empNoOr = [{ emp_no: empNoStr }];
    if (Number.isFinite(empNoNum) && !Number.isNaN(empNoNum)) empNoOr.push({ emp_no: empNoNum });
    const employee = await Employee.findOne(empNoOr.length === 1 ? empNoOr[0] : { $or: empNoOr });

    if (!employee) {
      return errorResponse(res, 'Employee not found in HRMS', 404);
    }

    const { division, department, group } = await resolveHrmsOrgNamesFindById(employee, Division, Department, Group);

    const result = {
      _id: employee._id,
      id: employee._id,
      emp_no: employee.emp_no,
      name: employee.employee_name,
      email: employee.email,
      mobileNumber: employee.phone_number,
      division,
      department,
      group
    };

    return successResponse(res, result, 'Employee details retrieved successfully');
  } catch (error) {
    console.error('Get HRMS employee error:', error);
    return errorResponse(res, 'Failed to fetch HRMS employee details', 500);
  }
};

// @desc    Delete user
// @route   DELETE /api/users/:id
// @access  Private (Super Admin)
export const deleteUser = async (req, res) => {
  try {
    const pool = getPool();

    // Check if user exists
    const [users] = await pool.execute(
      'SELECT id, hrms_id, emp_no, name, email, mobile_number, role_name, managed_by, is_manager, designation, permissions, is_active FROM users WHERE id = ?',
      [req.params.id]
    );

    if (users.length === 0) {
      return errorResponse(res, 'User not found', 404);
    }

    // Don't allow deleting yourself
    const currentUserId = req.user.id || req.user._id;
    if (users[0].id === currentUserId) {
      return errorResponse(res, 'You cannot delete your own account', 400);
    }

    const beforeSnap = snapshotUserForAudit(users[0]);
    const actorId = currentUserId;
    const actorName = req.user?.name || null;
    const { ipAddress, userAgent } = getRequestAuditMeta(req);

    // Audit before delete so FK target_user_id is still valid; ON DELETE SET NULL keeps the row
    await recordUserAuditLog({
      targetUserId: users[0].id,
      targetUserName: beforeSnap?.name || null,
      targetUserEmail: beforeSnap?.email || null,
      action: 'delete',
      changedBy: actorId,
      changedByName: actorName,
      changes: diffUserAuditSnapshots(beforeSnap, null),
      ipAddress,
      userAgent,
    });

    // Delete user (foreign key constraints will handle managed_by relationships)
    await pool.execute(
      'DELETE FROM users WHERE id = ?',
      [req.params.id]
    );

    return successResponse(res, null, 'User deleted successfully', 200);
  } catch (error) {
    console.error('Delete user error:', error);
    return errorResponse(res, error.message || 'Failed to delete user', 500);
  }
};

