// ============================================================
// app.js — Logic UI: Mock ↔ AI thật (RAG)
// ============================================================

const chatEl = document.getElementById("chat");
const inputEl = document.getElementById("question-input");
const formEl = document.getElementById("ask-form");
const modeBadgeEl = document.getElementById("mode-badge");
const toggleEl = document.getElementById("mode-toggle");

// ============== MODE ==============
function getMode() {
  return localStorage.getItem("vlearn_tutor_mode") || "mock";
}
function setMode(m) {
  localStorage.setItem("vlearn_tutor_mode", m);
  refreshModeUI();
}
function refreshModeUI() {
  const m = getMode();
  if (m === "ai") {
    modeBadgeEl.className = "mode-badge live";
    modeBadgeEl.innerHTML = '<span class="dot-indicator"></span><span>AI · RAG</span>';
    toggleEl.innerHTML = '<span>🔄</span><span>Đổi mode</span>';
  } else {
    modeBadgeEl.className = "mode-badge mock";
    modeBadgeEl.innerHTML = '<span class="dot-indicator"></span><span>MOCK · CP2</span>';
    toggleEl.innerHTML = '<span>🤖</span><span>AI thật</span>';
  }
}

toggleEl.addEventListener("click", () => {
  setMode(getMode() === "ai" ? "mock" : "ai");
});

// ============== MOCK DATA ==============
function findMockAnswer(question) {
  const q = question.toLowerCase();
  for (const entry of window.MOCK_QA) {
    for (const kw of entry.keywords) {
      if (q.includes(kw)) return entry;
    }
  }
  return window.MOCK_NOT_FOUND;
}

// ============== CITATION CHIP ==============
function buildCitationChip(code) {
  const a = document.createElement("a");
  a.className = "cite-chip";
  if (code.startsWith("T")) {
    a.href = `mock-transcripts.html#${code.toLowerCase()}`;
    a.target = "_blank";
    a.rel = "noopener";
    a.title = `Click để mở transcript tại đoạn ${code}`;
  } else if (code.startsWith("S")) {
    // Web source chip
    a.href = "#";
    a.title = `Nguồn web #${code}`;
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const sourceEl = document.getElementById(`source-${code}`);
      if (sourceEl) sourceEl.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  } else {
    a.href = "#";
    a.title = `Mã hội thoại ${code}`;
    a.addEventListener("click", (e) => {
      e.preventDefault();
      alert(`Mã hội thoại học viên: ${code}`);
    });
  }
  a.textContent = `📎 ${code}`;
  return a;
}

// ============== WEB SOURCE BOX ==============
function renderWebSourcesBox(sources) {
  if (!sources || !sources.length) return null;

  const citBox = document.createElement("div");
  citBox.className = "snippet-box web-sources-box";

  const title = document.createElement("div");
  title.className = "snippet-title web-source-title";
  title.textContent = `🌐 Từ tìm kiếm web (${sources.length} nguồn):`;
  citBox.appendChild(title);

  sources.forEach((s, i) => {
    const item = document.createElement("div");
    item.className = "snippet-item web-source-item";
    item.id = `source-${s.id}`;

    const head = document.createElement("div");
    head.className = "snippet-head";

    const label = document.createElement("span");
    label.className = "cite-chip web-chip";
    label.textContent = s.id;
    head.appendChild(label);

    const link = document.createElement("a");
    link.href = s.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.className = "web-source-link";
    link.textContent = s.title;
    head.appendChild(link);

    const externalIcon = document.createElement("span");
    externalIcon.className = "external-icon";
    externalIcon.textContent = " ↗";
    link.appendChild(externalIcon);

    item.appendChild(head);

    const quote = document.createElement("blockquote");
    quote.className = "web-snippet";
    quote.textContent = s.snippet;
    item.appendChild(quote);

    citBox.appendChild(item);
  });

  return citBox;
}

// ============== RENDER ==============
function renderUserMsg(text) {
  const div = document.createElement("div");
  div.className = "msg msg-user";
  div.textContent = text;
  return div;
}

function renderThinking() {
  const div = document.createElement("div");
  div.className = "msg msg-tutor thinking";
  div.id = "thinking-bubble";
  div.innerHTML =
    '<span class="dot"></span><span class="dot"></span><span class="dot"></span> đang tra cứu tài liệu…';
  return div;
}

function renderAnswerFromRag(r) {
  const wrap = document.createElement("div");
  wrap.className = "msg msg-tutor";

  if (r.isFailure) {
    const p = document.createElement("p");
    p.className = "answer-text failure";
    p.textContent = r.answer;
    wrap.appendChild(p);

    const note = document.createElement("p");
    note.className = "muted";
    note.textContent =
      "⚠ Failure path: tutor từ chối bịa — Lớp ① (Nguồn sự thật) trong spec §5.";
    wrap.appendChild(note);
    return wrap;
  }

  // Tách các marker [Txx-NNN] và [Cxxxx-Tyyyy-K] thành chip
  const parts = r.answer.split(/(\[(?:T\d{2}-\d{1,3}|C\d{4}-T\d{4}-[QA]|C\d{4})\])/g);
  const p = document.createElement("p");
  p.className = "answer-text";
  parts.forEach((seg) => {
    const m = seg.match(/^\[((?:T\d{2}-\d{1,3})|(?:C\d{4}-T\d{4}-[QA])|(?:C\d{4}))\]$/);
    if (m) {
      p.appendChild(buildCitationChip(m[1]));
    } else if (seg) {
      // Render \n\n và **bold** đơn giản
      seg.split("\n\n").forEach((para, idx, arr) => {
        if (idx > 0) p.appendChild(document.createElement("br"));
        para.split(/(\*\*[^*]+\*\*)/g).forEach((sub) => {
          const b = sub.match(/^\*\*([^*]+)\*\*$/);
          if (b) {
            const strong = document.createElement("strong");
            strong.textContent = b[1];
            p.appendChild(strong);
          } else if (sub) {
            p.appendChild(document.createTextNode(sub));
          }
        });
      });
    }
  });
  wrap.appendChild(p);

  // Box snippet
  if (r.snippets && r.snippets.length) {
    const citBox = document.createElement("div");
    citBox.className = "snippet-box";

    const title = document.createElement("div");
    title.className = "snippet-title";
    title.textContent = "📚 Trích từ tài liệu:";
    citBox.appendChild(title);

    r.snippets.forEach((s) => {
      const item = document.createElement("div");
      item.className = "snippet-item";

      const head = document.createElement("div");
      head.className = "snippet-head";
      head.appendChild(buildCitationChip(s.code));
      const ask = document.createElement("span");
      ask.className = "muted";
      const sourceLabel = s.source === "transcript" ? "  ← click để đọc nguyên đoạn" : "  (hội thoại học viên)";
      ask.textContent = sourceLabel;
      head.appendChild(ask);

      const quote = document.createElement("blockquote");
      quote.textContent = s.text;

      item.appendChild(head);
      item.appendChild(quote);
      citBox.appendChild(item);
    });

    wrap.appendChild(citBox);
  }

  // Web sources box (từ research)
  if (r.webSources && r.webSources.length) {
    const webBox = renderWebSourcesBox(r.webSources);
    if (webBox) wrap.appendChild(webBox);
  }

  // Trace hint (ẩn mặc định, click để xem)
  if (r.trace) {
    const trace = document.createElement("details");
    trace.className = "trace-details";
    const summary = document.createElement("summary");

    let traceText = `🔍 Trace: top-1 ${r.trace.retrieved[0]?.score?.toFixed(3) || "?"} · ${r.trace.retrieved.length} retrieved`;
    if (r.researchInfo?.used) {
      traceText += ` · 🌐 web (${r.researchInfo.sources?.length || 0} sources)`;
    }
    summary.textContent = traceText;

    trace.appendChild(summary);
    const pre = document.createElement("pre");
    pre.className = "trace-pre";
    pre.textContent = JSON.stringify(
      {
        retrieved: r.trace.retrieved,
        verified: r.trace.verified,
        research: r.researchInfo || r.trace.research || null,
      },
      null,
      2
    );
    trace.appendChild(pre);
    wrap.appendChild(trace);
  }

  return wrap;
}

function renderAnswerFromMock(entry) {
  // Tái sử dụng logic render cũ của CP2
  const wrap = document.createElement("div");
  wrap.className = "msg msg-tutor";

  if (entry.isFailure) {
    const p = document.createElement("p");
    p.className = "answer-text failure";
    p.textContent = entry.answer;
    wrap.appendChild(p);
    const note = document.createElement("p");
    note.className = "muted";
    note.textContent = "⚠ Failure path — lớp ① (Nguồn sự thật).";
    wrap.appendChild(note);
    return wrap;
  }

  const parts = entry.answer.split(/(\[[T0-9]+-[0-9]+\])/g);
  const p = document.createElement("p");
  p.className = "answer-text";
  parts.forEach((seg) => {
    const m = seg.match(/^\[([T0-9]+-[0-9]+)\]$/);
    if (m) {
      p.appendChild(buildCitationChip(m[1]));
    } else if (seg) {
      seg.split("\n\n").forEach((para, idx, arr) => {
        if (idx > 0) p.appendChild(document.createElement("br"));
        para.split(/(\*\*[^*]+\*\*)/g).forEach((sub) => {
          const b = sub.match(/^\*\*([^*]+)\*\*$/);
          if (b) {
            const strong = document.createElement("strong");
            strong.textContent = b[1];
            p.appendChild(strong);
          } else if (sub) {
            p.appendChild(document.createTextNode(sub));
          }
        });
      });
    }
  });
  wrap.appendChild(p);

  if (entry.citations && entry.citations.length) {
    const citBox = document.createElement("div");
    citBox.className = "snippet-box";
    const title = document.createElement("div");
    title.className = "snippet-title";
    title.textContent = "📚 Trích từ bài giảng:";
    citBox.appendChild(title);
    entry.citations.forEach((code) => {
      const key = `snippet_${code.toLowerCase().replace(/-/g, "_")}`;
      const snippet = entry[key];
      if (!snippet) return;
      const item = document.createElement("div");
      item.className = "snippet-item";
      const head = document.createElement("div");
      head.className = "snippet-head";
      head.appendChild(buildCitationChip(code));
      const ask = document.createElement("span");
      ask.className = "muted";
      ask.textContent = "  ← click để đọc nguyên đoạn";
      head.appendChild(ask);
      const quote = document.createElement("blockquote");
      quote.textContent = snippet;
      item.appendChild(head);
      item.appendChild(quote);
      citBox.appendChild(item);
    });
    wrap.appendChild(citBox);
  }
  return wrap;
}

function showFailureTriggerRow() {
  const wrap = document.createElement("div");
  wrap.className = "failure-trigger";
  wrap.innerHTML = '<span>Thử câu hỏi ngoài phạm vi:</span>';
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn-small";
  btn.textContent = "Công thức nấu phở bò chuẩn Hà Nội?";
  btn.addEventListener("click", () => {
    inputEl.value = btn.textContent;
    formEl.dispatchEvent(new Event("submit"));
  });
  wrap.appendChild(btn);
  return wrap;
}

// ============== SUBMIT ==============
formEl.addEventListener("submit", async (e) => {
  e.preventDefault();
  const question = inputEl.value.trim();
  if (!question) return;

  chatEl.appendChild(renderUserMsg(question));
  chatEl.scrollTop = chatEl.scrollHeight;
  inputEl.value = "";

  const thinking = renderThinking();
  chatEl.appendChild(thinking);
  chatEl.scrollTop = chatEl.scrollHeight;

  try {
    if (getMode() === "ai") {
      // Đảm bảo corpus đã load
      if (!window.RagBrowser) throw new Error("RagBrowser chưa load — kiểm tra rag-browser.js");
      await window.RagBrowser.loadCorpus();
      const r = await window.RagBrowser.askTutor(question);
      thinking.remove();
      chatEl.appendChild(renderAnswerFromRag(r));
    } else {
      // Mock — giả lập độ trễ
      await new Promise((res) => setTimeout(res, 600));
      thinking.remove();
      const entry = findMockAnswer(question);
      chatEl.appendChild(renderAnswerFromMock(entry));
    }
    chatEl.scrollTop = chatEl.scrollHeight;

    // Gợi ý failure case ở cuối
    if (!document.getElementById("failure-suggestion")) {
      const sug = document.createElement("div");
      sug.id = "failure-suggestion";
      sug.className = "failure-suggestion";
      sug.appendChild(showFailureTriggerRow());
      chatEl.appendChild(sug);
      chatEl.scrollTop = chatEl.scrollHeight;
    }
  } catch (err) {
    thinking.remove();
    const errDiv = document.createElement("div");
    errDiv.className = "msg msg-tutor";
    errDiv.innerHTML = `<p class="answer-text failure">⚠ Lỗi: ${escapeHtml(err.message)}</p>`;
    chatEl.appendChild(errDiv);
    chatEl.scrollTop = chatEl.scrollHeight;
  }
});

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ============== INIT ==============
refreshModeUI();
inputEl.focus();