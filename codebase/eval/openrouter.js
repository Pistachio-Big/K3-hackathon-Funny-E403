/**
 * openrouter.js — Wrapper cho OpenRouter API
 * Dùng chung interface với Gemini để dễ swap
 */

const https = require("https");
require("./loadenv.js");

const apiKey = process.env.OPENROUTER_API_KEY;
const MODEL_GEN = process.env.EVAL_MODEL || "openai/gpt-4o-mini";
const BASE_URL = "openrouter.ai";
const API_PATH = "/api/v1/chat/completions";

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

  const body = {
    model: MODEL_GEN,
    messages,
    ...options
  };

  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const req = https.request({
      method: "POST",
      hostname: BASE_URL,
      path: API_PATH,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(bodyStr),
        "Authorization": `Bearer ${apiKey}`,
        "HTTP-Referer": "https://vlearn.example.com",
        "X-Title": "VLearn Tutor"
      }
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        if (res.statusCode >= 400) {
          return reject(new Error(`OpenRouter HTTP ${res.statusCode}: ${data.slice(0, 500)}`));
        }
        try {
          const j = JSON.parse(data);
          const text = j.choices?.[0]?.message?.content || "";
          resolve(text);
        } catch (e) {
          reject(new Error(`Parse error: ${e.message}, data: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
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

  const requestOptions = {
    temperature: 0.3,
    max_tokens: 4096
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

  return new Promise((resolve, reject) => {
    const body = {
      model: MODEL_GEN,
      messages,
      ...requestOptions
    };

    const bodyStr = JSON.stringify(body);
    const req = https.request({
      method: "POST",
      hostname: BASE_URL,
      path: API_PATH,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(bodyStr),
        "Authorization": `Bearer ${apiKey}`,
        "HTTP-Referer": "https://vlearn.example.com",
        "X-Title": "VLearn Tutor"
      }
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        if (res.statusCode >= 400) {
          return reject(new Error(`OpenRouter HTTP ${res.statusCode}: ${data.slice(0, 500)}`));
        }
        try {
          const j = JSON.parse(data);
          const message = j.choices?.[0]?.message;
          
          // Check for tool calls
          const toolCalls = message?.tool_calls?.map(tc => ({
            id: tc.id,
            name: tc.function.name,
            args: JSON.parse(tc.function.arguments || "{}")
          })) || null;

          const text = message?.content || "";
          resolve({ text, toolCalls });
        } catch (e) {
          reject(new Error(`Parse error: ${e.message}, data: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

/**
 * Convert OpenAI-style tools to OpenRouter format
 */
function convertTools(openaiTools) {
  return openaiTools;
}

module.exports = { chat, chatWithTools, convertTools, MODEL_GEN };
