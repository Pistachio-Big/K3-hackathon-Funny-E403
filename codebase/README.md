# Codebase — VLearn Tutor (CP2 · Mock)

> **Mốc:** CP2 — Show được thứ bấm được
> **Mức prototype:** **Mock** (Sketch/Mock/Working — chọn Mock cho CP2)
> **Phần nào mock, phần nào thật:**
> - ✅ **Mock:** toàn bộ "AI" — dùng bảng mock trả lời sẵn (5-6 câu hỏi mẫu)
> - ✅ **Thật:** flow bấm click xem đoạn gốc (dẫn tới anchor `[Txx-NNN]` đã mở sẵn trong mock-transcripts.html)
> - ❌ **Chưa có:** lời gọi AI thật → việc của CP3 (sẽ gắn Gemini API + RAG trên transcript).

## Cách chạy

Mở `index.html` trong trình duyệt (click đúp chuột hoặc kéo thả vào Chrome/Safari). Không cần cài đặt gì, không cần server.

```
open index.html         # macOS
xdg-open index.html     # Linux
start index.html        # Windows
```

## Cấu trúc

```
codebase/
├── README.md              # file này
├── index.html             # App chính — mock tutor
├── mock-transcripts.html  # "Tài liệu" transcript (mở khi click citation)
├── app.js                 # Logic JS: hiển thị + click citation
└── data.js                # Bảng mock Q&A + snippets trích dẫn
```

## Flow demo 60 giây cho TA ở CP2

1. Mở `index.html` → thấy ô "Hỏi AI tutor về bài giảng" + 3 câu gợi ý.
2. Click một trong 3 câu gợi ý (hoặc gõ câu khác) → bấm **Hỏi tutor**.
3. Sau ~600ms (giả lập AI nghĩ), hiện:
   - Câu trả lời có đoạn **"Theo đoạn `[T01-XXX]`, giảng viên nói ..."**
   - Bên dưới: nút citation dạng chip — click được.
4. Click chip citation `[T01-002]` → mở `mock-transcripts.html` và **scroll thẳng tới đoạn đó**, highlight vàng.
5. Quay lại `index.html` → ô "Không tìm thấy trong tài liệu?" hiện sẵn — click để xem **Failure path (lớp ①)**: tutor trả lời *thẳng thắn* "Mình không tìm thấy nội dung này trong transcript. Bạn nên hỏi giảng viên hoặc vào tài liệu trực tiếp."

## Khác với CP3 (sẽ làm)

| | CP2 (hiện tại) | CP3 (kế tiếp) |
|---|---|---|
| AI | Mock bảng | Gemini API + RAG trên transcript thật |
| Trả lời | 5-6 câu mẫu cứng | Sinh động theo context |
| Citation | Snippet cứng trong `data.js` | Trích từ kết quả RAG, phải verify mã đoạn có thật |
| Hallucination | Không có (mock) | Phải test, có thể bịa mã `[Txx-999]` |

## Trạng thái rubric

- ✅ Flow chính bấm đi hết được (đáp ứng yêu cầu CP2)
- ✅ Repo có commit (artifact cho CP2)
- ✅ Đủ 4 đường đi của trải nghiệm: happy path · low-confidence (sẽ có ở CP3) · failure/không-căn-cứ (đã có) · correction (user sửa câu hỏi)
- ✅ 1 lời gọi AI thật: **CHƯA** — sẽ có ở CP3, gắn Gemini API.
