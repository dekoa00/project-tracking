# Project Tracking - OneDrive Manual Raw Flow

Bản này giữ **OneDrive staged-safe flow**, nhưng bỏ bước refresh/sync từ file **Tổng hợp**.

## Ý chính

```txt
tracking_raw.xlsx trong OneDrive
→ bạn tự nhập dữ liệu vào sheet 1. raw
→ bot copy tracking_raw.xlsx sang folder tạm ngoài OneDrive
→ bot đọc sheet 1. raw
→ bot tạo tracking_result.xlsx tạm
→ mirror result vào sheet 3. result của tracking_raw tạm
→ copy tracking_result.xlsx + tracking_raw.xlsx về OneDrive đúng 1 lần cuối
→ OneDrive upload file final lên cloud
```

Không còn bước:

```txt
Refresh workbook link / Power Query từ file Tổng hợp
```

## Chạy lần đầu

```bat
install.bat
```

`install.bat` sẽ cài Node packages, Playwright/Microsoft Edge support và Python env cho CMA/RCL.

Nếu máy mới chỉ lỗi CMA/RCL kiểu `env missing selenium`, chạy riêng:

```bat
setup-python-carriers.bat
```

Bản này mặc định:

```json
"autoSetupPythonCarriers": true,
"pythonSetupNonFatal": true
```

Nghĩa là khi chạy `run.bat`, nếu chưa có `.venv-cma` thì bot sẽ tự thử setup CMA/RCL. Nếu máy chưa có Python 3.11, flow vẫn chạy tiếp cho các carrier khác; riêng CMA/RCL sẽ báo lỗi env cho tới khi setup thành công.

## Chạy bot

```bat
run.bat
```

Chạy silent cho Task Scheduler:

```bat
run_silent.bat
```

Task Scheduler có thể gọi:

```bat
run_daily_0730.bat
```

## File Excel cần có

Mặc định `config.json` dùng:

```json
{
  "inputWorkbookPath": "%OneDrive%\\TRACKING\\tracking_raw.xlsx",
  "inputSheetName": "1. raw",
  "outputWorkbookPath": "%OneDrive%\\TRACKING\\tracking_result.xlsx",
  "outputSheetName": "Tracking_Result",
  "mirrorOutputSheetName": "3. result"
}
```

`%OneDrive%` sẽ tự lấy OneDrive path của máy hiện tại. Nếu máy đó không nhận đúng path, sửa thẳng thành path thật, ví dụ:

```json
"inputWorkbookPath": "D:\\OneDrive\\TRACKING\\tracking_raw.xlsx",
"outputWorkbookPath": "D:\\OneDrive\\TRACKING\\tracking_result.xlsx"
```

## Sheet input: `1. raw`

Bot sẽ đọc các cột này trong sheet `1. raw`:

```txt
BKG | BL NO. | TRACKING NUMBER | CARRIER
```

Có thể có thêm cột khác, bot sẽ bỏ qua.

Nên format cột `TRACKING NUMBER` là **Text** trước khi nhập/paste để tránh Excel đổi số dài thành dạng `2.35502E+11`.

## Sheet output

Bot ghi ra:

```txt
tracking_result.xlsx / Tracking_Result
tracking_raw.xlsx / 3. result
```

## Carrier bị bỏ qua

Mặc định bỏ qua:

```json
"ignoredCarriers": ["VESSEL", "0"]
```

Vessel/charter tracking thủ công, không cho bot xử lý.

## Lưu ý để tránh OneDrive merge conflict

- Không mở `tracking_raw.xlsx` hoặc `tracking_result.xlsx` khi bot đang chạy.
- Nếu đang bị Merge Conflict, resolve trước rồi chạy lại.
- Folder/file tracking nên chọn **Always keep on this device**.
- Trong OneDrive Settings, nên dùng **Download all files** thay vì để file cloud-only.

## WHL/Wan Hai note

Bản này đã tăng wait và thêm fallback cho Wan Hai input form. Nếu WHL vẫn báo `query input not found`, thường là site Wan Hai đang đổi layout, bị security check, hoặc máy mới chưa load được Edge/Playwright đúng cách. Chạy `install.bat` một lần trên máy mới trước.

## Carriers đang hỗ trợ

```txt
MSC, EMC, ONE, SIT, YML, KMT, IAL, MSK, WHL, CMA, RCL
```
