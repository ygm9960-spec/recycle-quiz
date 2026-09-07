# 올바른 분리배출 퀴즈 V4 · Google Sheets 통합본

중학교 도덕 수업용 모바일 퀴즈입니다. 학생용 화면과 교사용 대시보드는 하나의 `index.html`에 통합되어 있고, Google Apps Script + Google Sheets를 서버/기록 저장소로 사용합니다.

## 핵심 기능

- 1반 / 2반 + 번호 + 이름으로 학생 식별
- 20문항, 문제·보기 순서 랜덤
- 첫 도전만 공식 기록 및 명예의 전당 반영
- 재도전은 연습 기록으로 저장하되 순위 제외
- 새로고침 시 진행 중 공식 세션 복구
- 학생 개인 결과 / 영역별 분석 / 오답 정복
- 교사용 명예의 전당 / 문항 정답률 / 오답 선택 비율 / 영역 통계 / 재도전 통계
- 교사용 문제 ON/OFF
- 교사용 PIN 서버 검증
- 모바일 하단 `다음 문제` 버튼 고정

## 파일 구조

```text
index.html          학생·교사용 통합 웹앱
styles.css          모바일 UI
app.js              퀴즈 및 교사용 화면 로직
questions.js        20문항 데이터
config.js           GitHub ↔ Apps Script 연결 주소 설정
sheet-bridge.js     Apps Script API 통신

apps-script/Code.gs          Google Apps Script 서버 전체 코드
apps-script/appsscript.json   Apps Script 프로젝트 설정
SHEET_CONNECTION.md  실제 연결 순서
```

## 교사용 PIN

네. PIN은 직접 설정하면 됩니다.

PIN은 **GitHub의 `config.js`에 넣지 않습니다.** `Code.gs` 안의 아래 함수에서 원하는 값으로 바꾼 뒤 Apps Script 편집기에서 `setTeacherPin()`을 한 번 실행합니다.

```javascript
function setTeacherPin() {
  const NEW_PIN = '2468'; // 원하는 4~8자리 숫자로 변경
  ...
}
```

PIN은 Apps Script의 Script Properties에 저장되어 학생이 보는 GitHub 코드에는 노출되지 않습니다.

## 가장 빠른 설치 순서

1. Google Sheets에서 새 스프레드시트를 만듭니다.
2. `확장 프로그램 → Apps Script`를 엽니다.
3. `Code.gs` 내용을 전체 붙여넣습니다.
4. `setupProject()`를 1회 실행하고 권한을 승인합니다.
5. `setTeacherPin()`의 `NEW_PIN`을 원하는 PIN으로 바꾼 뒤 1회 실행합니다.
6. `배포 → 새 배포 → 웹 앱`으로 배포합니다.
7. 실행 사용자는 `나`, 액세스 권한은 학생들이 접속할 수 있도록 설정합니다.
8. 발급된 `/exec` 주소를 `config.js`의 `appsScriptUrl`에 붙여넣습니다.
9. GitHub Pages에 `index.html`, `styles.css`, `app.js`, `questions.js`, `config.js`, `sheet-bridge.js`를 업로드합니다.

자세한 순서는 `SHEET_CONNECTION.md`를 확인하세요.

## 자동 생성되는 시트

`setupProject()` 실행 시 다음 3개 탭을 자동 생성합니다.

- `Students`: 학생별 첫 공식 세션 잠금
- `Attempts`: 공식 도전 + 재도전 기록과 진행 상태
- `Questions`: 문항 ON/OFF 설정

별도로 열 제목이나 수식을 만들 필요가 없습니다.

### V4.1 hotfix
- Google Sheets가 `1-30` 같은 학생키를 날짜로 자동 변환해 발생하던 `Cannot read properties of null (reading 'row')` 오류 수정
- 학생키를 `C1-30` 형식으로 변경
- Students/Attempts 학생키 열을 일반 텍스트로 고정
- 초기 테스트 기록 정리용 `resetTestRecordsFromEditor()` 추가
