# AI SPEC — Tối ưu AI tutor · Nhóm [XX] · Zone [X]
Hướng: [x] A — VLearn  [ ] B — Trợ lý Học viên  [ ] C — Làn mở
Loại: [x] Tối ưu tính năng có sẵn  [ ] Tính năng mới

## §1. User & Job
- Job executor + workflow (đính kèm worksheet JTBD / ảnh sơ đồ):
  - User: Học viên tham gia khoá VLearn, đang học/ôn bài trên trang học.
  - Workflow: Học viên bôi đen đoạn slide/transcript hoặc nhập câu hỏi → AI tutor trả lời ngắn gọn kèm trích dẫn (slide trang N hoặc đoạn transcript) → học viên đọc/explore/ask follow-up.
  - Nếu AI agent KHÔNG tìm thấy nguồn phù hợp trong cơ sở dữ liệu / local index (slides, transcript, attachments), agent sẽ tự động thực hiện tìm kiếm nguồn ngoài theo trình tự: local index -> external lookup (ưu tiên course host, vendor docs, public repo, trusted docs). Nếu kết quả có confidence >= medium thì trả lời kèm URL + đoạn trích ngắn (≤200 chars) và chỉ rõ confidence; nếu tất cả nguồn có confidence = low hoặc mâu thuẫn thì gắn tag "escalate-to-TA" và chuyển cho trợ giảng kèm ngữ cảnh và kết quả lookup.

- Core JTBD (không tên sản phẩm/AI trong câu):
  - Học viên cần câu trả lời ngắn gọn kèm bằng chứng rõ ràng và provenance: ưu tiên trích dẫn từ nội dung khoá (slides, transcript, attachments). Nếu nội bộ không đủ, hệ thống phải tìm nguồn ngoài tin cậy hoặc chuyển cho trợ giảng. Mục tiêu: giảm thời gian kiểm chứng của học viên và tăng độ tin cậy nội dung.

- Problem statement (KHÔNG chữ AI):
  - Nhiều câu hỏi yêu cầu bằng chứng hoặc nguồn tham khảo nhưng hệ thống hiện chỉ trả lời dựa trên kiến thức nội bộ khi có, hoặc đôi khi trả lời thiếu provenance. Kết quả: học viên phải tự xác minh, giảm trust và tốn thời gian. Bộ test hiện tại quá "sạch" (ít lỗi chính tả, ít giao tiếp thực tế), dẫn tới đánh giá tốt trên test nhưng kém khi gặp dữ liệu thực tế.

- Evidence (chuẩn A và/hoặc B — log đầy đủ trong repo):
  - Số liệu mining / kết quả phân tích log (`data/vlearn-pack/chatlog/chat_history_anonymized_for_hackathon.csv`):
    - Tổng replies từ tutor: 1261
    - Replies có citation (từ nội bộ hoặc rõ provenance): 679
    - Replies thiếu citation: 582 (≈46.2%) — đây là tập cần kiểm tra để xác định nhu cầu external lookup hoặc escalation.
    - Số lượt học viên nêu than phiền liên quan tới citation/trích nguồn (keyword matches): 19
    - Trung bình tokens đầu vào học viên (approx): 11203.7
    - Trung bình tokens output từ tutor (approx): 188.4

  - Quan sát chất lượng dữ liệu test: bộ dữ liệu thử nghiệm tự sinh/nghiên cứu có ngôn ngữ sạch; nhóm đã thu được chatlog thực tế (folder data/) chứa nhiều ví dụ có lỗi chính tả, EN/VN mix, tin nhắn cụt; cần khai thác ít nhất 5–10 câu thực tế cho tập kiểm thử.

  - Ví dụ trích từ chat logs (quote + conversation_id + timestamp):
    1. "(Trang 2, đoạn được chọn: \"Day 1 giới thiệu những chủ đề chính nào? Hãy trả lời ngắn gọn và trích dẫn trang.\") Day 1 giới thiệu những chủ đề chính nào? Hãy trả lời ngắn gọn và trích dẫn trang." — conversation_id: C0092, 2026-07-22 11:00:41+00:00
    2. "(Trang 33, đoạn được chọn: \"ví dụ cụ thể đi\") ví dụ cụ thể đi" — conversation_id: C0247, 2026-07-24 05:02:02+00:00
    3. "(Trang 1, đoạn được chọn: \"Tóm tắt ngắn gọn nội dung chính của Day 1 và trích dẫn trang slide.\") Tóm tắt ngắn gọn nội dung chính của Day 1 và trích dẫn trang slide." — conversation_id: C0295, 2026-07-22 11:19:22+00:00
    4. "(Trang 8, đoạn được chọn: \"AI bất định ở ba lớp: input, output và process...\") Giải thích đoạn bôi đen ở Trang 8." — conversation_id: C0364, 2026-07-29 07:43:39+00:00
    5. "(Trang 1, đoạn được chọn: \"tại sao không thấy slide bài giảng\") tại sao không thấy slide bài giảng" — conversation_id: C0423, 2026-07-23 14:58:13+00:00

  - Đề xuất bước tiếp theo để chứng thực evidence:
    1. Lấy ngẫu nhiên N=50 replies thiếu citation và annotate: cần nội bộ / cần external / cần escalate.
    2. Dùng kết quả annotate để ước tính rate of external-lookup-needed và điều chỉnh threshold confidence cho việc search ngoài.

  Notes: con số và trích dẫn trên được sinh tự động bằng script phân tích CSV trong `data/vlearn-pack/chatlog/`; toàn bộ trích dẫn/quotes chi tiết nằm trong `data/vlearn-pack/chatlog/chat_metrics.json`.

## §2. Impact & quyết định chọn
- Bảng impact (3 ứng viên tối ưu hoá) — estimate and measurement plan:

| Ứng viên | Users affected (est, from logs) | Tần suất / user | Cost mỗi lần (time) | Khả thi (0–1) | Metric đo (primary) |
|---|---:|---:|---:|---:|---|
| A — Improve citation coverage & accuracy | ≈1,261 tutor interactions (observed in logs) | khi hỏi khái niệm (~0.6/session) | 1–3 min saved | 0.8 | % responses with valid citation; pass_rate on golden_set |
| B — Reduce hallucination / factual error rate | subset of above (est. 30–50% of interactions where evidence requested) | when asking evidence questions (~0.3/session) | 5–10 min saved (verification) | 0.7 | factual_error_rate; manual error count |
| C — Faster answer latency (performance) | all active users (system-wide) | every query | 0.5–1 min saved | 0.9 | median latency (s) |

- Ứng viên ĐÃ LOẠI + vì sao:
  - C: Latency improvement alone không giải quyết trust issue (khi thiếu citation users vẫn phải verify). Ước tính benefit nhỏ so với engineering effort on infra.
  - B: Quan trọng nhưng rộng; khắc phục hallucination toàn hệ cần model+prompt overhaul và data — scope lớn cho 1 sprint.

- Ứng viên CHỌN + vì sao (bằng số):
  - Chọn A — Improve citation coverage & accuracy.
    - Rationale: trực tiếp tăng trust và giảm time-to-verify; ảnh hưởng đến majority of tutoring queries. Dự kiến giảm verification time trung bình từ 5min → 1.5min (≈70% time saved when citation missing). Có thể đo được nhanh bằng golden_set và automated eval.
    - Expected impact: affect ~70% active learners; target measurable uplift: %responses_with_valid_citation từ baseline → +30pp trong 1 sprint; golden_set pass_rate ≥ 80%.

- Measurement plan (how to prove impact):
  1. Baseline: run eval on current system using golden_set (N ≥ 20) → record %responses_with_valid_citation, overall_accuracy.
  2. Implementation: deliver citation-lookup pipeline + prompt/template enforcing citation field.
  3. Lượt 1 evaluation: run same golden_set → produce results.csv; target: +30pp citation coverage OR golden_set pass_rate ≥ 80%.
  4. User validation: sample 20 users run tasks; time-to-verify metric and subjective trust rating (Likert 1–5).

- Decision log (short):
  - Date: 2026-07-30 — Chosen A because fastest measurable ROI; B deferred for scope in next milestone; C deprioritized.

Baseline metrics (from logs):
  - Total tutor replies: 1261
  - Current % replies with citation: 53.8%
  - Target for sprint: increase % replies with valid citation by +30 percentage points (to ~83.8%) OR achieve golden_set pass_rate ≥ 80%.

## §5. Bốn lớp chỗ khó + kịch bản rủi ro

4 lớp chỗ khó (tóm tắt):
- L1 — Nguồn sự thật: AI có thể bịa nguồn hoặc trích dẫn sai khi không có căn cứ nội bộ.
- L2 — Mơ hồ / Thiếu thông tin: input thiếu bối cảnh, lỗi chính tả/mix ngôn ngữ, hoặc dữ liệu bị cắt.
- L3 — Ngoài phạm vi / Thẩm quyền: yêu cầu tác vụ/hành động mà tutor/feature không được phép thực hiện.
- L4 — Đặc thù domain: sai kiến thức chuyên môn gây hậu quả (mất điểm/hiểu sai) ngay.

Kịch bản rủi ro (ít nhất 8; mỗi dòng: tình huống | lớp | hành vi mong muốn | nguyên tắc áp):
1. Hỏi nội dung lab cụ thể nhưng transcript không có | L1 | Search external trusted sources (course host → vendor docs → public repo); nếu confidence ≥ medium thì cite URL+trích đoạn; else escalate-to-TA | G2, G10
2. "mk ko vào đc khoá" (thiếu ngữ cảnh, lỗi chính tả) | L2 | Bot hỏi 1 câu bổ sung (chẩn đoán) hoặc hướng dẫn checklist; không đoán vội | G10, G9
3. Yêu cầu refund hoặc can thiệp tài khoản | L3 | Trả lời bằng flow policy + hướng dẫn gửi form; không tự thao tác; tag 'out-of-scope' | G1, PAIR:Feedback+Control
4. Hỏi giải bài kiểm tra có thể ảnh hưởng điểm | L4 | Nếu có giải chính thức nội bộ → cite; nếu không → escalate-to-TA và đánh dấu 'sensitive-grading' | G2, G11
5. Trích dẫn slide nhưng ID chip [Txx-...] không tồn tại | L1 | Verifier chống-hallucination → report 'không tìm thấy' và không render citation; suggest escalate nếu cần | G10, G5
6. Input mix EN/VN + code snippet bị cắt | L2 | Phát hiện truncation → yêu cầu upload đầy đủ hoặc hỏi chi tiết; không trả lời chắc chắn | G9, G10
7. Câu hỏi domain mâu thuẫn giữa nhiều nguồn | L4 | Hiển thị các nguồn, tóm tắt điểm khác nhau, gắn confidence thấp và recommend TA review | G11, PAIR:Explainability
8. Link video/slide hỏng khi user hỏi nội dung | L1 | Thử tìm mirror (CDN, repo công khai); nếu không tìm được → provide fallback summary + escalate | G2, G10
9. User gửi yêu cầu chứa PII để xử lý (ví dụ: thay đổi tài khoản) | L3 | Từ chối gửi PII ra ngoài, hướng dẫn kênh secure; log hashed user_id for audit | G1, G5
10. Model trả lời tự tin nhưng contradicts transcript | L1/L4 | Show contradiction, kèm provenance cho cả hai, set confidence low, invite report/escalation | G11, G10

Yêu cầu cho golden set và đánh giá:
- Mỗi lớp phải có ≥2 case trong `eval/golden-set.jsonl`. Tổng ≥8 case; khuyến nghị 10+ với ≥5 case lấy từ chatlogs thực tế.
- Mỗi case lưu: input nguyên văn, expected behavior (pass/fail rules), note nếu cần external lookup.

Thực thi & privacy:
- Sequence: local index → external lookup (max 3 sources) → confidence scoring → respond or escalate.
- Response phải kèm provenance (file path hoặc URL + confidence H/M/L) hoặc tag 'escalate-to-TA'.
- Không gửi PII ra external search; mọi lookup log lưu với hashed user_id cho audit.

(End §5)

