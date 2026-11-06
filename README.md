# Giới Thiệu
Ứng dụng được xây dựng nhằm mục tiêu xây dựng được phần mềm quản lý cho một cơ sở kinh doanh quy mô nhỏ lẻ. Được áp dụng thực tế cho cơ sở kinh doanh Rooftopbar DragonBall.
# Tính lương

Ứng dụng Windows tính lương tuần (T6–CN) từ Google Sheet đăng ký ca, xuất bảng lương và danh sách chuyển khoản theo mẫu ngân hàng.

## Cài và dùng lần đầu

1. Tải `TinhLuong-Setup.exe` mới nhất ở mục Releases của repo và chạy. Windows có thể hiện "Windows protected your PC" vì bộ cài chưa ký số: bấm **More info → Run anyway**.
2. Trang **Nhân viên**: nhập đơn giá giờ, ngày bắt đầu đi làm (cho chuyên cần), tài khoản ngân hàng.
   Có thể bấm **Xuất file mẫu tài khoản**, điền 4 cột rồi **Nhập tài khoản từ Excel**.
3. Google Sheet: bật chia sẻ **Bất kỳ ai có đường liên kết – Người xem** (hoặc dùng Service account trong Cài đặt).
4. Trang **Tuần lương** mỗi tuần:
   dán link tab tuần đó → **Đồng bộ Google Sheet** → ghi mưa / bưng đồ / tai nạn theo từng ngày →
   **Tính lương** → **Xác nhận lương & xuất 2 file Excel**.

File xuất nằm ở `Documents\TinhLuong\<năm>\`:
- `BangLuong_06-11-2026_08-11-2026.xlsx` (Tổng hợp, Chi tiết, Ca làm)
- `DanhSachThanhToan_06-11-2026_08-11-2026.xlsx` (đúng mẫu ngân hàng)
## Quy tắc đang áp dụng

| Khoản | Quy tắc |
| --- | --- |
| Lương giờ | Giờ làm × đơn giá riêng từng người (theo ngày hiệu lực) |
| Ca 22h30–24h | Người được gán ở trang Nhân viên, vào 16:00–17:00 và ra 24:00: 1,5h × 40.000 thay cho đơn giá thường |
| Tiền ăn | 30.000 nếu vào 16:00–17:00 hoặc ra 24:00, còn lại 10.000 |
| Tiền xăng | 10.000 mỗi ngày đi làm |
| Cộng cố định | Người được gán: +80.000 (sửa được từng người) mỗi ngày đi làm |
| Mưa | Ướt quần hoặc áo 20.000, ướt toàn thân 50.000 (tối đa 1 lần/ngày, không cộng dồn) |
| Bưng ghế/bàn/đá, tai nạn nhỏ | 20.000 mỗi lần |
| Chuyên cần | Người được gán: 200.000 mỗi chu kỳ 4 tuần tính từ ngày bắt đầu đi làm; nghỉ (off hoặc ô trống) quá 1 ngày thì mất; tuần quán đóng cửa không đếm; trả vào lương tuần thứ 4 |

Mọi mức tiền sửa được ở trang **Cài đặt**; người được hưởng sửa ở trang **Nhân viên**.

## Mã QR chuyển khoản (từ bản 1.1.0)

Sau khi xác nhận lương, trang Tuần lương hiện mã VietQR cho từng người, đã cố định số tiền và nội dung.
Quét bằng app ngân hàng, kiểm tra tên người nhận, rồi bấm **Đánh dấu đã chuyển**.
File `BangLuong_…xlsx` có thêm sheet **QR chuyển khoản**. File `DanhSachThanhToan_…xlsx` giữ nguyên để tải lên ngân hàng.
