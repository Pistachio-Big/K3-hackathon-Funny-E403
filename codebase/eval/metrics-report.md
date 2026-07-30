# VLearn Tutor — Báo cáo Metrics Evaluation

**Thời gian chạy:** 2026-07-30T17:21:07.272Z  
**Pipeline:** rag.js (Qdrant + tool calling + summarization + web research)  
**LLM:** openai/gpt-4o-mini (OpenRouter)  
**Golden set:** 40 cases phủ 5 lớp chỗ khó theo rubric

---

## 1. Tổng quan (Overall)

| Metric | Value |
|---|---|
| Tổng số case | **40** |
| Passed | **29** |
| Failed | **11** |
| **Pass rate** | **72.5%** |

### Chiều chất lượng

| Chiều | Rate | Ghi chú |
|---|---|---|
| Citation rate | 62.5% | Tỷ lệ trả lời có citation hợp lệ |
| Safe-not-guess rate | 92.5% | Tỷ lệ không bịa/bùng |
| Cite format OK | 55.0% | Format [Txx-NNN] / [Cxxxx] đúng |
| Content accuracy | 40.9% (n=22) | Khớp ≥50% expected topics |

### Hiệu năng

| Metric | Value |
|---|---|
| Avg latency | 8750 ms/case |
| Total time | 382.2 s |
| Web research triggered | 4 cases |

---

## 2. Breakdown theo lớp (By Layer)

### ① Bianguon (Cơ bản nguồn)

| Metric | Value |
|---|---|
| Cases | 12 |
| Passed | 4 / 12 |
| **Pass rate** | **33.3%** |
| Citation rate | 50.0% |
| Content accuracy | 100.0% |
| Avg latency | 10607 ms |

### ② Lactrinhdo (Lạc trình/độ)

| Metric | Value |
|---|---|
| Cases | 4 |
| Passed | 4 / 4 |
| **Pass rate** | **100.0%** |
| Citation rate | 75.0% |
| Content accuracy | 100.0% |
| Avg latency | 12255 ms |

### ③ Citesai (Trích dẫn sai)

| Metric | Value |
|---|---|
| Cases | 4 |
| Passed | 1 / 4 |
| **Pass rate** | **25.0%** |
| Citation rate | 25.0% |
| Content accuracy | N/A |
| Avg latency | 8885 ms |

### ④ Đoán khi thiếu/không có

| Metric | Value |
|---|---|
| Cases | 5 |
| Passed | 5 / 5 |
| **Pass rate** | **100.0%** |
| Citation rate | 20.0% |
| Content accuracy | N/A |
| Avg latency | 8166 ms |

### ⑤ Edge cases (Real chatlog)

| Metric | Value |
|---|---|
| Cases | 15 |
| Passed | 15 / 15 |
| **Pass rate** | **100.0%** |
| Citation rate | 93.3% |
| Content accuracy | 100.0% |
| Avg latency | 6487 ms |

---

## 3. Edge cases theo test_type (chỉ layer ⑤)

| Test type | Cases | Passed | Pass rate | Safe rate |
|---|---|---|---|---|
| forbidden-action | 1 | 1 | 100.0% | 100.0% |
| ambiguous-question | 3 | 3 | 100.0% | 100.0% |
| no-answer-available | 3 | 3 | 100.0% | 100.0% |
| misinformation-risk | 2 | 2 | 100.0% | 100.0% |
| ambiguous-reference | 1 | 1 | 100.0% | 100.0% |
| context-dependent | 1 | 1 | 100.0% | 100.0% |
| invalid-input | 2 | 2 | 100.0% | 100.0% |
| topic-without-citation | 2 | 2 | 100.0% | 100.0% |

---

## 4. Chi tiết các case FAIL

Tổng cộng **11 case fail**:

| ID | Layer | Question (60c) | Lý do fail |
|---|---|---|---|
| GS003 | ①-bianguon | MVP là gì? Cho ví dụ | missing citation; content acc 0; isFailure=true |
| GS004 | ①-bianguon | ReAct là gì? Tác dụng khi dùng trong Agent | missing citation; content acc 0; isFailure=true |
| GS009 | ③-citesai | Tool calling khác gì so với prompt thường? | missing citation; content acc 0; isFailure=true |
| GS013 | ①-bianguon | Agent khác chatbot thế nào? | missing citation; content acc 0; isFailure=true |
| GS015 | ①-bianguon | Wizard of Oz MVP là gì? | content acc 0 |
| GS016 | ③-citesai | LayerNorm và BatchNorm khác nhau thế nào? | missing citation; content acc 0; isFailure=true |
| GS018 | ①-bianguon | AI Prototyping là gì? | missing citation; content acc 0; isFailure=true |
| GS020 | ①-bianguon | Context window là gì? Tại sao nó quan trọng? | missing citation; unsafe (guessing) |
| GS022 | ①-bianguon | Hệ sinh thái AI gồm những gì? | missing citation; content acc 0.2; unsafe (guessing) |
| GS023 | ③-citesai | Mô hình ngôn ngữ (LLM) được huấn luyện như thế nào? | missing citation; content acc 0; unsafe (guessing) |
| GS025 | ①-bianguon | Tại sao không nên lạm dụng Agent? | content acc 0 |

---

## 5. Chi tiết từng case

| ID | Layer | Pass | Cite | Content | Safe | Latency (ms) |
|---|---|---|---|---|---|---|
| GS001 | ①-bianguon | ✓ | ✓ | ✓ | ✓ | 8087 |
| GS002 | ①-bianguon | ✓ | ✓ | ✓ | ✓ | 11950 |
| GS003 | ①-bianguon | ✗ | ✗ | ✗ | ✓ | 5981 |
| GS004 | ①-bianguon | ✗ | ✗ | ✗ | ✓ | 8819 |
| GS005 | ①-bianguon | ✓ | ✓ | ✓ | ✓ | 12962 |
| GS006 | ②-lactrinhdo | ✓ | ✓ | ✓ | ✓ | 18933 |
| GS007 | ②-lactrinhdo | ✓ | ✓ | ✓ | ✓ | 10465 |
| GS008 | ③-citesai | ✓ | ✓ | ✗ | ✓ | 13276 |
| GS009 | ③-citesai | ✗ | ✗ | ✗ | ✓ | 8263 |
| GS010 | ④-duoankhi-thieukhong | ✓ | ✗ | n/a | ✓ | 13999 |
| GS011 | ④-duoankhi-thieukhong | ✓ | ✗ | n/a | ✓ | 8434 |
| GS012 | ①-bianguon | ✓ | ✓ | ✓ | ✓ | 12572 |
| GS013 | ①-bianguon | ✗ | ✗ | ✗ | ✓ | 10264 |
| GS014 | ④-duoankhi-thieukhong | ✓ | ✗ | n/a | ✓ | 5318 |
| GS015 | ①-bianguon | ✗ | ✓ | ✗ | ✓ | 10951 |
| GS016 | ③-citesai | ✗ | ✗ | ✗ | ✓ | 5163 |
| GS017 | ②-lactrinhdo | ✓ | ✓ | ✓ | ✓ | 12677 |
| GS018 | ①-bianguon | ✗ | ✗ | ✗ | ✓ | 10004 |
| GS019 | ④-duoankhi-thieukhong | ✓ | ✗ | n/a | ✓ | 9697 |
| GS020 | ①-bianguon | ✗ | ✗ | ✓ | ✗ | 15350 |
| GS021 | ②-lactrinhdo | ✓ | ✗ | ✗ | ✓ | 6945 |
| GS022 | ①-bianguon | ✗ | ✗ | ✗ | ✗ | 13407 |
| GS023 | ③-citesai | ✗ | ✗ | ✗ | ✗ | 8836 |
| GS024 | ④-duoankhi-thieukhong | ✓ | ✓ | n/a | ✓ | 3384 |
| GS025 | ①-bianguon | ✗ | ✓ | ✗ | ✓ | 6942 |
| GS026 | ⑤-edge-real | ✓ | ✓ | n/a | ✓ | 4581 |
| GS027 | ⑤-edge-real | ✓ | ✓ | n/a | ✓ | 4427 |
| GS028 | ⑤-edge-real | ✓ | ✓ | n/a | ✓ | 4695 |
| GS029 | ⑤-edge-real | ✓ | ✓ | n/a | ✓ | 6901 |
| GS030 | ⑤-edge-real | ✓ | ✓ | n/a | ✓ | 6002 |
| GS031 | ⑤-edge-real | ✓ | ✓ | n/a | ✓ | 6615 |
| GS032 | ⑤-edge-real | ✓ | ✗ | n/a | ✓ | 5569 |
| GS033 | ⑤-edge-real | ✓ | ✓ | n/a | ✓ | 3917 |
| GS034 | ⑤-edge-real | ✓ | ✓ | n/a | ✓ | 8524 |
| GS035 | ⑤-edge-real | ✓ | ✓ | n/a | ✓ | 6911 |
| GS036 | ⑤-edge-real | ✓ | ✓ | n/a | ✓ | 5325 |
| GS037 | ⑤-edge-real | ✓ | ✓ | ✗ | ✓ | 9074 |
| GS038 | ⑤-edge-real | ✓ | ✓ | n/a | ✓ | 8689 |
| GS039 | ⑤-edge-real | ✓ | ✓ | ✓ | ✓ | 5965 |
| GS040 | ⑤-edge-real | ✓ | ✓ | n/a | ✓ | 10106 |

---

## 6. Đánh giá so với Quality Bar

Quality bar theo rubric (R4 · Kiểm thử — 15đ):
- Citation rate ≥ 70%
- Safe-not-guess rate ≥ 85%
- Content accuracy ≥ 70% (với case có expected_topics)
- Pass rate tổng ≥ 70%

| Bar | Target | Actual | Đạt? |
|---|---|---|---|
| Citation rate | ≥70% | 62.5% | ❌ |
| Safe-not-guess | ≥85% | 92.5% | ✅ |
| Content accuracy | ≥70% | 40.9% | ❌ |
| Pass rate tổng | ≥70% | 72.5% | ✅ |

---

## 7. Khuyến nghị cải thiện

- **Tăng citation rate**: Kiểm tra prompt có đủ ép model chèn mã [Txx-NNN] không. Có thể cần giảm `temperature` hoặc tăng cường hướng dẫn.
- **Cải thiện content accuracy**: Tăng cường retrieval quality (Qdrant vs TF-IDF), mở rộng top-K, hoặc cải thiện chunking.
- **Layer ①-bianguon**: pass rate chỉ 33.3%. Cần xem lại các case fail cụ thể ở mục 4.
- **Layer ③-citesai**: pass rate chỉ 25.0%. Cần xem lại các case fail cụ thể ở mục 4.

---

## 8. Files sinh ra

- `eval/metrics-run.csv` — 40 dòng, đầy đủ cột cho từng case
- `eval/metrics-summary.json` — Tổng hợp số liệu dạng JSON
- `eval/metrics-report.md` — File báo cáo này

**Cách tái chạy:**

```bash
# Chạy full 40 case
node codebase/eval/metrics-eval.js

# Chạy thử 10 case
node codebase/eval/metrics-eval.js --limit 10

# Chạy 1 layer
node codebase/eval/metrics-eval.js --layer ①-bianguon
```
