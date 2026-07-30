#!/usr/bin/env node
/**
 * tools.js — Tool definitions và handlers cho VLearn Tutor
 *
 * Định nghĩa các tools mà AI có thể gọi khi cần thiết:
 *   - search_web: Tìm kiếm trên Internet khi không có context local
 *   - lookup_document: Tra cứu tài liệu trong kho tri thức
 *
 * System prompt sử dụng tool calling để đảm bảo AI:
 *   1. Không bịa đặt thông tin
 *   2. Luôn kiểm tra kho tri thức trước
 *   3. Gọi web search khi cần thiết
 */

const https = require("https");
const path = require("path");
const fs = require("fs");
require("./loadenv.js"); // Load API keys

// ============== CONFIG ==============
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Load chunks for document lookup
const CHUNKS_PATH = path.resolve(__dirname, "chunks.json");
let codeToChunk = new Map();

function loadChunks() {
  try {
    const chunks = JSON.parse(fs.readFileSync(CHUNKS_PATH, "utf-8"));
    for (const c of chunks) codeToChunk.set(c.code, c);
    return chunks.length;
  } catch (e) {
    console.warn(`[tools] Cannot load chunks: ${e.message}`);
    return 0;
  }
}
loadChunks();

// ============== TOOL DEFINITIONS (for Gemini) ==============
const TOOL_DEFINITIONS = {
  tools: [
    {
      name: "search_web",
      description: "Tìm kiếm thông tin trên Internet. Dùng khi câu hỏi không có trong tài liệu khoá học hoặc cần thông tin bổ sung từ bên ngoài. Kết quả trả về gồm: tiêu đề, URL, và nội dung tóm tắt từ các trang web liên quan.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Câu truy vấn tìm kiếm. Nên ngắn gọn, tập trung vào từ khóa chính."
          }
        },
        required: ["query"]
      }
    },
    {
      name: "lookup_document",
      description: "Tra cứu nội dung cụ thể trong tài liệu bài giảng. Dùng khi bạn cần xác nhận thông tin từ tài liệu hoặc tìm thêm chi tiết về một chủ đề cụ thể. Trả về các đoạn văn bản liên quan từ transcript.",
      parameters: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            description: "Chủ đề hoặc từ khóa cần tra cứu trong tài liệu."
          }
        },
        required: ["topic"]
      }
    }
  ]
};

// ============== TOOL HANDLERS ==============

/**
 * Handler cho tool search_web
 */
async function handleSearchWeb(query) {
  console.log(`[tools] search_web called: "${query.slice(0, 60)}..."`);

  // Try Tavily first
  if (TAVILY_API_KEY) {
    try {
      const results = await searchTavily(query, 5);
      if (results.length > 0) return formatSearchResults(results);
    } catch (e) {
      console.warn(`[tools] Tavily failed: ${e.message}`);
    }
  }

  // Fallback to DuckDuckGo
  try {
    const results = await searchDuckDuckGo(query, 5);
    return formatSearchResults(results);
  } catch (e) {
    console.warn(`[tools] DuckDuckGo failed: ${e.message}`);
  }

  return {
    status: "error",
    message: "Không thể kết nối đến máy chủ tìm kiếm.",
    results: []
  };
}

async function searchTavily(query, limit) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      api_key: TAVILY_API_KEY,
      query,
      search_depth: "basic",
      max_results: limit,
      include_answer: true,
    });

    const req = https.request({
      method: "POST",
      hostname: "api.tavily.com",
      path: "/search",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        if (res.statusCode >= 400) {
          reject(new Error(`Tavily HTTP ${res.statusCode}`));
          return;
        }
        try {
          const j = JSON.parse(data);
          const results = (j.results || []).slice(0, limit).map(item => ({
            title: item.title || "",
            url: item.url || "",
            snippet: item.content || item.snippet || ""
          }));
          resolve(results);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function searchDuckDuckGo(query, limit) {
  return new Promise((resolve, reject) => {
    const encoded = encodeURIComponent(query);
    const url = `https://ddg-api.duckduckgo-stream.com/search?q=${encoded}&format=json&limit=${limit}`;

    const req = https.get(url, { timeout: 10000 }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try {
          const results = data
            .split("\n")
            .filter(line => line.trim())
            .slice(0, limit)
            .map(line => {
              try {
                const item = JSON.parse(line);
                return {
                  title: item.title || "",
                  url: item.url || "",
                  snippet: item.description || item.snippet || ""
                };
              } catch { return null; }
            })
            .filter(Boolean);
          resolve(results);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
  });
}

function formatSearchResults(results) {
  if (!results || results.length === 0) {
    return {
      status: "success",
      message: "Không tìm thấy kết quả nào cho truy vấn này.",
      results: []
    };
  }

  return {
    status: "success",
    message: `Tìm thấy ${results.length} kết quả:`,
    results: results.map((r, i) => ({
      index: i + 1,
      title: r.title,
      url: r.url,
      snippet: r.snippet.slice(0, 250)
    }))
  };
}

/**
 * Handler cho tool lookup_document
 */
async function handleLookupDocument(topic) {
  console.log(`[tools] lookup_document called: "${topic.slice(0, 60)}..."`);

  const topicLower = topic.toLowerCase();
  const matched = [];

  // Simple keyword matching
  for (const [code, chunk] of codeToChunk.entries()) {
    if (chunk.source !== "transcript") continue;

    const textLower = chunk.text.toLowerCase();
    // Check if topic keywords appear in chunk
    const topicWords = topicLower.split(/\s+/).filter(w => w.length > 2);
    const matchCount = topicWords.filter(w => textLower.includes(w)).length;

    if (matchCount > 0) {
      matched.push({
        code,
        score: matchCount / topicWords.length,
        text: chunk.text,
        title: chunk.metadata?.title || code
      });
    }
  }

  // Sort by relevance
  matched.sort((a, b) => b.score - a.score);

  // Return top 5
  const top = matched.slice(0, 5);

  if (top.length === 0) {
    return {
      status: "success",
      message: `Không tìm thấy nội dung nào liên quan đến "${topic}" trong tài liệu.`,
      documents: [],
      suggestion: "Thử tìm kiếm trên web hoặc hỏi giảng viên trực tiếp."
    };
  }

  return {
    status: "success",
    message: `Tìm thấy ${top.length} đoạn liên quan:`,
    documents: top.map(d => ({
      code: d.code,
      title: d.title,
      relevance: Math.round(d.score * 100) + "%",
      excerpt: d.text.slice(0, 300) + (d.text.length > 300 ? "..." : "")
    }))
  };
}

/**
 * Process tool calls từ Gemini response
 */
async function processToolCalls(toolCalls, maxDepth = 2) {
  if (!toolCalls || toolCalls.length === 0 || maxDepth <= 0) {
    return [];
  }

  const results = [];

  for (const call of toolCalls) {
    const { id, name, args } = call;
    let result;

    try {
      switch (name) {
        case "search_web":
          result = await handleSearchWeb(args.query || "");
          break;
        case "lookup_document":
          result = await handleLookupDocument(args.topic || "");
          break;
        default:
          result = { status: "error", message: `Unknown tool: ${name}` };
      }
    } catch (e) {
      result = { status: "error", message: `Tool error: ${e.message}` };
    }

    results.push({
      toolCallId: id,
      toolName: name,
      result
    });
  }

  return results;
}

/**
 * Convert tool results to Gemini format
 */
function formatToolResults(toolResults) {
  return toolResults.map(tr => ({
    toolCallId: tr.toolCallId,
    functionResponse: {
      name: tr.toolName,
      response: {
        content: JSON.stringify(tr.result, null, 2)
      }
    }
  }));
}

// ============== SYSTEM PROMPT ==============
const SYSTEM_PROMPT = `Bạn là VLearn Tutor — AI hỗ trợ học viên trong khoá AI Thực Chiến.

## NHIỆM VỤ
Trả lời câu hỏi của học viên một cách chính xác, dựa trên tài liệu bài giảng và thông tin tìm kiếm được.

## NGUYÊN TẮC VÀNG

### 1. LUÔN kiểm tra tài liệu TRƯỚC
- Khi được hỏi về nội dung bài giảng, LUÔN dùng tool lookup_document để tra cứu
- Chỉ trả lời khi có căn cứ từ tài liệu hoặc nguồn đáng tin

### 2. KHÔNG ĐƯỢC bịa đặt
- Tuyệt đối không tạo thông tin không có trong tài liệu
- Nếu không tìm thấy, thừa nhận rõ ràng: "Mình không tìm thấy nội dung này trong tài liệu"
- Không dùng **[Txx-NNN]** hoặc **[Cxxxx]** nếu không có thật trong kết quả tra cứu

### 3. Trích dẫn đúng cách
- Đoạn bài giảng: dùng mã **[Txx-NNN]** (ví dụ: [T02-045])
- Hội thoại học viên: dùng **[Cxxxx-Tyyyy-Q]** hoặc **[Cxxxx-Tyyyy-A]**
- Nguồn web: ghi rõ (Nguồn: tiêu đề - url)

### 4. Khi tài liệu không đủ
- Dùng tool search_web để tìm thông tin bổ sung
- Khi dùng thông tin web, ghi rõ nguồn
- Nêu rõ đây là thông tin bổ sung, không phải từ tài liệu khoá học

### 5. Văn phong
- Thân thiện, tiếng Việt tự nhiên, xưng "mình"
- Giải thích rõ ràng, có ví dụ khi cần
- Nếu câu hỏi mơ hồ, hỏi lại để hiểu đúng ý

## WORKFLOW KHI TRẢ LỜI

1. **Nghe câu hỏi** → Hiểu ý hỏi
2. **Tra cứu tài liệu** → Dùng lookup_document
3. **Đánh giá kết quả**
   - Nếu đủ → Trả lời với trích dẫn
   - Nếu thiếu → Tìm kiếm web
4. **Tổng hợp** → Trả lời hoàn chỉnh

## TRƯỜNG HỢP ĐẶC BIỆT

### Câu hỏi ngoài phạm vi khoá học
"Mình không tìm thấy nội dung này trong tài liệu khoá học. Bạn nên:
• Hỏi giảng viên hoặc TA trong Discord
• Tra cứu tài liệu bên ngoài"

### Câu hỏi mơ hồ
"Câu hỏi của bạn có thể hiểu theo nhiều cách. Bạn có thể nói rõ hơn ý mình là gì không?"

### Câu hỏi về code/project
"Khi nói về project, bạn có thể cho mình biết thêm:
• Đang làm project gì?
• Vấn đề cụ thể là gì?"

## VÍ DỤ

**Câu hỏi:** "Làm sao xác định bài toán từ đề bài mơ hồ?"
**Cách trả lời đúng:**
1. lookup_document("xác định bài toán đề bài mơ hồ")
2. Tìm thấy [T02-045] về phương pháp xác định
3. Trả lời với trích dẫn cụ thể

**Câu hỏi:** "Công thức nấu phở bò?"
**Cách trả lời đúng:**
1. lookup_document("công thức nấu phở")
2. Không tìm thấy trong tài liệu
3. search_web("công thức nấu phở bò ngon")
4. Trả lời với nguồn web, nêu rõ đây không phải từ khoá học

---

Hãy bắt đầu bằng cách tra cứu tài liệu cho mỗi câu hỏi.`;

module.exports = {
  TOOL_DEFINITIONS,
  SYSTEM_PROMPT,
  handleSearchWeb,
  handleLookupDocument,
  processToolCalls,
  formatToolResults
};
