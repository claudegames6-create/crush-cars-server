const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" } // Permite conexiones desde cualquier sitio web o localhost
});

const rooms = {}; // Guarda el estado de las salas activas

// Función para generar un código de sala único como CC-7K9P2
function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 5; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return `CC-${code}`;
}

io.on('connection', (socket) => {
    console.log(`Piloto conectado: ${socket.id}`);

    // 1. CREAR SALA PRIVADA
    socket.on('create_room', (data) => {
        const roomCode = generateRoomCode();
        rooms[roomCode] = {
            config: data.config, // "DUELO" o "AMIGOS Y BOTS"
            players: {}
        };
        
        socket.join(roomCode);
        socket.roomCode = roomCode;
        
        // Añadir al creador de la sala
        rooms[roomCode].players[socket.id] = {
            name: data.playerName,
            avatar: data.avatar,
            car: data.car,
            ready: false
        };

        socket.emit('room_created', { roomCode, roomData: rooms[roomCode] });
    });

    // 2. UNIRSE A UNA SALA EXISTENTE
    socket.on('join_room', (data) => {
        const roomCode = data.roomCode.toUpperCase();
        
        if (rooms[roomCode]) {
            socket.join(roomCode);
            socket.roomCode = roomCode;
            
            rooms[roomCode].players[socket.id] = {
                name: data.playerName,
                avatar: data.avatar,
                car: data.car,
                ready: false
            };

            // Notificar a todos en la sala del nuevo jugador
            io.to(roomCode).emit('room_updated', rooms[roomCode]);
        } else {
            socket.emit('error_message', 'La sala no existe o el código es incorrecto.');
        }
    });

    // 3. CAMBIAR ESTADO DE "LISTO" O ACTUALIZAR COCHE
    socket.on('update_player_status', (data) => {
        const roomCode = socket.roomCode;
        if (roomCode && rooms[roomCode] && rooms[roomCode].players[socket.id]) {
            rooms[roomCode].players[socket.id].ready = data.ready;
            rooms[roomCode].players[socket.id].car = data.car;
            
            io.to(roomCode).emit('room_updated', rooms[roomCode]);
        }
    });

    // 4. EMPEZAR LA CARRERA
    socket.on('start_race', () => {
        const roomCode = socket.roomCode;
        if (roomCode && rooms[roomCode]) {
            io.to(roomCode).emit('race_started');
        }
    });

    // 5. SINCRONIZACIÓN DE LA CARRERA (Tiempo Real: Posiciones, Nitro, Habilidades)
    socket.on('drive_update', (driveData) => {
        // Retransmite los datos de conducción a todos los demás jugadores de la misma sala
        if (socket.roomCode) {
            socket.to(socket.roomCode).emit('player_moved', {
                id: socket.id,
                x: driveData.x,
                y: driveData.y,
                speed: driveData.speed,
                nitro: driveData.nitro,
                ability: driveData.ability
            });
        }
    });

    // 6. DESCONEXIÓN DEL JUGADOR
    socket.on('disconnect', () => {
        const roomCode = socket.roomCode;
        if (roomCode && rooms[roomCode]) {
            delete rooms[roomCode].players[socket.id];
            
            // Si la sala se queda vacía, la eliminamos de la memoria
            if (Object.keys(rooms[roomCode].players).length === 0) {
                delete rooms[roomCode];
            } else {
                io.to(roomCode).emit('room_updated', rooms[roomCode]);
            }
        }
        console.log(`Piloto desconectado: ${socket.id}`);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor de Crush Cars corriendo 24/7 en el puerto ${PORT}`);
});
