# NV Drama Short 1.9.0

Bản 1.9.0 ưu tiên nguồn phát public từ các provider short-drama thông qua một public REST gateway, thay vì phụ thuộc vào việc DramaExpress phải expose player trực tiếp.

## Public playback providers

- DramaBox
- FlareFlow
- FlickReels
- GoodShort
- JoyReels
- KalosTV
- MoboReels
- NetShort
- Reelshort
- Stardust
- ShortWave

Khi mở một tập, addon lấy tên phim từ ID/slug, tìm phim tương ứng trên các provider public ở trên, lấy stream của đúng episode rồi trả URL stream cho Nuvio. Nếu không tìm được public source, addon mới fallback về resolver DramaExpress cũ.

## Giữ danh sách source DramaExpress

Danh sách catalog gốc vẫn giữ các source đã yêu cầu:
DramaBox, FlareFlow, FlickReels, GoodShort, JoyReels, KalosTV, MoboReels, MoreShort, MyDramaWave, NetShort, PetaDrama, Reelshort, Shortical, ShortTV, ShortWave, Stardust, StoryReel.

FlexTV không được thêm.

## Lưu ý

Nguồn public gateway hiện không có đủ cả 17 provider trên; 11 provider ở trên có public playback API. Các provider còn lại vẫn được giữ trong danh sách DramaExpress nhưng chưa được giả mạo URL playback khi không có nguồn public tương ứng.

Node 20+, PORT từ môi trường, bind 0.0.0.0.
