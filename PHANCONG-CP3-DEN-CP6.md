# Phân công CP3 → CP6 — VLearn Tutor

> **Nhóm 3 người** — ghi theo vai, bạn tự thay tên thật khi có thông tin.
> Nguyên tắc vibe-coding rule: ai cũng phải giải thích được phần có tên mình tại CP5/CP6.

| Vai | Tên (chờ cập nhật) | Mã HV (chờ cập nhật) |
|---|---|---|
| **Người 1** | _(bổ sung)_ | _(bổ sung)_ |
| **Người 2** | _(bổ sung)_ | _(bổ sung)_ |
| **Người 3** | _(bổ sung)_ | _(bổ sung)_ |

---

## Tổng quan 3 vai

| | Người 1 — **Builder** | Người 2 — **Evaluator** | Người 3 — **Spec & Storyteller** |
|---|---|---|---|
| **Mảng chính** | Code + AI call + RAG | Golden set + chạy số + phân tích | Spec + changelog + slide + validation |
| **Mức độ tương tác** | Tay nghề (technical) | Phân tích (analytical) | Giao tiếp (writing/staging) |
| **"Điểm chết" của người này** | AI hallucinate mã đoạn, chip link chết | Số liệu bị chỉnh, hoặc bảng % bị ẩn | Slide 3' quá sơ, hoặc spec §5 không map 4 lớp |
| **Tại CP5 bị hỏi** | "RAG chạy thế nào, mã đoạn verify ra sao?" | "Chất lượng đo bằng gì, bar bao nhiêu?" | "Tại sao chọn hướng này, failure là gì?" |

---

## CP3 · AI thật + đo lượt đầu (K3: 16:00 N1 / K4: 10:30 N2)

> **Yêu cầu rubric:** ≥1 lời gọi AI thật ở quyết định trung tâm + golden set ≥20 + bảng kết quả lượt 1 có %

### Người 1 — Builder

| # | Việc | Output | Giờ ước |
|---|---|---|---|
| 1.1 | Setup Gemini API key (biến môi trường, không commit) | `.env.example` + `ai.js` wrapper | 20' |
| 1.2 | Chunk 6 transcript theo `[Txx-NNN]` (regex đơn giản), lưu `eval/chunks.json` | file JSON ~700 đoạn | 30' |
| 1.3 | Embed chunks + cosine top-k=5, lưu `eval/embeddings.json` (chạy 1 lần) | file JSON | 30' |
| 1.4 | Hàm `askTutor(question)` → trả `{answer, citations:[Txx-NNN]}` qua Gemini prompt | log trace trong `eval/traces/` | 60' |
| 1.5 | **Verifier chống hallucination mã đoạn:** trước khi render chip, kiểm tra mã `[Txx-NNN]` có thật trong chunks. Không có → fail-safe "không tìm thấy". | hàm `verifyCitation()` | 30' |
| 1.6 | Ghép vào `index.html` (thay `data.js`) — UI cho phép toggle **Mock ↔ AI thật** | updated `app.js` | 30' |

**Tổng Người 1: ~3.5h**

### Người 2 — Evaluator

| # | Việc | Output | Giờ ước |
|---|---|---|---|
| 2.1 | Chạy tay 10-15 câu hỏi từ chatlog thật → gom nhóm lỗi đặt tên (bịa nguồn / lạc trình độ / cite sai / đoán khi thiếu info) | ghi chú cá nhân | 30' |
| 2.2 | Xây golden set ≥20 case: ≥2 case/lớp × 4 lớp + 8-10 case thường + 2-4 case hiếm; ≥10 case từ chatlog thật (trích mã `Cxxxx`) | `eval/golden-set.jsonl` | 90' |
| 2.3 | Benchmark tay 5 case → đối chiếu 2 người chấm → refine định nghĩa chiều chất lượng | ghi chú định nghĩa | 30' |
| 2.4 | Chạy `promptfoo` (hoặc script tự viết) golden set → bảng CSV `% đạt từng chiều` | `eval/run-1.csv` | 30' |

**Tổng Người 2: ~3h**

### Người 3 — Spec & Storyteller

| # | Việc | Output | Giờ ước |
|---|---|---|---|
| 3.1 | Viết `spec.md` §1 §2 (user & job + impact) — dùng số từ canvas + audit đã có | `spec.md` §1-§2 | 45' |
| 3.2 | Viết `spec.md` §5 (4 lớp chỗ khó + ≥8 kịch bản) — mapping từng lớp từ guide §2.5 | `spec.md` §5 | 60' |
| 3.3 | Tổng hợp bảng kết quả lượt 1 → 1 dòng % + 1 failure đáng kể nhất (nhận từ Người 2) | ghi chú | 20' |

**Tổng Người 3: ~2h**

### Cả 3 người cùng làm (CP3)

- **Review chéo** trước khi show TA: Người 1 demo live app → Người 2 đọc bảng kết quả → Người 3 kiểm tra §5 khớp 4 lớp

---

## CP4 · Chốt tiến độ + spec nộp hạn cứng **23:59 N1**

> **Yêu cầu rubric:** Evidence chuẩn A/B có log · bảng impact + ứng viên đã loại · 4 lớp cụ thể · ≥4 nguyên tắc có vị trí áp dụng · quality bar bằng **số** (chốt từ thời điểm này, KHÔNG đổi sau)

### Người 1 — Builder

| # | Việc | Output | Giờ ước |
|---|---|---|---|
| 1.7 | Từ prototype, xác định **4 nguyên tắc HAX/PAIR** đang áp vào **đâu cụ thể** (vd: G2 "Làm rõ làm tốt đến đâu" → chip citation + verifier; G10 "Thu hẹp phạm vi khi nghi ngờ" → fail-safe `MOCK_NOT_FOUND`) | bảng 4 nguyên tắc × vị trí | 30' |

### Người 2 — Evaluator

| # | Việc | Output | Giờ ước |
|---|---|---|---|
| 2.5 | Định nghĩa **3 chiều chất lượng** (vd: có-căn-cứ / đúng-cỡ-đúng-giọng / an-toàn) bằng pass/fail hoặc 1-5 có mô tả | ghi chú | 30' |
| 2.6 | **Chốt quality bar** bằng con số: "Đạt khi ≥ __% qua bộ, VÀ ___(điều kiện cứng, vd: 0% case bịa mã đoạn)" | 1 câu trong spec §7 | 15' |
| 2.7 | Tổng hợp nhật ký kịch bản hiếm từ lượt 1 → bổ sung vào golden set (nếu <20 case) | updated `eval/golden-set.jsonl` | 30' |

### Người 3 — Spec & Storyteller

| # | Việc | Output | Giờ ước |
|---|---|---|---|
| 3.4 | Hoàn thiện `spec.md` §3 §4 §6 §7 §8 (giải pháp tương tự · lát cắt · 4 đường đi · kiểm thử · phân công) | `spec.md` đầy đủ | 90' |
| 3.5 | Commit `spec.md` **trước 23:59 N1** (hard deadline) | git log | 5' |
| 3.6 | Cập nhật README.md — phân công có tên (thay "Bổ sung tên" ở canvas) | README.md | 15' |

**Checkpoint ngược:** chất lượng 3 file tại 23:59 quyết định 50% điểm R4.

---

## CP5 · Xác minh + validation + dry run (K3: 09:00 N2 / K4: 14:00 N2)

> **Yêu cầu rubric:** Feedback log ≥5 mẩu có tên · changelog có thay đổi từ feedback (hoặc giữ nguyên có lý do) · slide final + demo script · dry run xong

### Người 1 — Builder

| # | Việc | Output | Giờ ước |
|---|---|---|---|
| 1.8 | Tổng hợp feedback kỹ thuật từ người dùng thử → fix hoặc ghi nhận "không sửa vì..." | commit fix (nếu có) | 45' |
| 1.9 | Chuẩn bị backup demo (screenshot + video 30s) phòng live hỗng | `codebase/backup/` | 20' |

### Người 2 — Evaluator

| # | Việc | Output | Giờ ước |
|---|---|---|---|
| 2.8 | Chạy lại golden set sau khi có fix → bảng lượt 2 + so với lượt 1 | `eval/run-2.csv` | 30' |
| 2.9 | Phân tích 1 failure đáng kể nhất còn lại (slide 4) | 1 đoạn văn + 1 bảng | 20' |

### Người 3 — Spec & Storyteller

| # | Việc | Output | Giờ ước |
|---|---|---|---|
| 3.7 | Điều phối phiên validation 10'/người × 5 người (đã có sẵn từ form). 3 câu hỏi: "Khó hiểu/khó chịu nhất?" / "Có tin không — vì sao?" / "Có dùng thật không?" | `validation/feedback-log.md` | 90' |
| 3.8 | Changelog `spec.md` §9 theo feedback | spec §9 | 30' |
| 3.9 | Slide 6 trang (theo guide §5.1) — **mỗi slide phải có ≥1 số / quote có nguồn** | `demo-slides.pdf` | 90' |
| 3.10 | Demo script 5' + phân công nói: Mỗi người nói ≥1 phần (Người 1: demo live · Người 2: kết quả · Người 3: context + story) | `codebase/demo-script.md` | 30' |
| 3.11 | Dry run xong, bấm giờ, sửa nếu vượt 5' | ghi chú | 30' |

**Checkpoint ngược:** Tại CP5, TA chọn ngẫu nhiên 1 người hỏi "phần bạn làm hoạt động thế nào?" — vibe-coding rule 0 điểm.

---

## CP6 · Demo (K3: 10:00 N2 / K4: 15:00 N2)

> **Yêu cầu rubric:** 5' trình bày (slide 6 trang, có case lỗi live + % vs bar) + 5' Q&A. Thẻ giám khảo chạy 1 case lạ tại chỗ. Mỗi thành viên nói ≥1 phần.

### Phân công trình bày 5 phút

| Thời lượng | Người nói | Nội dung |
|---|---|---|
| 0:00–0:45 | **Người 3** | Slide 1 (User & Job) + Slide 2 (Vì sao chọn) |
| 0:45–2:45 | **Người 1** | Slide 3 (Giải pháp + demo live: 1 happy + 1 failure) |
| 2:45–3:30 | **Người 2** | Slide 4 (Kết quả đo: % vs bar + 1 failure đáng kể) |
| 3:30–4:15 | **Người 3** | Slide 5 (User thật nói gì, ≥2 quote nguyên văn) + Slide 6 (Nếu có thêm 1 tuần) |
| 4:15–5:00 | **Cả 3** | Dự phòng cho câu hỏi interrupt |

**Vai trò Q&A 5':**
- **Người 1** đỡ câu kỹ thuật (RAG, citation, hallucination)
- **Người 2** đỡ câu đo lường (golden set, bar, số liệu)
- **Người 3** đỡ câu context (vì sao chọn, user, validation)

### Người 1 — Builder

| # | Việc | Output |
|---|---|---|
| 1.10 | Live demo 1 case chuẩn + 1 case failure (lớp ①) | live |
| 1.11 | Dự phòng: nếu live hỏng, có backup video 30s | ready |

### Người 2 — Evaluator

| # | Việc | Output |
|---|---|---|
| 2.10 | Đọc slide 4 — % đạt quality bar + 1 failure đáng kể | live |
| 2.11 | Dự phòng trả lời "bar bao nhiêu, sao chốt vậy" | ready |

### Người 3 — Spec & Storyteller

| # | Việc | Output |
|---|---|---|
| 3.12 | Điều phối nhịp 5', canh giờ | live |
| 3.13 | Phát form feedback (nếu có) sau demo | — |

---

## Ma trận deliverable × người (tổng hợp)

| Deliverable | CP | Người 1 | Người 2 | Người 3 |
|---|:---:|:---:|:---:|:---:|
| `codebase/app.js` (AI thật) | CP3 | ✍️ | | |
| `eval/chunks.json` + `embeddings.json` | CP3 | ✍️ | | |
| `eval/golden-set.jsonl` ≥20 | CP3 | | ✍️ | |
| `eval/run-1.csv` (lượt 1) | CP3 | | ✍️ | |
| `spec.md` §1, §2, §5 | CP3 | | | ✍️ |
| `spec.md` §3, §4, §6, §7, §8 | CP4 | | ✍️ (chiều chất lượng, bar) | ✍️ |
| Bảng 4 nguyên tắc HAX × vị trí | CP4 | ✍️ | | |
| `spec.md` chốt 23:59 N1 | CP4 | | | ✍️ commit |
| `validation/feedback-log.md` ≥5 | CP5 | | | ✍️ |
| `evaluation/run-2.csv` | CP5 | | ✍️ | |
| `eval/not-fixing.md` (giữ nguyên có lý do) | CP5 | ✍️ | | ✍️ |
| `demo-slides.pdf` 6 trang | CP5 | | | ✍️ |
| `codebase/demo-script.md` | CP5 | | | ✍️ |
| `codebase/backup/` (video/screenshot) | CP5 | ✍️ | | |
| `reflection/` (mỗi người 1 file) | CP6 | ✍️ | ✍️ | ✍️ |
| Live demo + đỡ câu hỏi | CP6 | ✍️ | ✍️ | ✍️ |

---

## Cảnh báo & rủi ro

| Rủi ro | Người chịu | Giảm thiểu |
|---|---|---|
| Người 1 miss G/RAG → app vỡ giữa chừng | Người 1 | Verify bằng 3 case tay trước khi gắn UI |
| Người 2 chấm cảm tính → số liệu bị TA bắt | Người 2 | 2 người chấm độc lập 5 case đầu |
| Người 3 viết spec §5 chung chung → mất điểm R3 | Người 3 | Mỗi kịch bản 1 dòng, có lớp + hành vi mong muốn |
| AI thật ở CP3 hallucinate mã đoạn (vd: `[T01-999]`) | Người 1 | **Verifier chống hallucination** — bắt buộc từ lần code đầu |
| Free tier Gemini hết quota giữa chừng | Người 1 | Cache embedding; fallback về mock nếu quá 5 lỗi liên tiếp |
| Chạm data pack thật bị ghi nhận vi phạm bảo mật | Cả 3 | Repo public không chứa data pack; chỉ mã đoạn ngắn |

---

## Quy tắc làm việc nhóm

1. **Daily stand-up 5'** đầu mỗi phiên: mỗi người nói 1 câu — hôm qua xong gì, hôm nay làm gì, kẹt gì.
2. **Commit nhỏ, commit thường xuyên** — không merge 1 đống ở cuối ngày.
3. **Mọi output trước khi merge** phải có 1 người khác review. Nhánh: `cp3-{người}-{mô tả ngắn}`.
4. **Spec chốt 23:59 N1 là HARD deadline** — đổi quality bar sau thời điểm đó = mất điểm R4 (3 điểm).
5. **Không commit API key** — để local `.env`, dùng biến môi trường.

---

## Bước tiếp theo (ngay bây giờ)

1. **Người 3** → viết `spec.md` §1, §2, §5 (file mới) — không cần đợi CP3.
2. **Người 1** → setup `ai.js` wrapper + chunk 6 transcript (chạy 1 lần, lưu JSON).
3. **Người 2** → chạy tay 5 câu từ chatlog thật, gom nhóm lỗi dựa trên output Gemini raw → đặt tên lỗi.
4. Sau khi cả 3 xong phần mình → review chéo 30' → vào CP3 demo TA.
