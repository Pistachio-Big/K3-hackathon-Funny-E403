# Codebase — VLearn Tutor (CP3 · AI thật + RAG)

> **Mốc:** CP3 — AI chạy thật + đo lượt đầu
> **Mức prototype:** **Working** (1 lời gọi AI thật ở quyết định trung tâm)
> **Stack:** Node 20 (zero-dep) + Qdrant Vector DB + Gemini embed + Gemini generate

## Cấu trúc

```
codebase/
├── README.md              ← file này
├── Dockerfile             ← build app image
├── .dockerignore
├── entrypoint.sh          ← auto-ingest + start server
├── server.js              ← HTTP server (UI + /api/ask + /api/retrieve)
├── index.html             ← UI chính
├── app.js                 ← Frontend logic (Mock ↔ AI toggle)
├── rag-browser.js         ← Browser client (gọi /api/ask, không giữ key)
├── data.js                ← Mock data cho CP2 (vẫn dùng được ở mode Mock)
├── mock-transcripts.html  ← Transcript page (click citation)
├── code.js                ← Mock data + entrypoint
└── eval/
    ├── loadenv.js         ← Load GEMINI_API_KEY từ .env
    ├── chunker.js         ← Tách transcript + chatlog → chunks.json
    ├── chatlog_chunker.js ← Index chatlog thành Q/A chunks
    ├── qdrant.js          ← Qdrant REST client (zero-dep)
    ├── ingest.js          ← Embed + upsert toàn bộ chunks vào Qdrant
    ├── rag.js             ← Core RAG pipeline (retrieve + generate + verify)
    ├── chunks.json        ← 2,192 chunks (700 transcript + 1,492 chatlog)
    ├── qdrant-cache.json  ← Cache embeddings (bypass khi restart)
    ├── embeddings.json    ← Legacy fallback (chỉ dùng khi không có Qdrant)
    ├── chatlog-chunks.json
    └── traces/            ← Log mỗi lần askTutor (1 JSON/turn)
```

## Phần mock vs phần thật

| | Mock (CP2) | AI thật (CP3) |
|---|---|---|
| **Answer** | Bảng cứng trong `data.js` | Gemini `gemini-3-flash` sinh |
| **Retrieval** | Keyword match | Gemini `text-embedding-004` cosine trong Qdrant |
| **Citation** | Hardcoded trong mock | RAG tự sinh, **verifier** strip mã bịa |
| **Hallucination** | Không có | Test bằng 20+ golden case (rubric §7) |

## Cách chạy (Docker — recommended)

### 1. Chuẩn bị

```bash
# Sao chép env mẫu
cp .env.example .env
# Điền GEMINI_API_KEY vào .env (lấy từ https://aistudio.google.com/apikey)
```

### 2. Khởi động stack

```bash
docker compose up -d
# - app:  http://localhost:3000
# - qdrant REST:  http://localhost:6333
# - qdrant dashboard:  http://localhost:6333/dashboard
```

`entrypoint.sh` tự động:
1. Đợi Qdrant healthy
2. Kiểm tra collection — nếu rỗng → chạy `ingest.js` (embed 2,192 chunks)
3. Khởi động server

### 3. Mở UI

```
http://localhost:3000
```

Toggle **Mock ↔ AI thật** ở góc trên header. AI thật dùng RAG retrieval từ Qdrant.

## Cách chạy (không Docker — dev mode)

```bash
# 1. Cài Qdrant riêng
docker run -d -p 6333:6333 -p 6334:6334 \
  -v $(pwd)/qdrant_storage:/qdrant/storage \
  qdrant/qdrant:v1.12.0

# 2. Điền key
cp codebase/eval/.env.example codebase/eval/.env
# Sửa GEMINI_API_KEY

# 3. Ingest
node codebase/eval/ingest.js

# 4. Chạy server
node codebase/server.js
```

## Pipeline RAG (chi tiết kỹ thuật)

```
[User question]
     │
     ▼
[Query Analyzer]  ← skip (chỉ 1 loại query: hỏi về tài liệu)
     │
     ▼
[Retriever]       ← Qdrant cosine top-5 (Gemini embed)
     │
     ▼
[Verifier #1]     ← threshold check: top-1 < 0.5 → fail-safe
     │
     ▼
[Prompt builder]  ← ghép context + question + 4 quy tắc cite
     │
     ▼
[Gemini generate] ← gemini-3-flash, temperature 0.2
     │
     ▼
[Verifier #2]     ← regex match [Txx-NNN] / [Cxxxx-Tyyyy-K]
                    Chỉ giữ mã có thật → strip mã bịa bằng [⚠xxx?]
     │
     ▼
[Fail-safe #2]    ← nếu 0 citation hợp lệ → MOCK_NOT_FOUND
     │
     ▼
[Final answer + citations + snippets]
```

## 4 lớp chỗ khó (taxonomy)

| Lớp | Cách xử lý |
|---|---|
| ① Nguồn sự thật | Verifier strip mã bịa + fail-safe khi 0 citation |
| ② Mơ hồ / thiếu | Threshold check (top-1 score < 0.5/0.75 → fail) |
| ③ Ngoài phạm vi | Threshold check + retrieval từ corpus giới hạn |
| ④ Đặc thù domain | "Tự verify" trace log để audit thủ công |

## Phạm vi & giới hạn

- **Không commit API key** — dùng `.env` (đã `.gitignore`)
- **Không commit data pack** — dùng mount volume khi dev; production thì ingest trong build
- **Câu trả lời KHÔNG dùng chatlog text** — chỉ dùng chatlog làm ngữ cảnh retrieval, citation luôn từ transcript
- **Citation `[Cxxxx]`** — chỉ hiển thị chip, không snippet text (bảo mật dữ liệu học viên)

## Test nhanh

```bash
# Test pipeline CLI (không cần UI)
node codebase/eval/rag.js "Làm sao xác định bài toán từ đề bài mơ hồ"

# Test failure path
node codebase/eval/rag.js "Công thức nấu phở bò"

# Test verifier
node -e "const {verifyAnswer} = require('./codebase/eval/rag.js'); console.log(verifyAnswer('Theo [T01-001] và [T99-999]', ['T01-001']))"
```

## Phân công maintain

- **Người 1 (Builder)** — toàn bộ codebase/, đặc biệt rag.js, qdrant.js, server.js
- **Người 2 (Evaluator)** — golden set, benchmark, đo quality bar
- **Người 3 (Spec)** — spec.md, changelog, slide