# Hoàng Văn Phái — Reflection
Role: Builder

Tóm tắt những gì đã làm:
- Thiết kế và triển khai prototype trong thư mục `codebase/` (server.js, app.js, rag-browser.js, eval scripts).
- Thực hiện prompt engineering và tạo/điều chỉnh pipeline RAG: `codebase/rag-browser.js`, `codebase/eval/rag.js`, `codebase/eval/embedder.js`.
- Tạo script ingest và upsert embeddings (`codebase/eval/ingest.js`, `ingest-embeddings.js`) và benchmark/evaluator scripts (`evaluator.js`, `benchmark.js`).
- Chuẩn bị cấu hình Dockerfile và môi trường dev (`codebase/Dockerfile`, `.env.example`).

Files chính làm việc:
- `codebase/server.js`, `codebase/app.js`, `codebase/rag-browser.js`
- `codebase/eval/*` (ingest, embedder, evaluator, golden-set traces)
- `spec.md` (§8) — thực thi phần “Code / Prototype” và góp ý phần prompt/golden-set

Bài học và ghi nhận:
- Việc tách rõ local index vs external lookup giúp giảm rủi ro hallucination.
- Cần thêm test automation để validate provenance field trên mỗi response.

Next steps (đề xuất):
- Hoàn thiện integration giữa frontend mock (index.html) và backend RAG để demo luồng "select text → cite".
- Hợp nhất config và scripts để chạy `eval/run-1.csv` tự động (CI script nhỏ).

---
*Hoàng Văn Phái — 2A202601575*