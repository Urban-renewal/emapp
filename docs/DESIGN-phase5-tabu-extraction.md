# DESIGN — Phase-5: נסח-טאבו → בעלות (חילוץ-AI גנרי + אישור-ידני)

> מקור-אמת לתכנון Phase-5. משלים את `docs/DESIGN-project-model-and-autosetup.md` §6
> (שקבע: "העלה נסח → אנחנו מפענחים"; API-בתשלום נדחה). סטטוס-ביצוע חי:
> `docs/V12-SLICE-LEDGER.md` §Phase-5. החלטות-בעלים מצוטטות כלשונן.

## 1. החלטות הבעלים (כרונולוגי, 2026-06-12)

| #      | החלטה                                                                                                                 | ציטוט/תמצית                                                                             | סטטוס                                      |
| ------ | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------ |
| D-P5.1 | פיענוח-אוטומטי **+ אישור-ידני חובה**                                                                                  | "פיענוח אוטומטי עם אפשרות לאשר ידנית אחרי הטעינה... כדי שעין תוודא התאמה ותאשר"         | ✅ נקבע                                    |
| D-P5.2 | חילוץ ע"י **מודל-AI**, לא regex                                                                                       | "אולי לחסוך... ולהשתמש במודל AI שידע לבצע את החילוץ"                                    | ✅ נקבע                                    |
| D-P5.3 | **גנרי/מתחלף** — אפשר להחליף/להוסיף מנועים                                                                            | "חייב שתתכנן את זה גנרי כדי שאוכל להחליף או להוסיף עוד מנועים"                          | ✅ נקבע + מומש (IExtractionProvider)       |
| D-P5.4 | הצפנה: המסמך מוצפן + הנתונים-שחולצו מוצפנים                                                                           | "המסמך צריך להיות מוצפן והנתונים לאחר חילוץ צריכים להיות מוצפנים"                       | ✅ נתונים (0069) · ⏳ bytes-המסמך (7b-OTP) |
| D-P5.5 | גישה = הרשאה + **OTP step-up**; "בתהליך נוגע רק מי שיש לו גישה למסמך או על בסיס OTP"                                  | OTP **פעם-אחת-בסשן** פותח את **כל** המסמכים שהמשתמש מורשה להם                           | ⏳ ממתין ל-D-P5.7/8                        |
| D-P5.6 | מנוע-אמיתי: עדיפות **Gemini ב-Vertex אזור-ת"א (me-west1)** — PII נשאר בארץ; zero-retention+DPA+אישור-משפטי לפני חיבור | "כן בוא ננסה אולי נתחרט" — מאחורי ה-seam הגנרי                                          | ⏳ חיבור עתידי; עד אז Stub (אפס-egress)    |
| D-P5.7 | היקף ה-OTP: **רק נסחים / מסמכים רגישים** (לא כל מסמך)                                                                 | "רק נסחים או מסמכים רגישים"                                                             | ✅ נקבע 2026-06-12                         |
| D-P5.8 | TTL לפתיחה: **תוקף-הסשן או שעה כברירת-מחדל**, **ניתן-לשינוי בהגדרות מנהל-הטננט** (org settings)                       | "או בתוקף הסשן או לתוקף של שעה כברירת מחדל עם אפשרות לשינוי הזמן בהגדרות של מנהל הטננט" | ✅ נקבע 2026-06-12                         |

## 2. ארכיטקטורה

```
נסח (PDF/סריקה) ──upload──▶ R2 [bytes מוצפנים-במעטפה — 7b-OTP]
       │ tabu_extractions (7a ✅): draft|confirmed|discarded, source_document_id, apartment_id
       ▼
POST /tabu-extractions/:id/extract (7b-extract ✅)
       │ IExtractionProvider.extract({bytes,mimeType,text})   ◀── המנוע מתחלף (D-P5.3)
       │    ├─ StubExtractionProvider (ברירת-מחדל, אפס-רשת, אפס-egress)
       │    └─ [עתידי] Gemini-Vertex-me-west1 / Claude / מקומי — דרך extractionProviderFactory
       ▼
tabu_extraction_rows (0069 ✅): name_encrypted+national_id_encrypted (pgcrypto),
       share_num/den, confidence, edited, position · raw_text_encrypted על ה-extraction
       ▼
[7c ⏳] מסך-סקירה צד-לצד (נסח ↔ שורות מפוענחות) — מאחורי OTP-unlock (D-P5.5/7/8)
       │ עריכה (edited=true) → CONFIRM
       ▼
owners (שלדים 3a) + ownerships (שברים מדויקים 3b, atomic, sum-trigger) + provenance→extraction
```

## 3. עקרונות-אבטחה מחייבים (מהבקרות + CLAUDE.md)

- PII (שם/ת.ז./raw-text) **מוצפן-במנוחה** (pgcrypto, PII_ENCRYPTION_KEY); אף-פעם בלוג/audit/שגיאה.
- **אפס-egress כברירת-מחדל**: שום נסח לא נשלח למנוע-חיצוני עד שהבעלים מחבר מנוע (DPA+zero-retention).
- D.54: כל write-של-סוכן עם requireAgentCapability('edit_project_data') בגוף-המתודה.
- FORCE RLS org_id על שתי הטבלאות; no-oracle 404; scan-clean re-assert לפני קריאת-bytes.
- 7c: הצגת-PII-מפוענח = מאחורי OTP + masking-לפי-תפקיד (D.19/D.47); confirm = audit-first, atomic.

## 4. סלייסים

| סלייס      | תוכן                                                                 | סטטוס                                          |
| ---------- | -------------------------------------------------------------------- | ---------------------------------------------- |
| 7a         | מעטפת-extraction + lifecycle (0068)                                  | ✅ #358                                        |
| 7b-extract | מנוע גנרי + שורות מוצפנות (0069)                                     | ✅ #359                                        |
| 7b-OTP     | step-up unlock לסשן + שער-מסמכים-רגישים (0070)                       | ✅ #361 (בקרת-אבטחה: 2 HIGH תוקנו-בשורש+ננעלו) |
| 7c         | סקירה-מפוענחת מאחורי OTP + confirm→ownerships+provenance + FE-unlock | 🟢 הבא (כולל browser-QA שרשרת-מלאה)            |
| 7d         | הצפנת-bytes-המסמך במעטפה (R2 at-rest)                                | ⏳ אחרי 7c                                     |

## 5. Slice 7c — סקירה+אישור (spec)

- **BE:** `GET /tabu-extractions/:id/rows` — שורות מפוענחות (decryptField) **רק** מאחורי unlock תקף
  (אחרת 403 pii_step_up_required, אותה-posture כמו שער-המסמכים) + masking-לפי-תפקיד (D.19/D.47).
  `PATCH /tabu-extractions/:id/rows/:rowId` — עריכת שורה (edited=true; cap edit_project_data).
  `POST /tabu-extractions/:id/confirm` — audit-first, אידמפוטנטי (WHERE status='draft'), אטומי:
  יצירת/התאמת owners (שלדי-3a; התאמה לפי hash-ת.ז. כשקיימת) + החלפת ownerships של הדירה בשברים
  המאושרים (טריגר-סכום, טרנזקציה אחת) + confirmed_at + provenance (עמודת source_extraction_id על
  ownerships — migration, when > 1782745200000). + 3 ה-MINORs הרטרואקטיביים (טסט-pagination,
  טסט-agent-getOne, יישור limit-default).
- **FE:** מודאל-unlock (request→קוד→verify, נפתח על כל 403 pii_step_up_required) + מסך-סקירה צד-לצד
  (מציג-נסח ↔ שורות מפוענחות, עריכה, אישור) בעמוד-הדירה. he+en. stub ל-e2e.
- **Browser-QA (חוב 7a/7b נסגר כאן): השרשרת המלאה חיה** — העלאת-נסח(רגיש) → 403 → OTP unlock →
  extract(stub) → סקירה → עריכה → confirm → ownerships בשברים נכונים + provenance → הלוח משתקף.

## 7d — הצפנת-bytes של מסמכים רגישים (D-P5.4 חצי-שני) — החלטת-עיצוב (מתועדת תחת ההרשאה)

**מודל-האיום:** R2 מצפין-במנוחה כברירת-מחדל, אבל דליפת-credential/דאמפ-bucket חושפת נסחים (PII).
הגנה אמיתית = הצפנה אפליקטיבית שהמפתח שלה אינו ב-R2.

**ההחלטה — אופציה (a): app-envelope למסמכים רגישים בלבד.**

- **העלאה רגישה** עוברת דרך ה-API (לא presign): `POST /documents/:id/content` (bytes; bodyLimit
  ייעודי 52MB) → השרת מאמת hash/size מול-ההצהרה על ה-plaintext (אטסטציה חזקה מ-layer-2) → **סורק את
  ה-plaintext** (P0.B1 נשמר) → מצפין **AES-256-GCM** (מפתח DOC_ENCRYPTION_KEY מ-Infisical) → putObject.
- **פורמט-עצמי** של האובייקט: `EMAPPENC|v1|keyId|iv|tag|ciphertext` → אין migration; + עמודת
  `bytes_encrypted boolean` (migration 0072) לידיעה-מוקדמת בנתיב-ההגשה.
- **הורדה רגישה**: הנתיב הקיים (כבר OTP-gated) עובר מ-presign ל-**decrypt-stream** מה-API.
- **מסמכים רגילים: ללא שינוי** (presign דו-כיווני, אפס עלות-API).
- finalize למסמך-מוצפן: layer-2 (head-attestation) מוחלף באטסטציית-השרת (הוא חישב את ה-hash בעצמו).
  **נדחו:** (b) SSE-C — המפתח היה מגיע ללקוח ב-headers של presign (דליפה); (c) הסתמכות על R2-default —
  לא מגן מפני דליפת-credential. **עלות:** bytes-רגישים עוברים דרך ה-API (מקובל — נסחים קטנים; רגילים
  לא מושפעים). putObject מתווסף ל-IStorageProvider (R2+Fake).
