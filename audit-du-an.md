# 🔍 AUDIT DỰ ÁN — DAY05 · 2A202601217 · Nguyễn Văn Đại

> **Đề tài chọn:** VLearn Tutor — Trả lời có trích dẫn (AI trả lời kèm nguồn từ transcript)
> **Hướng:** A — VLearn · **Loại:** Tối ưu tính năng có sẵn
> **Thời điểm audit:** 2026-07-30 10:11

---

## 1. Tổng quan dự án

| Hạng mục | Chi tiết |
|---|---|
| **Repo** | `DAY05_2A202601217_NguyenVanDai` |
| **Đề bài** | Mini Hackathon AI — Batch 03, 1.5 ngày |
| **Đề tài** | VLearn Tutor — AI tutor trả lời câu hỏi học viên kèm trích dẫn nguồn từ transcript bài giảng |
| **6 mốc checkpoint** | CP1 (Canvas) → CP2 (Bấm được) → CP3 (AI thật) → CP4 (Chốt spec) → CP5 (Validation) → CP6 (Demo) |
| **Tổng điểm** | 100 = 25 (nộp checkpoint) + 75 (chấm bài) |

---

## 2. Data hiện có — Đánh giá

### 📂 Chatlog VLearn Tutor
- **File:** [chat_history_anonymized_for_hackathon.csv](file:///Users/phaihoang/Documents/DAY05_2A202601217_NguyenVanDai/data/vlearn-pack/chatlog/chat_history_anonymized_for_hackathon.csv)
- **Quy mô:** 2,522 dòng · 1,261 cặp hỏi-đáp (student + tutor) · 369 user · 585 hội thoại
- **Thời gian:** 22/07 → 29/07/2026

| Insight từ data | Giá trị cho đề tài |
|---|---|
| `citations` 46.2% rỗng → tutor trả lời **không có trích dẫn** gần nửa số lần | ⭐ **Pain chính** — đây là bằng chứng mạnh nhất |
| `move_used`: 85% là `review_concept`, chỉ 11.6% `give_direct_answer` | Tutor thiên về review khái niệm, ít trả lời trực tiếp |
| `rating`: chỉ 2.8% có đánh giá (33 up / 37 down) | Ít feedback → khó biết chất lượng thực |
| `misconceptions` và `follow_ups` luôn rỗng | Hệ thống chưa tận dụng 2 trường quan trọng |
| `asked_check_question`: chỉ 3/2515 `True` | Tutor gần như không bao giờ hỏi lại kiểm tra hiểu |

> [!IMPORTANT]
> **Pain cốt lõi xác nhận được từ data:** 46.2% câu trả lời tutor KHÔNG CÓ trích dẫn trang nguồn → học viên không biết kiểm chứng thông tin ở đâu, phải tự tìm lại trong tài liệu.

### 📂 Transcript bài giảng
- **6 file** transcript sạch, ~700 đoạn có mã `[Txx-NNN]`
- ~465k ký tự sạch — đủ lớn để làm context cho AI
- Có sẵn mã trích dẫn chuẩn → dễ cite nguồn

| File | Nội dung | Đoạn |
|---|---|---|
| transcript-01-clean.md | Day 2 sáng — Xác định bài toán kinh doanh cho AI | 89 |
| transcript-02-clean.md | Day 2 — Chỉ số thành công & mức tự động hoá | 43 |
| transcript-03-clean.md | Day 2 chiều — Soi bài toán + tự động hoá | 154 |
| transcript-04-clean.md | Day 1 — Foundation: cách LLM hoạt động | 98 |
| transcript-05-clean.md | Bài toán · đánh giá · dữ liệu | 154 |
| transcript-06-clean.md | Foundation: transformer & attention | 162 |

---

## 3. Trạng thái hiện tại vs. Yêu cầu checkpoint

### CP1 — Canvas (cần nộp)

| Yêu cầu CP1 | Trạng thái | Đánh giá |
|---|---|---|
| Hướng (A/B/C) | ✅ Đã chọn: Hướng A — VLearn | Đạt |
| Job executor | ⚠️ Chưa viết | **Cần làm** |
| Pain 1 câu | ⚠️ Chưa viết (nhưng có data evidence) | **Cần làm** |
| 1-2 bằng chứng đầu | ✅ Có thể trích từ chatlog (46.2% không cite) | Có sẵn data |
| Lát cắt MỘT CÂU | ⚠️ Chưa viết | **Cần làm** |
| Automation + lý do | ⚠️ Chưa viết | **Cần làm** |
| ≥3 willing users | ⚠️ Chưa có | **Cần thu thập** |
| Phân công có tên | ⚠️ Chưa có | **Cần làm** |

### Các file chưa tạo

| File cần tạo | Deadline | Trạng thái |
|---|---|---|
| Canvas CP1 | CP1 | ❌ Chưa có |
| `spec.md` | 23:59 N1 | ❌ Chưa có |
| `codebase/` | CP2-CP3 | ❌ Chưa có |
| `eval/` | CP3 | ❌ Chưa có |
| `validation/` | CP5 | ❌ Chưa có |
| `reflection/` | CP6 | ❌ Chưa có |

---

## 4. Phân tích SWOT cho đề tài đã chọn

| | Thuận lợi | Bất lợi |
|---|---|---|
| **Nội tại** | ✅ Data chatlog có sẵn bằng chứng rõ (46.2% no-cite) · ✅ Transcript có mã đoạn `[Txx-NNN]` sẵn sàng cite · ✅ Flow rõ ràng, dễ demo trong 5 phút | ⚠️ Transcript ~465k chars — cần chunking/RAG · ⚠️ Cần xử lý case transcript không chứa câu trả lời |
| **Bên ngoài** | ✅ Gemini API free tier 1,500 req/ngày · ✅ Học viên là user thật, dễ khảo sát · ✅ Hệ thống VLearn đã có sẵn → đề xuất cải thiện dễ thuyết phục | ⚠️ Giới hạn context window cho 6 transcript · ⚠️ Cạnh tranh với các nhóm khác cùng hướng A |

---

## 5. Rủi ro cần lưu ý

> [!WARNING]
> 1. **Transcript quá dài** (~465k chars) → không đưa hết vào 1 prompt → cần RAG hoặc chọn transcript phù hợp
> 2. **AI bịa citation** → cần verify mã đoạn trả về có tồn tại thật trong transcript
> 3. **Câu hỏi ngoài phạm vi transcript** → cần hành vi từ chối rõ ràng, không đoán
> 4. **Chưa có willing users** → cần thu thập sớm, ảnh hưởng R6 (8 điểm)

---

## 6. Kết luận audit

> [!TIP]
> Đề tài **VLearn Tutor — Trả lời có trích dẫn** là lựa chọn **mạnh** vì:
> - Pain có **bằng chứng đếm được** từ data (46.2% no-cite) — đạt chuẩn Evidence B
> - Transcript có **mã đoạn sẵn** → dễ implement cite
> - Flow đơn giản: hỏi → AI trả lời + cite `[Txx-NNN]` → học viên click xem nguồn
> - **Khả thi** trong thời gian hackathon

**Cần hành động ngay:** Viết Canvas CP1 (7 dòng) để nộp checkpoint.
