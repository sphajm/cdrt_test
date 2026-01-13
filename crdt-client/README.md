🏗️ Architecture Overview
System Components
1. Client Layer (React)

React Editor Component: Handles user input and UI rendering
Yjs Y.Doc: CRDT document that maintains conflict-free state
UndoManager: Per-client undo/redo stack that doesn't affect other users
WebSocket Provider: Handles real-time synchronization with server

2. Server Layer (Node.js/Express)

WebSocket Server: Manages client connections and message routing
Document Manager: Maintains server-side Yjs documents
Persistence Layer: Saves document state to disk for crash recovery
REST API: Provides document management endpoints

3. CRDT Algorithm (Yjs/YATA)

Each character has unique ID: clientId + clock
Vector clocks track causality across clients
Operations are commutative, associative, and idempotent
Deterministic ordering ensures all clients converge to same state

Key Features Implemented
✅ CRDT-based conflict resolution - Multiple users can edit simultaneously without conflicts
✅ Per-client undo - Each user's undo only affects their own changes
✅ Offline resilience - Changes queued offline, synced on reconnect
✅ Crash recovery - State persisted to disk, restored on restart
✅ Deterministic ordering - All clients converge to identical state