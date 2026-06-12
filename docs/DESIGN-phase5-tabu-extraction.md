# DESIGN — Phase-5: נסח-טאבו → בעלות (חילוץ-AI גנרי + אישור-ידני)

> מקור-אמת לתכנון Phase-5. משלים את `docs/DESIGN-project-model-and-autosetup.md` §6
> (שקבע: "העלה נסח → אנחנו מפענחים"; API-בתשלום נדחה). סטטוס-ביצוע חי:
> `docs/V12-SLICE-LEDGER.md` §Phase-5. החלטות-בעלים מצוטטות כלשונן.

## 1. החלטות הבעלים (כרונולוגי, 2026-06-12)

| #          | החלטה                                                                                                                 | ציטוט/תמצית                                                                     | סטטוס                                      |
| ---------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------ |
| D-P5.1     | פיענוח-אוטומטי **+ אישור-ידני חובה**                                                                                  | "פיענוח אוטומטי עם אפשרות לאשר ידנית אחרי הטעינה... כדי שעין תוודא התאמה ותאשר" | ✅ נקבע                                    |
| D-P5.2     | חילוץ ע"י **מודל-AI**, לא regex                                                                                       | "אולי לחסוך... ולהשתמש במודל AI שידע לבצע את החילוץ"                            | ✅ נקבע                                    |
| D-P5.3     | **גנרי/מתחלף** — אפשר להחליף/להוסיף מנועים                                                                            | "חייב שתתכנן את זה גנרי כדי שאוכל להחליף או להוסיף עוד מנועים"                  | ✅ נקבע + מומש (IExtractionProvider)       |
| D-P5.4     | הצפנה: המסמך מוצפן + הנתונים-שחולצו מוצפנים                                                                           | "המסמך צריך להיות מוצפן והנתונים לאחר חילוץ צריכים להיות מוצפנים"               | ✅ נתונים (0069) · ⏳ bytes-המסמך (7b-OTP) |
| D-P5.5     | גישה = הרשאה + **OTP step-up**; "בתהליך נוגע רק מי שיש לו גישה למסמך או על בסיס OTP"                                  | OTP **פעם-אחת-בסשן** פותח את **כל** המסמכים שהמשתמש מורשה להם                   | ⏳ ממתין ל-D-P5.7/8                        |
| D-P5.6     | מנוע-אמיתי: עדיפות **Gemini ב-Vertex אזור-ת"א (me-west1)** — PII נשאר בארץ; zero-retention+DPA+אישור-משפטי לפני חיבור | "כן בוא ננסה אולי נתחרט" — מאחורי ה-seam הגנרי                                  | ⏳ חיבור עתידי; עד אז Stub (אפס-egress)    |
| **D-P5.7** | **היקף ה-OTP** — רק נסחים/מסמכי-PII (מומלץ) או כל מסמך?                                                               | —                                                                               | 🔴 **פתוח — חוסם 7b-OTP+7c**               |
| **D-P5.8** | **TTL לפתיחה** — סשן / שעה / 15 דק'?                                                                                  | —                                                                               | 🔴 **פתוח — חוסם 7b-OTP+7c**               |

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

| סלייס      | תוכן                                                     | סטטוס               |
| ---------- | -------------------------------------------------------- | ------------------- |
| 7a         | מעטפת-extraction + lifecycle (0068)                      | ✅ #358             |
| 7b-extract | מנוע גנרי + שורות מוצפנות (0069)                         | ✅ #359             |
| 7b-OTP     | step-up unlock לסשן + הצפנת-bytes-המסמך                  | 🔴 חסום על D-P5.7/8 |
| 7c         | סקירה-מפוענחת מאחורי OTP + confirm→ownerships+provenance | 🔴 חסום על D-P5.7/8 |
