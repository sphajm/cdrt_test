import React, { useState, useEffect, useRef } from 'react';
import { AlertCircle, Users, Wifi, WifiOff, RotateCcw, Info } from 'lucide-react';

// Simulated Yjs CRDT implementation
class SimpleYDoc {
    constructor(clientId) {
        this.clientId = clientId;
        this.content = [];
        this.vectorClock = {};
        this.listeners = new Set();
        this.undoStack = [];
        this.redoStack = [];
    }

    getText() {
        return this.content
            .filter(char => !char.deleted)
            .map(char => char.value)
            .join('');
    }

    insert(position, text, origin = 'local') {
        const ops = [];
        for (let i = 0; i < text.length; i++) {
            const clock = (this.vectorClock[this.clientId] || 0) + 1;
            this.vectorClock[this.clientId] = clock;

            const char = {
                id: `${this.clientId}-${clock}`,
                value: text[i],
                clientId: this.clientId,
                clock: clock,
                deleted: false,
                position: position + i
            };

            let insertIndex = 0;
            for (let j = 0; j < this.content.length; j++) {
                if (!this.content[j].deleted) {
                    if (insertIndex === position + i) break;
                    insertIndex++;
                }
            }

            this.content.splice(insertIndex, 0, char);
            ops.push({ type: 'insert', char, origin });
        }

        if (origin === 'local') {
            this.undoStack.push({ type: 'insert', text, position, count: text.length });
            this.redoStack = [];
        }

        this.notifyListeners(ops);
        return ops;
    }

    delete(position, length, origin = 'local') {
        const ops = [];
        let deleted = 0;
        let currentPos = 0;

        for (let i = 0; i < this.content.length && deleted < length; i++) {
            if (!this.content[i].deleted) {
                if (currentPos >= position) {
                    this.content[i].deleted = true;
                    ops.push({ type: 'delete', char: this.content[i], origin });
                    deleted++;
                }
                currentPos++;
            }
        }

        if (origin === 'local') {
            const deletedChars = ops.map(op => op.char);
            this.undoStack.push({ type: 'delete', position, chars: deletedChars });
            this.redoStack = [];
        }

        this.notifyListeners(ops);
        return ops;
    }

    undo() {
        if (this.undoStack.length === 0) return;

        const operation = this.undoStack.pop();

        if (operation.type === 'insert') {
            this.delete(operation.position, operation.count, 'undo');
            this.redoStack.push({ ...operation, isRedo: true });
        } else if (operation.type === 'delete') {
            operation.chars.forEach(char => {
                char.deleted = false;
            });
            this.redoStack.push({ ...operation, isRedo: true });
            this.notifyListeners([{ type: 'undo-delete' }]);
        }
    }

    redo() {
        if (this.redoStack.length === 0) return;

        const operation = this.redoStack.pop();

        if (operation.type === 'insert') {
            this.insert(operation.position, operation.text, 'redo');
            this.undoStack.push(operation);
        } else if (operation.type === 'delete') {
            operation.chars.forEach(char => {
                char.deleted = true;
            });
            this.undoStack.push(operation);
            this.notifyListeners([{ type: 'redo-delete' }]);
        }
    }

    applyRemoteOps(ops) {
        ops.forEach(op => {
            if (op.type === 'insert') {
                const existingIndex = this.content.findIndex(c => c.id === op.char.id);
                if (existingIndex === -1) {
                    this.content.push(op.char);
                    this.content.sort((a, b) => {
                        if (a.clientId === b.clientId) return a.clock - b.clock;
                        return a.clientId.localeCompare(b.clientId);
                    });
                }
            } else if (op.type === 'delete') {
                const char = this.content.find(c => c.id === op.char.id);
                if (char) char.deleted = true;
            }
        });
        this.notifyListeners([{ type: 'remote' }]);
    }

    onChange(callback) {
        this.listeners.add(callback);
        return () => this.listeners.delete(callback);
    }

    notifyListeners(ops) {
        this.listeners.forEach(cb => cb(ops));
    }

    getState() {
        return {
            content: this.content,
            vectorClock: this.vectorClock,
            clientId: this.clientId
        };
    }

    setState(state) {
        this.content = state.content;
        this.vectorClock = state.vectorClock;
        this.notifyListeners([{ type: 'state-restored' }]);
    }
}

// Simulated WebSocket connection
class SimulatedConnection {
    constructor(clientId, onMessage, onStatusChange) {
        this.clientId = clientId;
        this.onMessage = onMessage;
        this.onStatusChange = onStatusChange;
        this.connected = true;
        this.messageQueue = [];

        if (!window.__collaborativeState) {
            window.__collaborativeState = {
                docs: {},
                connections: new Set()
            };
        }

        window.__collaborativeState.connections.add(this);
        this.syncInterval = setInterval(() => this.syncState(), 100);
    }

    send(message) {
        if (this.connected) {
            this.broadcast(message);
        } else {
            this.messageQueue.push(message);
        }
    }

    broadcast(message) {
        window.__collaborativeState.connections.forEach(conn => {
            if (conn !== this && conn.connected) {
                setTimeout(() => conn.onMessage(message), Math.random() * 50);
            }
        });
    }

    syncState() {
        // Simulated periodic state sync
    }

    disconnect() {
        this.connected = false;
        this.onStatusChange(false);
    }

    reconnect() {
        this.connected = true;
        this.onStatusChange(true);

        while (this.messageQueue.length > 0) {
            this.broadcast(this.messageQueue.shift());
        }
    }

    destroy() {
        clearInterval(this.syncInterval);
        window.__collaborativeState.connections.delete(this);
    }
}

// Main collaborative editor component
const CollaborativeEditor = () => {
    const [clientId] = useState(() => `client-${Math.random().toString(36).substr(2, 9)}`);
    const [text, setText] = useState('');
    const [connected, setConnected] = useState(true);
    const [activeUsers, setActiveUsers] = useState(1);
    const [showInfo, setShowInfo] = useState(false);

    const docRef = useRef(null);
    const connectionRef = useRef(null);
    const textareaRef = useRef(null);
    const cursorPositionRef = useRef(0);

    useEffect(() => {
        docRef.current = new SimpleYDoc(clientId);

        connectionRef.current = new SimulatedConnection(
            clientId,
            (message) => {
                if (message.type === 'ops' && message.clientId !== clientId) {
                    docRef.current.applyRemoteOps(message.ops);
                }
            },
            (status) => setConnected(status)
        );

        const unsubscribe = docRef.current.onChange(() => {
            setText(docRef.current.getText());
        });

        setActiveUsers(window.__collaborativeState.connections.size);
        const userInterval = setInterval(() => {
            setActiveUsers(window.__collaborativeState.connections.size);
        }, 1000);

        const saveInterval = setInterval(() => {
            if (connected) {
                const state = docRef.current.getState();
                localStorage.setItem(`crdt-state-${clientId}`, JSON.stringify(state));
            }
        }, 2000);

        const savedState = localStorage.getItem(`crdt-state-${clientId}`);
        if (savedState) {
            try {
                const state = JSON.parse(savedState);
                docRef.current.setState(state);
                setText(docRef.current.getText());
            } catch (e) {
                console.error('Failed to restore state:', e);
            }
        }

        return () => {
            unsubscribe();
            connectionRef.current.destroy();
            clearInterval(userInterval);
            clearInterval(saveInterval);
        };
    }, [clientId]);

    const handleTextChange = (e) => {
        const newText = e.target.value;
        const oldText = text;
        const cursorPos = e.target.selectionStart;

        if (newText.length > oldText.length) {
            const insertPos = cursorPos - (newText.length - oldText.length);
            const insertedText = newText.slice(insertPos, cursorPos);
            const ops = docRef.current.insert(insertPos, insertedText);

            connectionRef.current.send({
                type: 'ops',
                ops: ops,
                clientId: clientId
            });
        } else if (newText.length < oldText.length) {
            const deletePos = cursorPos;
            const deleteCount = oldText.length - newText.length;
            const ops = docRef.current.delete(deletePos, deleteCount);

            connectionRef.current.send({
                type: 'ops',
                ops: ops,
                clientId: clientId
            });
        }

        cursorPositionRef.current = cursorPos;
    };

    const handleUndo = () => {
        docRef.current.undo();
    };

    const handleRedo = () => {
        docRef.current.redo();
    };

    const handleDisconnect = () => {
        connectionRef.current.disconnect();
    };

    const handleReconnect = () => {
        connectionRef.current.reconnect();
    };

    const startRobotTyping = () => {
        const robot1Text = "Robot A says: ";
        const robot2Text = "Robot B says: ";

        setTimeout(() => {
            const pos = Math.floor(Math.random() * text.length);
            const ops = docRef.current.insert(pos, robot1Text);
            connectionRef.current.send({
                type: 'ops',
                ops: ops,
                clientId: 'robot-a'
            });
        }, 500);

        setTimeout(() => {
            const pos = Math.floor(Math.random() * text.length);
            const ops = docRef.current.insert(pos, robot2Text);
            connectionRef.current.send({
                type: 'ops',
                ops: ops,
                clientId: 'robot-b'
            });
        }, 1000);
    };

    return (
        <div style={{
            display: 'flex',
            flexDirection: 'column',
            height: '100vh',
            background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
        }}>
            {/* Header */}
            <div style={{
                background: 'rgba(255, 255, 255, 0.95)',
                backdropFilter: 'blur(10px)',
                borderBottom: '1px solid rgba(0, 0, 0, 0.1)',
                padding: '24px',
                boxShadow: '0 4px 6px rgba(0, 0, 0, 0.05)'
            }}>
                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between'
                }}>
                    <div>
                        <h1 style={{
                            fontSize: '28px',
                            fontWeight: '700',
                            background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                            WebkitBackgroundClip: 'text',
                            WebkitTextFillColor: 'transparent',
                            marginBottom: '8px'
                        }}>
                            🚀 CRDT Collaborative Editor
                        </h1>
                        <p style={{
                            fontSize: '13px',
                            color: '#6b7280',
                            marginTop: '4px'
                        }}>
                            Client ID: <code style={{
                            background: '#f3f4f6',
                            padding: '4px 8px',
                            borderRadius: '4px',
                            fontSize: '11px',
                            fontFamily: 'monospace'
                        }}>{clientId}</code>
                        </p>
                    </div>

                    <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '16px'
                    }}>
                        <div style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                            background: '#eff6ff',
                            padding: '8px 16px',
                            borderRadius: '12px'
                        }}>
                            <Users className="w-5 h-5" style={{ color: '#3b82f6' }} />
                            <span style={{
                                fontSize: '14px',
                                fontWeight: '600',
                                color: '#1e40af'
                            }}>{activeUsers} active</span>
                        </div>

                        <div style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                            padding: '8px 16px',
                            borderRadius: '12px',
                            background: connected ? '#d1fae5' : '#fee2e2',
                            color: connected ? '#065f46' : '#991b1b'
                        }}>
                            {connected ?
                                <Wifi className="w-5 h-5" /> :
                                <WifiOff className="w-5 h-5" />
                            }
                            <span style={{
                                fontSize: '14px',
                                fontWeight: '600'
                            }}>
                                {connected ? 'Connected' : 'Offline'}
                            </span>
                        </div>

                        <button
                            onClick={() => setShowInfo(!showInfo)}
                            style={{
                                padding: '10px',
                                background: showInfo ? '#f3f4f6' : 'transparent',
                                border: 'none',
                                borderRadius: '12px',
                                cursor: 'pointer',
                                transition: 'all 0.2s',
                                display: 'flex',
                                alignItems: 'center'
                            }}
                            onMouseEnter={(e) => e.target.style.background = '#f3f4f6'}
                            onMouseLeave={(e) => e.target.style.background = showInfo ? '#f3f4f6' : 'transparent'}
                        >
                            <Info className="w-5 h-5" style={{ color: '#6b7280' }} />
                        </button>
                    </div>
                </div>
            </div>

            {/* Info Panel */}
            {showInfo && (
                <div style={{
                    background: 'rgba(239, 246, 255, 0.95)',
                    backdropFilter: 'blur(10px)',
                    borderBottom: '1px solid #bfdbfe',
                    padding: '20px 24px',
                    animation: 'slideDown 0.3s ease-out'
                }}>
                    <div style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: '12px'
                    }}>
                        <AlertCircle className="w-5 h-5" style={{
                            color: '#3b82f6',
                            marginTop: '2px',
                            flexShrink: 0
                        }} />
                        <div style={{
                            fontSize: '14px',
                            color: '#1e3a8a',
                            lineHeight: '1.6'
                        }}>
                            <p style={{ fontWeight: '600', marginBottom: '12px' }}>
                                How this works:
                            </p>
                            <ul style={{
                                listStyle: 'disc',
                                paddingLeft: '24px',
                                margin: 0
                            }}>
                                <li style={{ marginBottom: '8px' }}>
                                    <strong>CRDT:</strong> Each character has a unique ID (clientId + clock) for conflict-free merging
                                </li>
                                <li style={{ marginBottom: '8px' }}>
                                    <strong>Per-client undo:</strong> Each client maintains its own undo stack that only reverts their operations
                                </li>
                                <li style={{ marginBottom: '8px' }}>
                                    <strong>Offline resilience:</strong> Changes are queued when offline and synced on reconnect
                                </li>
                                <li style={{ marginBottom: '8px' }}>
                                    <strong>Crash recovery:</strong> State is persisted to localStorage every 2 seconds
                                </li>
                                <li>
                                    <strong>Deterministic order:</strong> Operations are ordered by clientId + clock for consistency
                                </li>
                            </ul>
                        </div>
                    </div>
                </div>
            )}

            {/* Toolbar */}
            <div style={{
                background: 'rgba(255, 255, 255, 0.9)',
                backdropFilter: 'blur(10px)',
                borderBottom: '1px solid rgba(0, 0, 0, 0.1)',
                padding: '16px 24px',
                display: 'flex',
                gap: '12px',
                alignItems: 'center'
            }}>
                <button
                    onClick={handleUndo}
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        padding: '10px 20px',
                        background: '#f3f4f6',
                        border: 'none',
                        borderRadius: '10px',
                        cursor: 'pointer',
                        transition: 'all 0.2s',
                        fontSize: '14px',
                        fontWeight: '500',
                        color: '#374151'
                    }}
                    onMouseEnter={(e) => {
                        e.target.style.background = '#e5e7eb';
                        e.target.style.transform = 'translateY(-1px)';
                    }}
                    onMouseLeave={(e) => {
                        e.target.style.background = '#f3f4f6';
                        e.target.style.transform = 'translateY(0)';
                    }}
                >
                    <RotateCcw className="w-4 h-4" />
                    Undo
                </button>

                <button
                    onClick={handleRedo}
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        padding: '10px 20px',
                        background: '#f3f4f6',
                        border: 'none',
                        borderRadius: '10px',
                        cursor: 'pointer',
                        transition: 'all 0.2s',
                        fontSize: '14px',
                        fontWeight: '500',
                        color: '#374151'
                    }}
                    onMouseEnter={(e) => {
                        e.target.style.background = '#e5e7eb';
                        e.target.style.transform = 'translateY(-1px)';
                    }}
                    onMouseLeave={(e) => {
                        e.target.style.background = '#f3f4f6';
                        e.target.style.transform = 'translateY(0)';
                    }}
                >
                    <RotateCcw className="w-4 h-4" style={{ transform: 'scaleX(-1)' }} />
                    Redo
                </button>

                <div style={{ flex: 1 }} />

                <button
                    onClick={startRobotTyping}
                    style={{
                        padding: '10px 20px',
                        background: 'linear-gradient(135deg, #a78bfa 0%, #8b5cf6 100%)',
                        border: 'none',
                        borderRadius: '10px',
                        cursor: 'pointer',
                        transition: 'all 0.2s',
                        fontSize: '14px',
                        fontWeight: '600',
                        color: 'white',
                        boxShadow: '0 4px 6px rgba(139, 92, 246, 0.3)'
                    }}
                    onMouseEnter={(e) => {
                        e.target.style.transform = 'translateY(-2px)';
                        e.target.style.boxShadow = '0 6px 12px rgba(139, 92, 246, 0.4)';
                    }}
                    onMouseLeave={(e) => {
                        e.target.style.transform = 'translateY(0)';
                        e.target.style.boxShadow = '0 4px 6px rgba(139, 92, 246, 0.3)';
                    }}
                >
                    🤖 Simulate Robot Edits
                </button>

                <button
                    onClick={connected ? handleDisconnect : handleReconnect}
                    style={{
                        padding: '10px 20px',
                        background: connected
                            ? 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)'
                            : 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
                        border: 'none',
                        borderRadius: '10px',
                        cursor: 'pointer',
                        transition: 'all 0.2s',
                        fontSize: '14px',
                        fontWeight: '600',
                        color: 'white',
                        boxShadow: connected
                            ? '0 4px 6px rgba(239, 68, 68, 0.3)'
                            : '0 4px 6px rgba(16, 185, 129, 0.3)'
                    }}
                    onMouseEnter={(e) => {
                        e.target.style.transform = 'translateY(-2px)';
                        e.target.style.boxShadow = connected
                            ? '0 6px 12px rgba(239, 68, 68, 0.4)'
                            : '0 6px 12px rgba(16, 185, 129, 0.4)';
                    }}
                    onMouseLeave={(e) => {
                        e.target.style.transform = 'translateY(0)';
                        e.target.style.boxShadow = connected
                            ? '0 4px 6px rgba(239, 68, 68, 0.3)'
                            : '0 4px 6px rgba(16, 185, 129, 0.3)';
                    }}
                >
                    {connected ? 'Go Offline' : 'Reconnect'}
                </button>
            </div>

            {/* Editor */}
            <div style={{
                flex: 1,
                padding: '24px',
                overflow: 'hidden'
            }}>
                <textarea
                    ref={textareaRef}
                    value={text}
                    onChange={handleTextChange}
                    style={{
                        width: '100%',
                        height: '100%',
                        padding: '20px',
                        border: 'none',
                        borderRadius: '16px',
                        fontSize: '15px',
                        fontFamily: '"Fira Code", "Courier New", monospace',
                        resize: 'none',
                        outline: 'none',
                        background: 'rgba(255, 255, 255, 0.95)',
                        backdropFilter: 'blur(10px)',
                        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.1)',
                        lineHeight: '1.6',
                        color: '#1f2937'
                    }}
                    placeholder="Start typing... Open this in multiple tabs to see collaborative editing in action! ✨"
                />
            </div>

            {/* Status Bar */}
            <div style={{
                background: 'rgba(255, 255, 255, 0.95)',
                backdropFilter: 'blur(10px)',
                borderTop: '1px solid rgba(0, 0, 0, 0.1)',
                padding: '12px 24px',
                fontSize: '13px',
                color: '#6b7280'
            }}>
                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between'
                }}>
                    <div>
                        <span style={{ fontWeight: '500' }}>Characters:</span> {text.length}
                        <span style={{ margin: '0 12px', color: '#d1d5db' }}>|</span>
                        <span style={{ fontWeight: '500' }}>CRDT Nodes:</span> {docRef.current?.content.length || 0}
                    </div>
                    <div>
                        {!connected && (
                            <span style={{
                                color: '#f59e0b',
                                fontWeight: '600',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '6px'
                            }}>
                                ⚠️ Offline - changes will sync when reconnected
                            </span>
                        )}
                    </div>
                </div>
            </div>

            <style>{`
                @keyframes slideDown {
                    from {
                        opacity: 0;
                        transform: translateY(-10px);
                    }
                    to {
                        opacity: 1;
                        transform: translateY(0);
                    }
                }
                
                textarea::placeholder {
                    color: #9ca3af;
                }
                
                * {
                    box-sizing: border-box;
                }
            `}</style>
        </div>
    );
};

export default CollaborativeEditor;