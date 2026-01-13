// src/index.js
import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';

// Remove or comment out reportWebVitals — it's optional
// import reportWebVitals from 'web-vitals'; // ← Remove this line

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
    <React.StrictMode>
        <App />
    </React.StrictMode>
);

// Optional: If you want web vitals later, use named imports:
// import { getCLS, getFID, getFCP, getLCP, getTTFB } from 'web-vitals';
// function sendToAnalytics(metrics) { console.log(metrics); }
// getCLS(sendToAnalytics); etc.