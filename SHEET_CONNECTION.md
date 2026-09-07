# Google Sheets + Apps Script 연결 방법

## 1. Google 스프레드시트 만들기

빈 Google 스프레드시트를 하나 만듭니다. 시트 이름은 직접 만들 필요가 없습니다.

## 2. Apps Script 코드 넣기

스프레드시트 상단에서 `확장 프로그램 → Apps Script`를 엽니다.

기존 `Code.gs`의 내용을 모두 지우고 이 압축파일의 `apps-script/Code.gs` 내용을 붙여넣습니다.

`appsscript.json`은 Apps Script의 `프로젝트 설정 → appsscript.json 매니페스트 파일 표시`를 켠 뒤 필요하면 동일하게 맞출 수 있습니다. 필수는 아닙니다.

## 3. 시트 자동 생성

Apps Script 편집기 상단 함수 선택에서 `setupProject`를 선택하고 실행합니다.

첫 실행 시 Google 권한 승인 창이 뜹니다. 승인하면 다음 탭이 자동 생성됩니다.

- Students
- Attempts
- Questions

`Questions`에는 1~20번 문항이 모두 ON 상태로 생성됩니다.

## 4. 교사용 PIN 설정

`Code.gs`에서 아래 부분을 찾습니다.

```javascript
function setTeacherPin() {
  const NEW_PIN = '2468';
```

`2468`을 원하는 **4~8자리 숫자**로 바꿉니다.

예:

```javascript
const NEW_PIN = '7319';
```

저장한 뒤 함수 선택에서 `setTeacherPin`을 골라 **1회 실행**합니다.

이 PIN은 서버의 Script Properties에 저장됩니다. `config.js`에는 PIN을 적지 않습니다.

## 5. 웹 앱 배포

Apps Script 우측 상단에서:

`배포 → 새 배포 → 유형 선택 → 웹 앱`

권장 설정:

- 다음 사용자로 실행: **나**
- 액세스 권한: 학생들이 로그인 없이 사용할 경우 **모든 사용자**

배포 후 아래 형태의 주소를 복사합니다.

```text
https://script.google.com/macros/s/XXXXXXXXXXXXXXXX/exec
```

> 학교 Workspace 정책에 따라 `모든 사용자` 옵션이 제한될 수 있습니다. 이 경우 학교 계정의 웹 앱 공개 정책을 확인해야 합니다.

## 6. config.js 연결

GitHub에 올릴 `config.js`에서:

```javascript
data: {
  dataMode: "sheet",
  appsScriptUrl: "https://script.google.com/macros/s/XXXXXXXXXXXXXXXX/exec",
```

처럼 `/exec` 주소를 붙여넣습니다.

## 7. 연결 확인

브라우저에서 Apps Script `/exec` 주소 자체를 열었을 때 다음과 비슷한 JSON이 나오면 서버는 정상입니다.

```json
{"ok":true,"service":"올바른 분리배출 퀴즈 API"}
```

그다음 GitHub Pages의 학생용 웹앱에서 1명만 테스트 응시합니다.

정상이라면 `Students`와 `Attempts`에 행이 생깁니다.

## 8. 첫 기록 규칙

서버에서 `반 + 번호`를 학생 고유키로 사용합니다.

예: `1반 7번 → 1-07`

- 첫 도전 시작 시 공식 세션 생성
- 새로고침/재접속 시 같은 미완료 공식 세션 재개
- 첫 세션 완료 후 `firstCompleted = true`
- 이후 도전은 `isFirst = false`, `eligibleRank = false`
- 교사용 명예의 전당은 첫 공식 기록만 사용

따라서 학생이 재도전에서 더 높은 점수를 받아도 명예의 전당 점수는 바뀌지 않습니다.

## 9. Apps Script를 수정한 뒤 주의점

`Code.gs`를 수정한 뒤에는 기존 배포를 편집하여 **새 버전으로 다시 배포**해야 변경 내용이 실제 `/exec` 주소에 반영됩니다.

GitHub의 `config.js`는 같은 `/exec` 주소를 계속 사용할 수 있습니다.

## V4.2 오류 수정 안내

초기 V4에서 `studentKey`가 `1-30`처럼 저장될 경우 Google Sheets가 이를 날짜(1월 30일)로 자동 해석할 수 있었습니다. 그 결과 학생을 다시 찾지 못해 `Cannot read properties of null (reading 'row')` 오류가 발생할 수 있었습니다.

V4.2에서는 학생키를 `C1-30` 형태로 저장하고, Students의 A열과 Attempts의 B열을 일반 텍스트 형식으로 고정합니다. 또한 새 학생을 추가한 직후 행 번호를 직접 사용해 null row 오류를 방지합니다.

기존 테스트 중 중복 행이 생겼다면 Apps Script 편집기에서 `resetTestRecordsFromEditor()`를 1회 실행한 뒤 다시 테스트하세요. 이 함수는 Students / Attempts 기록만 지우며 Questions와 교사용 PIN은 유지합니다.

코드를 교체한 뒤에는 반드시 `setupProject()`를 다시 1회 실행하고, 웹 앱 배포에서 **새 버전으로 배포**하세요. 기존 `/exec` URL은 보통 그대로 사용할 수 있습니다.
