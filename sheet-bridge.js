(() => {
  "use strict";

  const cfg = window.APP_CONFIG?.data || {};

  function isSheetMode() {
    return cfg.dataMode === "sheet";
  }

  function isConfigured() {
    return isSheetMode() && /^https:\/\/script\.google\.com\/macros\/s\/.+\/exec(?:\?.*)?$/.test(cfg.appsScriptUrl || "");
  }

  async function request(action, payload = {}) {
    if (!isConfigured()) {
      throw new Error("Apps Script 웹 앱 주소가 설정되지 않았습니다. config.js의 appsScriptUrl을 확인하세요.");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number(cfg.requestTimeoutMs || 15000));

    try {
      const response = await fetch(cfg.appsScriptUrl, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({
          apiVersion: cfg.apiVersion || "v1",
          action,
          payload
        }),
        signal: controller.signal,
        redirect: "follow"
      });

      if (!response.ok) throw new Error(`서버 응답 오류 (${response.status})`);
      const data = await response.json();
      if (data?.ok === false) throw new Error(data.message || "서버 처리에 실패했습니다.");
      return data;
    } catch (error) {
      if (error?.name === "AbortError") throw new Error("서버 연결 시간이 초과되었습니다. 인터넷 연결을 확인해 주세요.");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  window.SheetBridge = Object.freeze({
    isSheetMode,
    isConfigured,
    request,
    ping: () => request("ping"),
    getQuestionSettings: () => request("getQuestionSettings"),
    startSession: payload => request("startSession", payload),
    saveProgress: payload => request("saveProgress", payload),
    submitAttempt: payload => request("submitAttempt", payload),
    teacherLogin: pin => request("teacherLogin", { pin }),
    getTeacherDashboard: token => request("getTeacherDashboard", { token }),
    setQuestionEnabled: (token, questionId, enabled) => request("setQuestionEnabled", { token, questionId, enabled }),
    resetRecords: token => request("resetRecords", { token })
  });
})();
