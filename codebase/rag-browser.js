// ============================================================
// rag-browser.js — Browser-side client (gọi /api/ask, không lộ key)
// ============================================================
//
// Tương đương codebase/eval/rag.js nhưng dùng cho UI:
//   - KHÔNG gọi Gemini API trực tiếp (key giấu trên server)
//   - Load corpus client-side từ eval/chunks.json (CHỈ metadata public)
//   - Gửi question + top retrieved codes → server proxy generateAnswer
//
// Lưu ý bảo mật: browser không truy cập được .env. Server load key qua codebase/server.js.
//
// PUBLIC:
//   window.RagBrowser = {
//     loadCorpus(),
//     retrieve(query),          // tự embed + cosine trong browser
//     askTutor(question),       // full pipeline qua /api/ask
//   }
// ============================================================

(function () {
  const CORPUS_URL = "eval/chunks.json";
  const TOP_K = 5;
  // Server có thể gọi trực tiếp Gemini → chất lượng embed cao.
  // Browser KHÔNG embed; server làm thay.

  let chunks = [];
  let codeToChunkMap = new Map();
  let loaded = false;

  async function loadCorpus() {
    if (loaded) return chunks.length;
    const r = await fetch(CORPUS_URL);
    if (!r.ok) throw new Error(`Không load được ${CORPUS_URL}: HTTP ${r.status}`);
    chunks = await r.json();
    for (const c of chunks) codeToChunkMap.set(c.code, c);
    loaded = true;
    return chunks.length;
  }

  async function retrieve(query) {
    // Browser retrieve: gọi server /api/retrieve để dùng Gemini embed (giấu key)
    const r = await fetch("/api/retrieve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: query, topK: TOP_K }),
    });
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`retrieve HTTP ${r.status}: ${t.slice(0, 200)}`);
    }
    const j = await r.json();
    return j.retrieved; // [{code, score}]
  }

  async function askTutor(question) {
    // 1. Retrieve: server embed + cosine
    const top = await retrieve(question);
    const allowedCodes = top.map((t) => t.code);

    // 2. Generate: server gọi Gemini để sinh câu trả lời (server cũng chạy verifier)
    const r = await fetch("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, top: allowedCodes }),
    });
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`ask HTTP ${r.status}: ${t.slice(0, 200)}`);
    }
    const result = await r.json();

    // 3. Snippet cho UI — chỉ trả text nếu là transcript
    if (result.citations && result.citations.length) {
      result.snippets = result.citations.map((code) => {
        const ch = codeToChunkMap.get(code);
        return {
          code,
          source: ch?.source || "unknown",
          text:
            ch?.source === "transcript"
              ? ch.text || ""
              : ch?.source === "web"
              ? code // For web sources, code is the ID
              : "[trích từ hội thoại học viên — xem mã]",
        };
      });
    }

    // 4. Handle research info
    if (result.researchInfo && result.researchInfo.used) {
      result.webSources = result.researchInfo.sources;
    }

    return result;
  }

  window.RagBrowser = {
    loadCorpus,
    retrieve,
    askTutor,
    // Direct research access
    async research(question, topChunks, forceResearch = false) {
      const r = await fetch("/api/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, topChunks, forceResearch }),
      });
      if (!r.ok) {
        const t = await r.text();
        throw new Error(`research HTTP ${r.status}: ${t.slice(0, 200)}`);
      }
      return await r.json();
    }
  };
})();