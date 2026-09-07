(() => {
  "use strict";

  const CONFIG = window.APP_CONFIG || {};
  const QUESTIONS = window.QUIZ_QUESTIONS || [];
  const KEYS = CONFIG.storage || {};
  const $ = id => document.getElementById(id);
  const screenIds = ["startScreen", "quizScreen", "resultScreen", "retestScreen", "teacherLoginScreen", "teacherScreen"];

  let selectedClass = "";
  let currentSession = null;
  let retestSession = null;
  let lastRenderedResult = null;
  let activeTeacherTab = "overview";
  let teacherAutoRefreshTimer = null;
  let teacherTitleTapCount = 0;
  let teacherTitleTapResetTimer = null;
  let remoteQuestionSettings = {};
  let teacherDashboardCache = { attempts: [], questionSettings: {} };
  let teacherRefreshInFlight = false;

  const isSheetMode = () => window.SheetBridge?.isSheetMode?.() === true;
  const isSheetConfigured = () => window.SheetBridge?.isConfigured?.() === true;

  const storage = {
    get(key, fallback) {
      if (!key) return fallback;
      try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
      catch { return fallback; }
    },
    set(key, value) {
      if (!key) return;
      localStorage.setItem(key, JSON.stringify(value));
    }
  };

  function showScreen(id) {
    screenIds.forEach(screenId => $(screenId)?.classList.toggle("active", screenId === id));
    if (id === "teacherScreen") startTeacherAutoRefresh(); else stopTeacherAutoRefresh();
    if (id !== "quizScreen") $("quizScreen")?.classList.remove("quiz-screen-final");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function shuffle(array) {
    const copy = [...array];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  function uid() {
    if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
    return `s_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  }

  const padNo = value => String(Number(value)).padStart(2, "0");
  const getStudents = () => storage.get(KEYS.students, {});
  const getAttempts = () => isSheetMode() ? (teacherDashboardCache.attempts || []) : storage.get(KEYS.attempts, []);
  const getActiveSessions = () => storage.get(KEYS.active, {});
  const getQuestionSettings = () => isSheetMode() ? (remoteQuestionSettings || {}) : storage.get(KEYS.questionSettings, {});

  async function loadRemoteQuestionSettings() {
    if (!isSheetMode()) return getQuestionSettings();
    if (!isSheetConfigured()) throw new Error("config.js에 Apps Script /exec 주소를 먼저 입력해 주세요.");
    const data = await window.SheetBridge.getQuestionSettings();
    remoteQuestionSettings = data.questionSettings || {};
    return remoteQuestionSettings;
  }

  function isQuestionEnabled(question) {
    const settings = getQuestionSettings();
    return settings[String(question.id)] !== false;
  }

  function getEnabledQuestions() {
    return QUESTIONS.filter(isQuestionEnabled);
  }

  async function setQuestionEnabled(questionId, enabled) {
    if (isSheetMode()) {
      const token = sessionStorage.getItem(KEYS.teacherToken || "recycleQuiz.teacherToken.v1");
      if (!token) throw new Error("교사용 인증이 필요합니다.");
      const data = await window.SheetBridge.setQuestionEnabled(token, questionId, Boolean(enabled));
      remoteQuestionSettings = data.questionSettings || { ...remoteQuestionSettings, [String(questionId)]: Boolean(enabled) };
      teacherDashboardCache.questionSettings = remoteQuestionSettings;
      return;
    }
    const settings = getQuestionSettings();
    settings[String(questionId)] = Boolean(enabled);
    storage.set(KEYS.questionSettings, settings);
  }

  function saveSession(session) {
    const active = getActiveSessions();
    active[session.sessionId] = session;
    storage.set(KEYS.active, active);
    localStorage.setItem(KEYS.current, session.sessionId);

    // sheet 모드에서도 브라우저에 임시 복구본을 남기고, 서버에는 비동기로 진행상태를 저장합니다.
    if (isSheetMode() && isSheetConfigured()) {
      window.SheetBridge.saveProgress({
        sessionId: session.sessionId,
        currentIndex: session.currentIndex || 0,
        answers: session.answers || [],
        streak: session.streak || 0,
        bestStreak: session.bestStreak || 0
      }).catch(err => console.warn("진행상태 서버 저장 실패:", err.message));
    }
  }

  function removeSession(sessionId) {
    const active = getActiveSessions();
    delete active[sessionId];
    storage.set(KEYS.active, active);
    if (localStorage.getItem(KEYS.current) === sessionId) localStorage.removeItem(KEYS.current);
  }

  function buildStudentKey(classId, studentNo) {
    return `C${classId}-${padNo(studentNo)}`;
  }

  function stepFromQuestion(q, stage) {
    return {
      questionId: q.id,
      stage,
      optionOrder: shuffle(q.options.map((_, i) => i))
    };
  }

  // 기본 20문항에서는 5 → 10 → 5 흐름으로 구성합니다.
  // STEP 1은 기초, STEP 2는 생활 적용, STEP 3은 도전 문제입니다.
  function buildQuestionPlan() {
    const enabled = getEnabledQuestions();
    if (!enabled.length) return [];

    const low = shuffle(enabled.filter(q => q.difficulty === "하"));
    const high = shuffle(enabled.filter(q => q.difficulty === "상"));
    const stage1Count = Math.min(5, low.length);
    const stage1 = low.slice(0, stage1Count);
    const stage1Ids = new Set(stage1.map(q => q.id));
    const stage3 = high;
    const stage3Ids = new Set(stage3.map(q => q.id));
    const stage2 = shuffle(enabled.filter(q => !stage1Ids.has(q.id) && !stage3Ids.has(q.id)));

    return [
      ...stage1.map(q => stepFromQuestion(q, 1)),
      ...stage2.map(q => stepFromQuestion(q, 2)),
      ...stage3.map(q => stepFromQuestion(q, 3))
    ];
  }

  function createOrResumeSession({ classId, studentNo, name, forceRetry = false }) {
    const students = getStudents();
    const active = getActiveSessions();
    const attempts = getAttempts();
    const studentKey = buildStudentKey(classId, studentNo);
    let student = students[studentKey];

    if (!student) {
      student = {
        studentKey,
        classId,
        studentNo: padNo(studentNo),
        name,
        firstSessionId: null,
        firstCompleted: false,
        createdAt: new Date().toISOString()
      };
    } else {
      student.name = name;
    }

    if (!forceRetry && student.firstSessionId && !student.firstCompleted && active[student.firstSessionId]) {
      students[studentKey] = student;
      storage.set(KEYS.students, students);
      return { session: active[student.firstSessionId], resumed: true };
    }

    if (!student.firstCompleted && student.firstSessionId && !active[student.firstSessionId] && !attempts.some(a => a.sessionId === student.firstSessionId)) {
      student.firstSessionId = null;
    }

    const previousCompleted = attempts.filter(a => a.studentKey === studentKey).length;
    const attemptNo = previousCompleted + 1;
    const isFirst = !student.firstCompleted && !student.firstSessionId;
    const plan = buildQuestionPlan();
    const sessionId = uid();
    const session = {
      sessionId,
      studentKey,
      classId,
      studentNo: padNo(studentNo),
      name,
      attemptNo,
      isFirst,
      eligibleRank: isFirst,
      startedAt: new Date().toISOString(),
      currentIndex: 0,
      plan,
      answers: [],
      streak: 0,
      bestStreak: 0
    };

    if (isFirst) student.firstSessionId = sessionId;
    students[studentKey] = student;
    storage.set(KEYS.students, students);
    saveSession(session);
    return { session, resumed: false };
  }

  async function createOrResumeRemoteSession({ classId, studentNo, name, forceRetry = false }) {
    await loadRemoteQuestionSettings();
    const plan = buildQuestionPlan();
    if (!plan.length) throw new Error("현재 사용할 수 있는 문제가 없습니다. 교사용 문제 관리 설정을 확인해 주세요.");

    const data = await window.SheetBridge.startSession({
      classId,
      studentNo,
      name,
      forceRetry: Boolean(forceRetry),
      plan
    });

    if (data.questionSettings) remoteQuestionSettings = data.questionSettings;
    const session = data.session;
    if (!session || !session.sessionId) throw new Error("서버에서 세션을 만들지 못했습니다.");
    session.answers ||= [];
    session.plan ||= plan;
    session.currentIndex = Number(session.currentIndex || 0);
    session.streak = Number(session.streak || 0);
    session.bestStreak = Number(session.bestStreak || 0);

    // 로컬에는 네트워크 끊김/새로고침 복구용 사본만 유지합니다.
    const active = getActiveSessions();
    active[session.sessionId] = session;
    storage.set(KEYS.active, active);
    localStorage.setItem(KEYS.current, session.sessionId);
    return { session, resumed: Boolean(data.resumed) };
  }

  function currentQuestionData() {
    const step = currentSession.plan[currentSession.currentIndex];
    const question = QUESTIONS.find(item => item.id === step.questionId);
    return { step, question };
  }

  function stageInfo(stage) {
    if (stage === 1) return { short: "STEP 1", label: "기초 다지기", banner: "STEP 1 · 기본 분리배출 원칙을 확인해요" };
    if (stage === 3) return { short: "STEP 3", label: "도전", banner: "STEP 3 · 헷갈리는 생활 속 분리배출에 도전!" };
    return { short: "STEP 2", label: "생활 적용", banner: "STEP 2 · 실제 생활 상황에 적용해 봐요" };
  }

  function renderQuiz() {
    if (!currentSession || !currentSession.plan?.length) return;
    showScreen("quizScreen");

    const { step, question } = currentQuestionData();
    const total = currentSession.plan.length;
    const n = currentSession.currentIndex + 1;
    const answer = currentSession.answers.find(a => a.questionId === question.id);
    const stage = stageInfo(step.stage);
    const isFinal = n === total;

    $("quizScreen").classList.toggle("quiz-screen-final", isFinal);
    $("studentBadge").textContent = `${currentSession.classId}반 ${currentSession.studentNo}번 ${currentSession.name}`;
    $("attemptBadge").textContent = currentSession.isFirst ? "첫 도전 · 공식" : `재도전 ${Math.max(1, currentSession.attemptNo - 1)}회 · 연습`;
    $("progressText").textContent = `${n} / ${total}`;
    $("progressBar").style.width = `${(n / total) * 100}%`;
    $("questionNo").textContent = isFinal ? "FINAL" : `${n}번`;
    $("stageChip").textContent = isFinal ? "FINAL QUESTION" : stage.label;
    $("stageBanner").textContent = isFinal ? "🏁 마지막 문제 · 끝까지 신중하게!" : stage.banner;
    $("questionText").textContent = question.question;

    const bubble = $("questionBubble");
    bubble.classList.remove("slide-in");
    void bubble.offsetWidth;
    bubble.classList.add("slide-in");

    renderStreak(false);
    const grid = $("answerGrid");
    grid.innerHTML = "";
    grid.className = "answer-grid";
    if (question.options.length === 2) grid.classList.add("two-options");
    const longOptions = question.options.some(o => o.length >= 18) || question.question.length >= 45;
    if (question.options.length === 4 && longOptions && window.innerWidth <= 430) grid.classList.add("long-options");

    step.optionOrder.forEach((originalIndex, displayIndex) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "answer-card";
      button.innerHTML = `<span class="answer-label">${String.fromCharCode(65 + displayIndex)}</span><span class="answer-text">${escapeHtml(question.options[originalIndex])}</span>`;
      button.addEventListener("click", () => chooseAnswer(displayIndex));
      grid.appendChild(button);
    });

    if (answer) renderAnsweredState(answer, step, question, false);
    else $("feedbackCard").classList.add("hidden");
  }

  function haptic(ms = 18) {
    if (CONFIG.quiz?.enableVibration && navigator.vibrate) navigator.vibrate(ms);
  }

  function chooseAnswer(displayIndex) {
    const { step, question } = currentQuestionData();
    if (currentSession.answers.some(a => a.questionId === question.id)) return;

    haptic(16);
    const selectedOriginalIndex = step.optionOrder[displayIndex];
    const isCorrect = selectedOriginalIndex === question.answer;
    currentSession.streak = isCorrect ? (currentSession.streak || 0) + 1 : 0;
    currentSession.bestStreak = Math.max(currentSession.bestStreak || 0, currentSession.streak);

    const answer = {
      questionId: question.id,
      selectedOriginalIndex,
      isCorrect,
      difficulty: question.difficulty,
      category: question.category,
      answeredAt: new Date().toISOString()
    };

    currentSession.answers.push(answer);
    saveSession(currentSession);
    renderAnsweredState(answer, step, question, true);
  }

  function renderAnsweredState(answer, step, question, animate) {
    const buttons = [...$("answerGrid").querySelectorAll(".answer-card")];
    buttons.forEach((button, displayIndex) => {
      button.disabled = true;
      const originalIndex = step.optionOrder[displayIndex];
      if (originalIndex === question.answer) button.classList.add("correct");
      else if (originalIndex === answer.selectedOriginalIndex) button.classList.add("wrong");
      else button.classList.add("dimmed");
    });

    $("feedbackTitle").textContent = answer.isCorrect ? "✓ 정답!" : `✕ 아쉬워요! 정답은 ‘${question.options[question.answer]}’`;
    $("feedbackTitle").style.color = answer.isCorrect ? "var(--success)" : "var(--danger)";
    $("feedbackExplanation").textContent = question.explanation;
    $("memoryTip").textContent = `♻ 핵심 · ${question.tip || memoryTipFor(question)}`;

    if (!answer.isCorrect && question.misconception) {
      $("misconceptionText").textContent = question.misconception;
      $("misconceptionBox").classList.remove("hidden");
    } else {
      $("misconceptionBox").classList.add("hidden");
    }

    $("feedbackCard").classList.remove("hidden");
    $("nextBtn").textContent = currentSession.currentIndex === currentSession.plan.length - 1 ? "결과 보기 →" : "다음 문제 →";

    if (animate) {
      if (answer.isCorrect) haptic(26);
      renderStreak(true);
    }

    setTimeout(() => $("feedbackCard").scrollIntoView({ behavior: "smooth", block: "nearest" }), 60);
  }

  function memoryTipFor(q) {
    const tips = {
      "음식물": "딱딱한 뼈·씨·껍데기는 음식물쓰레기가 아닌 경우가 많아요.",
      "종이": "젖거나 기름으로 심하게 오염된 종이는 재활용이 어렵습니다.",
      "플라스틱": "비우고 → 헹구고 → 다른 재질을 분리해요.",
      "비닐": "내용물과 이물질을 제거한 뒤 지역 기준을 확인해요.",
      "페트병": "내용물을 비우고 라벨 등 다른 재질을 분리해요.",
      "유리": "유리병과 도자기·거울·내열유리는 같은 종류가 아니에요.",
      "별도배출": "건전지·형광등·폐의약품은 지정 수거처를 이용해요.",
      "복합재질": "여러 재질이 섞인 작은 생활용품은 선별이 어려울 수 있어요.",
      "재활용": "재활용의 기본은 비우기·헹구기·분리하기입니다.",
      "상황판단": "재활용 표시는 재질뿐 아니라 오염 상태도 함께 봐야 해요.",
      "일반/별도": "일반쓰레기와 별도 수거 품목을 먼저 구분해요."
    };
    return tips[q.category] || "배출 전 재질과 오염 상태를 함께 확인해요.";
  }

  function renderStreak(showPop) {
    const streak = currentSession?.streak || 0;
    const toast = $("streakToast");
    const milestone = streak >= 10 ? "🏆" : streak >= 5 ? "⚡" : "🔥";
    if (streak >= 3) {
      toast.textContent = `${milestone} ${streak}문제 연속 정답!`;
      toast.classList.remove("hidden");
      if (showPop) {
        toast.style.animation = "none";
        void toast.offsetWidth;
        toast.style.animation = "";
      }
    } else {
      toast.classList.add("hidden");
    }
  }

  function goNext() {
    const { question } = currentQuestionData();
    if (!currentSession.answers.some(a => a.questionId === question.id)) return;
    if (currentSession.currentIndex >= currentSession.plan.length - 1) return finishQuiz();
    currentSession.currentIndex += 1;
    saveSession(currentSession);
    renderQuiz();
  }

  async function finishQuiz() {
    if (!currentSession) return;

    if (isSheetMode()) {
      if (!isSheetConfigured()) {
        alert("Apps Script 주소가 설정되지 않았습니다. config.js를 확인해 주세요.");
        return;
      }
      try {
        $("nextBtn").disabled = true;
        $("nextBtn").textContent = "기록 저장 중…";
        const response = await window.SheetBridge.submitAttempt({
          sessionId: currentSession.sessionId,
          answers: currentSession.answers,
          streak: currentSession.streak || 0,
          bestStreak: currentSession.bestStreak || 0
        });
        const result = response.result;
        if (!result) throw new Error("서버가 결과를 반환하지 않았습니다.");
        storage.set(KEYS.lastResult, result);
        removeSession(currentSession.sessionId);
        renderResult(result);
      } catch (err) {
        alert(`기록 저장에 실패했습니다. 인터넷 연결을 확인한 뒤 다시 눌러 주세요.\n\n${err.message}`);
        $("nextBtn").disabled = false;
        $("nextBtn").textContent = "제출 다시 시도 →";
      }
      return;
    }

    const attempts = getAttempts();
    const duplicate = attempts.find(a => a.sessionId === currentSession.sessionId);
    if (duplicate) {
      storage.set(KEYS.lastResult, duplicate);
      removeSession(currentSession.sessionId);
      renderResult(duplicate);
      return;
    }

    const correctCount = currentSession.answers.filter(a => a.isCorrect).length;
    const questionCount = currentSession.plan.length;
    const submittedAt = new Date().toISOString();
    const result = {
      sessionId: currentSession.sessionId,
      studentKey: currentSession.studentKey,
      classId: currentSession.classId,
      studentNo: currentSession.studentNo,
      name: currentSession.name,
      attemptNo: currentSession.attemptNo,
      isFirst: currentSession.isFirst,
      eligibleRank: currentSession.isFirst,
      completed: true,
      score: questionCount ? Math.round((correctCount / questionCount) * (CONFIG.quiz?.totalScore || 100)) : 0,
      correctCount,
      questionCount,
      durationSec: Math.max(1, Math.round((new Date(submittedAt) - new Date(currentSession.startedAt)) / 1000)),
      startedAt: currentSession.startedAt,
      submittedAt,
      answers: currentSession.answers,
      plan: currentSession.plan,
      bestStreak: currentSession.bestStreak || 0
    };

    attempts.push(result);
    storage.set(KEYS.attempts, attempts);

    if (result.isFirst) {
      const students = getStudents();
      const student = students[result.studentKey];
      if (student) {
        student.firstCompleted = true;
        students[result.studentKey] = student;
        storage.set(KEYS.students, students);
      }
    }

    storage.set(KEYS.lastResult, result);
    removeSession(currentSession.sessionId);
    renderResult(result);
  }

  function masteryFor(score) {
    if (score >= 100) return { title: "♻ 분리배출 마스터", message: "완벽해요! 생활 속에서도 같은 원칙을 실천해 보세요." };
    if (score >= 90) return { title: "🌏 환경 지킴이", message: "거의 다 알고 있어요. 헷갈린 몇 가지만 다시 확인하면 충분합니다." };
    if (score >= 75) return { title: "🌿 분리배출 탐험가", message: "기본 원칙은 잘 알고 있어요. 생활 속 헷갈리는 사례를 조금 더 익혀 봐요." };
    if (score >= 60) return { title: "🌱 한 걸음 더", message: "좋은 출발이에요. 틀린 문제를 다시 풀면 분리배출 기준이 더 선명해질 거예요." };
    return { title: "📚 다시 배워볼까요?", message: "오답 정복으로 헷갈리는 기준을 하나씩 다시 익혀 봐요." };
  }

  function starText(rate) {
    const filled = Math.max(1, Math.min(5, Math.round(rate / 20)));
    return `${"★".repeat(filled)}${"☆".repeat(5 - filled)}`;
  }

  function categoryRows(result) {
    const map = new Map();
    result.answers.forEach(a => {
      if (!map.has(a.category)) map.set(a.category, { c: 0, t: 0 });
      const s = map.get(a.category);
      s.t += 1;
      if (a.isCorrect) s.c += 1;
    });
    return [...map.entries()]
      .map(([name, s]) => ({ name, ...s, rate: Math.round((s.c / s.t) * 100) }))
      .sort((a, b) => a.rate - b.rate || b.t - a.t || a.name.localeCompare(b.name, "ko"));
  }

  function renderResult(result) {
    currentSession = null;
    retestSession = null;
    lastRenderedResult = result;
    showScreen("resultScreen");

    const mastery = masteryFor(result.score);
    $("masteryBadge").textContent = mastery.title;
    $("scoreValue").textContent = result.score;
    $("correctValue").textContent = `${result.correctCount} / ${result.questionCount || result.answers.length}문제 정답${result.bestStreak >= 3 ? ` · 최고 ${result.bestStreak}연속` : ""}`;
    $("recordNotice").textContent = result.isFirst
      ? "🏆 이 점수가 첫 공식 기록으로 저장되었습니다."
      : "연습 기록입니다. 명예의 전당 순위에는 반영되지 않습니다.";

    const rows = categoryRows(result);
    const weak = rows.find(r => r.rate < 100) || rows[0];
    $("resultMessage").textContent = weak && weak.rate < 100
      ? `${mastery.message} 특히 ‘${weak.name}’ 영역을 오답 정복에서 다시 확인해 보세요.`
      : mastery.message;

    $("categoryReport").innerHTML = rows.map((r, i) => `
      <div class="category-card ${i === 0 && r.rate < 100 ? "weak" : ""}">
        <div class="category-head"><strong>${escapeHtml(r.name)}</strong><span class="star-score" aria-label="5점 만점 ${Math.round(r.rate / 20)}점">${starText(r.rate)}</span></div>
        <div class="category-meta"><div class="area-track"><div class="area-fill" style="width:${r.rate}%"></div></div><span class="area-score">${r.c}/${r.t}</span></div>
      </div>`).join("");

    const diffCount = { "하": { c: 0, t: 0 }, "중": { c: 0, t: 0 }, "상": { c: 0, t: 0 } };
    result.answers.forEach(a => {
      if (!diffCount[a.difficulty]) diffCount[a.difficulty] = { c: 0, t: 0 };
      diffCount[a.difficulty].t += 1;
      if (a.isCorrect) diffCount[a.difficulty].c += 1;
    });
    $("difficultySummary").innerHTML = ["하", "중", "상"].map(d => `<div class="summary-item"><span>난이도 ${d}</span><strong>${diffCount[d].c}/${diffCount[d].t}</strong></div>`).join("");

    const wrongCount = result.answers.filter(a => !a.isCorrect).length;
    $("wrongRetestBtn").disabled = wrongCount === 0;
    $("wrongRetestBtn").textContent = wrongCount ? `오답 정복 · ${wrongCount}문제` : "오답 없음 🎉";
  }

  async function retry() {
    const last = storage.get(KEYS.lastResult, null);
    if (!last) return showScreen("startScreen");
    try {
      $("retryBtn").disabled = true;
      $("retryBtn").textContent = "연습 준비 중…";
      const data = { classId: last.classId, studentNo: last.studentNo, name: last.name, forceRetry: true };
      const { session } = isSheetMode() ? await createOrResumeRemoteSession(data) : createOrResumeSession(data);
      if (!session.plan.length) return alert("현재 사용 설정된 문제가 없습니다. 교사용 문제 관리에서 문제를 켜 주세요.");
      currentSession = session;
      renderQuiz();
    } catch (err) {
      alert(err.message);
    } finally {
      $("retryBtn").disabled = false;
      $("retryBtn").textContent = "다시 도전";
    }
  }

  function tryResumeOnLoad() {
    const sessionId = localStorage.getItem(KEYS.current);
    if (!sessionId) return false;
    const session = getActiveSessions()[sessionId];
    if (!session || !session.plan?.length) return false;
    currentSession = session;
    currentSession.streak ??= 0;
    currentSession.bestStreak ??= 0;
    renderQuiz();
    return true;
  }

  function validateStart() {
    const noInput = $("studentNo");
    const nameInput = $("studentName");
    noInput.classList.remove("invalid");
    nameInput.classList.remove("invalid");
    $("startMessage").textContent = "";

    const no = Number(noInput.value);
    const name = nameInput.value.trim();
    const maxStudentNo = CONFIG.quiz?.maxStudentNo || 99;
    let message = "";

    if (!selectedClass) message = "먼저 반을 선택해 주세요.";
    else if (!Number.isInteger(no) || no < 1 || no > maxStudentNo) {
      message = "번호를 정확히 입력해 주세요.";
      noInput.classList.add("invalid");
    } else if (!name) {
      message = "이름을 입력해 주세요.";
      nameInput.classList.add("invalid");
    }

    if (message) {
      $("startMessage").textContent = message;
      return null;
    }
    return { classId: selectedClass, studentNo: no, name };
  }

  async function startQuiz() {
    const data = validateStart();
    if (!data) return;

    if (isSheetMode() && !isSheetConfigured()) {
      $("startMessage").textContent = "Apps Script 연결 주소가 아직 설정되지 않았습니다. config.js를 확인해 주세요.";
      return;
    }

    try {
      $("startBtn").disabled = true;
      $("startBtn").textContent = "기록 확인 중…";
      if (isSheetMode()) await loadRemoteQuestionSettings();
      const enabledCount = getEnabledQuestions().length;
      if (!enabledCount) throw new Error("현재 사용할 수 있는 문제가 없습니다. 교사용 문제 관리 설정을 확인해 주세요.");

      const { session, resumed } = isSheetMode()
        ? await createOrResumeRemoteSession(data)
        : createOrResumeSession(data);
      currentSession = session;
      if (resumed) $("startMessage").textContent = "진행 중이던 첫 도전을 이어서 시작합니다.";
      renderQuiz();
    } catch (err) {
      $("startMessage").textContent = err.message || "서버 연결에 실패했습니다.";
    } finally {
      $("startBtn").disabled = false;
      $("startBtn").textContent = "퀴즈 시작";
    }
  }

  /* ---------- 오답 미니 재시험 ---------- */
  function startWrongRetest() {
    const result = lastRenderedResult || storage.get(KEYS.lastResult, null);
    if (!result) return;
    const wrongIds = result.answers.filter(a => !a.isCorrect).map(a => a.questionId);
    if (!wrongIds.length) return;

    retestSession = {
      sourceSessionId: result.sessionId,
      index: 0,
      correct: 0,
      answers: [],
      plan: shuffle(wrongIds).map(questionId => {
        const q = QUESTIONS.find(item => item.id === questionId);
        return { questionId, optionOrder: shuffle(q.options.map((_, i) => i)) };
      })
    };
    renderRetest();
  }

  function renderRetest() {
    if (!retestSession) return;
    showScreen("retestScreen");
    $("retestComplete").classList.add("hidden");
    $("retestQuestionBubble").classList.remove("hidden");
    $("retestAnswerGrid").classList.remove("hidden");

    const step = retestSession.plan[retestSession.index];
    const q = QUESTIONS.find(item => item.id === step.questionId);
    const n = retestSession.index + 1;
    const total = retestSession.plan.length;
    const existing = retestSession.answers.find(a => a.questionId === q.id);

    $("retestProgress").textContent = `${n} / ${total}`;
    $("retestProgressBar").style.width = `${(n / total) * 100}%`;
    $("retestQuestionText").textContent = q.question;

    const grid = $("retestAnswerGrid");
    grid.className = "answer-grid";
    grid.innerHTML = "";
    if (q.options.length === 2) grid.classList.add("two-options");
    if (q.options.length === 4 && q.options.some(o => o.length >= 18) && window.innerWidth <= 430) grid.classList.add("long-options");

    step.optionOrder.forEach((originalIndex, displayIndex) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "answer-card";
      button.innerHTML = `<span class="answer-label">${String.fromCharCode(65 + displayIndex)}</span><span class="answer-text">${escapeHtml(q.options[originalIndex])}</span>`;
      button.addEventListener("click", () => chooseRetestAnswer(displayIndex));
      grid.appendChild(button);
    });

    $("retestFeedbackCard").classList.add("hidden");
    if (existing) renderRetestAnswered(existing, step, q);
  }

  function chooseRetestAnswer(displayIndex) {
    if (!retestSession) return;
    const step = retestSession.plan[retestSession.index];
    const q = QUESTIONS.find(item => item.id === step.questionId);
    if (retestSession.answers.some(a => a.questionId === q.id)) return;

    haptic(16);
    const selectedOriginalIndex = step.optionOrder[displayIndex];
    const isCorrect = selectedOriginalIndex === q.answer;
    if (isCorrect) retestSession.correct += 1;
    const answer = { questionId: q.id, selectedOriginalIndex, isCorrect };
    retestSession.answers.push(answer);
    renderRetestAnswered(answer, step, q);
  }

  function renderRetestAnswered(answer, step, q) {
    [...$("retestAnswerGrid").querySelectorAll(".answer-card")].forEach((button, displayIndex) => {
      button.disabled = true;
      const originalIndex = step.optionOrder[displayIndex];
      if (originalIndex === q.answer) button.classList.add("correct");
      else if (originalIndex === answer.selectedOriginalIndex) button.classList.add("wrong");
      else button.classList.add("dimmed");
    });

    $("retestFeedbackTitle").textContent = answer.isCorrect ? "✓ 이번에는 정답!" : `✕ 정답은 ‘${q.options[q.answer]}’`;
    $("retestFeedbackTitle").style.color = answer.isCorrect ? "var(--success)" : "var(--danger)";
    $("retestFeedbackExplanation").textContent = q.tip || q.explanation;
    $("retestNextBtn").textContent = retestSession.index === retestSession.plan.length - 1 ? "오답 정복 결과 →" : "다음 오답 →";
    $("retestFeedbackCard").classList.remove("hidden");
  }

  function nextRetest() {
    if (!retestSession) return;
    const step = retestSession.plan[retestSession.index];
    if (!retestSession.answers.some(a => a.questionId === step.questionId)) return;

    if (retestSession.index >= retestSession.plan.length - 1) {
      $("retestQuestionBubble").classList.add("hidden");
      $("retestAnswerGrid").classList.add("hidden");
      $("retestFeedbackCard").classList.add("hidden");
      $("retestComplete").classList.remove("hidden");
      $("retestCompleteText").textContent = `${retestSession.plan.length}문제 중 ${retestSession.correct}문제를 다시 맞혔어요.`;
      return;
    }

    retestSession.index += 1;
    renderRetest();
  }

  /* ---------- Teacher dashboard ---------- */
  const fmtTime = sec => `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
  const pct = (c, t) => t ? Math.round((c / t) * 100) : 0;
  const avg = values => values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10 : 0;

  function teacherTokenKey() {
    return KEYS.teacherToken || "recycleQuiz.teacherToken.v1";
  }

  function openTeacherLogin() {
    const hasAuth = isSheetMode()
      ? Boolean(sessionStorage.getItem(teacherTokenKey()))
      : sessionStorage.getItem("recycleQuiz.teacherAuth") === "1";
    if (hasAuth) {
      showScreen("teacherScreen");
      renderTeacherAll();
    } else {
      $("teacherPin").value = "";
      $("teacherLoginMessage").textContent = "";
      showScreen("teacherLoginScreen");
    }
  }

  async function teacherLogin() {
    const pin = $("teacherPin").value.trim();
    $("teacherLoginMessage").textContent = "";
    try {
      $("teacherLoginBtn").disabled = true;
      $("teacherLoginBtn").textContent = "확인 중…";
      if (isSheetMode()) {
        if (!isSheetConfigured()) throw new Error("config.js에 Apps Script 주소를 먼저 입력해 주세요.");
        const data = await window.SheetBridge.teacherLogin(pin);
        sessionStorage.setItem(teacherTokenKey(), data.token);
      } else {
        const expected = String(CONFIG.teacher?.localTestPin || "2468");
        if (pin !== expected) throw new Error("PIN이 올바르지 않습니다.");
        sessionStorage.setItem("recycleQuiz.teacherAuth", "1");
      }
      showScreen("teacherScreen");
      await renderTeacherAll();
    } catch (err) {
      $("teacherLoginMessage").textContent = err.message || "교사용 로그인에 실패했습니다.";
    } finally {
      $("teacherLoginBtn").disabled = false;
      $("teacherLoginBtn").textContent = "교사용 메뉴 열기";
    }
  }

  function teacherExit() {
    sessionStorage.removeItem("recycleQuiz.teacherAuth");
    sessionStorage.removeItem(teacherTokenKey());
    showScreen("startScreen");
  }

  async function refreshTeacherData() {
    if (!isSheetMode()) return;
    if (teacherRefreshInFlight) return;
    const token = sessionStorage.getItem(teacherTokenKey());
    if (!token) throw new Error("교사용 인증이 필요합니다.");
    teacherRefreshInFlight = true;
    try {
      const data = await window.SheetBridge.getTeacherDashboard(token);
      teacherDashboardCache = {
        attempts: data.attempts || [],
        questionSettings: data.questionSettings || {}
      };
      remoteQuestionSettings = teacherDashboardCache.questionSettings;
    } finally {
      teacherRefreshInFlight = false;
    }
  }

  function teacherFilterAttempts({ firstOnly = false } = {}) {
    const cls = $("classFilter").value;
    let list = getAttempts().filter(a => a.completed);
    if (cls !== "all") list = list.filter(a => a.classId === cls);
    if (firstOnly) list = list.filter(a => a.isFirst && a.eligibleRank);
    return list;
  }

  function teacherStatsScope() {
    return teacherFilterAttempts({ firstOnly: $("attemptScope").value === "first" });
  }

  async function renderTeacherAll() {
    try {
      await refreshTeacherData();
      renderTeacherOverview();
      renderTeacherHall();
      renderTeacherQuestions();
      renderTeacherCategory();
      renderTeacherRetry();
      renderTeacherManage();
    } catch (err) {
      if (isSheetMode()) {
        sessionStorage.removeItem(teacherTokenKey());
        $("teacherLoginMessage").textContent = err.message || "교사용 인증이 만료되었습니다.";
        showScreen("teacherLoginScreen");
      } else {
        console.error(err);
      }
    }
  }

  function questionStats(attempts) {
    return QUESTIONS.map(q => {
      const counts = q.options.map(() => 0);
      let total = 0;
      let correct = 0;
      attempts.forEach(a => {
        const ans = (a.answers || []).find(x => x.questionId === q.id);
        if (!ans) return;
        total += 1;
        if (ans.isCorrect) correct += 1;
        if (Number.isInteger(ans.selectedOriginalIndex) && counts[ans.selectedOriginalIndex] !== undefined) counts[ans.selectedOriginalIndex] += 1;
      });
      return { q, total, correct, rate: pct(correct, total), counts };
    });
  }

  function renderTeacherOverview() {
    const first = teacherFilterAttempts({ firstOnly: true });
    const all = teacherFilterAttempts();
    const average = avg(first.map(a => a.score));
    const perfect = first.filter(a => a.score === 100).length;
    const retries = all.filter(a => !a.isFirst).length;
    const c1 = first.filter(a => a.classId === "1").length;
    const c2 = first.filter(a => a.classId === "2").length;
    const missed = questionStats(first).filter(r => r.total).sort((a, b) => a.rate - b.rate || b.total - a.total).slice(0, 5);

    $("tab-overview").innerHTML = `
      <div class="stat-grid">
        ${statCard("공식 참여", `${first.length}명`)}
        ${statCard("첫 기록 평균", `${average}점`)}
        ${statCard("100점", `${perfect}명`)}
        ${statCard("연습 도전", `${retries}회`)}
      </div>
      <div class="teacher-card">
        <h2>반별 공식 참여</h2>
        ${barsHtml([{ name: "1반", rate: c1, total: c1, raw: `${c1}명` }, { name: "2반", rate: c2, total: c2, raw: `${c2}명` }], Math.max(c1, c2, 1))}
      </div>
      <div class="teacher-card">
        <h2>가장 많이 틀린 문제 TOP 5</h2>
        <p class="teacher-card-sub">첫 공식 기록 기준 · 문제를 누르면 수업 피드백 모드로 크게 볼 수 있습니다.</p>
        ${missed.length ? `<div class="top-missed">${missed.map(r => `
          <button class="missed-row" type="button" data-focus-question="${r.q.id}">
            <span class="missed-no">${r.q.id}</span>
            <span class="missed-q">${escapeHtml(r.q.question)}</span>
            <span class="missed-rate">${r.rate}%</span>
          </button>`).join("")}</div>` : emptyHtml()}
      </div>
      <p class="refresh-note">마지막 갱신 ${new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</p>`;
  }

  function renderTeacherHall() {
    const ranked = teacherFilterAttempts({ firstOnly: true })
      .sort((a, b) => b.score - a.score || a.durationSec - b.durationSec || new Date(a.submittedAt) - new Date(b.submittedAt));

    $("tab-hall").innerHTML = `<div class="teacher-card">
      <h2>🏆 명예의 전당</h2>
      <p class="teacher-card-sub">첫 도전 기록만 반영 · 동점은 풀이시간이 짧은 순</p>
      ${ranked.length ? `<div class="rank-list">${ranked.map((a, i) => `
        <div class="rank-card ${i === 0 ? "top-1" : ""}">
          <div class="rank-num">${i < 3 ? ["🥇", "🥈", "🥉"][i] : i + 1}</div>
          <div class="rank-person"><strong>${a.classId}반 ${a.studentNo}번 ${escapeHtml(a.name)}</strong><span>${a.correctCount}/${a.questionCount || QUESTIONS.length} 정답 · ${fmtTime(a.durationSec)}</span></div>
          <div class="rank-score"><strong>${a.score}</strong><span>점</span></div>
        </div>`).join("")}</div>` : emptyHtml()}
    </div>`;
  }

  function renderTeacherQuestions() {
    const attempts = teacherStatsScope();
    const rows = questionStats(attempts).sort((a, b) => (a.total ? 0 : 1) - (b.total ? 0 : 1) || a.rate - b.rate || a.q.id - b.q.id);
    $("tab-questions").innerHTML = `<div class="teacher-card">
      <h2>문항별 오답 선택 분석</h2>
      <p class="teacher-card-sub">정답률뿐 아니라 학생들이 어떤 오답에 몰렸는지 확인합니다.</p>
      <div class="question-stat-list">${rows.map(r => questionStatCardHtml(r)).join("")}</div>
    </div>`;
  }

  function questionStatCardHtml(r) {
    return `<article class="question-stat-card">
      <div class="qstat-head"><strong>${r.q.id}. ${escapeHtml(r.q.question)}</strong><span class="rate-pill">${r.total ? r.rate + "%" : "-"}</span></div>
      <div class="qstat-meta">난이도 ${r.q.difficulty} · ${escapeHtml(r.q.category)} ${r.q.localCheck ? '<span class="badge-local">지역 확인</span>' : ""} · ${r.total}명 응답</div>
      ${r.q.options.map((o, i) => {
        const rate = pct(r.counts[i], r.total);
        return `<div class="option-stat ${i === r.q.answer ? "correct-option" : ""}">
          <div class="option-stat-line"><span class="option-letter">${String.fromCharCode(65 + i)}</span><span class="option-text-small">${escapeHtml(o)}</span><span class="option-percent">${r.total ? rate + "%" : "-"}</span></div>
          <div class="bar-track"><div class="bar-fill" style="width:${rate}%"></div></div>
        </div>`;
      }).join("")}
      <button class="small-btn" type="button" data-focus-question="${r.q.id}">수업용으로 크게 보기</button>
    </article>`;
  }

  function aggregateBy(field) {
    const attempts = teacherStatsScope();
    const map = new Map();
    QUESTIONS.forEach(q => {
      if (!map.has(q[field])) map.set(q[field], { total: 0, correct: 0 });
    });
    attempts.forEach(a => (a.answers || []).forEach(ans => {
      const q = QUESTIONS.find(x => x.id === ans.questionId);
      if (!q) return;
      const b = map.get(q[field]) || { total: 0, correct: 0 };
      b.total += 1;
      if (ans.isCorrect) b.correct += 1;
      map.set(q[field], b);
    }));
    return [...map.entries()].map(([name, s]) => ({ name, ...s, rate: pct(s.correct, s.total) })).sort((a, b) => a.rate - b.rate);
  }

  function renderTeacherCategory() {
    const category = aggregateBy("category");
    const difficulty = aggregateBy("difficulty").sort((a, b) => ["하", "중", "상"].indexOf(a.name) - ["하", "중", "상"].indexOf(b.name));
    $("tab-category").innerHTML = `
      <div class="teacher-card"><h2>영역별 정답률</h2>${barsHtml(category, 100)}</div>
      <div class="teacher-card"><h2>난이도별 정답률</h2>${barsHtml(difficulty, 100)}</div>`;
  }

  function renderTeacherRetry() {
    const cls = $("classFilter").value;
    const all = getAttempts().filter(a => a.completed && (cls === "all" || a.classId === cls));
    const by = new Map();
    all.forEach(a => {
      if (!by.has(a.studentKey)) by.set(a.studentKey, []);
      by.get(a.studentKey).push(a);
    });

    const rows = [...by.values()].map(list => {
      const first = list.find(a => a.isFirst);
      const retries = list.filter(a => !a.isFirst);
      if (!first || !retries.length) return null;
      const best = Math.max(...retries.map(a => a.score));
      return { first, count: retries.length, best, improve: best - first.score };
    }).filter(Boolean).sort((a, b) => b.improve - a.improve);

    const retryStudents = rows.length;
    const avgImprove = avg(rows.map(r => r.improve));
    $("tab-retry").innerHTML = `
      <div class="stat-grid">${statCard("재도전 학생", `${retryStudents}명`)}${statCard("평균 향상", `${avgImprove >= 0 ? "+" : ""}${avgImprove}점`)}</div>
      <div class="teacher-card"><h2>재도전 향상도</h2>
        ${rows.length ? `<div class="retry-list">${rows.map(r => `
          <div class="retry-card"><div><strong>${r.first.classId}반 ${r.first.studentNo}번 ${escapeHtml(r.first.name)}</strong><span>첫 ${r.first.score}점 → 연습 최고 ${r.best}점 · ${r.count}회 재도전</span></div><div class="retry-improve">${r.improve > 0 ? "+" : ""}${r.improve}</div></div>`).join("")}</div>` : emptyHtml()}
      </div>`;
  }

  function renderTeacherManage() {
    const enabledCount = getEnabledQuestions().length;
    const target = CONFIG.quiz?.targetQuestionCount || 20;
    $("tab-manage").innerHTML = `<div class="teacher-card">
      <h2>문제 사용 설정</h2>
      <p class="teacher-card-sub">OFF로 바꾼 문제는 새로 시작하는 퀴즈부터 제외됩니다. 공정한 순위를 위해 수업 도중에는 설정을 바꾸지 않는 것을 권장합니다.</p>
      <div class="manage-summary"><div><strong>현재 ${enabledCount}문제 사용</strong><br><span>${enabledCount === target ? `기본 ${target}문항 구성이 유지되고 있습니다.` : `기본 ${target}문항과 다릅니다. 점수는 100점 환산으로 계산됩니다.`}</span></div><span>${enabledCount}/${QUESTIONS.length}</span></div>
      <div class="manage-list">${QUESTIONS.map(q => {
        const enabled = isQuestionEnabled(q);
        return `<article class="manage-card ${enabled ? "" : "disabled-q"}">
          <div><h3>${q.id}. ${escapeHtml(q.question)}</h3><div class="manage-meta">난이도 ${q.difficulty} · ${escapeHtml(q.category)} ${q.localCheck ? '<span class="badge-local">지역 확인 필요</span>' : ""}</div><div class="manage-answer"><b>정답:</b> ${escapeHtml(q.options[q.answer])}</div></div>
          <button class="toggle ${enabled ? "on" : ""}" type="button" data-toggle-question="${q.id}" aria-label="${q.id}번 문제 ${enabled ? "끄기" : "켜기"}" aria-pressed="${enabled}"></button>
        </article>`;
      }).join("")}</div>
    </div>`;
  }

  function showTeacherFocus(questionId) {
    const q = QUESTIONS.find(item => item.id === Number(questionId));
    if (!q) return;
    const stats = questionStats(teacherStatsScope()).find(r => r.q.id === q.id);
    $("focusQuestionTitle").textContent = `${q.id}. ${q.question}`;
    $("focusQuestionMeta").innerHTML = `정답률 <b>${stats.total ? stats.rate + "%" : "응답 없음"}</b> · ${escapeHtml(q.category)} · ${stats.total}명 응답 ${q.localCheck ? '<span class="badge-local">지역 확인</span>' : ""}`;
    $("focusOptions").innerHTML = q.options.map((option, i) => {
      const rate = pct(stats.counts[i], stats.total);
      return `<div class="focus-option ${i === q.answer ? "correct" : ""}"><div class="focus-option-head"><span>${String.fromCharCode(65 + i)}. ${escapeHtml(option)}${i === q.answer ? " ✓ 정답" : ""}</span><span>${stats.total ? rate + "%" : "-"}</span></div><div class="bar-track"><div class="bar-fill" style="width:${rate}%"></div></div></div>`;
    }).join("");
    $("focusExplanation").innerHTML = `<b>수업 정리</b><br>${escapeHtml(q.explanation)}<br><br><b>학생이 헷갈리기 쉬운 이유</b><br>${escapeHtml(q.misconception || "재질과 배출 방법을 함께 판단해야 합니다.")}`;
    $("teacherFocusModal").classList.remove("hidden");
  }

  function closeTeacherFocus() {
    $("teacherFocusModal").classList.add("hidden");
  }

  function statCard(label, value) {
    return `<div class="stat-card"><span>${label}</span><strong>${value}</strong></div>`;
  }

  function emptyHtml() {
    return `<div class="empty">아직 기록이 없습니다.</div>`;
  }

  function barsHtml(data, max = 100) {
    if (!data.some(d => d.total)) return emptyHtml();
    return `<div class="mini-bars">${data.map(d => {
      const width = max === 100 ? d.rate : Math.round((d.rate / max) * 100);
      return `<div class="bar-row"><strong>${escapeHtml(d.name)}</strong><div class="bar-track"><div class="bar-fill" style="width:${Math.min(100, width)}%"></div></div><span class="bar-value">${d.raw || (d.total ? d.rate + "%" : "-")}</span></div>`;
    }).join("")}</div>`;
  }

  function exportCsv() {
    const rows = teacherFilterAttempts().map(a => ({
      class: `${a.classId}반`,
      number: a.studentNo,
      name: a.name,
      attemptNo: a.attemptNo,
      official: a.isFirst ? "Y" : "N",
      score: a.score,
      correct: a.correctCount,
      questionCount: a.questionCount || a.answers?.length || "",
      durationSec: a.durationSec,
      submittedAt: a.submittedAt
    }));
    const header = ["class", "number", "name", "attemptNo", "official", "score", "correct", "questionCount", "durationSec", "submittedAt"];
    const csv = "\ufeff" + [header.join(","), ...rows.map(r => header.map(k => `"${String(r[k] ?? "").replaceAll('"', '""')}"`).join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `분리배출_퀴즈_기록_${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function startTeacherAutoRefresh() {
    stopTeacherAutoRefresh();
    teacherAutoRefreshTimer = setInterval(() => {
      if ($("teacherScreen").classList.contains("active")) renderTeacherAll();
    }, CONFIG.teacher?.autoRefreshMs || 5000);
  }

  function stopTeacherAutoRefresh() {
    if (teacherAutoRefreshTimer) {
      clearInterval(teacherAutoRefreshTimer);
      teacherAutoRefreshTimer = null;
    }
  }

  function setupTeacherTitleTap() {
    const title = $("startTitle");
    const requiredTaps = Math.max(2, Number(CONFIG.teacher?.titleTapCount || 5));
    const resetMs = Math.max(700, Number(CONFIG.teacher?.titleTapResetMs || 1800));

    const resetTapCount = () => {
      teacherTitleTapCount = 0;
      if (teacherTitleTapResetTimer) {
        clearTimeout(teacherTitleTapResetTimer);
        teacherTitleTapResetTimer = null;
      }
    };

    const registerTap = () => {
      teacherTitleTapCount += 1;

      if (teacherTitleTapResetTimer) clearTimeout(teacherTitleTapResetTimer);
      teacherTitleTapResetTimer = setTimeout(resetTapCount, resetMs);

      if (teacherTitleTapCount >= requiredTaps) {
        resetTapCount();
        haptic(35);
        openTeacherLogin();
      }
    };

    // 스마트폰 탭과 PC 클릭을 모두 click 이벤트 하나로 통일합니다.
    title.addEventListener("click", registerTap);
    title.addEventListener("contextmenu", e => e.preventDefault());

    // 키보드 사용 시에도 Enter 5회로 같은 규칙을 적용합니다.
    title.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        registerTap();
      }
    });
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll(".class-btn").forEach(button => button.addEventListener("click", () => {
      selectedClass = button.dataset.class;
      document.querySelectorAll(".class-btn").forEach(b => b.classList.toggle("selected", b === button));
    }));

    $("startBtn").addEventListener("click", startQuiz);
    $("nextBtn").addEventListener("click", goNext);
    $("retryBtn").addEventListener("click", retry);
    $("homeBtn").addEventListener("click", () => showScreen("startScreen"));
    $("wrongRetestBtn").addEventListener("click", startWrongRetest);

    $("retestNextBtn").addEventListener("click", nextRetest);
    $("retestExitBtn").addEventListener("click", () => lastRenderedResult ? renderResult(lastRenderedResult) : showScreen("resultScreen"));
    $("retestDoneBtn").addEventListener("click", () => lastRenderedResult ? renderResult(lastRenderedResult) : showScreen("resultScreen"));

    setupTeacherTitleTap();
    $("teacherLoginBack").addEventListener("click", () => showScreen("startScreen"));
    $("teacherLoginBtn").addEventListener("click", teacherLogin);
    $("teacherPin").addEventListener("keydown", e => { if (e.key === "Enter") teacherLogin(); });
    $("teacherExitBtn").addEventListener("click", teacherExit);
    $("teacherRefreshBtn").addEventListener("click", renderTeacherAll);
    $("classFilter").addEventListener("change", renderTeacherAll);
    $("attemptScope").addEventListener("change", renderTeacherAll);
    $("exportBtn").addEventListener("click", exportCsv);

    document.querySelectorAll(".tab").forEach(tab => tab.addEventListener("click", () => {
      activeTeacherTab = tab.dataset.tab;
      document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t === tab));
      document.querySelectorAll(".tab-content").forEach(c => c.classList.toggle("active", c.id === `tab-${activeTeacherTab}`));
    }));

    $("teacherScreen").addEventListener("click", async e => {
      const focusButton = e.target.closest("[data-focus-question]");
      if (focusButton) {
        showTeacherFocus(focusButton.dataset.focusQuestion);
        return;
      }
      const toggle = e.target.closest("[data-toggle-question]");
      if (toggle) {
        const id = Number(toggle.dataset.toggleQuestion);
        const q = QUESTIONS.find(item => item.id === id);
        if (!q) return;
        toggle.disabled = true;
        try {
          await setQuestionEnabled(id, !isQuestionEnabled(q));
          renderTeacherManage();
        } catch (err) {
          alert(err.message);
        } finally {
          toggle.disabled = false;
        }
      }
    });

    $("focusCloseBtn").addEventListener("click", closeTeacherFocus);
    $("teacherFocusModal").addEventListener("click", e => { if (e.target === $("teacherFocusModal")) closeTeacherFocus(); });

    $("clearBtn").addEventListener("click", async () => {
      const message = isSheetMode()
        ? "Google Sheets의 Students/Attempts 기록을 모두 삭제하려면 ‘초기화’를 입력하세요."
        : "이 기기의 학생 테스트 기록을 모두 삭제하려면 ‘초기화’를 입력하세요.";
      const input = prompt(message);
      if (input !== "초기화") return;
      try {
        if (isSheetMode()) {
          const token = sessionStorage.getItem(teacherTokenKey());
          await window.SheetBridge.resetRecords(token);
          teacherDashboardCache.attempts = [];
        } else {
          [KEYS.students, KEYS.attempts, KEYS.active, KEYS.current, KEYS.lastResult].forEach(k => k && localStorage.removeItem(k));
        }
        await renderTeacherAll();
      } catch (err) {
        alert(err.message);
      }
    });

    window.addEventListener("storage", () => {
      if ($("teacherScreen").classList.contains("active")) renderTeacherAll();
    });

    if (!tryResumeOnLoad()) showScreen("startScreen");

    if (isSheetMode()) {
      if (!isSheetConfigured()) {
        $("startMessage").textContent = "설정 필요: config.js에 Apps Script /exec 주소를 입력해 주세요.";
      } else {
        loadRemoteQuestionSettings().catch(err => {
          $("startMessage").textContent = `시트 연결 확인 필요: ${err.message}`;
        });
      }
    }
  });
})();
