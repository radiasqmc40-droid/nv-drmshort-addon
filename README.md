# Nuvio DramaExpress Addon 1.8.6-test

Bản test 1.8.6-test dùng để kiểm tra kết nối outbound từ Abasthan tới Internet và DramaExpress.

## Endpoints

- `/health` — kiểm tra addon đang chạy.
- `/debug-network` — kiểm tra kết nối từ Abasthan tới Internet, DramaExpress homepage và Upgrade Episode 1.
- `/debug-upstream` — kiểm tra upstream DramaExpress.
- `/manifest.json` — manifest của addon.

## Mục đích

Bản này ưu tiên chẩn đoán network trước khi tiếp tục sửa resolver/player.

Các phép kiểm tra outbound có timeout ngắn để tránh endpoint debug tự treo quá lâu.
