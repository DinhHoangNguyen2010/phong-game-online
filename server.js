const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());

// Phục vụ giao diện game tại trang chủ.
const publicDir = path.join(__dirname, 'public');
const indexPath = path.join(publicDir, 'index.html');
app.get('/', (req, res) => {
    if (!fs.existsSync(indexPath)) {
        console.error('Không tìm thấy index.html tại:', indexPath);
        return res.status(500).send('Lỗi cấu hình: không tìm thấy index.html. Hãy kiểm tra Root Directory trên Render.');
    }
    res.sendFile(indexPath);
});

app.get('/healthz', (req, res) => res.status(200).send('OK'));
app.use(express.static(publicDir));
// Hỗ trợ cả đường dẫn /public/... nếu giao diện đang dùng đường dẫn kiểu cũ.
app.use('/public', express.static(publicDir));

// Báo lỗi rõ ràng thay vì trang Not Found trống nếu URL không tồn tại.
app.use((req, res) => res.status(404).send(`Not Found: ${req.method} ${req.originalUrl}`));

// Kết nối DB MongoDB
const mongoURI = process.env.MONGO_URI || 'mongodb://localhost:27017/phonggame';
mongoose.connect(mongoURI)
    .then(() => console.log('Đã kết nối MongoDB!'))
    .catch(err => console.log('Lỗi DB:', err));

const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true }
});
const User = mongoose.model('User', userSchema);

// API Đăng ký / Đăng nhập
app.post('/api/register', async (req, res) => {
    try {
        const { username, password } = req.body || {};
        if (typeof username !== 'string' || typeof password !== 'string' || username.trim().length < 3 || password.length < 4) {
            return res.status(400).json({ success: false, message: 'Tên tài khoản tối thiểu 3 ký tự, mật khẩu tối thiểu 4 ký tự!' });
        }
        const cleanUsername = username.trim();
        if (await User.findOne({ username: cleanUsername })) {
            return res.status(400).json({ success: false, message: 'Tài khoản đã tồn tại!' });
        }
        const hashedPassword = await bcrypt.hash(password, 10);
        await new User({ username: cleanUsername, password: hashedPassword }).save();
        res.json({ success: true, message: 'Đăng ký thành công!' });
    } catch (err) {
        if (err && err.code === 11000) return res.status(400).json({ success: false, message: 'Tài khoản đã tồn tại!' });
        res.status(500).json({ success: false, message: 'Lỗi server' });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body || {};
        if (typeof username !== 'string' || typeof password !== 'string') {
            return res.status(400).json({ success: false, message: 'Vui lòng nhập tài khoản và mật khẩu!' });
        }
        const user = await User.findOne({ username: username.trim() });
        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(400).json({ success: false, message: 'Sai thông tin đăng nhập!' });
        }
        res.json({ success: true, username: user.username });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Lỗi server' });
    }
});

// ================= HỆ THỐNG CƠ CHẾ PHÒNG & SOCKET.IO =================
const rooms = {}; // Lưu trữ danh sách phòng đang hoạt động

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Gửi danh sách phòng cho người dùng vừa vào Lobby
    socket.emit('room_list_update', Object.values(rooms));

    // 1. Tạo phòng mới
    socket.on('create_room', ({ roomName, maxPlayers, username }) => {
    const roomId = 'room_' + Math.random().toString(36).substr(2, 9);
    rooms[roomId] = {
        id: roomId,
        name: roomName || `Phòng của ${username}`,
        host: username,
        maxPlayers: maxPlayers || 2,
        players: [{ id: socket.id, username, isReady: true, charIndex: 0 }],
        status: 'waiting',
        subMode: 'pvp_solo' // <--- THÊM DÒNG NÀY VÀO ĐỂ LƯU CHẾ ĐỘ MẶC ĐỊNH
    };

    socket.join(roomId);
    socket.roomId = roomId;
    socket.username = username;

    socket.emit('room_joined', rooms[roomId]);
    io.emit('room_list_update', Object.values(rooms));
});
// Thêm sự kiện này để Host thay đổi chế độ chơi trong phòng
socket.on('update_room_mode', ({ subMode }) => {
    const room = rooms[socket.roomId];
    if (!room) return;
    
    const player = room.players.find(p => p.id === socket.id);
    // Chỉ có Chủ phòng (Host) mới có quyền đổi chế độ chơi
    if (player && player.username === room.host && ['pvp_solo', 'pvp_coop'].includes(subMode)) {
        room.subMode = subMode;
        io.to(room.id).emit('room_update', room); // Gửi thông tin mới cho tất cả người chơi trong phòng
    }
});
    // 2. Tham gia phòng (Join Room)
    socket.on('join_room', ({ roomId, username }) => {
        const room = rooms[roomId];
        if (!room) return socket.emit('error_msg', 'Phòng không tồn tại!');
        if (room.players.length >= room.maxPlayers) return socket.emit('error_msg', 'Phòng đã đầy!');
        if (room.status === 'playing') return socket.emit('error_msg', 'Trận đấu đang diễn ra!');

        room.players.push({ id: socket.id, username, isReady: false, charIndex: 1 });
        socket.join(roomId);
        socket.roomId = roomId;
        socket.username = username;

        socket.emit('room_joined', room);
        io.to(roomId).emit('room_update', room);
        io.emit('room_list_update', Object.values(rooms));
    });

    // 3. Đổi trạng thái Ready
    socket.on('toggle_ready', () => {
        const room = rooms[socket.roomId];
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if (player && player.username !== room.host) {
            player.isReady = !player.isReady;
            io.to(room.id).emit('room_update', room);
        }
    });

    // 4. Host bắt đầu trận đấu
socket.on('start_game', () => {
    const room = rooms[socket.roomId];
    if (!room) return;
    
    const player = room.players.find(p => p.id === socket.id);
    // Chỉ Host mới có quyền bấm bắt đầu game
    if (player && player.username === room.host && room.players.length >= 2 && room.players.every(p => p.username === room.host || p.isReady)) {
        room.status = 'playing';
        
        // <--- BỔ SUNG subMode: room.subMode VÀO ĐÂY ĐỂ TRUYỀN XUỐNG MÁY KHÁCH
        io.to(room.id).emit('game_started', {
            room: room,
            subMode: room.subMode, 
            p1SocketId: room.players[0].id,
            p2SocketId: room.players[1] ? room.players[1].id : null
        });
        
        io.emit('room_list_update', Object.values(rooms));
    }
});

    // ==========================================
    // 5. ĐỒNG BỘ TRONG TRẬN ĐẤU (IN-GAME SYNC)
    // ==========================================

    // 5.1. Đồng bộ vị trí di chuyển
    socket.on('player_move', (data) => {
        if (socket.roomId) {
            socket.to(socket.roomId).emit('remote_player_move', {
                socketId: socket.id,
                ...data
            });
        }
    });

    // 5.2. Đồng bộ hành động tấn công (Đấm / Đá)
    socket.on('player_action', (data) => {
        if (socket.roomId) {
            socket.to(socket.roomId).emit('remote_player_action', {
                socketId: socket.id,
                ...data
            });
        }
    });

    // 5.3. Đồng bộ sát thương / trừ máu
    socket.on('take_damage', (data) => {
        if (socket.roomId) {
            socket.to(socket.roomId).emit('sync_health', data);
        }
    });

    // 5.4. Đồng bộ bắn súng
    socket.on('player_shoot', (data) => {
        if (socket.roomId) {
            socket.to(socket.roomId).emit('remote_player_shoot', data);
        }
    });

    // 5.5. Đồng bộ đặt bẫy lưới
    socket.on('player_trap', (data) => {
        if (socket.roomId) {
            socket.to(socket.roomId).emit('remote_player_trap', data);
        }
    });

    // 5.6. Đồng bộ sinh hộp vật phẩm (từ Host)
    socket.on('spawn_box', (data) => {
        if (socket.roomId) {
            socket.to(socket.roomId).emit('sync_spawn_box', data);
        }
    });

    // 6. Rời phòng / Ngắt kết nối
    socket.on('leave_room', () => {
        handleLeaveRoom(socket);
    });

    socket.on('disconnect', () => {
        handleLeaveRoom(socket);
    });
});

function handleLeaveRoom(socket) {
    const roomId = socket.roomId;
    if (!roomId || !rooms[roomId]) return;

    const room = rooms[roomId];
    room.players = room.players.filter(p => p.id !== socket.id);

    if (room.players.length === 0) {
        delete rooms[roomId];
    } else {
        if (room.host === socket.username && room.players.length > 0) {
            room.host = room.players[0].username;
            room.players[0].isReady = true;
        }
        io.to(roomId).emit('room_update', room);
    }

    socket.leave(roomId);
    socket.roomId = null;
    io.emit('room_list_update', Object.values(rooms));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server đang chạy trên cổng ${PORT}`);
    console.log('Thư mục chạy:', __dirname);
    console.log('index.html tồn tại:', fs.existsSync(indexPath));
});