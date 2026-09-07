/*
 * 올바른 분리배출 퀴즈 V4 · Google Sheets 연동 설정
 * ------------------------------------------------------------
 * 1) Apps Script를 웹 앱으로 배포한 뒤 /exec 주소를 appsScriptUrl에 붙여넣습니다.
 * 2) 실제 수업에서는 dataMode: "sheet"를 유지하세요.
 * 3) 시트 없이 UI만 테스트하려면 dataMode를 "local"로 바꿀 수 있습니다.
 *
 * 교사용 PIN은 이 파일에 적지 않습니다.
 * PIN은 Apps Script의 Script Properties에서 서버 측으로 검증합니다.
 */
window.APP_CONFIG = Object.freeze({
  appName: "올바른 분리배출 퀴즈",
  version: "4.1.0",

  data: {
    dataMode: "sheet", // "sheet" | "local"
    appsScriptUrl: "https://script.google.com/macros/s/AKfycbywK_Ou_eCJ5TQ8A1eKbv7VOKFwFBDAE3L8g3TrxBWQPnHgVj6bue_EpEnLq8nXx3Czrw/exec", // 예: https://script.google.com/macros/s/XXXXXXXX/exec
    requestTimeoutMs: 15000,
    apiVersion: "v1"
  },

  teacher: {
    // local 모드에서만 쓰는 테스트용 PIN입니다. 실제 sheet 모드에서는 서버 PIN만 사용합니다.
    localTestPin: "2468",
    titleLongPressMs: 2200,
    autoRefreshMs: 5000
  },

  quiz: {
    classes: ["1", "2"],
    maxStudentNo: 99,
    targetQuestionCount: 20,
    totalScore: 100,
    enableVibration: true,
    officialFirstAttemptOnly: true
  },

  storage: {
    students: "recycleQuiz.students.v1",
    attempts: "recycleQuiz.attempts.v1",
    active: "recycleQuiz.activeSessions.v1",
    current: "recycleQuiz.currentSessionId.v1",
    lastResult: "recycleQuiz.lastResult.v1",
    questionSettings: "recycleQuiz.questionSettings.v4",
    teacherToken: "recycleQuiz.teacherToken.v1"
  }
});
