const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static('public'));

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
        const { username, password } = req.body;
        if (await User.findOne({ username })) {
            return res.status(400).json({ success: false, message: 'Tài khoản đã tồn tại!' });
        }
        const hashedPassword = await bcrypt.hash(password, 10);
        await new User({ username, password: hashedPassword }).save();
        res.json({ success: true, message: 'Đăng ký thành công!' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Lỗi server' });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = await User.findOne({ username });
        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(400).json({ success: false, message: 'Sai thông tin đăng nhập!' });
        }
        res.json({ success: true, username: user.username });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Lỗi server' });
    }
});

// ================= HỆ THỐNG CƠ CHẾ PHÒNG (LIKE XARENA) =================
const rooms = {}; // Lưu trữ danh sách phòng đang hoạt động

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Gửi danh sách phòng cho người dùng vừa vào Lobby
    socket.emit('room_list_update', Object.values(rooms));
// Thêm đoạn này vào bên trong io.on('connection', (socket) => { ... })

// 5.1. Đồng bộ vị trí di chuyển
socket.on('player_move', (data) => {
    if (socket.roomId) {
        socket.to(socket.roomId).emit('remote_player_move', {
            socketId: socket.id,
            ...data
        });
    }
});

// 5.2. Đồng bộ hành động tấn công (Đấm / Đá / Bắn)
socket.on('player_action', (data) => {
    if (socket.roomId) {
        socket.to(socket.roomId).emit('remote_player_action', {
            socketId: socket.id,
            ...data
        });
    }
});

// 5.3. Đồng bộ sát thương / trừ máu khi có người dính đòn
socket.on('take_damage', (data) => {
    if (socket.roomId) {
        // Gửi thông tin cập nhật máu cho người chơi còn lại trong phòng
        socket.to(socket.roomId).emit('sync_health', data);
    }
});
    // 1. Tạo phòng mới
    socket.on('create_room', ({ roomName, maxPlayers, username }) => {
        const roomId = 'room_' + Math.random().toString(36).substr(2, 9);
        rooms[roomId] = {
            id: roomId,
            name: roomName || `Phòng của ${username}`,
            host: username,
            maxPlayers: maxPlayers || 2,
            players: [{ id: socket.id, username, isReady: true, charIndex: 0 }],
            status: 'waiting' // waiting | playing
        };

        socket.join(roomId);
        socket.roomId = roomId;

        socket.emit('room_joined', rooms[roomId]);
        io.emit('room_list_update', Object.values(rooms));
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

        socket.emit('room_joined', room);
        io.to(roomId).emit('room_update', room);
        io.emit('room_list_update', Object.values(rooms));
    });

    // 3. Đổi trạng thái Ready / Đổi tướng
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
    // 4. Host bắt đầu trận đấu (Thay thế đoạn start_game cũ trong server.js)
socket.on('start_game', () => {
    const room = rooms[socket.roomId];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (player && player.username === room.host) {
        room.status = 'playing';
        
        // Gửi thông báo bắt đầu kèm theo danh sách ID ai là P1 (host), ai là P2 (khách)
        io.to(room.id).emit('game_started', {
            room: room,
            p1SocketId: room.players[0].id,
            p2SocketId: room.players[1] ? room.players[1].id : null
        });
        
        io.emit('room_list_update', Object.values(rooms));
    }
});

    // 5. Đồng bộ hành động khi đang chơi (In-Game Sync)
    socket.on('player_input', (data) => {
        if (socket.roomId) {
            socket.to(socket.roomId).emit('remote_player_input', {
                socketId: socket.id,
                ...data
            });
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
        // Nếu Host rời phòng, chuyển Host cho người kế tiếp
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
server.listen(PORT, () => {
    console.log(`Server chạy tại http://localhost:${PORT}`);
});