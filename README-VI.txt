EGO FUTSAL - DIRECT WEBRTC OPTION
================================

MUC DICH
- Them nut WebRTC truc tiep vao man hinh tao/vao phong.
- WebRTC DataChannel gui input va snapshot truc tiep giua hai may khi NAT cho phep.
- Render van phuc vu file game; Render WebSocket gateway van la phuong an du phong.

CAC FILE
- Ego-Futsal-Neutral-Server.html: giao dien game co nut WebRTC truc tiep.
- server.js: gateway hien tai (giu nguyen, chi dung khi chon Render relay).
- package.json: cau hinh Node.

CAP NHAT GITHUB
1. Giai nen ZIP.
2. Trong repository ego-futsal-server, thay file o thu muc goc:
   Ego-Futsal-Neutral-Server.html
   server.js (ban nay la gateway hien tai; neu khong muon thay thi giu server.js dang chay)
   package.json (giu file hien co neu no da dung)
3. Commit changes.
4. Render -> Manual Deploy -> Deploy latest commit.

CACH CHOI WEBRTC
- Ca hai nguoi mo CUNG link Render cua game.
- Ca hai chon Choi online -> nhap cung ma phong.
- Chu phong bam "Ket noi truc tiep · WebRTC" de mo phong.
- Nguoi choi 2 bam "Vao truc tiep · WebRTC" voi cung ma.
- Khi ket noi thanh cong, gameplay chay tren WebRTC DataChannel truc tiep; khong di qua Render cho moi goi toa do va bong.
- Neu WebRTC khong ket noi duoc, ca hai quay lai chon "Qua Render (du phong)"; ca hai phai chon cung mot kieu.

GIOI HAN
- WebRTC direct chi giam do tre neu ket noi ICE chon duoc candidate truc tiep (host/srflx).
- Neu bi NAT/firewall chan va phai dung TURN relay, do tre co the van cao.
- Game van dung host-authoritative simulation: may tao phong xu ly vat ly bong, va cham, ban thang.
- Chua phai dedicated authoritative server. RTT 700ms qua Render khong the duoc sua bang CSS/FPS.
