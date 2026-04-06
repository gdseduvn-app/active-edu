/* ═══════════════════════════════════════════════════════════════
   AURA Lesson Studio — lesson-studio.js
   State + AL Templates + Math Models + 791 Browser
   ═══════════════════════════════════════════════════════════════ */

const PROXY = 'https://api.gds.edu.vn';
const TOKEN_KEY = 'ae_token';

/* ── STATE ── */
let session = {};
let std791Data = [];   // 784 YCCĐ loaded from JSON
let currentStd = null; // selected YCCĐ
let currentALFormat = null;
let soloTarget = 3;
let iloList = [];
let actCounter = 0;

const stagesMeta = [
  { n:1, title:'Kích hoạt',  kolb:'CE',  color:'#2563EB', bg:'#EEF6FF', icon:'⚡' },
  { n:2, title:'Kiến tạo',   kolb:'AC',  color:'#16A34A', bg:'#F0FDF4', icon:'🔨' },
  { n:3, title:'Hành động',  kolb:'AE',  color:'#D97706', bg:'#FFF7ED', icon:'🎯' },
  { n:4, title:'Phản chiếu', kolb:'RO',  color:'#9333EA', bg:'#FDF4FF', icon:'🪞' },
  { n:5, title:'Tổng kết',   kolb:'all', color:'#E11D48', bg:'#FFF1F2', icon:'✅' },
];

// Each stage holds array of activity objects
let stages = stagesMeta.map(s => ({ ...s, duration: [5,10,12,5,3][s.n-1], activities: [] }));

/* ── BLOOM VERBS (Biggs Table 7.2) ── */
const BLOOM_VERBS = {
  1: ['nhận biết','nhớ lại','liệt kê','xác định','gọi tên'],
  2: ['giải thích','mô tả','phân biệt','so sánh','tóm tắt'],
  3: ['áp dụng','tính toán','giải quyết','sử dụng','thực hiện'],
  4: ['phân tích','phân loại','suy luận','đánh giá','kết nối'],
  5: ['đánh giá','nhận xét','biện luận','bảo vệ','phê phán'],
  6: ['thiết kế','tạo ra','đề xuất','xây dựng','sáng tác'],
};

/* ── AL FORMAT TEMPLATES ── */
const AL_FORMATS = [
  /* TIER 1 */
  { id:'think_pair_share', tier:1, icon:'💭', name:'Think–Pair–Share',
    bloom:[1,3], solo_min:2, duration:20, kolb:'CE+RO',
    desc:'Cá nhân → Cặp → Lớp',
    stages: [
      { kolb:'CE', dur:5,
        prompt:'Đặt câu hỏi kích hoạt tư duy (1-2 câu ngắn gọn, liên hệ thực tế):',
        activities:[{type:'think_write', prompt:'🤔 Think (3 phút): Theo em, [CHỦ ĐỀ] là gì? Viết ngắn gọn suy nghĩ của em.', points:1, bloom:1, solo:2}] },
      { kolb:'RO', dur:7,
        prompt:'Học sinh thảo luận cặp đôi, ghi lại điểm đồng thuận / khác biệt:',
        activities:[{type:'think_write', prompt:'👥 Pair (4 phút): Sau khi trao đổi với bạn, em thấy điểm nào giống / khác so với ban đầu?', points:1, bloom:2, solo:3}] },
      { kolb:'AC', dur:5,
        prompt:'Đại diện các cặp chia sẻ — GV hệ thống kiến thức:',
        activities:[{type:'mcq', prompt:'📢 Share: Sau thảo luận, em chọn đáp án nào đúng nhất?', opts:['A. Phương án 1','B. Phương án 2','C. Phương án 3','D. Phương án 4'], correct:'A', points:1, bloom:2, solo:3}] },
      { kolb:'RO', dur:2,
        prompt:'Phản chiếu nhanh — điều gì thay đổi trong suy nghĩ của em:',
        activities:[{type:'think_write', prompt:'🔁 Suy nghĩ của em thay đổi như thế nào sau khi thảo luận?', points:1, bloom:2, solo:3}] },
      { kolb:'all', dur:1,
        prompt:'Exit ticket 1 câu:',
        activities:[{type:'exit_ticket', prompt:'📝 Hôm nay em học được 1 điều quan trọng: ___', points:1, bloom:1, solo:2}] },
    ]},

  { id:'worked_example_fading', tier:1, icon:'📐', name:'Worked Example + Fading',
    bloom:[2,3], solo_min:2, duration:30, kolb:'AC+AE',
    desc:'Ví dụ đầy đủ → bán hoàn chỉnh → tự làm',
    stages: [
      { kolb:'CE', dur:3, prompt:'Đặt tình huống / bài toán cần giải:',
        activities:[{type:'think_write', prompt:'Nhìn vào bài toán sau. Trước khi xem lời giải, em nghĩ sẽ bắt đầu từ đâu?', points:1, bloom:1, solo:2}] },
      { kolb:'AC', dur:10, prompt:'Ví dụ ĐẦYĐỦ: GV giải từng bước, có chú thích lý do:',
        activities:[{type:'think_write', prompt:'Xem lời giải mẫu phía trên. Bước nào em chưa rõ? Ghi câu hỏi ra đây:', points:1, bloom:2, solo:2}] },
      { kolb:'AE', dur:10, prompt:'Ví dụ BÁN HOÀN CHỈNH: điền vào chỗ trống:',
        activities:[{type:'fill_blank', prompt:'Hoàn thành lời giải (điền vào [___]):\nBước 1: [___]\nBước 2: Ta có ___\nBước 3: Vậy kết quả là ___', correct:'', points:2, bloom:3, solo:3}] },
      { kolb:'AE', dur:5, prompt:'Bài TỰLÀM hoàn toàn:',
        activities:[{type:'numeric', prompt:'Giải bài toán tương tự (không có gợi ý):', correct:'', tolerance:0.01, points:3, bloom:3, solo:4}] },
      { kolb:'RO', dur:2, prompt:'So sánh với lời giải mẫu:',
        activities:[{type:'exit_ticket', prompt:'Bước nào em làm khác với mẫu? Em nghĩ cách nào đúng hơn?', points:1, bloom:4, solo:4}] },
    ]},

  { id:'muddiest_point', tier:1, icon:'☁️', name:'Muddiest Point',
    bloom:[1,2], solo_min:2, duration:15, kolb:'RO',
    desc:'Sau bài → ghi điểm mờ nhất → AI phản hồi',
    stages: [
      { kolb:'CE', dur:3, prompt:'Ôn lại nội dung vừa học:',
        activities:[{type:'mcq', prompt:'Câu hỏi kiểm tra nhanh về nội dung vừa học:', opts:['A.','B.','C.','D.'], correct:'A', points:1, bloom:1, solo:2}] },
      { kolb:'RO', dur:5, prompt:'HS ghi điểm "mờ nhất" — còn chưa hiểu rõ:',
        activities:[{type:'open_ai', prompt:'🌫️ Muddiest Point: Điều gì trong bài học hôm nay em vẫn còn mơ hồ hoặc chưa hiểu rõ nhất?', points:2, bloom:2, solo:2,
          rubric:[{score:2,criteria:'Xác định cụ thể điểm mờ và có thể đặt câu hỏi rõ ràng'},{score:1,criteria:'Nhận ra có điểm chưa hiểu nhưng diễn đạt chưa rõ'},{score:0,criteria:'Không xác định được hoặc bỏ trống'}]}] },
      { kolb:'AC', dur:4, prompt:'GV/AI phản hồi điểm mờ phổ biến:',
        activities:[{type:'think_write', prompt:'Sau khi đọc phản hồi, em hiểu thêm điều gì?', points:1, bloom:2, solo:3}] },
      { kolb:'RO', dur:2, prompt:'Kiểm tra lại sau phản hồi:',
        activities:[{type:'mcq', prompt:'Câu hỏi về điểm mờ đã được giải đáp:', opts:['A.','B.','C.','D.'], correct:'A', points:1, bloom:2, solo:3}] },
      { kolb:'all', dur:1, prompt:'',
        activities:[{type:'exit_ticket', prompt:'Tôi hiểu rồi: ___', points:0, bloom:1, solo:2}] },
    ]},

  { id:'exit_ticket', tier:1, icon:'🎟️', name:'Exit Ticket',
    bloom:[1,3], solo_min:2, duration:10, kolb:'AE',
    desc:'Kiểm tra cuối buổi — 1 câu đại diện',
    stages: [
      { kolb:'CE', dur:2, prompt:'', activities:[{type:'mcq', prompt:'Câu 1 (Nhận biết):', opts:['A.','B.','C.','D.'], correct:'A', points:1, bloom:1, solo:2}] },
      { kolb:'AC', dur:2, prompt:'', activities:[{type:'mcq', prompt:'Câu 2 (Thông hiểu):', opts:['A.','B.','C.','D.'], correct:'A', points:1, bloom:2, solo:3}] },
      { kolb:'AE', dur:3, prompt:'', activities:[{type:'numeric', prompt:'Câu 3 (Vận dụng) — tính kết quả:', correct:'', tolerance:0.01, points:2, bloom:3, solo:3}] },
      { kolb:'RO', dur:2, prompt:'', activities:[{type:'think_write', prompt:'Câu 4 (Phản chiếu): Bài học này kết nối với điều gì em đã biết trước đây?', points:1, bloom:4, solo:4}] },
      { kolb:'all', dur:1, prompt:'', activities:[{type:'exit_ticket', prompt:'1 từ mô tả cảm giác của em sau bài học hôm nay:', points:0, bloom:1, solo:2}] },
    ]},

  /* TIER 2 */
  { id:'problem_based', tier:2, icon:'🧩', name:'Problem-Based Learning',
    bloom:[3,4], solo_min:3, duration:40, kolb:'CE+AE',
    desc:'Tình huống thực → khám phá → giải quyết',
    stages: [
      { kolb:'CE', dur:8, prompt:'Trình bày TÌNH HUỐNG THỰC TẾ (chưa cho biết kiến thức cần dùng):',
        activities:[{type:'open_ai', prompt:'🌍 Em thấy vấn đề gì trong tình huống trên? Điều gì cần được giải quyết?', points:2, bloom:3, solo:3,
          rubric:[{score:2,criteria:'Xác định vấn đề rõ ràng, đặt câu hỏi đúng hướng'},{score:1,criteria:'Nhận ra vấn đề nhưng còn mơ hồ'},{score:0,criteria:'Không xác định được vấn đề'}]}] },
      { kolb:'RO+AC', dur:10, prompt:'HS khám phá — thu thập thông tin — đặt giả thuyết:',
        activities:[{type:'think_write', prompt:'📋 KWL: Em đã BIẾT gì? Muốn TÌM HIỂU gì? Cần HỌC thêm gì?', points:2, bloom:3, solo:3}] },
      { kolb:'AE', dur:15, prompt:'Giải quyết vấn đề theo nhóm / cá nhân:',
        activities:[{type:'open_ai', prompt:'💡 Đề xuất giải pháp của em và lập luận tại sao cách đó hiệu quả:', points:3, bloom:4, solo:4,
          rubric:[{score:3,criteria:'Giải pháp khả thi, có lập luận logic, xét nhiều khía cạnh'},{score:2,criteria:'Giải pháp đúng nhưng lập luận còn thiếu'},{score:1,criteria:'Có ý tưởng nhưng chưa cụ thể'},{score:0,criteria:'Không có giải pháp'}]}] },
      { kolb:'RO', dur:5, prompt:'So sánh giải pháp giữa các nhóm:',
        activities:[{type:'open_ai', prompt:'⚖️ So sánh cách giải của nhóm em với 1 nhóm khác. Cách nào tốt hơn? Vì sao?', points:2, bloom:5, solo:4,
          rubric:[{score:2,criteria:'So sánh có tiêu chí rõ, lập luận có căn cứ'},{score:1,criteria:'So sánh nhưng chưa có tiêu chí rõ'},{score:0,criteria:'Không so sánh được'}]}] },
      { kolb:'AC', dur:2, prompt:'Rút ra quy tắc / công thức / nguyên lý:',
        activities:[{type:'exit_ticket', prompt:'🔑 Từ bài toán hôm nay, em rút ra nguyên tắc gì có thể dùng lại?', points:1, bloom:5, solo:5}] },
    ]},

  { id:'peer_instruction', tier:2, icon:'🗳️', name:'Peer Instruction (Mazur)',
    bloom:[2,4], solo_min:3, duration:25, kolb:'CE+RO',
    desc:'Vote → thảo luận → re-vote',
    stages: [
      { kolb:'CE', dur:3, prompt:'Câu hỏi khái niệm (ConcepTest) — không phải tính toán:',
        activities:[{type:'mcq', prompt:'🎯 ConcepTest: [Câu hỏi về khái niệm — chọn 1 đáp án]', opts:['A.','B.','C.','D.'], correct:'A', points:1, bloom:2, solo:3}] },
      { kolb:'RO', dur:8, prompt:'HS thảo luận cặp — thuyết phục bạn:',
        activities:[{type:'think_write', prompt:'👥 Giải thích cho bạn cùng bàn tại sao em chọn đáp án đó. Bạn phản bác gì?', points:2, bloom:3, solo:4}] },
      { kolb:'CE', dur:2, prompt:'Re-vote sau thảo luận:',
        activities:[{type:'mcq', prompt:'🔄 Re-vote: Sau thảo luận em giữ nguyên hay đổi đáp án?', opts:['A. Vẫn chọn đáp án cũ','B. Đổi sang đáp án khác — đó là: ___','C. Vẫn không chắc'], correct:'A', points:1, bloom:2, solo:3}] },
      { kolb:'AC', dur:10, prompt:'GV giải thích tại sao đáp án đúng — liên hệ khái niệm:',
        activities:[{type:'open_ai', prompt:'💬 Giải thích bằng lời của em tại sao đáp án [X] là đúng và các đáp án khác sai:', points:2, bloom:3, solo:4,
          rubric:[{score:2,criteria:'Giải thích đúng, dùng khái niệm đúng, có thể dạy lại'},{score:1,criteria:'Giải thích đúng nhưng còn thiếu sót'},{score:0,criteria:'Giải thích sai hoặc bỏ trống'}]}] },
      { kolb:'all', dur:2, prompt:'',
        activities:[{type:'exit_ticket', prompt:'Khái niệm em hiểu nhầm trước đây là gì? Bây giờ em hiểu đúng ra sao?', points:1, bloom:3, solo:4}] },
    ]},

  { id:'socratic', tier:2, icon:'🏛️', name:'Socratic Questioning',
    bloom:[3,4], solo_min:3, duration:35, kolb:'RO+AC',
    desc:'Chuỗi câu hỏi dẫn dắt HS tự xây dựng kiến thức',
    stages: [
      { kolb:'CE', dur:5, prompt:'Câu hỏi mở đầu — khai thác prior knowledge:',
        activities:[{type:'think_write', prompt:'❓ Q1 (Làm rõ): "[Khái niệm/hiện tượng]" theo em có nghĩa là gì?', points:1, bloom:1, solo:2}] },
      { kolb:'RO', dur:8, prompt:'Câu hỏi thách thức giả định:',
        activities:[{type:'open_ai', prompt:'🔍 Q2 (Thách thức): Em có chắc không? Điều gì sẽ xảy ra nếu [điều kiện ngược]?', points:2, bloom:3, solo:3,
          rubric:[{score:2,criteria:'Nhận ra giới hạn của giả định và điều chỉnh'},{score:1,criteria:'Bắt đầu nghi ngờ giả định'},{score:0,criteria:'Không xem xét lại'}]}] },
      { kolb:'AC', dur:12, prompt:'Câu hỏi xây dựng kiến thức mới:',
        activities:[{type:'open_ai', prompt:'🧱 Q3 (Xây dựng): Từ những gì em vừa khám phá, em có thể rút ra quy tắc chung nào?', points:3, bloom:4, solo:4,
          rubric:[{score:3,criteria:'Quy tắc chính xác, diễn đạt rõ, có thể áp dụng'},{score:2,criteria:'Quy tắc đúng nhưng chưa đầy đủ'},{score:1,criteria:'Có hướng đúng nhưng còn mơ hồ'},{score:0,criteria:'Không rút ra được'}]}] },
      { kolb:'RO', dur:8, prompt:'Câu hỏi phản chiếu — giá trị và ứng dụng:',
        activities:[{type:'open_ai', prompt:'🌐 Q4 (Ứng dụng): Quy tắc này có thể dùng để giải quyết vấn đề thực tế nào?', points:2, bloom:4, solo:5,
          rubric:[{score:2,criteria:'Ví dụ thực tế cụ thể, kết nối rõ ràng với quy tắc'},{score:1,criteria:'Ví dụ còn mơ hồ'},{score:0,criteria:'Không liên hệ được'}]}] },
      { kolb:'all', dur:2, prompt:'',
        activities:[{type:'exit_ticket', prompt:'Em tự đặt 1 câu hỏi về chủ đề hôm nay mà em muốn khám phá thêm:', points:0, bloom:6, solo:5}] },
    ]},

  { id:'flipped', tier:2, icon:'🔄', name:'Flipped Lesson',
    bloom:[3,5], solo_min:3, duration:30, kolb:'AE',
    desc:'Lý thuyết ở nhà → luyện tập sâu trên lớp',
    stages: [
      { kolb:'CE', dur:5, prompt:'Kiểm tra đã xem video/đọc tài liệu ở nhà:',
        activities:[{type:'mcq', prompt:'📱 Pre-class check: Từ video/tài liệu ở nhà, điều nào SAI?', opts:['A.','B.','C.','D.'], correct:'A', points:1, bloom:2, solo:3}] },
      { kolb:'AC', dur:5, prompt:'Làm rõ điểm còn thắc mắc từ bài ở nhà:',
        activities:[{type:'think_write', prompt:'❓ Điều em chưa hiểu từ bài ở nhà (nếu có):', points:1, bloom:2, solo:2}] },
      { kolb:'AE', dur:12, prompt:'Luyện tập ứng dụng — bài tập phức tạp:',
        activities:[{type:'open_ai', prompt:'🔨 Áp dụng kiến thức vừa học để giải bài toán thực tế:', points:3, bloom:4, solo:4,
          rubric:[{score:3,criteria:'Giải đúng, trình bày logic, có giải thích'},{score:2,criteria:'Giải đúng nhưng thiếu giải thích'},{score:1,criteria:'Có hướng đúng nhưng còn sai'},{score:0,criteria:'Sai hoặc không làm'}]}] },
      { kolb:'RO', dur:6, prompt:'Peer review và thảo luận:',
        activities:[{type:'think_write', prompt:'👁️ Nhìn vào bài của bạn: Em nhận xét gì? Cách nào hay hơn?', points:1, bloom:5, solo:4}] },
      { kolb:'all', dur:2, prompt:'',
        activities:[{type:'exit_ticket', prompt:'So sánh: Học flipped khác gì học truyền thống với em?', points:0, bloom:5, solo:5}] },
    ]},

  { id:'case_study', tier:2, icon:'📂', name:'Case Study',
    bloom:[4,5], solo_min:4, duration:40, kolb:'CE+AC',
    desc:'Phân tích tình huống toán học có trong thực tế',
    stages: [
      { kolb:'CE', dur:8, prompt:'Trình bày CASE — dữ liệu thực tế, ngữ cảnh rõ ràng:',
        activities:[{type:'open_ai', prompt:'🔎 Đọc case study. Xác định: (1) Vấn đề cốt lõi, (2) Dữ liệu có sẵn, (3) Câu hỏi cần trả lời', points:2, bloom:4, solo:4,
          rubric:[{score:2,criteria:'Xác định đủ 3 phần, rõ ràng'},{score:1,criteria:'Xác định được 1-2 phần'},{score:0,criteria:'Không phân tích được'}]}] },
      { kolb:'AC', dur:10, prompt:'Xây dựng mô hình toán học cho case:',
        activities:[{type:'math_input', prompt:'📐 Viết phương trình / hàm số mô tả tình huống trong case:', correct:'', points:3, bloom:4, solo:4}] },
      { kolb:'AE', dur:12, prompt:'Giải và diễn giải kết quả trong ngữ cảnh thực tế:',
        activities:[{type:'open_ai', prompt:'📊 Giải mô hình và giải thích kết quả có nghĩa gì trong thực tế:', points:3, bloom:5, solo:5,
          rubric:[{score:3,criteria:'Giải đúng và diễn giải có ý nghĩa thực tế rõ ràng'},{score:2,criteria:'Giải đúng nhưng diễn giải còn mơ hồ'},{score:1,criteria:'Giải được một phần'},{score:0,criteria:'Không giải được'}]}] },
      { kolb:'RO', dur:8, prompt:'So sánh cách tiếp cận và đánh giá mô hình:',
        activities:[{type:'open_ai', prompt:'⚠️ Mô hình toán học của em có giới hạn / giả định gì? Khi nào nó không áp dụng được?', points:2, bloom:5, solo:5,
          rubric:[{score:2,criteria:'Nhận ra được giới hạn cụ thể, có lập luận'},{score:1,criteria:'Nhận ra giới hạn nhưng chưa rõ'},{score:0,criteria:'Không nhận ra giới hạn'}]}] },
      { kolb:'all', dur:2, prompt:'',
        activities:[{type:'exit_ticket', prompt:'Case study này thay đổi cách em nhìn về ứng dụng của toán học thế nào?', points:0, bloom:5, solo:5}] },
    ]},

  /* TIER 3 */
  { id:'jigsaw', tier:3, icon:'🧩', name:'Jigsaw',
    bloom:[4,5], solo_min:4, duration:50, kolb:'AE+RO',
    desc:'Nhóm chuyên gia → dạy lại nhóm gốc',
    stages: [
      { kolb:'CE', dur:5, prompt:'Giới thiệu chủ đề tổng quát và chia phần chuyên gia:',
        activities:[{type:'think_write', prompt:'Em được phân công tìm hiểu phần: [PHẦN CHUYÊN GIA]. Ghi lại những gì em đã biết về phần này:', points:1, bloom:1, solo:2}] },
      { kolb:'AC', dur:15, prompt:'Nhóm chuyên gia nghiên cứu sâu phần được phân công:',
        activities:[{type:'open_ai', prompt:'📚 Expert phase: Tóm tắt nội dung chính của phần em phụ trách. Bao gồm: khái niệm, ví dụ, điểm dễ nhầm:', points:3, bloom:4, solo:4,
          rubric:[{score:3,criteria:'Đầy đủ khái niệm, ví dụ rõ, nhận ra điểm dễ nhầm'},{score:2,criteria:'Đủ khái niệm và ví dụ'},{score:1,criteria:'Chỉ có khái niệm'},{score:0,criteria:'Thiếu hoặc sai'}]}] },
      { kolb:'AE', dur:15, prompt:'Quay về nhóm gốc — dạy lại các bạn:',
        activities:[{type:'open_ai', prompt:'👩‍🏫 Teaching phase: Giải thích phần của em cho nhóm gốc. Dùng 1 ví dụ cụ thể:', points:3, bloom:5, solo:5,
          rubric:[{score:3,criteria:'Giải thích rõ ràng, ví dụ phù hợp, bạn hiểu được'},{score:2,criteria:'Giải thích đúng nhưng ví dụ chưa rõ'},{score:1,criteria:'Giải thích còn thiếu sót'},{score:0,criteria:'Không truyền đạt được'}]}] },
      { kolb:'RO', dur:12, prompt:'Kiểm tra tổng thể — quiz chéo nhau:',
        activities:[{type:'mcq', prompt:'🧪 Quiz: Câu hỏi về phần do bạn khác phụ trách (kiểm tra bạn dạy tốt không):', opts:['A.','B.','C.','D.'], correct:'A', points:2, bloom:3, solo:4}] },
      { kolb:'all', dur:3, prompt:'',
        activities:[{type:'exit_ticket', prompt:'Điều gì khó nhất khi DẠY lại cho bạn (so với chỉ tự học)?', points:0, bloom:5, solo:5}] },
    ]},

  { id:'argumentation', tier:3, icon:'⚔️', name:'Argumentation / Debate',
    bloom:[4,5], solo_min:4, duration:40, kolb:'RO+AC',
    desc:'Tranh luận có cấu trúc về cách giải / phương án',
    stages: [
      { kolb:'CE', dur:5, prompt:'Đặt LUẬN ĐIỂM tranh luận (2 phía):',
        activities:[{type:'mcq', prompt:'🎭 Bạn đồng ý hay không đồng ý với luận điểm: "[PHÁT BIỂU]"?', opts:['A. Hoàn toàn đồng ý','B. Đồng ý một phần','C. Không đồng ý','D. Cần thêm thông tin'], correct:'A', points:1, bloom:4, solo:4}] },
      { kolb:'AC', dur:10, prompt:'Chuẩn bị lập luận + bằng chứng toán học:',
        activities:[{type:'open_ai', prompt:'📜 Claim-Evidence-Reasoning: Luận điểm của em? Bằng chứng toán học nào ủng hộ? Lập luận như thế nào?', points:3, bloom:5, solo:4,
          rubric:[{score:3,criteria:'Luận điểm rõ, bằng chứng toán học đúng, lập luận logic'},{score:2,criteria:'Luận điểm rõ nhưng bằng chứng chưa đủ'},{score:1,criteria:'Có ý tưởng nhưng chưa có bằng chứng'},{score:0,criteria:'Không có lập luận'}]}] },
      { kolb:'AE', dur:15, prompt:'Phản bác lập luận của phía đối lập:',
        activities:[{type:'open_ai', prompt:'🗡️ Counter-argument: Lập luận phía đối lập là gì? Em phản bác bằng cách nào?', points:3, bloom:5, solo:5,
          rubric:[{score:3,criteria:'Hiểu đúng lập luận đối lập và phản bác có căn cứ'},{score:2,criteria:'Phản bác được nhưng còn yếu'},{score:1,criteria:'Nhận ra lập luận đối lập nhưng không phản bác được'},{score:0,criteria:'Không phản bác được'}]}] },
      { kolb:'RO', dur:8, prompt:'Tổng hợp — đánh giá lập luận cả hai phía:',
        activities:[{type:'open_ai', prompt:'⚖️ Sau tranh luận, quan điểm nào thuyết phục hơn? Vì sao?', points:2, bloom:5, solo:5,
          rubric:[{score:2,criteria:'Đánh giá cân bằng, có tiêu chí rõ'},{score:1,criteria:'Có đánh giá nhưng thiên vị'},{score:0,criteria:'Không đánh giá được'}]}] },
      { kolb:'all', dur:2, prompt:'',
        activities:[{type:'exit_ticket', prompt:'Tranh luận thay đổi quan điểm của em thế nào?', points:0, bloom:5, solo:5}] },
    ]},

  { id:'project_based', tier:3, icon:'🏗️', name:'Project-Based Learning',
    bloom:[5,6], solo_min:5, duration:0, kolb:'all',
    desc:'Dự án thực tế nhiều buổi (3-5 buổi)',
    stages: [
      { kolb:'CE', dur:20, prompt:'Buổi 1 — Khám phá vấn đề & hình thành câu hỏi dự án:',
        activities:[{type:'open_ai', prompt:'🚀 Driving Question: Câu hỏi dự án của nhóm em là gì? Vì sao vấn đề này quan trọng?', points:2, bloom:5, solo:4,
          rubric:[{score:2,criteria:'Câu hỏi có ý nghĩa, có thể nghiên cứu, liên hệ toán học'},{score:1,criteria:'Câu hỏi còn chung chung'},{score:0,criteria:'Chưa hình thành được câu hỏi'}]}] },
      { kolb:'AC', dur:30, prompt:'Buổi 2 — Nghiên cứu & xây dựng mô hình:',
        activities:[{type:'open_ai', prompt:'📊 Thu thập dữ liệu và xây dựng mô hình toán học cho dự án:', points:4, bloom:5, solo:5,
          rubric:[{score:4,criteria:'Dữ liệu đầy đủ, mô hình phù hợp, có giải thích'},{score:3,criteria:'Dữ liệu tốt, mô hình đúng hướng'},{score:2,criteria:'Dữ liệu có nhưng mô hình chưa hoàn chỉnh'},{score:1,criteria:'Mới bắt đầu'},{score:0,criteria:'Chưa làm'}]}] },
      { kolb:'AE', dur:30, prompt:'Buổi 3-4 — Phát triển & kiểm tra giải pháp:',
        activities:[{type:'open_ai', prompt:'🔧 Giải pháp của nhóm: Mô tả cụ thể và trình bày kết quả dự án:', points:4, bloom:6, solo:5,
          rubric:[{score:4,criteria:'Giải pháp sáng tạo, khả thi, kết quả rõ ràng'},{score:3,criteria:'Giải pháp tốt nhưng chưa hoàn chỉnh'},{score:2,criteria:'Có giải pháp nhưng còn nhiều hạn chế'},{score:1,criteria:'Đang phát triển'},{score:0,criteria:'Chưa có giải pháp'}]}] },
      { kolb:'RO', dur:20, prompt:'Buổi 5 — Trình bày & phản hồi:',
        activities:[{type:'open_ai', prompt:'🎤 Phản chiếu dự án: Điều gì hoạt động tốt? Điều gì sẽ làm khác nếu làm lại?', points:2, bloom:6, solo:5,
          rubric:[{score:2,criteria:'Phân tích sâu, rút ra bài học rõ ràng'},{score:1,criteria:'Nhận ra vài điểm'},{score:0,criteria:'Không phản chiếu'}]}] },
      { kolb:'all', dur:10, prompt:'',
        activities:[{type:'exit_ticket', prompt:'Dự án này thay đổi cách em nghĩ về toán học thế nào?', points:0, bloom:6, solo:5}] },
    ]},

  { id:'design_thinking', tier:3, icon:'💡', name:'Design Thinking',
    bloom:[5,6], solo_min:5, duration:0, kolb:'all',
    desc:'Discover → Define → Develop → Deliver',
    stages: [
      { kolb:'CE', dur:15, prompt:'DISCOVER — Đồng cảm với người dùng / vấn đề:',
        activities:[{type:'open_ai', prompt:'🔎 Empathy Map: Người dùng mục tiêu CẦN gì? CẢM thấy gì? NÓI gì? LÀM gì liên quan đến [vấn đề]?', points:2, bloom:5, solo:4,
          rubric:[{score:2,criteria:'Empathy map đầy đủ, có insight thực tế'},{score:1,criteria:'Có một số điểm'},{score:0,criteria:'Không có'}]}] },
      { kolb:'AC', dur:15, prompt:'DEFINE — Xác định vấn đề cốt lõi (Point Of View):',
        activities:[{type:'open_ai', prompt:'🎯 Point of View Statement: "[Người dùng] cần [điều gì] vì [insight]."', points:2, bloom:5, solo:5,
          rubric:[{score:2,criteria:'POV rõ ràng, actionable, có insight sâu'},{score:1,criteria:'POV đúng hướng nhưng chưa sắc bén'},{score:0,criteria:'Chưa xác định được'}]}] },
      { kolb:'AE', dur:20, prompt:'DEVELOP — Ý tưởng và nguyên mẫu (với công cụ toán):',
        activities:[{type:'open_ai', prompt:'🧪 Prototype toán: Xây dựng mô hình/giải pháp bằng toán học cho vấn đề đã xác định:', points:4, bloom:6, solo:5,
          rubric:[{score:4,criteria:'Mô hình toán đúng, sáng tạo, giải quyết được POV'},{score:3,criteria:'Mô hình đúng nhưng chưa tối ưu'},{score:2,criteria:'Có ý tưởng nhưng mô hình chưa hoàn chỉnh'},{score:1,criteria:'Đang phát triển'},{score:0,criteria:'Chưa có'}]}] },
      { kolb:'RO', dur:10, prompt:'DELIVER — Test và nhận phản hồi:',
        activities:[{type:'open_ai', prompt:'📋 Test: Giải pháp của em giải quyết được POV không? Bằng chứng là gì?', points:2, bloom:6, solo:5,
          rubric:[{score:2,criteria:'Test rõ ràng, có bằng chứng, nhận ra điểm cần cải thiện'},{score:1,criteria:'Test có nhưng chưa có bằng chứng'},{score:0,criteria:'Chưa test'}]}] },
      { kolb:'all', dur:0, prompt:'',
        activities:[{type:'exit_ticket', prompt:'Design Thinking giúp em nhìn toán học khác đi thế nào?', points:0, bloom:6, solo:5}] },
    ]},
];

/* ── MATH MODELS ── */
const MATH_MODELS = [
  { id:'katex_inline',   icon:'fas fa-subscript',         label:'Công thức',
    insert: (stage) => addMathActivity(stage, 'katex', '$$f(x) = ax^2 + bx + c$$') },
  { id:'katex_system',   icon:'fas fa-equals',            label:'Hệ PT',
    insert: (stage) => addMathActivity(stage, 'katex', '$$\\begin{cases} 2x + y = 5 \\\\ x - y = 1 \\end{cases}$$') },
  { id:'geogebra',       icon:'fas fa-shapes',            label:'GeoGebra',
    insert: (stage) => addGeoGebraActivity(stage) },
  { id:'number_line',    icon:'fas fa-ruler-horizontal',  label:'Trục số',
    insert: (stage) => addMathActivity(stage, 'number_line', '') },
  { id:'prob_tree',      icon:'fas fa-diagram-project',   label:'Cây xác suất',
    insert: (stage) => addMathActivity(stage, 'katex', '$$P(A \\cap B) = P(A) \\cdot P(B|A)$$') },
  { id:'matrix',         icon:'fas fa-table-cells',       label:'Ma trận',
    insert: (stage) => addMathActivity(stage, 'katex', '$$A = \\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}$$') },
  { id:'integral',       icon:'fas fa-infinity',          label:'Tích phân',
    insert: (stage) => addMathActivity(stage, 'katex', '$$\\int_a^b f(x)\\,dx = F(b) - F(a)$$') },
  { id:'trig',           icon:'fas fa-circle-half-stroke', label:'Lượng giác',
    insert: (stage) => addMathActivity(stage, 'katex', '$$\\sin^2 x + \\cos^2 x = 1$$') },
];

/* ═══════════════════════════════════════════════════════════════
   INIT
   ═══════════════════════════════════════════════════════════════ */
async function init() {
  session = JSON.parse(localStorage.getItem('ae_user') || '{}');
  // Load courses
  const cr = await apiFetch('/admin/courses?limit=100');
  if (cr) {
    const courses = (await cr.json()).list || [];
    const sel = document.getElementById('lp-course');
    courses.forEach(c => {
      const o = document.createElement('option');
      o.value = c.Id || c.id;
      o.textContent = c.Title || c.name;
      sel.appendChild(o);
    });
  }
  // Load 791 data
  await load791Data();
  // Render AL format picker
  renderALPicker();
  // Render math models
  renderMathModels();
  // Render stages
  renderAllStages();
  // Init ILO
  addILO();
  // Init score summary
  updateScoreSummary();
  // Check URL for existing lesson
  const params = new URLSearchParams(location.search);
  if (params.get('lesson_id')) loadExistingLesson(params.get('lesson_id'));
}

async function load791Data() {
  try {
    const r = await fetch('../content/hoclieu_toan.json');
    const d = await r.json();
    std791Data = d.lessons || [];
    build791Filters();
    render791Left();
    render791Main();
  } catch(e) { console.warn('791 data not loaded', e); }
}

/* ═══════════════════════════════════════════════════════════════
   LEFT PANEL
   ═══════════════════════════════════════════════════════════════ */
function toggleLP(head) {
  head.classList.toggle('open');
  const body = head.nextElementSibling;
  body.classList.toggle('open');
}

function renderALPicker() {
  const el = document.getElementById('al-format-body');
  const tiers = [
    { n:1, label:'Tier 1 — Khám phá cơ bản' },
    { n:2, label:'Tier 2 — Vận dụng tích cực' },
    { n:3, label:'Tier 3 — Tư duy bậc cao' },
  ];
  let html = '<div style="margin-bottom:6px"><button class="btn btn-ghost btn-sm" style="width:100%;justify-content:center" onclick="selectALFormat(null)"><i class="fas fa-times"></i> Không chọn format</button></div>';
  tiers.forEach(tier => {
    const fmts = AL_FORMATS.filter(f => f.tier === tier.n);
    html += `<div class="al-tier">${tier.label}</div><div class="al-grid">`;
    fmts.forEach(f => {
      html += `<button class="al-btn" id="al-${f.id}" onclick="selectALFormat('${f.id}')">
        <span class="al-icon">${f.icon}</span>
        <span class="al-name">${f.name}</span>
        <span class="al-meta">${f.desc}</span>
      </button>`;
    });
    html += '</div>';
  });
  el.innerHTML = html;
}

function selectALFormat(id) {
  currentALFormat = id;
  document.querySelectorAll('.al-btn').forEach(b => b.classList.remove('selected'));
  if (id) {
    document.getElementById('al-' + id)?.classList.add('selected');
    const fmt = AL_FORMATS.find(f => f.id === id);
    if (fmt) applyALTemplate(fmt);
  }
}

function applyALTemplate(fmt) {
  if (!confirm(`Áp dụng template "${fmt.name}"? Nội dung hiện tại của 5 stage sẽ được thay thế.`)) return;
  // Update AURA config suggestions
  document.getElementById('rp-bloom').value = fmt.bloom[0] + 1;
  setSolo(fmt.solo_min + 1 <= 5 ? fmt.solo_min + 1 : 5);
  // Apply stage templates
  stages = stagesMeta.map((s, i) => {
    const tmpl = fmt.stages[i] || { kolb: s.kolb, dur: [5,10,12,5,3][i], activities: [] };
    return {
      ...s,
      kolb: tmpl.kolb || s.kolb,
      duration: tmpl.dur || s.duration,
      activities: (tmpl.activities || []).map(a => ({ ...a, id: 'act_' + (++actCounter) }))
    };
  });
  renderAllStages();
  syncVisualToCode();
  showToast(`✅ Đã áp dụng template ${fmt.icon} ${fmt.name}`);
}

function renderMathModels() {
  const el = document.getElementById('math-model-body');
  let html = '<div style="margin-bottom:8px;font-size:11px;color:var(--text-muted)">Chọn stage để chèn:</div>';
  html += '<div class="form-row" style="margin-bottom:8px"><label>Chèn vào Stage</label><select id="mm-target-stage" class="mini" style="width:100%">';
  stages.forEach(s => { html += `<option value="${s.n}">${s.n}. ${s.title}</option>`; });
  html += '</select></div>';
  html += '<div class="math-model-grid">';
  MATH_MODELS.forEach(m => {
    html += `<button class="mm-btn" onclick="insertMathModel('${m.id}')">
      <i class="${m.icon}"></i>${m.label}</button>`;
  });
  html += '</div>';
  el.innerHTML = html;
}

function insertMathModel(id) {
  const stageN = parseInt(document.getElementById('mm-target-stage').value);
  const model = MATH_MODELS.find(m => m.id === id);
  if (model) model.insert(stageN);
}

function addMathActivity(stageN, type, formula) {
  const s = stages[stageN - 1];
  s.activities.push({
    id: 'act_' + (++actCounter),
    type: 'math_display',
    formula,
    katex: true,
    points: 0,
    bloom: parseInt(document.getElementById('rp-bloom').value),
    solo: soloTarget,
  });
  renderAllStages();
}

function addGeoGebraActivity(stageN) {
  const materialId = prompt('Nhập GeoGebra Material ID (từ geogebra.org):', 'xYz12345');
  if (!materialId) return;
  const s = stages[stageN - 1];
  s.activities.push({
    id: 'act_' + (++actCounter),
    type: 'geogebra',
    materialId,
    width: 600, height: 400,
    points: 0,
    bloom: parseInt(document.getElementById('rp-bloom').value),
    solo: soloTarget,
  });
  renderAllStages();
}

/* ═══════════════════════════════════════════════════════════════
   791 BROWSER
   ═══════════════════════════════════════════════════════════════ */
function build791Filters() {
  const grades = [...new Set(std791Data.map(l => l.grade_num))].sort((a,b)=>a-b);
  ['std-grade', 'std-grade-main'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    grades.forEach(g => { el.innerHTML += `<option value="${g}">Lớp ${g}</option>`; });
  });
  const units = [...new Set(std791Data.map(l => l.unit_l1))].sort();
  ['std-unit-main'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    units.forEach(u => { el.innerHTML += `<option value="${u}">${u}</option>`; });
  });
}

function getBloomBadge(b) {
  const map = {1:'badge-bloom1 Nhận biết',2:'badge-bloom2 Thông hiểu',3:'badge-bloom3 Vận dụng',
               4:'badge-bloom4 Phân tích',5:'badge-bloom5 Đánh giá',6:'badge-bloom6 Sáng tạo'};
  const [cls, label] = (map[b]||'badge-gray Khác').split(' ');
  return `<span class="badge ${cls}">${label}</span>`;
}

function filterStd791(searchId, gradeId, bloomId, unitId) {
  const q = (document.getElementById(searchId)?.value || '').toLowerCase();
  const grade = document.getElementById(gradeId)?.value || '';
  const bloom = document.getElementById(bloomId)?.value || '';
  const unit = document.getElementById(unitId)?.value || '';
  return std791Data.filter(l =>
    (!q || l.requirement.toLowerCase().includes(q) || l.lesson_id.includes(q) || (l.unit_l1||'').toLowerCase().includes(q)) &&
    (!grade || l.grade_num == grade) &&
    (!bloom || l.bloom_level == bloom) &&
    (!unit || l.unit_l1 === unit)
  );
}

function render791Left() {
  const list = filterStd791('std-search', 'std-grade', 'std-bloom', '').slice(0, 30);
  const el = document.getElementById('std-list');
  if (!el) return;
  el.innerHTML = list.map(l => `
    <div class="std-card" onclick="use791Lesson('${l.lesson_id}')" title="${l.requirement}">
      <div class="std-id">${l.lesson_id}</div>
      <div class="std-req">${l.requirement.length > 80 ? l.requirement.slice(0,80)+'…' : l.requirement}</div>
      <div class="std-badges">${getBloomBadge(l.bloom_level)}<span class="badge badge-gray">Lớp ${l.grade_num}</span></div>
    </div>`).join('');
}

function render791Main() {
  const list = filterStd791('std-search-main', 'std-grade-main', 'std-bloom-main', 'std-unit-main');
  const el = document.getElementById('std-list-main');
  const ct = document.getElementById('std-count-main');
  if (!el) return;
  if (ct) ct.textContent = `${list.length} / 784 YCCĐ`;
  el.innerHTML = list.slice(0, 100).map(l => `
    <div class="std-card" onclick="use791Lesson('${l.lesson_id}')">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px">
        <div>
          <div class="std-id">${l.lesson_id}</div>
          <div style="font-size:11px;color:var(--text-muted);margin:2px 0">${l.unit_l1} › ${l.unit_l2 || ''}</div>
          <div class="std-req">${l.requirement}</div>
          <div class="std-badges" style="margin-top:4px">
            ${getBloomBadge(l.bloom_level)}
            <span class="badge badge-gray">Lớp ${l.grade_num}</span>
            ${(l.lesson_model_default||[]).map(m=>`<span class="badge badge-gray">${m}</span>`).join('')}
          </div>
        </div>
        <button class="btn btn-primary btn-sm" onclick="event.stopPropagation();use791Lesson('${l.lesson_id}')">Dùng</button>
      </div>
    </div>`).join('');
}

function use791Lesson(id) {
  const l = std791Data.find(x => x.lesson_id === id);
  if (!l) return;
  currentStd = l;
  // Fill fields
  const titleEl = document.getElementById('lesson-title-input');
  if (!titleEl.value) titleEl.value = l.requirement.length > 80 ? l.requirement.slice(0,80) : l.requirement;
  document.getElementById('rp-lesson-id').value = l.lesson_id;
  document.getElementById('rp-bloom').value = l.bloom_level;
  setSolo(Math.min(l.bloom_level + 1, 5));
  const model = l.lesson_model_default?.[0] || 'scaffold';
  document.getElementById('rp-model').value = model;
  // Preview in right panel
  document.getElementById('rp-std-preview').innerHTML =
    `<b>${l.unit_l1}</b>${l.unit_l2 ? ' › '+l.unit_l2 : ''}<br>${l.requirement}`;
  // Auto-suggest AL format based on bloom
  const suggested = bloom2ALFormat(l.bloom_level);
  if (suggested && !currentALFormat) {
    showToast(`💡 Gợi ý format: ${AL_FORMATS.find(f=>f.id===suggested)?.name}`);
  }
  showToast(`✅ Đã chọn chuẩn ${id}`);
  // Switch to soạn bài tab
  switchTab('visual', document.querySelector('.studio-tab'));
}

function bloom2ALFormat(bloom) {
  if (bloom <= 2) return 'think_pair_share';
  if (bloom === 3) return 'worked_example_fading';
  if (bloom === 4) return 'problem_based';
  return 'case_study';
}

function lookupStd791(id) {
  const l = std791Data.find(x => x.lesson_id === id);
  const el = document.getElementById('rp-std-preview');
  if (l) {
    el.innerHTML = `<b>${l.unit_l1}</b><br>${l.requirement}`;
    el.style.color = 'var(--success)';
  } else if (id.length > 8) {
    el.innerHTML = 'Không tìm thấy mã này';
    el.style.color = 'var(--danger)';
  } else {
    el.innerHTML = ''; el.style.color = '';
  }
}

/* ═══════════════════════════════════════════════════════════════
   STAGE & ACTIVITY RENDERING
   ═══════════════════════════════════════════════════════════════ */
const STAGE_COLORS = ['#2563EB','#16A34A','#D97706','#9333EA','#E11D48'];
const KOLB_COLORS  = {'CE':'#3B82F6','RO':'#8B5CF6','AC':'#10B981','AE':'#F59E0B','all':'#6B7280'};

function renderAllStages() {
  const container = document.getElementById('stages-container');
  container.innerHTML = stages.map(s => renderStageCard(s)).join('');
  // Re-render KaTeX
  if (window.renderMathInElement) renderMathInElement(container, { delimiters:[{left:'$$',right:'$$',display:true},{left:'$',right:'$',display:false}], throwOnError:false });
  updateScoreSummary();
}

function renderStageCard(s) {
  const kolbs = s.kolb.split('+').map(k =>
    `<span class="kolb-tag" style="background:${KOLB_COLORS[k]||'#6B7280'}22;color:${KOLB_COLORS[k]||'#6B7280'}">${k}</span>`
  ).join('');
  return `
  <div class="stage-card" id="stage-card-${s.n}">
    <div class="stage-head" style="background:${STAGE_COLORS[s.n-1]}08">
      <div class="stage-num" style="background:${STAGE_COLORS[s.n-1]}">${s.n}</div>
      <div class="stage-title-text">${s.icon} ${s.title}</div>
      ${kolbs}
      <input class="dur-input" type="number" value="${s.duration}" min="1" max="120"
             onchange="stages[${s.n-1}].duration=+this.value;updateScoreSummary()"
             title="Thời gian (phút)" style="margin-left:auto">
      <span style="font-size:11px;color:var(--text-muted)">phút</span>
    </div>
    <div class="stage-body">
      ${s.activities.map(a => renderActivityBlock(a, s.n)).join('')}
      <div class="add-act-row">
        <button class="btn btn-outline btn-sm" onclick="addActivity(${s.n},'mcq')">+ MCQ</button>
        <button class="btn btn-outline btn-sm" onclick="addActivity(${s.n},'numeric')">+ Số học</button>
        <button class="btn btn-outline btn-sm" onclick="addActivity(${s.n},'open_ai')">+ Tự luận AI</button>
        <button class="btn btn-outline btn-sm" onclick="addActivity(${s.n},'think_write')">+ Ghi suy nghĩ</button>
        <button class="btn btn-outline btn-sm" onclick="addActivity(${s.n},'math_input')">+ Nhập toán</button>
      </div>
    </div>
  </div>`;
}

function renderActivityBlock(a, stageN) {
  const typeLabel = {mcq:'MCQ',numeric:'Số học',open_ai:'Tự luận AI',think_write:'Ghi suy nghĩ',
    math_display:'Công thức',geogebra:'GeoGebra',exit_ticket:'Exit Ticket',
    fill_blank:'Điền chỗ trống',math_input:'Nhập toán'}[a.type] || a.type;

  let inner = '';
  if (a.type === 'math_display') {
    inner = `<div class="act-body"><div style="font-family:monospace;font-size:12px;background:#F8FAFC;padding:10px;border-radius:4px;border:1px solid var(--border)">
      <div>${a.formula || ''}</div></div>
      <div style="margin-top:8px;font-size:11px;color:var(--text-muted)">
        Công thức KaTeX — render trong Preview
      </div></div>`;
  } else if (a.type === 'geogebra') {
    inner = `<div class="act-body">
      <div style="background:#EFF6FF;border:1px solid #BFDBFE;border-radius:6px;padding:12px;text-align:center">
        <i class="fas fa-shapes" style="font-size:24px;color:var(--info);display:block;margin-bottom:6px"></i>
        GeoGebra Material: <b>${a.materialId}</b><br>
        <a href="https://www.geogebra.org/m/${a.materialId}" target="_blank" style="font-size:11px">Xem trên GeoGebra</a>
      </div></div>`;
  } else {
    inner = `<div class="act-body">
      <textarea rows="2" placeholder="Nội dung câu hỏi / hướng dẫn..."
                onchange="updateActivity('${a.id}','prompt',this.value)"
                style="margin-bottom:6px">${escHtml(a.prompt||'')}</textarea>
      ${a.type === 'mcq' ? renderMCQOptions(a) : ''}
      ${a.type === 'numeric' ? `<div style="display:flex;gap:8px;align-items:center;margin-top:4px">
        <label style="font-size:11px;color:var(--text-muted)">Đáp án đúng:</label>
        <input type="text" style="width:100px" placeholder="e.g. 4.5"
               value="${escHtml(String(a.correct||''))}"
               onchange="updateActivity('${a.id}','correct',this.value)">
        <label style="font-size:11px;color:var(--text-muted)">±</label>
        <input type="number" style="width:60px" value="${a.tolerance||0.01}" step="0.001"
               onchange="updateActivity('${a.id}','tolerance',+this.value)">
      </div>` : ''}
      ${a.type === 'open_ai' ? renderRubricEditor(a) : ''}
      <div class="act-score-row">
        <label>Điểm: <input type="number" value="${a.points||0}" min="0" max="20"
                onchange="updateActivity('${a.id}','points',+this.value);updateScoreSummary()"></label>
        <label>Bloom: <select onchange="updateActivity('${a.id}','bloom',+this.value)">
          ${[1,2,3,4,5,6].map(b=>`<option value="${b}" ${a.bloom==b?'selected':''}>${b}</option>`).join('')}
        </select></label>
        <label>SOLO: <select onchange="updateActivity('${a.id}','solo',+this.value)">
          ${[1,2,3,4,5].map(v=>`<option value="${v}" ${a.solo==v?'selected':''}>${v}</option>`).join('')}
        </select></label>
        <button class="btn btn-ghost btn-sm" style="color:var(--danger);margin-left:auto"
                onclick="deleteActivity('${a.id}',${stageN})"><i class="fas fa-trash"></i></button>
      </div>
    </div>`;
  }

  return `<div class="activity-block" id="act-${a.id}">
    <div class="act-head">
      <span class="act-type-badge act-type-${a.type}">${typeLabel}</span>
      <span style="font-size:10px;color:var(--text-muted);margin-left:auto">
        B${a.bloom||1} · S${a.solo||2} · ${a.points||0}đ
        ${a.type==='open_ai'?'<span style="background:#F3E8FF;color:#7C3AED;font-size:9px;padding:1px 5px;border-radius:100px;margin-left:4px">AI chấm</span>':''}
      </span>
    </div>
    ${inner}
  </div>`;
}

function renderMCQOptions(a) {
  const opts = a.opts || ['A. ','B. ','C. ','D. '];
  return `<div class="mcq-options">
    ${opts.map((opt, i) => {
      const letter = 'ABCD'[i];
      return `<div class="mcq-option-row">
        <input type="radio" name="correct_${a.id}" value="${letter}"
               ${a.correct===letter?'checked':''}
               onchange="updateActivity('${a.id}','correct','${letter}')">
        <span class="opt-label">${letter}</span>
        <input type="text" style="flex:1" value="${escHtml(opt)}"
               onchange="updateActivityOpt('${a.id}',${i},this.value)"
               placeholder="Đáp án ${letter}...">
      </div>`;
    }).join('')}
    <button class="btn btn-ghost btn-sm" style="font-size:10px" onclick="addMCQOption('${a.id}')">
      <i class="fas fa-plus"></i> Thêm đáp án
    </button>
  </div>`;
}

function renderRubricEditor(a) {
  const rubric = a.rubric || [{score:3,criteria:''},{score:2,criteria:''},{score:1,criteria:''},{score:0,criteria:''}];
  return `<div style="margin-top:8px">
    <div style="font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:6px">
      <i class="fas fa-list-check" style="color:#7C3AED"></i> Rubric chấm AI
    </div>
    ${rubric.map((r,i) => `
      <div style="display:flex;gap:6px;align-items:flex-start;margin-bottom:4px">
        <span style="background:#F3E8FF;color:#7C3AED;font-size:11px;font-weight:700;padding:3px 7px;border-radius:4px;flex-shrink:0">${r.score}đ</span>
        <input type="text" style="flex:1" value="${escHtml(r.criteria)}"
               placeholder="Tiêu chí đạt ${r.score} điểm..."
               onchange="updateRubric('${a.id}',${i},this.value)">
      </div>`).join('')}
  </div>`;
}

function addActivity(stageN, type) {
  const a = {
    id: 'act_' + (++actCounter),
    type,
    prompt: '',
    points: type === 'open_ai' ? 3 : type === 'mcq' ? 1 : 2,
    bloom: parseInt(document.getElementById('rp-bloom').value),
    solo: soloTarget,
  };
  if (type === 'mcq') { a.opts = ['A. ','B. ','C. ','D. ']; a.correct = 'A'; }
  if (type === 'numeric') { a.correct = ''; a.tolerance = 0.01; }
  if (type === 'open_ai') { a.rubric = [{score:3,criteria:''},{score:2,criteria:''},{score:1,criteria:''},{score:0,criteria:''}]; }
  stages[stageN-1].activities.push(a);
  renderAllStages();
}

function deleteActivity(id, stageN) {
  stages[stageN-1].activities = stages[stageN-1].activities.filter(a => a.id !== id);
  renderAllStages();
}

function updateActivity(id, key, val) {
  stages.forEach(s => { const a = s.activities.find(x=>x.id===id); if(a) a[key]=val; });
}

function updateActivityOpt(id, idx, val) {
  stages.forEach(s => { const a = s.activities.find(x=>x.id===id); if(a&&a.opts) a.opts[idx]=val; });
}

function updateRubric(id, idx, val) {
  stages.forEach(s => { const a = s.activities.find(x=>x.id===id); if(a&&a.rubric) a.rubric[idx].criteria=val; });
}

function addMCQOption(id) {
  stages.forEach(s => { const a = s.activities.find(x=>x.id===id); if(a&&a.opts) a.opts.push('E. '); });
  renderAllStages();
}

/* ═══════════════════════════════════════════════════════════════
   AURA CONFIG
   ═══════════════════════════════════════════════════════════════ */
function setSolo(v) {
  soloTarget = v;
  document.querySelectorAll('.solo-dot').forEach(d => {
    d.classList.toggle('active', +d.dataset.v === v);
  });
}

/* ── ILO Builder ── */
function addILO() {
  const bloom = parseInt(document.getElementById('rp-bloom').value) || 3;
  const verbs = BLOOM_VERBS[bloom] || BLOOM_VERBS[3];
  const ilo = { id: 'ilo_' + Date.now(), verb: verbs[0], topic: '', solo: soloTarget };
  iloList.push(ilo);
  renderILOs();
}

function renderILOs() {
  const el = document.getElementById('ilo-list');
  const bloom = parseInt(document.getElementById('rp-bloom').value) || 3;
  const verbs = BLOOM_VERBS[bloom] || BLOOM_VERBS[3];
  el.innerHTML = iloList.map(ilo => `
    <div class="ilo-row">
      <select style="width:90px" onchange="updateILO('${ilo.id}','verb',this.value)">
        ${verbs.map(v=>`<option value="${v}" ${ilo.verb===v?'selected':''}>${v}</option>`).join('')}
      </select>
      <input type="text" placeholder="chủ đề, ngữ cảnh..."
             value="${escHtml(ilo.topic)}"
             onchange="updateILO('${ilo.id}','topic',this.value)">
      <button class="ilo-del" onclick="removeILO('${ilo.id}')">✕</button>
    </div>`).join('');
}

function updateILO(id, key, val) {
  const ilo = iloList.find(i => i.id === id);
  if (ilo) ilo[key] = val;
}

function removeILO(id) {
  iloList = iloList.filter(i => i.id !== id);
  renderILOs();
}

/* ── CA Validator ── */
function validateCA() {
  const checks = [];
  const hasActivities = stages.some(s => s.activities.length > 0);
  if (!hasActivities) {
    checks.push({ cls:'err', icon:'fa-times-circle', text:'Chưa có hoạt động nào trong 5 stage' });
  }
  const hasILO = iloList.length > 0 && iloList.some(i => i.topic);
  if (!hasILO) checks.push({ cls:'warn', icon:'fa-exclamation-triangle', text:'Chưa có ILO rõ ràng' });
  else checks.push({ cls:'ok', icon:'fa-check-circle', text:`${iloList.length} ILO đã định nghĩa` });

  const totalPoints = stages.flatMap(s=>s.activities).reduce((sum,a)=>sum+(a.points||0),0);
  if (totalPoints === 0) checks.push({ cls:'warn', icon:'fa-exclamation-triangle', text:'Tổng điểm = 0' });
  else checks.push({ cls:'ok', icon:'fa-check-circle', text:`Tổng điểm: ${totalPoints}đ` });

  const hasHighBloom = stages.flatMap(s=>s.activities).some(a => (a.bloom||0) >= 4);
  if (!hasHighBloom) checks.push({ cls:'warn', icon:'fa-exclamation-triangle', text:'Chưa có hoạt động Bloom 4-6 (phân tích, đánh giá, sáng tạo)' });
  else checks.push({ cls:'ok', icon:'fa-check-circle', text:'Có hoạt động bậc tư duy cao (Bloom ≥ 4)' });

  const hasAIScore = stages.flatMap(s=>s.activities).some(a => a.type === 'open_ai');
  if (hasAIScore) checks.push({ cls:'ok', icon:'fa-robot', text:'Có câu hỏi tự luận — AI AURA sẽ chấm' });

  const soloMax = Math.max(...stages.flatMap(s=>s.activities).map(a=>a.solo||1), 1);
  if (soloMax < soloTarget) checks.push({ cls:'warn', icon:'fa-exclamation-triangle', text:`SOLO target ${soloTarget} nhưng hoạt động cao nhất S${soloMax}` });
  else checks.push({ cls:'ok', icon:'fa-check-circle', text:`SOLO max: ${soloMax} ≥ target ${soloTarget}` });

  document.getElementById('ca-checks').innerHTML = checks.map(c => `
    <div class="ca-check ${c.cls}">
      <i class="fas ${c.icon}" style="color:${c.cls==='ok'?'var(--success)':c.cls==='warn'?'var(--warning)':'var(--danger)'}"></i>
      <span>${c.text}</span>
    </div>`).join('');
}

function updateScoreSummary() {
  const acts = stages.flatMap(s => s.activities);
  const total = acts.reduce((s,a) => s+(a.points||0), 0);
  const aiCount = acts.filter(a => a.type === 'open_ai' || a.type === 'exit_ticket').length;
  const autoCount = acts.filter(a => ['mcq','numeric','fill_blank','true_false'].includes(a.type)).length;
  const totalDur = stages.reduce((s,st) => s+st.duration, 0);
  document.getElementById('score-summary').innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      <div style="text-align:center;padding:10px;background:var(--bg);border-radius:6px">
        <div style="font-size:20px;font-weight:700;color:var(--primary)">${total}</div>
        <div style="font-size:10px;color:var(--text-muted)">Tổng điểm</div>
      </div>
      <div style="text-align:center;padding:10px;background:var(--bg);border-radius:6px">
        <div style="font-size:20px;font-weight:700;color:var(--info)">${totalDur}</div>
        <div style="font-size:10px;color:var(--text-muted)">phút</div>
      </div>
      <div style="text-align:center;padding:10px;background:#F0FDF4;border-radius:6px">
        <div style="font-size:18px;font-weight:700;color:var(--success)">${autoCount}</div>
        <div style="font-size:10px;color:var(--text-muted)">Auto-score</div>
      </div>
      <div style="text-align:center;padding:10px;background:#FDF4FF;border-radius:6px">
        <div style="font-size:18px;font-weight:700;color:#7C3AED">${aiCount}</div>
        <div style="font-size:10px;color:var(--text-muted)">AI chấm</div>
      </div>
    </div>
    <div style="margin-top:10px;font-size:11px;color:var(--text-muted)">
      ${acts.length} hoạt động · ${stages.filter(s=>s.activities.length>0).length}/5 stage có nội dung
    </div>`;
}

/* ═══════════════════════════════════════════════════════════════
   HTML EXPORT (AURA Schema)
   ═══════════════════════════════════════════════════════════════ */
function buildAURAHTML() {
  const title = document.getElementById('lesson-title-input').value || 'Bài học';
  const lessonId = document.getElementById('rp-lesson-id').value || '';
  const bloom = document.getElementById('rp-bloom').value;
  const model = document.getElementById('rp-model').value;
  const ktype = document.querySelector('input[name=ktype]:checked')?.value || 'declarative';
  const threshold = document.getElementById('rp-threshold').checked ? 1 : 0;
  const alFmt = currentALFormat || '';
  const totalPts = stages.flatMap(s=>s.activities).reduce((sum,a)=>sum+(a.points||0),0);
  const totalDur = stages.reduce((s,st)=>s+st.duration,0);
  const ilosJSON = JSON.stringify(iloList.map(i=>({solo:soloTarget,verb:i.verb,topic:i.topic})));

  let html = `<article class="aura-lesson"
  data-lesson-id="${escAttr(lessonId)}"
  data-al-format="${escAttr(alFmt)}"
  data-bloom="${bloom}"
  data-solo-target="${soloTarget}"
  data-knowledge-type="${ktype}"
  data-threshold="${threshold}"
  data-lesson-model="${escAttr(model)}"
  data-total-points="${totalPts}"
  data-estimated-minutes="${totalDur}"
  data-subject="toan">
  <meta name="aura:title" content="${escAttr(title)}">
  <meta name="aura:ilos" content='${escAttr(ilosJSON)}'>
`;

  stages.forEach(s => {
    if (s.activities.length === 0) return;
    html += `\n  <!-- Stage ${s.n}: ${s.title} -->\n`;
    html += `  <section class="aura-stage" data-stage="${s.n}" data-kolb="${s.kolb}" data-duration="${s.duration}">\n`;
    html += `    <h3 class="aura-stage-title" style="background:${STAGE_COLORS[s.n-1]}">${s.icon} Stage ${s.n} — ${s.title}</h3>\n`;
    s.activities.forEach(a => {
      html += buildActivityHTML(a, s.n);
    });
    html += `  </section>\n`;
  });

  html += `\n</article>`;
  return html;
}

function buildActivityHTML(a, stageN) {
  const qid = `s${stageN}_${a.id}`;
  const base = `    <div class="aura-q" data-qid="${qid}" data-type="${a.type}" data-bloom="${a.bloom||1}" data-solo="${a.solo||2}" data-points="${a.points||0}"`;

  if (a.type === 'math_display') {
    return `    <div class="aura-math" data-katex="true">\n      ${escHtml(a.formula||'')}\n    </div>\n`;
  }
  if (a.type === 'geogebra') {
    return `    <div class="aura-geogebra" data-material-id="${a.materialId}" data-width="${a.width}" data-height="${a.height}"></div>\n`;
  }
  if (a.type === 'mcq') {
    const opts = (a.opts||['A.','B.','C.','D.']).map((opt,i)=>{
      const letter='ABCD'[i];
      return `      <label class="aura-option"><input type="radio" name="${qid}" value="${letter}"> ${escHtml(opt)}</label>`;
    }).join('\n');
    return `${base} data-correct="${escAttr(a.correct||'A')}">\n      <p>${escHtml(a.prompt||'')}</p>\n      <div class="aura-options">\n${opts}\n      </div>\n    </div>\n`;
  }
  if (a.type === 'numeric') {
    return `${base} data-correct="${a.correct}" data-tolerance="${a.tolerance||0.01}">\n      <p>${escHtml(a.prompt||'')}</p>\n      <input class="aura-input" type="text" data-qid="${qid}" placeholder="Nhập kết quả...">\n    </div>\n`;
  }
  if (a.type === 'open_ai') {
    const rubricJSON = JSON.stringify(a.rubric||[]).replace(/'/g,'&#39;');
    return `${base} data-rubric='${rubricJSON}'>\n      <p>${escHtml(a.prompt||'')}</p>\n      <textarea class="aura-input" data-qid="${qid}" rows="4" placeholder="Viết câu trả lời của em..."></textarea>\n    </div>\n`;
  }
  if (a.type === 'math_input') {
    return `${base}>\n      <p>${escHtml(a.prompt||'')}</p>\n      <input class="aura-math-input" type="text" data-qid="${qid}" placeholder="Nhập biểu thức toán...">\n    </div>\n`;
  }
  // think_write, exit_ticket, fill_blank
  return `${base}>\n      <p>${escHtml(a.prompt||'')}</p>\n      <textarea class="aura-input" data-qid="${qid}" rows="3" placeholder="Viết câu trả lời của em..."></textarea>\n    </div>\n`;
}

/* ═══════════════════════════════════════════════════════════════
   TABS & PREVIEW
   ═══════════════════════════════════════════════════════════════ */
function switchTab(name, el) {
  document.querySelectorAll('.studio-tab').forEach(t=>t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t=>{ t.style.display='none'; });
  el?.classList.add('active');
  const tab = document.getElementById('tab-' + name);
  if (tab) { tab.style.display = name === 'code' ? 'flex' : (name === 'visual' || name === 'std791' ? 'block' : 'block'); }

  if (name === 'code') { syncVisualToCode(); tab.style.display='flex'; tab.style.flexDirection='column'; }
  if (name === 'preview') { syncVisualToCode(); renderPreview(); }
  if (name === 'std791') { render791Main(); }
}

function syncVisualToCode() {
  const el = document.getElementById('code-editor');
  if (el) el.value = buildAURAHTML();
}

function syncCodeToVisual() {
  showToast('⚠️ Parse HTML → Visual coming soon. Dùng Code tab để chỉnh sửa trực tiếp.');
}

function renderPreview() {
  const html = document.getElementById('code-editor')?.value || buildAURAHTML();
  const container = document.getElementById('preview-container');
  container.innerHTML = buildPreviewHTML(html);
  // Render KaTeX
  if (window.renderMathInElement) {
    renderMathInElement(container, {
      delimiters: [{left:'$$',right:'$$',display:true},{left:'$',right:'$',display:false}],
      throwOnError: false
    });
  }
  // Embed GeoGebra
  container.querySelectorAll('.aura-geogebra').forEach(el => {
    const id = el.dataset.materialId;
    const w = el.dataset.width || 600, h = el.dataset.height || 400;
    el.innerHTML = `<iframe src="https://www.geogebra.org/material/iframe/id/${id}/width/${w}/height/${h}/border/888888/sfsb/true/smb/false/stb/false/stbh/false/ai/false/asb/false/sri/false/rc/false/ld/false/sdz/false/ctl/false"
      width="${w}" height="${h}" style="border:1px solid #ccc;border-radius:6px"></iframe>`;
  });
}

function buildPreviewHTML(auraHTML) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(auraHTML, 'text/html');
  const lesson = doc.querySelector('.aura-lesson') || doc.body;
  const title = document.getElementById('lesson-title-input').value || 'Bài học';

  let out = `<div style="max-width:720px;margin:0 auto">
    <h2 style="margin-bottom:4px;color:var(--text)">${escHtml(title)}</h2>
    <div style="font-size:12px;color:var(--text-muted);margin-bottom:20px">
      ${currentALFormat ? `<span style="background:#FFF7ED;color:var(--warning);padding:2px 8px;border-radius:100px;font-weight:600">${AL_FORMATS.find(f=>f.id===currentALFormat)?.icon} ${AL_FORMATS.find(f=>f.id===currentALFormat)?.name}</span>` : ''}
      SOLO Target: ${soloTarget} · Bloom: ${document.getElementById('rp-bloom')?.value}
    </div>`;

  stages.forEach(s => {
    if (s.activities.length === 0) return;
    out += `<div class="aura-stage-preview">
      <div class="aura-stage-head" style="background:${STAGE_COLORS[s.n-1]}">
        ${s.icon} Stage ${s.n} — ${s.title}
        <span style="float:right;font-size:11px;opacity:.8">${s.kolb} · ${s.duration}p</span>
      </div>
      <div style="padding:12px 16px">`;
    s.activities.forEach((a,i) => {
      out += buildPreviewActivity(a, `s${s.n}_${a.id}`, i);
    });
    out += '</div></div>';
  });
  out += '</div>';
  return out;
}

function buildPreviewActivity(a, qid, idx) {
  const aiChip = (a.type==='open_ai'||a.type==='exit_ticket') ? '<span class="score-chip ai"><i class="fas fa-robot"></i> AI chấm</span>' : `<span class="score-chip">${a.points}đ</span>`;

  if (a.type === 'math_display') {
    return `<div class="aura-math-display">${a.formula||''}</div>`;
  }
  if (a.type === 'geogebra') {
    return `<div class="aura-geogebra" data-material-id="${a.materialId}" data-width="${a.width}" data-height="${a.height}" style="margin:10px 0"></div>`;
  }
  if (a.type === 'mcq') {
    const opts = (a.opts||['A.','B.','C.','D.']).map((opt,i) =>
      `<label class="aura-options-preview"><input type="radio" name="prev_${qid}" value="${'ABCD'[i]}"> ${escHtml(opt)}</label>`
    ).join('');
    return `<div class="aura-q-preview"><p>${escHtml(a.prompt||'')}${aiChip}</p><div class="aura-options-preview">${opts}</div></div>`;
  }
  if (a.type === 'numeric' || a.type === 'math_input') {
    return `<div class="aura-q-preview"><p>${escHtml(a.prompt||'')}${aiChip}</p><input class="aura-input-preview" type="text" placeholder="Nhập kết quả..."></div>`;
  }
  return `<div class="aura-q-preview"><p>${escHtml(a.prompt||'')}${aiChip}</p><textarea class="aura-input-preview" rows="${a.type==='open_ai'?4:2}" placeholder="Viết câu trả lời..."></textarea></div>`;
}

/* ═══════════════════════════════════════════════════════════════
   SAVE / PUBLISH / EXPORT
   ═══════════════════════════════════════════════════════════════ */
async function saveDraft() {
  await saveLesson('draft');
}
async function publishLesson() {
  validateCA();
  await saveLesson('published');
}

async function saveLesson(status) {
  const title = document.getElementById('lesson-title-input').value;
  if (!title) { showToast('Nhập tên bài học trước', 'error'); return; }
  const htmlContent = buildAURAHTML();
  const courseId = document.getElementById('lp-course').value;
  const bloom = parseInt(document.getElementById('rp-bloom').value);
  const model = document.getElementById('rp-model').value;
  const ktype = document.querySelector('input[name=ktype]:checked')?.value||'declarative';
  const lessonId = document.getElementById('rp-lesson-id').value;
  const payload = {
    Title: title, Status: status,
    LessonId: lessonId, BloomLevel: bloom, SoloTarget: soloTarget,
    LessonModel: model, KnowledgeType: ktype,
    AlFormat: currentALFormat||'',
    ThresholdConcept: document.getElementById('rp-threshold').checked ? 1 : 0,
    HtmlContent: htmlContent,
    CourseId: courseId,
    ILOs: JSON.stringify(iloList),
    EstimatedMinutes: stages.reduce((s,st)=>s+st.duration,0),
    TotalPoints: stages.flatMap(s=>s.activities).reduce((sum,a)=>sum+(a.points||0),0),
  };
  const r = await apiFetch('/api/lessons', { method:'POST', body: JSON.stringify(payload) });
  if (r?.ok) {
    document.getElementById('lesson-status-badge').textContent = status==='published'?'Đã đăng':'Nháp';
    document.getElementById('lesson-status-badge').className = `top-badge ${status==='published'?'published':'draft'}`;
    showToast(status==='published'?'🚀 Đã đăng bài!':'💾 Đã lưu nháp');
  } else {
    showToast('Lỗi lưu bài. Kiểm tra console.', 'error');
  }
}

function exportHTML() {
  const html = buildAURAHTML();
  const blob = new Blob([html], { type:'text/html' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = (document.getElementById('lesson-title-input').value||'lesson')+'.html';
  a.click(); URL.revokeObjectURL(url);
}

function previewLesson() {
  syncVisualToCode();
  switchTab('preview', document.querySelectorAll('.studio-tab')[2]);
}

function generateWithAI() {
  const std = currentStd;
  if (!std) { showToast('Chọn chuẩn QĐ 791 trước', 'error'); return; }
  showToast('✨ AI đang soạn bài... (cần kết nối AURA API)');
  // TODO: POST /api/ai/lesson-generate
}

function openParser791() {
  showToast('📥 Tính năng import file QĐ 791 sắp có');
}

function importJSON() {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = '.json';
  input.onchange = async e => {
    try {
      const text = await e.target.files[0].text();
      const data = JSON.parse(text);
      if (data.stages) { stages = data.stages; renderAllStages(); showToast('✅ Import thành công'); }
    } catch { showToast('File JSON không hợp lệ', 'error'); }
  };
  input.click();
}

function clearAll() {
  if (!confirm('Xoá tất cả nội dung? Không thể khôi phục.')) return;
  stages = stagesMeta.map(s => ({ ...s, duration:[5,10,12,5,3][s.n-1], activities:[] }));
  iloList = []; currentALFormat = null; currentStd = null;
  document.getElementById('lesson-title-input').value = '';
  document.querySelectorAll('.al-btn').forEach(b=>b.classList.remove('selected'));
  renderAllStages(); renderILOs(); updateScoreSummary();
}

/* ═══════════════════════════════════════════════════════════════
   UTILS
   ═══════════════════════════════════════════════════════════════ */
function escHtml(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escAttr(s) {
  return String(s||'').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

async function apiFetch(path, opts={}) {
  const token = localStorage.getItem(TOKEN_KEY);
  try {
    return await fetch(PROXY + path, {
      ...opts,
      headers: { 'Content-Type':'application/json', Authorization:`Bearer ${token}`, ...(opts.headers||{}) }
    });
  } catch(e) { console.error('apiFetch', path, e); return null; }
}

let _toastTimer;
function showToast(msg, type='success') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.style.background = type==='error' ? '#DC2626' : '#1E293B';
  el.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

/* ── BOOT ── */
document.addEventListener('DOMContentLoaded', init);
