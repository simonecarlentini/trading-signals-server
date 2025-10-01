// ============================================
// TRADING SIGNALS SERVER
// ============================================

require('dotenv').config();
const express = require('express');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;

// Middleware
app.use(cors());
app.use(express.json());
// Servi l'app web
app.use(express.static('app'));

// Storage in memoria (per iniziare)
const users = new Map();
const signals = [];
const positions = new Map();
const activeConnections = new Map();

// ============================================
// AUTHENTICATION
// ============================================

app.post('/api/auth/login', async (req, res) => {
    try {
        const { accountNumber, password } = req.body;
        
        console.log('Login attempt:', accountNumber);
        
        let user = users.get(accountNumber);
        
        if (!user) {
            // Crea utente demo per test
            const hashedPassword = await bcrypt.hash(password, 10);
            user = {
                accountNumber,
                password: hashedPassword,
                broker: 'Demo',
                isDemo: true,
                createdAt: Date.now()
            };
            users.set(accountNumber, user);
            console.log('New user created:', accountNumber);
        }
        
        const isValid = await bcrypt.compare(password, user.password);
        
        if (!isValid) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        const token = jwt.sign(
            { accountNumber, broker: user.broker },
            JWT_SECRET,
            { expiresIn: '7d' }
        );
        
        console.log('Login successful:', accountNumber);
        
        res.json({
            token,
            accountNumber,
            broker: user.broker
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Login failed' });
    }
});

// Middleware autenticazione
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) {
        return res.status(401).json({ error: 'Access denied' });
    }
    
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ error: 'Invalid token' });
        }
        req.user = user;
        next();
    });
};

// ============================================
// SIGNALS API
// ============================================

app.get('/api/signals', authenticateToken, (req, res) => {
    const recentSignals = signals.filter(s => 
        Date.now() - s.timestamp < 3600000
    );
    console.log(`Sending ${recentSignals.length} signals`);
    res.json(recentSignals);
});

// Ricevi segnali da MT4
app.post('/api/signals', express.json(), (req, res) => {
    try {
        const { apiKey, signal } = req.body;
        
        if (apiKey !== process.env.MT4_API_KEY) {
            return res.status(401).json({ error: 'Invalid API key' });
        }
        
        const newSignal = {
            id: Date.now().toString(),
            pair: signal.pair,
            action: signal.action,
            rsi: signal.rsi,
            macd: signal.macd,
            strength: signal.strength,
            quality: signal.quality,
            timestamp: Date.now()
        };
        
        signals.push(newSignal);
        
        if (signals.length > 50) {
            signals.shift();
        }
        
        console.log('New signal:', newSignal.pair, newSignal.action);
        
        broadcastSignal(newSignal);
        
        res.json({ success: true, signalId: newSignal.id });
    } catch (error) {
        console.error('Signal error:', error);
        res.status(500).json({ error: 'Failed to process signal' });
    }
});

// ============================================
// POSITIONS API
// ============================================

app.get('/api/positions', authenticateToken, (req, res) => {
    const accountNumber = req.user.accountNumber;
    const userPositions = Array.from(positions.values())
        .filter(p => p.accountNumber === accountNumber);
    
    console.log(`User ${accountNumber} has ${userPositions.length} positions`);
    res.json(userPositions);
});

// ============================================
// TRADING API
// ============================================

app.post('/api/trade/open', authenticateToken, async (req, res) => {
    try {
        const { pair, type, lots, stopLoss, takeProfit } = req.body;
        const accountNumber = req.user.accountNumber;
        
        console.log(`Opening trade: ${pair} ${type} ${lots} lots for ${accountNumber}`);
        
        const positionId = Date.now().toString();
        const position = {
            id: positionId,
            accountNumber,
            pair,
            type,
            lots,
            entryPrice: type === 'BUY' ? 3893.45 : 3893.20,
            currentPrice: 3893.45,
            profit: 0,
            stopLoss,
            takeProfit,
            openTime: Date.now()
        };
        
        positions.set(positionId, position);
        
        broadcastPosition(position, accountNumber);
        
        res.json({ success: true, positionId });
    } catch (error) {
        console.error('Trade error:', error);
        res.status(500).json({ error: 'Failed to execute trade' });
    }
});

app.post('/api/trade/close/:positionId', authenticateToken, async (req, res) => {
    try {
        const { positionId } = req.params;
        const accountNumber = req.user.accountNumber;
        
        const position = positions.get(positionId);
        
        if (!position || position.accountNumber !== accountNumber) {
            return res.status(404).json({ error: 'Position not found' });
        }
        
        console.log(`Closing position ${positionId} for ${accountNumber}`);
        
        positions.delete(positionId);
        
        res.json({ success: true });
    } catch (error) {
        console.error('Close trade error:', error);
        res.status(500).json({ error: 'Failed to close position' });
    }
});

// ============================================
// WEBSOCKET SERVER
// ============================================

const server = app.listen(PORT, () => {
    console.log('================================================');
    console.log('🚀 TRADING SIGNALS SERVER STARTED');
    console.log('================================================');
    console.log(`Port: ${PORT}`);
    console.log(`Time: ${new Date().toLocaleString()}`);
    console.log('================================================');
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
    console.log('New WebSocket connection');
    
    const params = new URLSearchParams(req.url.split('?')[1]);
    const token = params.get('token');
    
    if (!token) {
        ws.close();
        return;
    }
    
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        activeConnections.set(ws, decoded);
        
        console.log(`User ${decoded.accountNumber} connected via WebSocket`);
        
        ws.send(JSON.stringify({
            type: 'init',
            signals: signals.slice(-10)
        }));
        
        ws.on('close', () => {
            activeConnections.delete(ws);
            console.log(`User ${decoded.accountNumber} disconnected`);
        });
        
    } catch (error) {
        console.error('WebSocket auth error:', error);
        ws.close();
    }
});

function broadcastSignal(signal) {
    activeConnections.forEach((user, ws) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'signal',
                data: signal
            }));
        }
    });
}

function broadcastPosition(position, accountNumber) {
    activeConnections.forEach((user, ws) => {
        if (ws.readyState === WebSocket.OPEN && user.accountNumber === accountNumber) {
            ws.send(JSON.stringify({
                type: 'position',
                data: position
            }));
        }
    });
}

// Aggiorna prezzi (simulato)
setInterval(() => {
    positions.forEach((position, id) => {
        const randomChange = (Math.random() - 0.5) * 2;
        position.currentPrice += randomChange;
        
        const priceDiff = position.type === 'BUY' 
            ? position.currentPrice - position.entryPrice
            : position.entryPrice - position.currentPrice;
        
        position.profit = priceDiff * position.lots * 100;
        
        broadcastPosition(position, position.accountNumber);
    });
}, 2000);

// Health check
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'healthy', 
        uptime: process.uptime(),
        signals: signals.length,
        positions: positions.size,
        connections: activeConnections.size
    });
});

console.log('Waiting for connections...');