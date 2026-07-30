// ============================================================
// 📋 TẠO GOOGLE FORM KHẢO SÁT — VLearn Tutor · Trả lời có trích dẫn
// ============================================================
// 
// HƯỚNG DẪN SỬ DỤNG:
// 1. Truy cập https://script.google.com
// 2. Tạo project mới (New Project)
// 3. Xoá code mặc định, paste toàn bộ code này vào
// 4. Nhấn nút ▶ Run (chọn hàm createSurveyForm)
// 5. Cấp quyền khi được hỏi (Allow)
// 6. Kiểm tra Google Drive → Form đã được tạo!
// ============================================================

function createSurveyForm() {
  // Tạo form mới
  var form = FormApp.create('📋 Khảo sát VLearn Tutor — Trả lời có trích dẫn');
  
  // Mô tả form
  form.setDescription(
    'Xin chào! Mình đang làm dự án cải thiện AI Tutor trên VLearn. ' +
    'Khảo sát này chỉ mất 2-3 phút, giúp mình hiểu trải nghiệm thật của bạn.\n\n' +
    '⚠️ Không có câu trả lời đúng/sai — mình cần ý kiến thật của bạn.\n' +
    '📌 Mọi câu trả lời sẽ được ghi nhận ẩn danh trong báo cáo.\n\n' +
    'Nhóm: 2A202601217 · Nguyễn Văn Đại'
  );
  
  form.setConfirmationMessage('Cảm ơn bạn đã tham gia khảo sát! 🙏');
  form.setAllowResponseEdits(false);
  form.setLimitOneResponsePerUser(false);

  // ──────────────────────────────────────────────
  // PHẦN 1: THÔNG TIN CƠ BẢN
  // ──────────────────────────────────────────────
  
  form.addSectionHeaderItem()
    .setTitle('📌 Phần 1: Thông tin cơ bản');

  form.addTextItem()
    .setTitle('Họ tên hoặc mã học viên của bạn')
    .setHelpText('Dùng để ghi log khảo sát — sẽ được ẩn danh trong báo cáo')
    .setRequired(true);

  // ──────────────────────────────────────────────
  // PHẦN 2: TRẢI NGHIỆM TRA LẠI KIẾN THỨC
  // ──────────────────────────────────────────────
  
  form.addSectionHeaderItem()
    .setTitle('📖 Phần 2: Trải nghiệm tra lại kiến thức bài giảng');

  // Câu 1
  var q1 = form.addCheckboxItem();
  q1.setTitle('Câu 1: Lần gần nhất bạn cần tra lại một kiến thức từ bài giảng, bạn làm cách nào?');
  q1.setHelpText('Chọn tất cả cách bạn đã thử');
  q1.setChoices([
    q1.createChoice('Tua lại video bài giảng để tìm đoạn cần'),
    q1.createChoice('Hỏi AI Tutor trên VLearn'),
    q1.createChoice('Hỏi ChatGPT / Gemini / Claude bên ngoài'),
    q1.createChoice('Đọc lại slide / tài liệu'),
    q1.createChoice('Hỏi bạn bè trong lớp / Discord'),
    q1.createChoice('Bỏ qua, không tìm lại')
  ]);
  q1.showOtherOption(true);
  q1.setRequired(true);

  // Câu 2
  var q2 = form.addMultipleChoiceItem();
  q2.setTitle('Câu 2: Lần đó, bạn mất khoảng bao lâu để tìm được thông tin cần?');
  q2.setChoices([
    q2.createChoice('Dưới 2 phút'),
    q2.createChoice('2–5 phút'),
    q2.createChoice('5–15 phút'),
    q2.createChoice('Trên 15 phút'),
    q2.createChoice('Không tìm được, bỏ cuộc')
  ]);
  q2.setRequired(true);

  // ──────────────────────────────────────────────
  // PHẦN 3: TRẢI NGHIỆM VỚI AI TUTOR VLEARN
  // ──────────────────────────────────────────────
  
  form.addSectionHeaderItem()
    .setTitle('🤖 Phần 3: Trải nghiệm với AI Tutor trên VLearn');

  // Câu 3
  var q3 = form.addMultipleChoiceItem();
  q3.setTitle('Câu 3: Bạn đã từng dùng AI Tutor trên VLearn để hỏi bài chưa?');
  q3.setChoices([
    q3.createChoice('Có, dùng thường xuyên (≥5 lần)'),
    q3.createChoice('Có, dùng vài lần (1–4 lần)'),
    q3.createChoice('Chưa bao giờ dùng')
  ]);
  q3.setRequired(true);

  // Câu 4
  var q4 = form.addMultipleChoiceItem();
  q4.setTitle('Câu 4: Khi AI Tutor trả lời, bạn có thấy nó ghi rõ nguồn (trang nào, đoạn nào của tài liệu) không?');
  q4.setHelpText('Nghĩ về lần gần nhất bạn dùng');
  q4.setChoices([
    q4.createChoice('Có, luôn ghi rõ nguồn (trang/đoạn)'),
    q4.createChoice('Thỉnh thoảng có, thỉnh thoảng không'),
    q4.createChoice('Hầu như không bao giờ ghi nguồn'),
    q4.createChoice('Mình không để ý / chưa dùng')
  ]);
  q4.setRequired(true);

  // Câu 5
  var q5 = form.addMultipleChoiceItem();
  q5.setTitle('Câu 5: Khi AI Tutor trả lời mà KHÔNG ghi nguồn, bạn có tin câu trả lời đó không?');
  q5.setChoices([
    q5.createChoice('Tin luôn, không kiểm tra lại'),
    q5.createChoice('Hơi nghi ngờ, nhưng vẫn dùng'),
    q5.createChoice('Không tin, phải tự mở tài liệu kiểm tra lại'),
    q5.createChoice('Không tin, bỏ qua luôn câu trả lời')
  ]);
  q5.setRequired(true);

  // Câu 6
  form.addParagraphTextItem()
    .setTitle('Câu 6: Khi AI Tutor trả lời mà không ghi nguồn, bạn thường làm gì tiếp theo?')
    .setHelpText('Mô tả cụ thể hành động của bạn (ví dụ: mở lại slide tìm, hỏi bạn bè, bỏ qua...)')
    .setRequired(true);

  // ──────────────────────────────────────────────
  // PHẦN 4: ĐÁNH GIÁ GIẢI PHÁP
  // ──────────────────────────────────────────────
  
  form.addSectionHeaderItem()
    .setTitle('💡 Phần 4: Đánh giá giải pháp đề xuất');

  // Câu 7
  var q7 = form.addMultipleChoiceItem();
  q7.setTitle('Câu 7: Nếu AI Tutor trả lời kèm trích dẫn cụ thể (ví dụ: "Theo đoạn [T01-005], giảng viên nói: ..."), bạn có thấy hữu ích hơn không?');
  q7.setChoices([
    q7.createChoice('Rất hữu ích — giúp mình kiểm chứng và học sâu hơn'),
    q7.createChoice('Hữu ích — nhưng không quá quan trọng'),
    q7.createChoice('Bình thường — mình chỉ cần câu trả lời đúng là được'),
    q7.createChoice('Không cần — thêm trích dẫn làm rối')
  ]);
  q7.setRequired(true);

  // Câu 8 — mở
  form.addParagraphTextItem()
    .setTitle('Câu 8: Bạn có góp ý gì thêm về trải nghiệm dùng AI Tutor trên VLearn không?')
    .setHelpText('Chia sẻ tự do — bất kỳ điều gì bạn thấy chưa tốt hoặc muốn cải thiện')
    .setRequired(false);

  // ──────────────────────────────────────────────
  // PHẦN 5: WILLING USER
  // ──────────────────────────────────────────────
  
  form.addSectionHeaderItem()
    .setTitle('🙋 Phần 5: Tham gia thử nghiệm');

  var q9 = form.addMultipleChoiceItem();
  q9.setTitle('Bạn có sẵn sàng dùng thử prototype (bản demo) của nhóm mình trước buổi demo không?');
  q9.setHelpText('Chỉ mất khoảng 5-10 phút. Giúp nhóm mình rất nhiều! 🙏');
  q9.setChoices([
    q9.createChoice('Có, mình sẵn sàng thử!'),
    q9.createChoice('Có thể, tuỳ thời gian'),
    q9.createChoice('Không, mình không tiện')
  ]);
  q9.setRequired(true);

  // Log kết quả
  Logger.log('✅ Form đã được tạo thành công!');
  Logger.log('📎 Link chỉnh sửa form: ' + form.getEditUrl());
  Logger.log('📤 Link gửi cho người khảo sát: ' + form.getPublishedUrl());
}
