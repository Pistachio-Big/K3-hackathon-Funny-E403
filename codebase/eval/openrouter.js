/**
 * openrouter.js — Wrapper cho OpenRouter API
 * Dùng chung interface với Gemini để dễ swap
 *
 * Lưu ý: `max_tokens` mặc định được set THẤP (512) để tránh vượt credit
 * OpenRouter. Nếu hết credit, server sẽ trả 402 với payload gợi ý giảm
 * max_tokens / prompt size. Hàm `chat()` sẽ TỰ ĐỘNG retry với max_tokens
 * nhỏ hơn khi gặp 402.
 */

const https = require("https");
require("./loadenv.js");

const apiKey = process.env.OPENROUTER_API_KEY;
const MODEL_GEN = process.env.EVAL_MODEL || "openai/gpt-4o-mini";
const BASE_URL = "openrouter.ai";
const API_PATH = "/api/v1/chat/completions";

// === DEFAULT MAX_TOKENS ===
// Giữ giá trị AN TOÀN để không vượt credit OpenRouter.
// 512 tokens ≈ 350-400 từ tiếng Việt — đủ cho câu trả lời tutor có trích dẫn.
// Lập trình viên có thể override qua options.max_tokens khi cần câu dài hơn.
const DEFAULT_MAX_TOKENS = 512;
// Ngưỡng dưới cùng nếu phải retry do 402 (credit thấp)
const FALLBACK_MAX_TOKENS = 150;

/**
 * Retry với max_tokens nhỏ hơn khi OpenRouter trả 402.
 * @param {Function} doRequest - () => Promise<text>
 * @param {number} initialMaxTokens - max_tokens ban đầu
 * @returns {Promise<string>}
 */
async function withTokenBudgetRetry(doRequest, initialMaxTokens) {
  try {
    return await doRequest(initialMaxTokens);
  } catch (e) {
    const msg = e?.message || "";
    const is402 = msg.includes("HTTP 402");
    const canFallback = initialMaxTokens > FALLBACK_MAX_TOKENS;
    if (!is402 || !canFallback) throw e;

    // Parse "You requested up to N tokens" từ message
    const m = msg.match(/requested up to (\d+) tokens/);
    const requested = m ? parseInt(m[1], 10) : initialMaxTokens;

    // Chọn max_tokens mới: tối đa bằng (requested * 0.5) hoặc FALLBACK_MAX_TOKENS
    // đảm bảo LUÔN nhỏ hơn requested ban đầu
    const newMax = Math.max(
      FALLBACK_MAX_TOKENS,
      Math.min(Math.floor(requested * 0.5), FALLBACK_MAX_TOKENS)
    );
    console.warn(
      `[openrouter] HTTP 402 (credit) — retry với max_tokens=${newMax} (was ${requested})`
    );
    return await doRequest(newMax);
  }
}

/**
 * Estimate số tokens gần đúng (1 token ≈ 4 ký tự tiếng Việt, an toàn ≈ 3).
 * @param {string|array} messages
 */
function estimateTokens(messages) {
  let text = "";
  if (typeof messages === "string") text = messages;
  else if (Array.isArray(messages)) {
    text = messages
      .map((m) => {
        if (typeof m.content === "string") return m.content;
        if (Array.isArray(m.content)) {
          return m.content.map((p) => p?.text || "").join(" ");
        }
        return "";
      })
      .join("\n");
  }
  // Vietnamese có nhiều ký tự đa byte; ước lượng 1 token / 2.5 chars là an toàn
  return Math.ceil(text.length / 2.5);
}

/**
 * Gọi OpenRouter chat completions
 * @param {string|array} messages - String (prompt) hoặc array of {role, content}
 * @param {object} options - generationConfig
 * @returns {Promise<string>} - Response text
 */
async function chat(messages, options = {}) {
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY not set");
  }

  // Convert string prompt to messages format
  if (typeof messages === "string") {
    messages = [{ role: "user", content: messages }];
  }

  // === AUTO-BUDGUET ===
  // Nếu caller không truyền max_tokens → dùng DEFAULT (thay vì OpenRouter mặc định ~8K)
  if (options.max_tokens === undefined) {
    options = { ...options, max_tokens: DEFAULT_MAX_TOKENS };
  }

  const inputTokensEst = estimateTokens(messages);
  console.log(
    `[openrouter] request: model=${MODEL_GEN} max_tokens=${options.max_tokens} est_input_tokens=${inputTokensEst}`
  );

  const requestOnce = (maxTokens) => {
    const body = {
      model: MODEL_GEN,
      messages,
      max_tokens: maxTokens,
      ...Object.fromEntries(
        Object.entries(options).filter(([k]) => k !== "max_tokens")
      ),
    };
    return new Promise((resolve, reject) => {
      const bodyStr = JSON.stringify(body);
      const req = https.request(
        {
          method: "POST",
          hostname: BASE_URL,
          path: API_PATH,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(bodyStr),
            Authorization: `Bearer ${apiKey}`,
            "HTTP-Referer": "https://vlearn.example.com",
            "X-Title": "VLearn Tutor",
          },
        },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => {
            if (res.statusCode >= 400) {
              return reject(
                new Error(`OpenRouter HTTP ${res.statusCode}: ${data.slice(0, 500)}`)
              );
            }
            try {
              const j = JSON.parse(data);
              const text = j.choices?.[0]?.message?.content || "";
              const usage = j.usage || {};
              console.log(
                `[openrouter] response: prompt=${usage.prompt_tokens ?? "?"} completion=${usage.completion_tokens ?? "?"} total=${usage.total_tokens ?? "?"}`
              );
              resolve(text);
            } catch (e) {
              reject(new Error(`Parse error: ${e.message}, data: ${data.slice(0, 200)}`));
            }
          });
        }
      );
      req.on("error", reject);
      req.write(bodyStr);
      req.end();
    });
  };

  return withTokenBudgetRetry(requestOnce, options.max_tokens);
}

/**
 * Gọi OpenRouter với tools (function calling)
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {array} tools - OpenAI format tools
 * @returns {Promise<{text: string, toolCalls: array|null}>}
 */
async function chatWithTools(systemPrompt, userPrompt, tools = null) {
  const messages = [];

  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }

  messages.push({ role: "user", content: userPrompt });

  // === AN TOÀN: dùng max_tokens nhỏ để tránh 402 ===
  // Tool-calling prompt rất nặng (system + tools + user) → để 4096 dễ vượt credit.
  // Tutor cần câu trả lời ngắn gọn có trích dẫn → 512 là đủ.
  // Nếu caller cần dài hơn → truyền qua options.
  const requestOptions = {
    temperature: 0.3,
    max_tokens: 512,
  };

  // OpenAI-compatible format requires type:"function" wrapper on each tool
  if (tools && tools.length > 0) {
    const wrapped = tools.map(t => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters
      }
    }));
    requestOptions.tools = wrapped;
    requestOptions.tool_choice = "auto";
  }

  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY not set");
  }

  const requestOnce = (maxTokens) => {
    const body = {
      model: MODEL_GEN,
      messages,
      ...requestOptions,
      max_tokens: maxTokens,
    };

    const bodyStr = JSON.stringify(body);

    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          method: "POST",
          hostname: BASE_URL,
          path: API_PATH,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(bodyStr),
            "Authorization": `Bearer ${apiKey}`,
            "HTTP-Referer": "https://vlearn.example.com",
            "X-Title": "VLearn Tutor",
          },
        },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => {
            if (res.statusCode >= 400) {
              return reject(
                new Error(`OpenRouter HTTP ${res.statusCode}: ${data.slice(0, 500)}`)
              );
            }
            try {
              const j = JSON.parse(data);
              const message = j.choices?.[0]?.message;

              // Check for tool calls
              const toolCalls =
                message?.tool_calls?.map(tc => ({
                  id: tc.id,
                  name: tc.function.name,
                  args: JSON.parse(tc.function.arguments || "{}"),
                })) || null;

              const text = message?.content || "";

              const usage = j.usage || {};
              console.log(
                `[openrouter] response (tools): prompt=${usage.prompt_tokens ?? "?"} completion=${usage.completion_tokens ?? "?"} tools=${toolCalls?.length || 0}`
              );

              resolve({ text, toolCalls });
            } catch (e) {
              reject(new Error(`Parse error: ${e.message}, data: ${data.slice(0, 200)}`));
            }
          });
        }
      );
      req.on("error", reject);
      req.write(bodyStr);
      req.end();
    });
  };

  return withTokenBudgetRetry(requestOnce, requestOptions.max_tokens);
}

/**
 * Convert OpenAI-style tools to OpenRouter format
 */
function convertTools(openaiTools) {
  return openaiTools;
}

module.exports = {
  chat,
  chatWithTools,
  convertTools,
  MODEL_GEN,
  // Exports for retry/estimation helpers (debug + future use)
  withTokenBudgetRetry,
  estimateTokens,
  DEFAULT_MAX_TOKENS,
  FALLBACK_MAX_TOKENS,
};
