/**
 * 올바른 분리배출 퀴즈 V4.1 - Google Apps Script API
 * ------------------------------------------------------------
 * 권장 사용법
 * 1. 새 Google 스프레드시트 생성
 * 2. 확장 프로그램 > Apps Script
 * 3. 이 Code.gs 전체 붙여넣기
 * 4. setupProject() 1회 실행
 * 5. setTeacherPin() 안의 NEW_PIN 값을 원하는 PIN으로 바꾸고 1회 실행
 * 6. 배포 > 새 배포 > 웹 앱
 *    - 다음 사용자로 실행: 나
 *    - 액세스 권한: 모든 사용자
 * 7. /exec 주소를 GitHub의 config.js에 입력
 */

const API_VERSION_ = 'v1';
const SHEETS_ = Object.freeze({
  STUDENTS: 'Students',
  ATTEMPTS: 'Attempts',
  QUESTIONS: 'Questions'
});

const STUDENT_HEADERS_ = [
  'studentKey', 'classId', 'studentNo', 'name', 'firstSessionId',
  'firstCompleted', 'createdAt', 'updatedAt'
];

const ATTEMPT_HEADERS_ = [
  'sessionId', 'studentKey', 'classId', 'studentNo', 'name',
  'attemptNo', 'isFirst', 'eligibleRank', 'completed', 'status',
  'score', 'correctCount', 'questionCount', 'durationSec',
  'startedAt', 'submittedAt', 'answersJson', 'planJson',
  'currentIndex', 'streak', 'bestStreak', 'updatedAt'
];

const QUESTION_HEADERS_ = ['questionId', 'enabled', 'updatedAt'];

// questions.js의 정답 인덱스와 동일해야 합니다. 0부터 시작합니다.
const QUESTION_ANSWER_KEY_ = Object.freeze({
  1: 2, 2: 1, 3: 3, 4: 2, 5: 2,
  6: 1, 7: 0, 8: 2, 9: 1, 10: 1,
  11: 1, 12: 1, 13: 0, 14: 1, 15: 2,
  16: 1, 17: 2, 18: 0, 19: 1, 20: 2
});

function doGet() {
  return jsonOutput_({
    ok: true,
    apiVersion: API_VERSION_,
    service: '올바른 분리배출 퀴즈 API',
    message: 'Apps Script 웹 앱이 정상 실행 중입니다.'
  });
}

function doPost(e) {
  try {
    ensureProject_();
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (body.apiVersion && body.apiVersion !== API_VERSION_) {
      throw new Error('API 버전이 맞지 않습니다.');
    }

    const action = String(body.action || '');
    const payload = body.payload || {};
    let result;

    switch (action) {
      case 'ping': result = ping_(); break;
      case 'getQuestionSettings': result = getQuestionSettings_(); break;
      case 'startSession': result = startSession_(payload); break;
      case 'saveProgress': result = saveProgress_(payload); break;
      case 'submitAttempt': result = submitAttempt_(payload); break;
      case 'teacherLogin': result = teacherLogin_(payload); break;
      case 'getTeacherDashboard': result = getTeacherDashboard_(payload); break;
      case 'setQuestionEnabled': result = setQuestionEnabled_(payload); break;
      case 'resetRecords': result = resetRecords_(payload); break;
      default: throw new Error('지원하지 않는 요청입니다: ' + action);
    }

    return jsonOutput_(Object.assign({ ok: true, apiVersion: API_VERSION_ }, result || {}));
  } catch (err) {
    return jsonOutput_({
      ok: false,
      apiVersion: API_VERSION_,
      message: err && err.message ? err.message : String(err)
    });
  }
}

/** 최초 1회 실행: 현재 스프레드시트를 API 데이터베이스로 등록하고 시트를 만듭니다. */
function setupProject() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('스프레드시트에서 연결된 Apps Script로 실행해 주세요.');
  PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', ss.getId());
  ensureProject_();
  formatKeyColumnsAsPlainText_(ss);
  SpreadsheetApp.getUi().alert('설정 완료', 'Students / Attempts / Questions 시트가 준비되었습니다.\nV4.1에서는 학생키가 날짜로 오인되지 않도록 보호됩니다.\n이제 setTeacherPin()을 실행한 뒤 웹 앱으로 배포하세요.', SpreadsheetApp.getUi().ButtonSet.OK);
}

/**
 * 교사용 PIN 설정 함수.
 * 아래 NEW_PIN 값만 원하는 숫자로 바꾼 뒤 이 함수를 1회 실행하세요.
 * PIN은 GitHub 파일에 저장되지 않고 Apps Script의 Script Properties에만 저장됩니다.
 */
function setTeacherPin() {
  const NEW_PIN = '2468'; // ← 원하는 4~8자리 숫자로 변경
  if (!/^\d{4,8}$/.test(NEW_PIN)) throw new Error('PIN은 4~8자리 숫자로 설정해 주세요.');
  PropertiesService.getScriptProperties().setProperty('TEACHER_PIN', NEW_PIN);
  SpreadsheetApp.getUi().alert('교사용 PIN이 설정되었습니다.');
}

function ping_() {
  return {
    serverTime: new Date().toISOString(),
    spreadsheetIdConfigured: Boolean(PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID'))
  };
}

function getQuestionSettings_() {
  return { questionSettings: readQuestionSettings_() };
}

function startSession_(payload) {
  const classId = String(payload.classId || '').trim();
  const studentNo = padNo_(payload.studentNo);
  const name = String(payload.name || '').trim().slice(0, 20);
  const proposedPlan = sanitizePlan_(payload.plan || []);

  if (!['1', '2'].includes(classId)) throw new Error('반 정보가 올바르지 않습니다.');
  if (!/^\d{2}$/.test(studentNo) || Number(studentNo) < 1 || Number(studentNo) > 99) throw new Error('번호가 올바르지 않습니다.');
  if (!name) throw new Error('이름을 입력해 주세요.');

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const ss = getSpreadsheet_();
    const studentSheet = ss.getSheetByName(SHEETS_.STUDENTS);
    const attemptSheet = ss.getSheetByName(SHEETS_.ATTEMPTS);
    const students = readObjects_(studentSheet);
    const attempts = readObjects_(attemptSheet);
    const studentKey = makeStudentKey_(classId, studentNo);
    const now = new Date().toISOString();

    let studentInfo = findObjectWithRow_(students, 'studentKey', studentKey);
    let student = studentInfo ? studentInfo.obj : null;

    if (!student) {
      student = {
        studentKey, classId, studentNo, name,
        firstSessionId: '', firstCompleted: false,
        createdAt: now, updatedAt: now
      };
      const newStudentRow = appendObject_(studentSheet, STUDENT_HEADERS_, student);
      // append 직후 다시 읽어서 찾지 않습니다. 시트가 '1-30' 같은 값을 날짜로 자동 해석해도
      // row가 null이 되는 문제를 피하기 위해 방금 추가한 행 번호를 그대로 사용합니다.
      studentInfo = { obj: student, row: newStudentRow };
    } else {
      student.name = name;
      student.updatedAt = now;
      updateObjectRow_(studentSheet, studentInfo.row, STUDENT_HEADERS_, student);
    }

    // 첫 도전이 완료되지 않았다면 새 공식 기록을 만들지 않고 기존 세션을 재개합니다.
    if (!toBool_(student.firstCompleted) && student.firstSessionId) {
      const activeInfo = findObjectWithRow_(attempts, 'sessionId', String(student.firstSessionId));
      if (activeInfo && String(activeInfo.obj.status) !== 'COMPLETED') {
        return { session: attemptToSession_(activeInfo.obj), resumed: true, questionSettings: readQuestionSettings_() };
      }
    }

    const studentAttempts = attempts.filter(a => String(a.studentKey) === studentKey);
    const isFirst = !toBool_(student.firstCompleted) && !student.firstSessionId;

    if (!proposedPlan.length) throw new Error('출제할 문제가 없습니다. 문제 관리 설정을 확인해 주세요.');

    const sessionId = Utilities.getUuid();
    const attemptNo = studentAttempts.length + 1;
    const attempt = {
      sessionId,
      studentKey,
      classId,
      studentNo,
      name,
      attemptNo,
      isFirst,
      eligibleRank: isFirst,
      completed: false,
      status: 'ACTIVE',
      score: '',
      correctCount: '',
      questionCount: proposedPlan.length,
      durationSec: '',
      startedAt: now,
      submittedAt: '',
      answersJson: '[]',
      planJson: JSON.stringify(proposedPlan),
      currentIndex: 0,
      streak: 0,
      bestStreak: 0,
      updatedAt: now
    };
    appendObject_(attemptSheet, ATTEMPT_HEADERS_, attempt);

    if (isFirst) {
      student.firstSessionId = sessionId;
      student.updatedAt = now;
      updateObjectRow_(studentSheet, studentInfo.row, STUDENT_HEADERS_, student);
    }

    return { session: attemptToSession_(attempt), resumed: false, questionSettings: readQuestionSettings_() };
  } finally {
    lock.releaseLock();
  }
}

function saveProgress_(payload) {
  const sessionId = String(payload.sessionId || '');
  if (!sessionId) throw new Error('세션 정보가 없습니다.');

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getSpreadsheet_().getSheetByName(SHEETS_.ATTEMPTS);
    const info = findObjectWithRow_(readObjects_(sheet), 'sessionId', sessionId);
    if (!info) throw new Error('저장할 세션을 찾을 수 없습니다.');
    if (String(info.obj.status) === 'COMPLETED') return { saved: true, completed: true };

    info.obj.answersJson = JSON.stringify(sanitizeAnswers_(payload.answers || []));
    info.obj.currentIndex = Math.max(0, Number(payload.currentIndex || 0));
    info.obj.streak = Math.max(0, Number(payload.streak || 0));
    info.obj.bestStreak = Math.max(0, Number(payload.bestStreak || 0));
    info.obj.updatedAt = new Date().toISOString();
    updateObjectRow_(sheet, info.row, ATTEMPT_HEADERS_, info.obj);
    return { saved: true };
  } finally {
    lock.releaseLock();
  }
}

function submitAttempt_(payload) {
  const sessionId = String(payload.sessionId || '');
  if (!sessionId) throw new Error('세션 정보가 없습니다.');

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const ss = getSpreadsheet_();
    const attemptSheet = ss.getSheetByName(SHEETS_.ATTEMPTS);
    const studentSheet = ss.getSheetByName(SHEETS_.STUDENTS);
    const info = findObjectWithRow_(readObjects_(attemptSheet), 'sessionId', sessionId);
    if (!info) throw new Error('제출할 세션을 찾을 수 없습니다.');

    if (String(info.obj.status) === 'COMPLETED') {
      return { result: attemptToResult_(info.obj) };
    }

    const plan = safeJson_(info.obj.planJson, []);
    const answers = sanitizeAnswers_(payload.answers || safeJson_(info.obj.answersJson, []));
    const planIds = plan.map(s => Number(s.questionId));
    const answerMap = new Map();
    answers.forEach(a => answerMap.set(Number(a.questionId), a));

    if (!planIds.length) throw new Error('문제 계획이 비어 있습니다.');
    if (planIds.some(id => !answerMap.has(id))) throw new Error('아직 풀지 않은 문제가 있습니다.');

    let correctCount = 0;
    const canonicalAnswers = planIds.map(id => {
      const a = answerMap.get(id);
      const correct = Number(a.selectedOriginalIndex) === Number(QUESTION_ANSWER_KEY_[id]);
      if (correct) correctCount += 1;
      return Object.assign({}, a, { questionId: id, isCorrect: correct });
    });

    const submittedAt = new Date().toISOString();
    const startedMs = Date.parse(info.obj.startedAt);
    const durationSec = Math.max(1, Math.round((Date.now() - (Number.isFinite(startedMs) ? startedMs : Date.now())) / 1000));
    const score = Math.round((correctCount / planIds.length) * 100);

    info.obj.completed = true;
    info.obj.status = 'COMPLETED';
    info.obj.score = score;
    info.obj.correctCount = correctCount;
    info.obj.questionCount = planIds.length;
    info.obj.durationSec = durationSec;
    info.obj.submittedAt = submittedAt;
    info.obj.answersJson = JSON.stringify(canonicalAnswers);
    info.obj.currentIndex = Math.max(0, planIds.length - 1);
    info.obj.streak = Math.max(0, Number(payload.streak || info.obj.streak || 0));
    info.obj.bestStreak = Math.max(0, Number(payload.bestStreak || info.obj.bestStreak || 0));
    info.obj.updatedAt = submittedAt;
    updateObjectRow_(attemptSheet, info.row, ATTEMPT_HEADERS_, info.obj);

    if (toBool_(info.obj.isFirst)) {
      const studentInfo = findObjectWithRow_(readObjects_(studentSheet), 'studentKey', info.obj.studentKey);
      if (studentInfo) {
        studentInfo.obj.firstCompleted = true;
        studentInfo.obj.updatedAt = submittedAt;
        updateObjectRow_(studentSheet, studentInfo.row, STUDENT_HEADERS_, studentInfo.obj);
      }
    }

    return { result: attemptToResult_(info.obj) };
  } finally {
    lock.releaseLock();
  }
}

function teacherLogin_(payload) {
  const pin = String(payload.pin || '');
  const saved = PropertiesService.getScriptProperties().getProperty('TEACHER_PIN');
  if (!saved) throw new Error('교사용 PIN이 아직 설정되지 않았습니다. Apps Script에서 setTeacherPin()을 먼저 실행해 주세요.');
  if (pin !== saved) throw new Error('PIN이 올바르지 않습니다.');

  const token = Utilities.getUuid().replace(/-/g, '');
  CacheService.getScriptCache().put('teacher:' + token, '1', 21600); // 6시간
  return { token, expiresInSec: 21600 };
}

function getTeacherDashboard_(payload) {
  requireTeacher_(payload.token);
  const ss = getSpreadsheet_();
  const attempts = readObjects_(ss.getSheetByName(SHEETS_.ATTEMPTS))
    .filter(a => toBool_(a.completed))
    .map(attemptToResult_);
  return {
    attempts,
    questionSettings: readQuestionSettings_(),
    serverTime: new Date().toISOString()
  };
}

function setQuestionEnabled_(payload) {
  requireTeacher_(payload.token);
  const questionId = Number(payload.questionId);
  if (!QUESTION_ANSWER_KEY_.hasOwnProperty(questionId)) throw new Error('문항 번호가 올바르지 않습니다.');
  const enabled = Boolean(payload.enabled);

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getSpreadsheet_().getSheetByName(SHEETS_.QUESTIONS);
    const rows = readObjects_(sheet);
    const info = findObjectWithRow_(rows, 'questionId', String(questionId)) || findObjectWithRow_(rows, 'questionId', questionId);
    const obj = { questionId, enabled, updatedAt: new Date().toISOString() };
    if (info) updateObjectRow_(sheet, info.row, QUESTION_HEADERS_, obj);
    else appendObject_(sheet, QUESTION_HEADERS_, obj);
    return { questionId, enabled, questionSettings: readQuestionSettings_() };
  } finally {
    lock.releaseLock();
  }
}

function resetRecords_(payload) {
  requireTeacher_(payload.token);
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const ss = getSpreadsheet_();
    clearDataRows_(ss.getSheetByName(SHEETS_.STUDENTS));
    clearDataRows_(ss.getSheetByName(SHEETS_.ATTEMPTS));
    return { reset: true };
  } finally {
    lock.releaseLock();
  }
}

function requireTeacher_(token) {
  const t = String(token || '');
  if (!t || CacheService.getScriptCache().get('teacher:' + t) !== '1') {
    throw new Error('교사용 인증이 만료되었습니다. PIN을 다시 입력해 주세요.');
  }
  // 사용 중이면 만료 시간을 다시 연장합니다.
  CacheService.getScriptCache().put('teacher:' + t, '1', 21600);
}

function ensureProject_() {
  const ss = getSpreadsheet_();
  ensureSheet_(ss, SHEETS_.STUDENTS, STUDENT_HEADERS_);
  ensureSheet_(ss, SHEETS_.ATTEMPTS, ATTEMPT_HEADERS_);
  const qSheet = ensureSheet_(ss, SHEETS_.QUESTIONS, QUESTION_HEADERS_);
  const existing = readObjects_(qSheet);
  if (!existing.length) {
    const now = new Date().toISOString();
    const rows = Object.keys(QUESTION_ANSWER_KEY_).map(id => [Number(id), true, now]);
    qSheet.getRange(2, 1, rows.length, QUESTION_HEADERS_.length).setValues(rows);
  }
}

function getSpreadsheet_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('SPREADSHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;
  throw new Error('SPREADSHEET_ID가 설정되지 않았습니다. setupProject()를 먼저 실행해 주세요.');
}

function ensureSheet_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  const current = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  if (current.join('|') !== headers.join('|')) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  }
  return sheet;
}

function readQuestionSettings_() {
  const sheet = getSpreadsheet_().getSheetByName(SHEETS_.QUESTIONS);
  const settings = {};
  readObjects_(sheet).forEach(row => {
    settings[String(row.questionId)] = toBool_(row.enabled);
  });
  Object.keys(QUESTION_ANSWER_KEY_).forEach(id => {
    if (!(id in settings)) settings[id] = true;
  });
  return settings;
}

function readObjects_(sheet) {
  const values = sheet.getDataRange().getValues();
  if (values.length <= 1) return [];
  const headers = values[0].map(String);
  return values.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => obj[h] = row[i]);
    return obj;
  });
}

function findObjectWithRow_(objects, key, value) {
  for (let i = 0; i < objects.length; i++) {
    if (String(objects[i][key]) === String(value)) return { obj: objects[i], row: i + 2 };
  }
  return null;
}

function appendObject_(sheet, headers, obj) {
  const row = Math.max(2, sheet.getLastRow() + 1);
  prepareKeyCellAsText_(sheet, row);
  sheet.getRange(row, 1, 1, headers.length)
    .setValues([headers.map(h => normalizeCell_(obj[h]))]);
  return row;
}

function updateObjectRow_(sheet, row, headers, obj) {
  prepareKeyCellAsText_(sheet, row);
  sheet.getRange(row, 1, 1, headers.length).setValues([headers.map(h => normalizeCell_(obj[h]))]);
}

function clearDataRows_(sheet) {
  const last = sheet.getLastRow();
  if (last > 1) sheet.getRange(2, 1, last - 1, Math.max(1, sheet.getLastColumn())).clearContent();
}

function normalizeCell_(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

function attemptToSession_(a) {
  return {
    sessionId: String(a.sessionId),
    studentKey: String(a.studentKey),
    classId: String(a.classId),
    studentNo: padNo_(a.studentNo),
    name: String(a.name),
    attemptNo: Number(a.attemptNo || 1),
    isFirst: toBool_(a.isFirst),
    eligibleRank: toBool_(a.eligibleRank),
    startedAt: String(a.startedAt),
    currentIndex: Number(a.currentIndex || 0),
    plan: safeJson_(a.planJson, []),
    answers: safeJson_(a.answersJson, []),
    streak: Number(a.streak || 0),
    bestStreak: Number(a.bestStreak || 0)
  };
}

function attemptToResult_(a) {
  const answers = safeJson_(a.answersJson, []);
  const plan = safeJson_(a.planJson, []);
  return {
    sessionId: String(a.sessionId),
    studentKey: String(a.studentKey),
    classId: String(a.classId),
    studentNo: padNo_(a.studentNo),
    name: String(a.name),
    attemptNo: Number(a.attemptNo || 1),
    isFirst: toBool_(a.isFirst),
    eligibleRank: toBool_(a.eligibleRank),
    completed: toBool_(a.completed),
    score: Number(a.score || 0),
    correctCount: Number(a.correctCount || 0),
    questionCount: Number(a.questionCount || plan.length || answers.length || 0),
    durationSec: Number(a.durationSec || 0),
    startedAt: String(a.startedAt || ''),
    submittedAt: String(a.submittedAt || ''),
    answers,
    plan,
    bestStreak: Number(a.bestStreak || 0)
  };
}

function sanitizePlan_(plan) {
  if (!Array.isArray(plan)) return [];
  const seen = {};
  return plan.map(step => ({
    questionId: Number(step.questionId),
    stage: Math.max(1, Math.min(3, Number(step.stage || 2))),
    optionOrder: Array.isArray(step.optionOrder) ? step.optionOrder.map(Number) : []
  })).filter(step => {
    if (!QUESTION_ANSWER_KEY_.hasOwnProperty(step.questionId) || seen[step.questionId]) return false;
    seen[step.questionId] = true;
    return true;
  });
}

function sanitizeAnswers_(answers) {
  if (!Array.isArray(answers)) return [];
  const seen = {};
  return answers.map(a => ({
    questionId: Number(a.questionId),
    selectedOriginalIndex: Number(a.selectedOriginalIndex),
    isCorrect: Boolean(a.isCorrect),
    difficulty: String(a.difficulty || ''),
    category: String(a.category || ''),
    answeredAt: String(a.answeredAt || '')
  })).filter(a => {
    if (!QUESTION_ANSWER_KEY_.hasOwnProperty(a.questionId) || seen[a.questionId]) return false;
    seen[a.questionId] = true;
    return Number.isInteger(a.selectedOriginalIndex) && a.selectedOriginalIndex >= 0;
  });
}

/**
 * 학생키에 문자 접두사를 붙여 Google Sheets가 '1-30'을 날짜(1월 30일)로
 * 자동 변환하는 문제를 원천 차단합니다.
 * 예: 1반 30번 -> C1-30
 */
function makeStudentKey_(classId, studentNo) {
  return 'C' + String(classId) + '-' + padNo_(studentNo);
}

/** 학생키 열은 항상 일반 텍스트로 저장합니다. */
function formatKeyColumnsAsPlainText_(ss) {
  const students = ss.getSheetByName(SHEETS_.STUDENTS);
  const attempts = ss.getSheetByName(SHEETS_.ATTEMPTS);
  if (students) students.getRange('A:A').setNumberFormat('@');
  if (attempts) attempts.getRange('B:B').setNumberFormat('@');
}

function prepareKeyCellAsText_(sheet, row) {
  if (sheet.getName() === SHEETS_.STUDENTS) sheet.getRange(row, 1).setNumberFormat('@');
  if (sheet.getName() === SHEETS_.ATTEMPTS) sheet.getRange(row, 2).setNumberFormat('@');
}

/**
 * 초기 테스트 중 생긴 잘못된/중복 기록을 지우고 다시 테스트하고 싶을 때
 * Apps Script 편집기에서 직접 1회 실행하세요. Questions와 PIN은 유지합니다.
 */
function resetTestRecordsFromEditor() {
  const ss = getSpreadsheet_();
  clearDataRows_(ss.getSheetByName(SHEETS_.STUDENTS));
  clearDataRows_(ss.getSheetByName(SHEETS_.ATTEMPTS));
  formatKeyColumnsAsPlainText_(ss);
  SpreadsheetApp.getUi().alert('테스트 기록 초기화 완료', 'Students / Attempts의 데이터 행을 지웠습니다. Questions와 교사용 PIN은 유지됩니다.', SpreadsheetApp.getUi().ButtonSet.OK);
}

function padNo_(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  return String(Math.trunc(n)).padStart(2, '0');
}

function toBool_(v) {
  return v === true || String(v).toLowerCase() === 'true' || String(v) === '1';
}

function safeJson_(value, fallback) {
  if (Array.isArray(value) || (value && typeof value === 'object')) return value;
  try { return JSON.parse(String(value || '')); } catch (e) { return fallback; }
}

function jsonOutput_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
