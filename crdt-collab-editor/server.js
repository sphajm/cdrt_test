// server.js - Node.js/Express WebSocket Server for CRDT Collaboration
//
// Installation:
// npm install express ws yjs fs-extra cors

const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const Y = require('yjs');
const fs = require('fs-extra');
const path = require('path');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Configuration
const PORT = process.env.PORT || 3001;
const PERSISTENCE_DIR = './crdt-persistence';

// Ensure persistence directory exists
fs.ensureDirSync(PERSISTENCE_DIR);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files from 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Store for documents and client connections
const documents = new Map();
const rooms = new Map();

/**
 * Document Manager - Handles CRDT document lifecycle
 */
class DocumentManager {
    constructor(docId) {
        this.docId = docId;
        this.doc = new Y.Doc();
        this.text = this.doc.getText('content');
        this.clients = new Set();
        this.persistencePath = path.join(PERSISTENCE_DIR, `${docId}.yjs`);

        // Load persisted state if exists
        this.loadState();

        // Set up auto-save on updates
        this.doc.on('update', (update, origin) => {
            if (origin !== 'load') {
                this.saveState();
                this.broadcastUpdate(update, origin);
            }
        });

        // Periodic state snapshot for crash recovery
        this.snapshotInterval = setInterval(() => {
            this.saveSnapshot();
        }, 30000); // Every 30 seconds
    }

    /**
     * Load document state from disk
     */
    async loadState() {
        try {
            if (await fs.pathExists(this.persistencePath)) {
                const data = await fs.readFile(this.persistencePath);
                Y.applyUpdate(this.doc, new Uint8Array(data), 'load');
                console.log(`📂 Loaded document ${this.docId} from disk`);
            }
        } catch (error) {
            console.error(`Error loading document ${this.docId}:`, error);
        }
    }

    /**
     * Save document state to disk
     */
    async saveState() {
        try {
            const state = Y.encodeStateAsUpdate(this.doc);
            await fs.writeFile(this.persistencePath, Buffer.from(state));
        } catch (error) {
            console.error(`Error saving document ${this.docId}:`, error);
        }
    }

    /**
     * Save complete snapshot for recovery
     */
    async saveSnapshot() {
        try {
            const snapshotPath = path.join(
                PERSISTENCE_DIR,
                `${this.docId}.snapshot.${Date.now()}.yjs`
            );
            const state = Y.encodeStateAsUpdate(this.doc);
            await fs.writeFile(snapshotPath, Buffer.from(state));

            // Clean up old snapshots (keep last 5)
            const files = await fs.readdir(PERSISTENCE_DIR);
            const snapshots = files
                .filter(f => f.startsWith(`${this.docId}.snapshot.`))
                .sort()
                .reverse();

            for (let i = 5; i < snapshots.length; i++) {
                await fs.remove(path.join(PERSISTENCE_DIR, snapshots[i]));
            }
        } catch (error) {
            console.error(`Error saving snapshot for ${this.docId}:`, error);
        }
    }

    /**
     * Add client to document
     */
    addClient(client) {
        this.clients.add(client);
        console.log(`👤 Client ${client.id} joined document ${this.docId}`);

        // Send current state to new client
        const state = Y.encodeStateAsUpdate(this.doc);
        client.send(JSON.stringify({
            type: 'sync',
            update: Array.from(state),
            docId: this.docId
        }));
    }

    /**
     * Remove client from document
     */
    removeClient(client) {
        this.clients.delete(client);
        console.log(`👋 Client ${client.id} left document ${this.docId}`);

        // Clean up if no clients remain
        if (this.clients.size === 0) {
            this.cleanup();
        }
    }

    /**
     * Broadcast update to all clients except sender
     */
    broadcastUpdate(update, origin) {
        const message = JSON.stringify({
            type: 'update',
            update: Array.from(update),
            docId: this.docId
        });

        this.clients.forEach(client => {
            if (client !== origin && client.readyState === 1) { // WebSocket.OPEN
                try {
                    client.send(message);
                } catch (error) {
                    console.error(`Error broadcasting to client ${client.id}:`, error);
                }
            }
        });
    }

    /**
     * Apply update from client
     */
    applyUpdate(update, client) {
        try {
            Y.applyUpdate(this.doc, new Uint8Array(update), client);
        } catch (error) {
            console.error(`Error applying update from client ${client.id}:`, error);
        }
    }

    /**
     * Get document statistics
     */
    getStats() {
        return {
            docId: this.docId,
            clients: this.clients.size,
            textLength: this.text.length,
            updateSize: Y.encodeStateAsUpdate(this.doc).length
        };
    }

    /**
     * Cleanup resources
     */
    cleanup() {
        clearInterval(this.snapshotInterval);
        this.saveState();
        documents.delete(this.docId);
        console.log(`🗑️  Cleaned up document ${this.docId}`);
    }
}

/**
 * Get or create document manager
 */
function getDocument(docId) {
    if (!documents.has(docId)) {
        documents.set(docId, new DocumentManager(docId));
    }
    return documents.get(docId);
}

/**
 * WebSocket connection handler
 */
wss.on('connection', (ws, req) => {
    ws.id = `client-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    ws.currentDoc = null;
    ws.isAlive = true;

    console.log(`🔌 New connection: ${ws.id}`);

    // Heartbeat
    ws.on('pong', () => {
        ws.isAlive = true;
    });

    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data);

            switch (message.type) {
                case 'join':
                    handleJoin(ws, message);
                    break;

                case 'update':
                    handleUpdate(ws, message);
                    break;

                case 'sync-request':
                    handleSyncRequest(ws, message);
                    break;

                case 'undo':
                    handleUndo(ws, message);
                    break;

                case 'redo':
                    handleRedo(ws, message);
                    break;

                default:
                    console.log(`Unknown message type: ${message.type}`);
            }
        } catch (error) {
            console.error(`Error handling message from ${ws.id}:`, error);
            ws.send(JSON.stringify({
                type: 'error',
                message: error.message
            }));
        }
    });

    ws.on('close', () => {
        console.log(`🔌 Connection closed: ${ws.id}`);
        if (ws.currentDoc) {
            const doc = documents.get(ws.currentDoc);
            if (doc) {
                doc.removeClient(ws);
            }
        }
    });

    ws.on('error', (error) => {
        console.error(`WebSocket error for ${ws.id}:`, error);
    });

    // Send welcome message
    ws.send(JSON.stringify({
        type: 'connected',
        clientId: ws.id,
        timestamp: Date.now()
    }));
});

/**
 * Handle client joining a document
 */
function handleJoin(ws, message) {
    const { docId } = message;

    if (!docId) {
        ws.send(JSON.stringify({
            type: 'error',
            message: 'Document ID required'
        }));
        return;
    }

    // Leave current document if any
    if (ws.currentDoc) {
        const oldDoc = documents.get(ws.currentDoc);
        if (oldDoc) {
            oldDoc.removeClient(ws);
        }
    }

    // Join new document
    ws.currentDoc = docId;
    const doc = getDocument(docId);
    doc.addClient(ws);

    // Send room info
    ws.send(JSON.stringify({
        type: 'joined',
        docId: docId,
        stats: doc.getStats()
    }));
}

/**
 * Handle update from client
 */
function handleUpdate(ws, message) {
    const { update, docId } = message;

    if (!ws.currentDoc || ws.currentDoc !== docId) {
        ws.send(JSON.stringify({
            type: 'error',
            message: 'Not in document'
        }));
        return;
    }

    const doc = documents.get(docId);
    if (doc) {
        doc.applyUpdate(update, ws);
    }
}

/**
 * Handle sync request from reconnecting client
 */
function handleSyncRequest(ws, message) {
    const { docId, vectorClock } = message;

    const doc = documents.get(docId);
    if (!doc) {
        ws.send(JSON.stringify({
            type: 'error',
            message: 'Document not found'
        }));
        return;
    }

    // Send full state for now (optimization: send only diff)
    const state = Y.encodeStateAsUpdate(doc.doc);
    ws.send(JSON.stringify({
        type: 'sync',
        update: Array.from(state),
        docId: docId
    }));
}

/**
 * Handle undo operation
 */
function handleUndo(ws, message) {
    const { docId } = message;

    // Undo is handled client-side with UndoManager
    // Server just broadcasts the resulting operations
    ws.send(JSON.stringify({
        type: 'undo-ack',
        docId: docId
    }));
}

/**
 * Handle redo operation
 */
function handleRedo(ws, message) {
    const { docId } = message;

    // Redo is handled client-side with UndoManager
    ws.send(JSON.stringify({
        type: 'redo-ack',
        docId: docId
    }));
}

/**
 * Heartbeat to detect dead connections
 */
const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            console.log(`💀 Terminating dead connection: ${ws.id}`);
            return ws.terminate();
        }

        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

/**
 * REST API endpoints
 */

// Root route - serves a simple dashboard
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CRDT Collaboration Server</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        .container {
            background: white;
            border-radius: 20px;
            padding: 40px;
            max-width: 800px;
            width: 100%;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
        }
        h1 {
            font-size: 36px;
            margin-bottom: 10px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }
        .subtitle {
            color: #666;
            margin-bottom: 30px;
            font-size: 16px;
        }
        .status {
            background: #d1fae5;
            border: 2px solid #10b981;
            border-radius: 12px;
            padding: 20px;
            margin-bottom: 30px;
        }
        .status h2 {
            color: #065f46;
            font-size: 18px;
            margin-bottom: 15px;
        }
        .stat {
            display: flex;
            justify-content: space-between;
            padding: 8px 0;
            border-bottom: 1px solid #a7f3d0;
        }
        .stat:last-child {
            border-bottom: none;
        }
        .stat-label {
            color: #047857;
            font-weight: 500;
        }
        .stat-value {
            color: #065f46;
            font-weight: 700;
        }
        .endpoints {
            background: #f3f4f6;
            border-radius: 12px;
            padding: 20px;
            margin-bottom: 20px;
        }
        .endpoints h2 {
            color: #1f2937;
            font-size: 18px;
            margin-bottom: 15px;
        }
        .endpoint {
            background: white;
            padding: 12px 16px;
            margin-bottom: 10px;
            border-radius: 8px;
            font-family: 'Courier New', monospace;
            font-size: 14px;
            display: flex;
            gap: 10px;
        }
        .method {
            font-weight: 700;
            color: #3b82f6;
        }
        .path {
            color: #6b7280;
        }
        .button {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 14px 28px;
            border: none;
            border-radius: 10px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            width: 100%;
            transition: transform 0.2s;
        }
        .button:hover {
            transform: translateY(-2px);
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🚀 CRDT Collaboration Server</h1>
        <p class="subtitle">Real-time collaborative editing with conflict-free replicated data types</p>
        
        <div class="status">
            <h2>✅ Server Status</h2>
            <div class="stat">
                <span class="stat-label">Status</span>
                <span class="stat-value">Running</span>
            </div>
            <div class="stat">
                <span class="stat-label">Port</span>
                <span class="stat-value">${PORT}</span>
            </div>
            <div class="stat">
                <span class="stat-label">WebSocket</span>
                <span class="stat-value">ws://localhost:${PORT}</span>
            </div>
            <div class="stat">
                <span class="stat-label">Active Documents</span>
                <span class="stat-value" id="docCount">0</span>
            </div>
            <div class="stat">
                <span class="stat-label">Connected Clients</span>
                <span class="stat-value" id="clientCount">0</span>
            </div>
        </div>

        <div class="endpoints">
            <h2>📡 API Endpoints</h2>
            <div class="endpoint">
                <span class="method">GET</span>
                <span class="path">/health</span>
            </div>
            <div class="endpoint">
                <span class="method">GET</span>
                <span class="path">/api/documents</span>
            </div>
            <div class="endpoint">
                <span class="method">GET</span>
                <span class="path">/api/documents/:docId</span>
            </div>
            <div class="endpoint">
                <span class="method">POST</span>
                <span class="path">/api/documents</span>
            </div>
            <div class="endpoint">
                <span class="method">DELETE</span>
                <span class="path">/api/documents/:docId</span>
            </div>
        </div>

        <button class="button" onclick="location.href='/health'">
            Check Server Health
        </button>
    </div>

    <script>
        // Update stats every 2 seconds
        setInterval(async () => {
            try {
                const response = await fetch('/health');
                const data = await response.json();
                document.getElementById('docCount').textContent = data.documents || 0;
                document.getElementById('clientCount').textContent = data.connections || 0;
            } catch (error) {
                console.error('Error fetching stats:', error);
            }
        }, 2000);

        // Initial load
        setTimeout(() => {
            fetch('/health')
                .then(r => r.json())
                .then(data => {
                    document.getElementById('docCount').textContent = data.documents || 0;
                    document.getElementById('clientCount').textContent = data.connections || 0;
                });
        }, 100);
    </script>
</body>
</html>
    `);
});

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        uptime: process.uptime(),
        connections: wss.clients.size,
        documents: documents.size
    });
});

// Get document info
app.get('/api/documents/:docId', (req, res) => {
    const doc = documents.get(req.params.docId);
    if (!doc) {
        return res.status(404).json({ error: 'Document not found' });
    }

    res.json(doc.getStats());
});

// List all documents
app.get('/api/documents', (req, res) => {
    const docs = Array.from(documents.values()).map(doc => doc.getStats());
    res.json({ documents: docs });
});

// Create new document
app.post('/api/documents', (req, res) => {
    const docId = req.body.docId || `doc-${Date.now()}`;
    const doc = getDocument(docId);
    res.json({
        docId: docId,
        stats: doc.getStats()
    });
});

// Delete document
app.delete('/api/documents/:docId', async (req, res) => {
    const doc = documents.get(req.params.docId);
    if (!doc) {
        return res.status(404).json({ error: 'Document not found' });
    }

    // Disconnect all clients
    doc.clients.forEach(client => {
        client.send(JSON.stringify({
            type: 'document-deleted',
            docId: req.params.docId
        }));
        client.close();
    });

    // Delete persistence files
    try {
        await fs.remove(doc.persistencePath);
        const files = await fs.readdir(PERSISTENCE_DIR);
        const snapshots = files.filter(f =>
            f.startsWith(`${req.params.docId}.snapshot.`)
        );
        for (const snapshot of snapshots) {
            await fs.remove(path.join(PERSISTENCE_DIR, snapshot));
        }
    } catch (error) {
        console.error('Error deleting persistence files:', error);
    }

    doc.cleanup();
    res.json({ success: true });
});

/**
 * Graceful shutdown
 */
process.on('SIGTERM', async () => {
    console.log('🛑 SIGTERM received, shutting down gracefully...');

    // Save all documents
    const savePromises = Array.from(documents.values()).map(doc =>
        doc.saveState()
    );
    await Promise.all(savePromises);

    // Close server
    server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
    });

    // Force shutdown after 10 seconds
    setTimeout(() => {
        console.error('❌ Forced shutdown after timeout');
        process.exit(1);
    }, 10000);
});

/**
 * Start server
 */
server.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   🚀 CRDT Collaborative Server                           ║
║                                                           ║
║   HTTP Server: http://localhost:${PORT}                    ║
║   WebSocket:   ws://localhost:${PORT}                      ║
║   Persistence: ${PERSISTENCE_DIR}                    ║
║                                                           ║
║   Open http://localhost:${PORT} in your browser          ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
  `);
});

// Export for testing
module.exports = { app, server, getDocument };