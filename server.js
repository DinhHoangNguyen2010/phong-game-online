
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

app.use(express.json({ limit: '20kb' }));

// ================= 1. PHỤC VỤ GIAO DIỆN =================
const publicDir = path.join(__dirname, 'public');
const indexPath = path.join(publicDir, 'index.html');

app.get('/', (req, res) => {
    if (!fs.existsSync(indexPath)) {
        console.error('Không tìm thấy:', indexPath);
        return res.status(500).send(
            'Không tìm thấy public/index.html. Hãy kiểm tra cấu hình Render.'
        );
    }
    res.sendFile(indexPath);
});

app.get('/healthz', (req, res) => {
    res.status(200).send('OK');
});

app.use(express.static(publicDir));
app.use('/public', express.static(publicDir));

// ================= 2. KẾT NỐI MONGODB =================
const mongoURI = process.env.MONGO_URI ||
    (process.env.RENDER ? '' : 'mongodb://127.0.0.1:27017/phonggame');

if (mongoURI) {
    mongoose.connect(mongoURI, {
        serverSelectionTimeoutMS: 10000
    })
    .then(() => console.log('Đã kết nối MongoDB!'))
    .catch(err => console.error('Lỗi MongoDB:', err.message));
} else {
    console.error('THIẾU MONGO_URI. Hãy thêm biến này trong Render > Environment.');
}

mongoose.connection.on('disconnected', () => {
    console.warn('MongoDB đã ngắt kết nối.');
});

const userSchema = new mongoose.Schema({
    username: {
        type: String,
        required: true,
        unique: true,
        trim: true
    },
    password: {
        type: String,
        required: true
    }
});

const User = mongoose.model('User', userSchema);

// ================= 3. ĐĂNG KÝ =================
app.post('/api/register', async (req, res) => {
    if (mongoose.connection.readyState !== 1) {
        return res.status(503).json({
            success: false,
            message: 'Cơ sở dữ liệu chưa kết nối. Hãy kiểm tra MONGO_URI.'
        });
    }

    try {
        const { username, password } = req.body || {};

        if (
            typeof username !== 'string' ||
            typeof password !== 'string' ||
            username.trim().length < 3 ||
            password.length < 4
        ) {
            return res.status(400).json({
                success: false,
                message: 'Tên tài khoản tối thiểu 3 ký tự, mật khẩu tối thiểu 4 ký tự!'
            });
        }

        const cleanUsername = username.trim();

        const existingUser = await User.findOne({
            username: cleanUsername
        });

        if (existingUser) {
            return res.status(400).json({
                success: false,
                message: 'Tài khoản đã tồn tại!'
            });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        await new User({
            username: cleanUsername,
            password: hashedPassword
        }).save();

        return res.json({
            success: true,
            message: 'Đăng ký thành công!'
        });
    } catch (err) {
        if (err && err.code === 11000) {
            return res.status(400).json({
                success: false,
                message: 'Tài khoản đã tồn tại!'
            });
        }

        console.error('Lỗi đăng ký:', err.message);
        return res.status(500).json({
            success: false,
            message: 'Lỗi server khi đăng ký!'
        });
    }
});

// ================= 4. ĐĂNG NHẬP =================
app.post('/api/login', async (req, res) => {
    if (mongoose.connection.readyState !== 1) {
        return res.status(503).json({
            success: false,
            message: 'Cơ sở dữ liệu chưa kết nối. Hãy kiểm tra MONGO_URI.'
        });
    }

    try {
        const { username, password } = req.body || {};

        if (
            typeof username !== 'string' ||
            typeof password !== 'string'
        ) {
            return res.status(400).json({
                success: false,
                message: 'Vui lòng nhập tài khoản và mật khẩu!'
            });
        }

        const user = await User.findOne({
            username: username.trim()
        });

        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(400).json({
                success: false,
                message: 'Sai thông tin đăng nhập!'
            });
        }

        return res.json({
            success: true,
            username: user.username
        });
    } catch (err) {
        console.error('Lỗi đăng nhập:', err.message);
        return res.status(500).json({
            success: false,
            message: 'Lỗi server khi đăng nhập!'
        });
    }
});

// ================= 5. QUẢN LÝ PHÒNG =================
const rooms = {};

io.on('connection', (socket) => {
    console.log('Người chơi kết nối:', socket.id);

    socket.emit('room_list_update', Object.values(rooms));

    // Tạo phòng
    socket.on('create_room', (data = {}) => {
        const roomName = data.roomName;
        const username = typeof data.username === 'string'
            ? data.username.trim()
            : '';
        const requestedMaxPlayers = Number(data.maxPlayers) || 2;

        if (!username) {
            return socket.emit('error_msg', 'Vui lòng đăng nhập trước!');
        }

        const roomId = 'room_' + Math.random().toString(36).slice(2, 11);

        rooms[roomId] = {
            id: roomId,
            name: roomName || `Phòng của ${username}`,
            host: username,
            maxPlayers: Math.min(Math.max(requestedMaxPlayers, 1), 2),
            players: [{
                id: socket.id,
                username,
                isReady: true,
                charIndex: 0
            }],
            status: 'waiting',
            subMode: 'pvp_solo'
        };

        socket.join(roomId);
        socket.roomId = roomId;
        socket.username = username;

        socket.emit('room_joined', rooms[roomId]);
        io.emit('room_list_update', Object.values(rooms));
    });

    // Đổi chế độ chơi
    socket.on('update_room_mode', (data = {}) => {
        const room = rooms[socket.roomId];
        if (!room || room.status === 'playing') return;

        const player = room.players.find(p => p.id === socket.id);
        const subMode = data.subMode;

        const validModes = [
            'pvp_solo',
            'pvp_coop',
            'pve_bot_easy',
            'pve_bot_hard'
        ];

        if (!player || player.username !== room.host) return;
        if (!validModes.includes(subMode)) return;

        room.subMode = subMode;
        room.maxPlayers = subMode.startsWith('pve_bot') ? 1 : 2;

        if (room.players.length > room.maxPlayers) {
            return socket.emit('error_msg', 'Phòng đang có quá nhiều người cho chế độ này!');
        }

        io.to(room.id).emit('room_update', room);
        io.emit('room_list_update', Object.values(rooms));
    });

    // Tham gia phòng
    socket.on('join_room', (data = {}) => {
        const roomId = data.roomId;
        const username = typeof data.username === 'string'
            ? data.username.trim()
            : '';

        const room = rooms[roomId];

        if (!username) {
            return socket.emit('error_msg', 'Vui lòng đăng nhập trước!');
        }

        if (!room) {
            return socket.emit('error_msg', 'Phòng không tồn tại!');
        }

        if (socket.roomId) {
            return socket.emit('error_msg', 'Bạn đang ở trong một phòng khác!');
        }

        if (room.status === 'playing') {
            return socket.emit('error_msg', 'Trận đấu đang diễn ra!');
        }

        if (room.players.length >= room.maxPlayers) {
            return socket.emit('error_msg', 'Phòng đã đầy hoặc đang ở chế độ chơi với Bot!');
        }

        if (room.players.some(p => p.username === username)) {
            return socket.emit('error_msg', 'Tên người chơi đã có trong phòng!');
        }

        room.players.push({
            id: socket.id,
            username,
            isReady: false,
            charIndex: 1
        });

        socket.join(roomId);
        socket.roomId = roomId;
        socket.username = username;

        socket.emit('room_joined', room);
        io.to(roomId).emit('room_update', room);
        io.emit('room_list_update', Object.values(rooms));
    });

    // Sẵn sàng / hủy sẵn sàng
    socket.on('toggle_ready', () => {
        const room = rooms[socket.roomId];
        if (!room || room.status === 'playing') return;

        const player = room.players.find(p => p.id === socket.id);

        if (player && player.username !== room.host) {
            player.isReady = !player.isReady;
            io.to(room.id).emit('room_update', room);
        }
    });

    // Bắt đầu trận đấu
    socket.on('start_game', () => {
        const room = rooms[socket.roomId];
        if (!room || room.status === 'playing') return;

        const player = room.players.find(p => p.id === socket.id);
        if (!player || player.username !== room.host) return;

        const isPvE = room.subMode.startsWith('pve_bot');
        const canStart = isPvE ||
            (
                room.players.length === 2 &&
                room.players.every(p =>
                    p.username === room.host || p.isReady
                )
            );

        if (!canStart) {
            return socket.emit(
                'error_msg',
                'Chưa đủ người chơi hoặc đối thủ chưa sẵn sàng!'
            );
        }

        room.status = 'playing';

        io.to(room.id).emit('game_started', {
            room,
            subMode: room.subMode,
            p1SocketId: room.players[0].id,
            p2SocketId: room.players[1]
                ? room.players[1].id
                : null
        });

        io.emit('room_list_update', Object.values(rooms));
    });

    // Kết thúc trận
    socket.on('game_over', () => {
        const room = rooms[socket.roomId];
        if (!room || room.status !== 'playing') return;

        room.status = 'waiting';

        room.players.forEach(p => {
            if (p.username !== room.host) {
                p.isReady = false;
            }
        });

        io.to(room.id).emit('room_update', room);
        io.emit('room_list_update', Object.values(rooms));
    });

    // ================= 6. ĐỒNG BỘ TRONG TRẬN =================
    socket.on('player_move', (data) => {
        if (!socket.roomId || !rooms[socket.roomId]) return;

        socket.to(socket.roomId).emit('remote_player_move', {
            socketId: socket.id,
            ...data
        });
    });

    socket.on('player_action', (data) => {
        if (!socket.roomId || !rooms[socket.roomId]) return;

        socket.to(socket.roomId).emit('remote_player_action', {
            socketId: socket.id,
            ...data
        });
    });

    socket.on('take_damage', (data) => {
        if (!socket.roomId || !rooms[socket.roomId]) return;
        socket.to(socket.roomId).emit('sync_health', data);
    });

    socket.on('player_shoot', (data) => {
        if (!socket.roomId || !rooms[socket.roomId]) return;
        socket.to(socket.roomId).emit('remote_player_shoot', data);
    });

    socket.on('player_trap', (data) => {
        if (!socket.roomId || !rooms[socket.roomId]) return;
        socket.to(socket.roomId).emit('remote_player_trap', data);
    });

    socket.on('spawn_box', (data) => {
        if (!socket.roomId || !rooms[socket.roomId]) return;
        socket.to(socket.roomId).emit('sync_spawn_box', data);
    });

    // Rời phòng
    socket.on('leave_room', () => {
        handleLeaveRoom(socket);
    });

    // Mất kết nối
    socket.on('disconnect', () => {
        handleLeaveRoom(socket);
        console.log('Người chơi ngắt kết nối:', socket.id);
    });
});

// ================= 7. XỬ LÝ RỜI PHÒNG =================
function handleLeaveRoom(socket) {
    const roomId = socket.roomId;
    if (!roomId || !rooms[roomId]) return;

    const room = rooms[roomId];

    room.players = room.players.filter(p => p.id !== socket.id);

    if (room.players.length === 0) {
        delete rooms[roomId];
    } else {
        if (room.host === socket.username) {
            room.host = room.players[0].username;
            room.players[0].isReady = true;
        }

        if (room.status === 'playing') {
            room.status = 'waiting';
            room.players.forEach(p => {
                if (p.username !== room.host) p.isReady = false;
            });
        }

        io.to(roomId).emit('room_update', room);
    }

    socket.leave(roomId);
    socket.roomId = null;

    io.emit('room_list_update', Object.values(rooms));
}

// ================= 8. KHỞI ĐỘNG SERVER =================
const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server chạy tại cổng ${PORT}`);
});
