// ============================================================
// data.js — MOCK DATA cho CP2
// ============================================================
// Mục đích: thay thế AI trong CP2. Sang CP3 sẽ thay bằng Gemini API.
//
// Mỗi entry gồm:
//   - keywords: từ khoá để match câu hỏi của user (đơn giản hoá)
//   - answer: câu trả lời của tutor (có chèn citation marker "[Txx-NNN]")
//   - citations: mảng mã đoạn → dùng render chip + mở mock-transcripts.html
//   - snippet: nội dung trích dẫn hiển thị kèm chip
// ============================================================

window.MOCK_QA = [
  {
    keywords: ["xác định bài toán", "từ đề bài mơ hồ", "kỹ năng xác định"],
    answer:
      "Theo đoạn [T01-005], giảng viên nhấn mạnh rằng kỹ năng xác định bài toán từ yêu cầu mơ hồ là một trong những kỹ năng quan trọng nhất hiện nay: 'từ mục tiêu, yêu cầu mơ hồ, biến nó thành thứ cụ thể có thể triển khai được trong thời gian ngắn và ra được kết quả'.\n\n" +
      "Đoạn [T01-030] bổ sung cách làm cụ thể: dùng **Five Whys** — hỏi 'why' đến 5 lần để đào sâu vấn đề thực sự phía sau đề bài. Ví dụ: khi sếp bảo 'xây chatbot AI support' có khi pain thật là 'sale đang quá tải' — và giải pháp có thể không cần build chatbot.",
    citations: ["T01-005", "T01-030"],
    snippet_t01_005:
      "từ mục tiêu, yêu cầu mơ hồ, biến nó thành thứ cụ thể có thể triển khai được trong thời gian ngắn và ra được kết quả… đừng kỳ vọng người khác sẽ đưa cho bạn một thứ cụ thể — bạn hãy luôn giữ cho mình tư duy phản biện.",
    snippet_t01_030:
      "Bạn dùng Five Whys — bạn hỏi why đến năm lần, nó cũng giúp bạn đào sâu được… sếp bảo xây chatbot cho khách hàng, nhưng hỏi ra thì thực ra lý do là vì sale đang quá tải.",
  },

  {
    keywords: ["product manager", "pm", "project manager", "khác product manager"],
    answer:
      "Theo đoạn [T01-010], **project manager** thiên về quản lý tiến độ, nguồn lực, rủi ro — bài toán đã rõ ràng, nhiệm vụ là chạy đúng deadline và budget. Thường gặp ở các công ty outsourcing.\n\n" +
      "Theo đoạn [T01-011], **product manager / product owner** khác hẳn: phải *tự đi tìm bài toán*, khảo sát user, tìm ra điểm đau, đề xuất tính năng. Tư duy **user-centered** là khác biệt cốt lõi.",
    citations: ["T01-010", "T01-011"],
    snippet_t01_010:
      "Những team đấy nhận bài toán từ khách hàng, và bài toán thường rõ ràng… nhiệm vụ của những người đấy là làm thế nào bố trí nguồn lực vào trong một team để có thể chạy được.",
    snippet_t01_011:
      "Product manager sẽ rộng hơn, là người đi trước nhiều hơn, nhìn ra cơ hội… những người làm product thì mình hay dùng từ user-centered — lấy người dùng làm trung tâm.",
  },

  {
    keywords: ["llm", "ai sinh xác suất", "khác sản phẩm truyền thống", "ai engineering"],
    answer:
      "Theo đoạn [T01-019], làm sản phẩm AI khác sản phẩm truyền thống ở chỗ: 'AI sinh ra xác suất, không phải 100 lần nó sẽ trả lời 100 cái đúng như nhau'. Sản phẩm truyền thống chạy 20 năm vẫn ổn nếu không đụng vào; sản phẩm AI thì không như vậy, và bạn phải kiểm soát được **kỳ vọng của người dùng**.\n\n" +
      "Đoạn [T01-026] recommend cuốn **'AI Engineering'** nếu muốn hiểu nền móng về mô hình ngôn ngữ lớn và sản phẩm AI khác sản phẩm thường ra sao.",
    citations: ["T01-019", "T01-026"],
    snippet_t01_019:
      "Sản phẩm truyền thống thì 100 lần chạy có thể trả lời 100 lần như nhau… Nhưng với AI sẽ không như thế, và bạn phải kiểm soát được kỳ vọng của người dùng.",
    snippet_t01_026:
      "mình rất recommend đọc cuốn AI Engineering… nếu bạn xác định bạn là một người làm product thì nó cũng sẽ có những phần thông tin rất quan trọng.",
  },

  {
    keywords: ["kỳ vọng người dùng", "user expectation", "chuyển đổi", "cạnh tranh"],
    answer:
      "Theo đoạn [T01-020], kỳ vọng người dùng đang thay đổi rất nhanh: 'cách đây 4 năm chưa có ChatGPT, con người đâu có kỳ vọng về việc là tôi có thể hỏi một cỗ máy và nó trả lời mọi thứ'. Bây giờ chat một câu trả lời sai là người ta la lên.\n\n" +
      "Đoạn [T01-021] nhấn mạnh **chi phí chuyển đổi giữa sản phẩm** đã rẻ hơn rất nhiều — user dễ export dữ liệu, dễ bỏ đi — nên sản phẩm của bạn phải có **cái gì đủ khác biệt**.",
    citations: ["T01-020", "T01-021"],
    snippet_t01_020:
      "cuộc chiến là làm thế nào để sản phẩm của bạn giành được sự chú ý… chat một câu đã lỗi rồi là 'thôi tôi sang tôi dùng cái khác' — sức cạnh tranh lên rất nhiều.",
    snippet_t01_021:
      "chi phí chuyển đổi của user từ một sản phẩm A sang một sản phẩm B… bây giờ cái đấy gần như bị xoá nhoà: bạn rất dễ dàng export và mang được dữ liệu sang.",
  },
];

// Fallback "không tìm thấy trong tài liệu" — chiếm failure path (lớp ① Nguồn sự thật)
window.MOCK_NOT_FOUND = {
  isFailure: true,
  answer:
    "Mình **không tìm thấy nội dung này** trong các transcript bài giảng hiện có.\n\n" +
    "Thay vì đoán và trả lời sai, mình khuyên bạn:\n" +
    "• Hỏi trực tiếp giảng viên hoặc TA trong Discord khoá.\n" +
    "• Hoặc mở tài liệu gốc để tìm.\n\n" +
    "_(Đây là hành vi cố ý của tutor: tránh bịa nguồn — Lớp ① trong spec §5.)_",
  citations: [],
};

// Câu gợi ý hiển thị khi mở app
window.SUGGESTED_QUESTIONS = [
  "Làm sao xác định bài toán từ đề bài mơ hồ của sếp?",
  "Product manager khác project manager ở chỗ nào?",
  "Sản phẩm AI khác sản phẩm truyền thống như thế nào?",
  "AI ảnh hưởng đến kỳ vọng người dùng ra sao?",
];
