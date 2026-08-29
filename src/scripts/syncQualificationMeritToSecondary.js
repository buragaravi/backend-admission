/**
 * Push CRM `admissions.qualification_merit` (Yes/No) → secondary `student_merit_status`
 * for the student's current year (`students.current_year`, default 1).
 *
 * Default is dry-run (no writes). Logs each student that would change / did change.
 *
 * Usage (from backend-admission):
 *   node src/scripts/syncQualificationMeritToSecondary.js
 *   node src/scripts/syncQualificationMeritToSecondary.js --dry-run
 *   node src/scripts/syncQualificationMeritToSecondary.js --apply
 *   node src/scripts/syncQualificationMeritToSecondary.js --apply --prefix=2026
 *   npm run sync:merit-status:dry
 *   npm run sync:merit-status:apply
 */
import dotenv from 'dotenv';
import { getPool as getPrimaryPool, closeDB as closePrimary } from '../config-sql/database.js';
import {
  getPool as getSecondaryPool,
  closeDB as closeSecondary,
} from '../config-sql/database-secondary.js';
import {
  mapQualificationMeritToSecondaryStatus,
  upsertStudentMeritStatus,
} from '../utils/studentSync.util.js';

dotenv.config();

function parseArgs(argv) {
  const args = {
    apply: false,
    prefix: '2026',
    limit: 0,
    verbose: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--dry-run') args.apply = false;
    else if (a === '--verbose' || a === '-v') args.verbose = true;
    else if (a.startsWith('--prefix=')) args.prefix = String(a.split('=')[1] || '').trim();
    else if (a.startsWith('--limit=')) {
      const n = Number.parseInt(a.split('=')[1] || '', 10);
      args.limit = Number.isFinite(n) && n > 0 ? n : 0;
    }
  }
  return args;
}

function resolveStudentYear(currentYear) {
  const y = Number.parseInt(String(currentYear ?? '').trim(), 10);
  if (Number.isFinite(y) && y >= 1 && y <= 12) return y;
  return 1;
}

async function main() {
  const args = parseArgs(process.argv);
  const mode = args.apply ? 'apply' : 'dry-run';
  const prefix = args.prefix || '';

  console.log(`[merit-sync] mode=${mode} prefix=${prefix || '(all)'} limit=${args.limit || 'none'}`);

  const primary = getPrimaryPool();
  const secondary = getSecondaryPool();

  const like = prefix ? `${prefix}%` : '%';
  let [admissions] = await primary.execute(
    `SELECT admission_number, student_name, qualification_merit, status
     FROM admissions
     WHERE admission_number LIKE ?
     ORDER BY CAST(admission_number AS UNSIGNED)`,
    [like]
  );
  if (args.limit > 0) {
    admissions = admissions.slice(0, args.limit);
  }

  const admissionNumbers = admissions
    .map((r) => String(r.admission_number || '').trim())
    .filter(Boolean);

  const secondaryByAdmission = new Map();
  const CHUNK = 400;
  for (let i = 0; i < admissionNumbers.length; i += CHUNK) {
    const chunk = admissionNumbers.slice(i, i + CHUNK);
    if (!chunk.length) continue;
    const placeholders = chunk.map(() => '?').join(',');
    const [rows] = await secondary.execute(
      `SELECT id, admission_number, current_year, student_name
       FROM students
       WHERE admission_number IN (${placeholders})`,
      chunk
    );
    for (const row of rows) {
      secondaryByAdmission.set(String(row.admission_number).trim(), row);
    }
  }

  const studentIds = [...new Set([...secondaryByAdmission.values()].map((s) => s.id))];
  const meritByStudentYear = new Map();
  for (let i = 0; i < studentIds.length; i += CHUNK) {
    const chunk = studentIds.slice(i, i + CHUNK);
    if (!chunk.length) continue;
    const placeholders = chunk.map(() => '?').join(',');
    const [rows] = await secondary.execute(
      `SELECT student_id, student_year, merit_status
       FROM student_merit_status
       WHERE student_id IN (${placeholders})`,
      chunk
    );
    for (const row of rows) {
      meritByStudentYear.set(`${row.student_id}:${row.student_year}`, row.merit_status);
    }
  }

  const summary = {
    mode,
    scanned: 0,
    missingSecondaryStudent: 0,
    skippedNoMerit: 0,
    unchanged: 0,
    wouldInsert: 0,
    wouldUpdate: 0,
    inserted: 0,
    updated: 0,
    errors: 0,
  };

  for (const row of admissions) {
    summary.scanned += 1;

    const admissionNumber = String(row.admission_number || '').trim();
    const studentName = String(row.student_name || '').trim() || '(unnamed)';
    const expected = mapQualificationMeritToSecondaryStatus(row.qualification_merit);

    if (expected !== 'yes' && expected !== 'no') {
      summary.skippedNoMerit += 1;
      if (args.verbose) {
        console.log(
          `[skip] ${admissionNumber} ${studentName} — CRM merit empty (qualification_merit=${row.qualification_merit})`
        );
      }
      continue;
    }

    const student = secondaryByAdmission.get(admissionNumber);
    if (!student) {
      summary.missingSecondaryStudent += 1;
      console.log(
        `[missing-secondary] ${admissionNumber} ${studentName} — CRM merit=${expected}, no secondary student row`
      );
      continue;
    }

    const studentId = student.id;
    const studentYear = resolveStudentYear(student.current_year);
    const key = `${studentId}:${studentYear}`;
    const rawPrevious = meritByStudentYear.has(key) ? meritByStudentYear.get(key) : undefined;
    const previous =
      rawPrevious === undefined ? null : rawPrevious == null ? null : String(rawPrevious);
    const hasRow = meritByStudentYear.has(key);

    if (hasRow && previous === expected) {
      summary.unchanged += 1;
      if (args.verbose) {
        console.log(
          `[unchanged] ${admissionNumber} ${studentName} — year=${studentYear} merit=${expected}`
        );
      }
      continue;
    }

    const actionLabel = hasRow ? 'update' : 'insert';
    const changeText = hasRow
      ? `${previous ?? '∅'} → ${expected}`
      : `∅ → ${expected}`;

    if (!args.apply) {
      if (actionLabel === 'insert') summary.wouldInsert += 1;
      else summary.wouldUpdate += 1;
      console.log(
        `[dry-run] would ${actionLabel} student ${admissionNumber} ${studentName} ` +
          `(student_id=${studentId}, year=${studentYear}) merit ${changeText}`
      );
      continue;
    }

    try {
      const result = await upsertStudentMeritStatus(secondary, {
        studentId,
        studentYear,
        meritStatus: expected,
      });
      if (result.action === 'inserted') {
        summary.inserted += 1;
        meritByStudentYear.set(key, expected);
        console.log(
          `[updated] student ${admissionNumber} ${studentName} inserted ` +
            `(student_id=${studentId}, year=${studentYear}) merit ${changeText}`
        );
      } else if (result.action === 'updated') {
        summary.updated += 1;
        meritByStudentYear.set(key, expected);
        console.log(
          `[updated] student ${admissionNumber} ${studentName} updated ` +
            `(student_id=${studentId}, year=${studentYear}) merit ${changeText}`
        );
      } else if (result.action === 'unchanged') {
        summary.unchanged += 1;
      } else {
        summary.errors += 1;
        console.log(
          `[error] student ${admissionNumber} ${studentName} — upsert skipped (${result.action})`
        );
      }
    } catch (err) {
      summary.errors += 1;
      console.error(`[error] student ${admissionNumber} ${studentName}:`, err?.message || err);
    }
  }

  console.log('\n[merit-sync] summary');
  console.log(JSON.stringify(summary, null, 2));

  if (!args.apply) {
    console.log(
      '\nDry-run only. Re-run with --apply (or npm run sync:merit-status:apply) to write secondary rows.'
    );
  }

  await closePrimary();
  await closeSecondary();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
