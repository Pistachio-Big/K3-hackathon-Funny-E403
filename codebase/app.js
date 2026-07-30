// ============================================================
// app.js — Logic CP2 Mock Tutor
// ============================================================

const chatEl = document.getElementById("chat");
const inputEl = document.getElementById("question-input");
const formEl = document.getElementById("ask-form");
const suggestedEl = document.getElementById("suggested");

// Render danh sách câu hỏi gợi ý
function renderSuggested() {
  suggestedEl.innerHTML = "";
  window.SUGGESTED_QUESTIONS.forEach((q) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "suggested-chip";
    btn.textContent = q;
    btn.addEventListener("click", () => {
      inputEl.value = q;
      inputEl.focus();
    });
    suggestedEl.appendChild(btn);
  });
}

// Tìm mock QA phù hợp (match keyword — đơn giản hoá)
function findMockAnswer(question) {
  const q = question.toLowerCase();
  for (const entry of window.MOCK_QA) {
    for (const kw of entry.keywords) {
      if (q.includes(kw)) return entry;
    }
  }
  return window.MOCK_NOT_FOUND;
}

// Render một citation chip — click mở mock-transcripts.html#<id>
function buildCitationChip(code) {
  const a = document.createElement("a");
  a.className = "cite-chip";
  a.href = `mock-transcripts.html#${code.toLowerCase()}`;
  a.target = "_blank";
  a.rel = "noopener";
  a.textContent = `📎 ${code}`;
  a.title = `Click để mở transcript tại đoạn ${code}`;
  return a;
}

// Render nội dung trả lời, chèn citation chip inline
function renderAnswer(entry) {
  const wrap = document.createElement("div");
  wrap.className = "msg msg-tutor";

  if (entry.isFailure) {
    const p = document.createElement("p");
    p.className = "answer-text failure";
    p.textContent = entry.answer;
    wrap.appendChild(p);

    const note = document.createElement("p");
    note.className = "muted";
    note.textContent =
      "⚠ Failure path: tutor từ chối bịa — Lớp ① (Nguồn sự thật) trong spec §5.";
    wrap.appendChild(note);
    return wrap;
  }

  // Tách các marker [Txx-NNN] thành chip citation
  const parts = entry.answer.split(/(\[[T0-9]+-[0-9]+\])/g);
  const p = document.createElement("p");
  p.className = "answer-text";
  parts.forEach((seg) => {
    const m = seg.match(/^\[([T0-9]+-[0-9]+)\]$/);
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

  // Box snippet cho mỗi citation
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
    '<span class="dot"></span><span class="dot"></span><span class="dot"></span> đang tra cứu transcript…';
  return div;
}

function showFailureTriggerRow() {
  const wrap = document.createElement("div");
  wrap.className = "failure-trigger";
  wrap.innerHTML =
    '<span class="muted">Thử câu hỏi ngoài phạm vi transcript:</span>';
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

// Submit handler
formEl.addEventListener("submit", (e) => {
  e.preventDefault();
  const question = inputEl.value.trim();
  if (!question) return;

  // Render user message
  chatEl.appendChild(renderUserMsg(question));
  chatEl.scrollTop = chatEl.scrollHeight;
  inputEl.value = "";

  // Render thinking bubble
  const thinking = renderThinking();
  chatEl.appendChild(thinking);
  chatEl.scrollTop = chatEl.scrollHeight;

  // Sau 600ms, thay bằng câu trả lời
  setTimeout(() => {
    thinking.remove();
    const entry = findMockAnswer(question);
    chatEl.appendChild(renderAnswer(entry));
    chatEl.scrollTop = chatEl.scrollHeight;

    // Nếu happy path, hiện thêm 1 dòng gợi ý thử failure case
    if (!entry.isFailure && !document.getElementById("failure-suggestion")) {
      const sug = document.createElement("div");
      sug.id = "failure-suggestion";
      sug.className = "failure-suggestion";
      sug.appendChild(showFailureTriggerRow());
      chatEl.appendChild(sug);
      chatEl.scrollTop = chatEl.scrollHeight;
    }
  }, 600);
});

// Init
renderSuggested();
inputEl.focus();
