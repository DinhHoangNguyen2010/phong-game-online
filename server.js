const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static('public'));

// Kết nối cơ sở dữ liệu MongoDB (Cục bộ)
const mongoURI = process.env.MONGO_URI || 'mongodb://localhost:27017/phonggame';
mongoose.connect(mongoURI)
    .then(() => console.log('Đã kết nối cơ sở dữ liệu MongoDB thành công!'))
    .catch(err => console.log('Lỗi kết nối DB:', err));

// Định nghĩa cấu trúc tài khoản người dùng
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true }
});
const User = mongoose.model('User', userSchema);

// API Đăng ký tài khoản
app.post('/api/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        const existingUser = await User.findOne({ username });
        if (existingUser) {
            return res.status(400).json({ success: false, message: 'Tên tài khoản đã tồn tại!' });
        }
        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = new User({ username, password: hashedPassword });
        await newUser.save();
        res.json({ success: true, message: 'Đăng ký thành công!' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Lỗi server khi đăng ký.' });
    }
});

// API Đăng nhập tài khoản
app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = await User.findOne({ username });
        if (!user) {
            return res.status(400).json({ success: false, message: 'Sai tên đăng nhập hoặc mật khẩu!' });
        }
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(400).json({ success: false, message: 'Sai tên đăng nhập hoặc mật khẩu!' });
        }
        res.json({ success: true, message: 'Đăng nhập thành công!', username: user.username });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Lỗi server khi đăng nhập.' });
    }
});

// Xử lý kết nối thời gian thực qua Socket.io giữa các người chơi
io.on('connection', (socket) => {
    console.log('Người chơi đã kết nối mạng:', socket.id);

    socket.on('playerAction', (data) => {
        socket.broadcast.emit('remoteAction', data);
    });

    socket.on('disconnect', () => {
        console.log('Người chơi đã thoát game:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Máy chủ đang chạy tại http://localhost:${PORT}`);
});